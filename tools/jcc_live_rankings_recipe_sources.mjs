import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_RECIPE_POINTER_FILE,
  ACTIVE_RECIPE_POINTER_SCHEMA,
} from "./jcc_live_rankings_recipe_store.mjs";
import {
  buildRankingRecipeFreshnessProfile,
  recipeSourceStatDate,
} from "./jcc_ranking_recipe_freshness.mjs";

export const RECIPE_GENERATION_SCHEMA = "jcc-live-ranking-recipe-generation-v1";
export const RECIPE_CANDIDATE_SCHEMA = "jcc-live-ranking-recipe-candidate-v1";
export const RECIPE_CAPABILITY_SCHEMA = "jcc-live-ranking-recipe-capability-v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OFFICIAL_CURATED_HOSTS = new Set(["game.gtimg.cn"]);
const PLAYER_MARKERS = new Set([
  "ugc", "player", "player_lineup", "user", "user_generated", "community",
]);
const CHAMPION_UNIT_TYPES = new Set(["hero", "champion", "chess", "unit"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function asString(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function normalizedName(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN").replace(/[\s·•'’_-]+/gu, "");
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).flatMap((value) => {
    if (typeof value === "string" && /[,|]/u.test(value)) return value.split(/[,|]/u);
    return [value];
  }).map(asString).filter(Boolean))];
}

function catalogRows(catalog) {
  if (catalog instanceof Map) return [...catalog.values()];
  if (Array.isArray(catalog)) return catalog;
  if (Array.isArray(catalog?.items)) return catalog.items;
  if (catalog && typeof catalog === "object") return Object.values(catalog);
  return [];
}

function aliasesFor(row) {
  return uniqueStrings([
    row?.name,
    row?.display_name,
    row?.displayName,
    row?.title,
    row?.jccname,
    row?.api_name,
    row?.apiName,
    row?.alias,
    row?.aliases,
    row?.name_aliases,
  ]);
}

function buildCatalogIndex(catalog) {
  const byId = new Map();
  const byName = new Map();
  const addId = (id, entity) => {
    const key = asString(id);
    if (!key) return;
    if (!byId.has(key)) byId.set(key, entity);
    else if (byId.get(key)?.id !== entity.id) byId.set(key, null);
  };
  for (const row of catalogRows(catalog)) {
    const id = asString(firstValue(row?.id, row?.official_id, row?.hero_id, row?.item_id, row?.augment_id));
    if (!id) continue;
    const entity = { id, name: asString(firstValue(row?.name, row?.display_name, row?.displayName, row?.title, row?.jccname)) || id };
    for (const candidateId of uniqueStrings([
      id,
      row?.canonical_id,
      row?.mumu_base_id,
      row?.runtime_id,
      row?.upstream_id,
      row?.raw_refs?.raw_star_ids,
      row?.raw_refs?.upstream_ids,
    ])) addId(candidateId, entity);
    for (const mapping of asArray(row?.source_mappings)) {
      const sourceId = asString(mapping?.source_id);
      if (!sourceId) continue;
      addId(sourceId, {
        ...entity,
        source_mapping: {
          source_id: sourceId,
          mapping_kind: asString(mapping?.mapping_kind),
          authority: asString(mapping?.authority),
        },
        ...(mapping?.variant_trait_id ? {
          source_variant: {
            source_id: sourceId,
            order: Number(mapping.variant_order),
            trait_id: asString(mapping.variant_trait_id),
            trait_name: asString(mapping.variant_trait_name),
          },
        } : {}),
      });
    }
    for (const alias of aliasesFor(row)) {
      const key = normalizedName(alias);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      if (!byName.get(key).some((entry) => entry.id === id)) byName.get(key).push(entity);
    }
  }
  return { byId, byName };
}

function buildCatalogs(catalogs = {}) {
  return {
    champions: buildCatalogIndex(catalogs.champions),
    items: buildCatalogIndex(catalogs.items || catalogs.equipment),
    augments: buildCatalogIndex(catalogs.augments),
  };
}

function referenceParts(reference, kind) {
  if (reference === null || reference === undefined) return { id: null, name: null };
  if (typeof reference !== "object") {
    const value = asString(reference);
    return { id: value, name: value };
  }
  const prefixes = kind === "champion" ? ["hero", "champion", "chess"] : kind === "item" ? ["item", "equip"] : ["augment", "rune", "hex"];
  return {
    id: asString(firstValue(reference.id, ...prefixes.map((prefix) => reference[`${prefix}_id`]), reference.api_id)),
    name: asString(firstValue(reference.name, ...prefixes.map((prefix) => reference[`${prefix}_name`]), reference.title, reference.jccname)),
  };
}

function resolveEntity(reference, index, kind) {
  const parts = referenceParts(reference, kind);
  if (parts.id && index.byId.has(parts.id)) return index.byId.get(parts.id);
  if (kind === "champion" && /^\d{4}$/u.test(parts.id || "")) {
    const prefixedSourceId = `1${parts.id}`;
    const sourceMapped = index.byId.get(prefixedSourceId);
    if (sourceMapped?.source_mapping?.source_id === prefixedSourceId) return sourceMapped;
  }
  for (const candidate of [parts.name, parts.id]) {
    const matches = index.byName.get(normalizedName(candidate)) || [];
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function parseDetail(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

function sourceIdentity(target) {
  const seasonId = asString(target?.season_id || target?.season);
  const patchId = asString(target?.patch_id || target?.patch);
  const coreProfileId = asString(target?.core_profile_id);
  const upstream = target?.upstream_identity || {};
  if (!seasonId || !patchId) throw new Error("ranking recipe target requires season_id and patch_id");
  if (!SHA256_PATTERN.test(coreProfileId || "")) throw new Error("ranking recipe target requires a lowercase SHA-256 core_profile_id");
  return {
    season_id: seasonId,
    patch_id: patchId,
    core_profile_id: coreProfileId,
    upstream_identity: {
      mode: asString(firstValue(upstream.mode, target?.game_mode_id)),
      season: asString(firstValue(upstream.season, upstream.upstream_season)),
      version: asString(firstValue(upstream.version, upstream.patch, target?.upstream_version)),
    },
  };
}

function popularConfig(target) {
  const config = target?.ranking_sources?.popular_lineups;
  if (!config || typeof config !== "object") throw new Error("target.ranking_sources.popular_lineups is required");
  if (config.source_kind !== "official_curated_popular_lineup") throw new Error("popular lineup source_kind must be official_curated_popular_lineup");
  if (config.player_lineups_enabled !== false) throw new Error("popular lineup source must explicitly disable player lineups");
  if (config.metrics_authority !== false) throw new Error("popular lineup source must explicitly disable metrics authority");
  const url = new URL(config.url);
  const expectedPath = `/images/lol/act/jkzlkauto/json/lineupJson/m${asString(config.upstream_season)}/${asString(config.channel)}/${asString(config.mode)}/lineup_detail_total.json`;
  if (url.protocol !== "https:"
    || !OFFICIAL_CURATED_HOSTS.has(url.hostname)
    || url.port
    || url.username
    || url.password
    || url.pathname !== expectedPath
    || url.search
    || url.hash) {
    throw new Error("popular lineup URL must be an allowlisted Tencent official curated HTTPS URL");
  }
  for (const field of ["mode", "upstream_season", "channel"]) {
    if (!asString(config[field])) throw new Error(`popular lineup source requires ${field}`);
  }
  if (!Number.isFinite(Number(config.max_source_age_hours)) || Number(config.max_source_age_hours) <= 0) {
    throw new Error("popular lineup source requires a positive max_source_age_hours freshness bound");
  }
  return { ...config, url: url.href };
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === "function") return asString(response.headers.get(name));
  return asString(response?.headers?.[name] ?? response?.headers?.[name.toLowerCase()]);
}

function officialSourceReceipt(response, config, now = Date.now()) {
  const etag = responseHeader(response, "etag");
  const lastModified = responseHeader(response, "last-modified");
  const lastModifiedMs = Date.parse(lastModified || "");
  const maxAgeMs = Number(config.max_source_age_hours) * 60 * 60 * 1000;
  if (!etag || !Number.isFinite(lastModifiedMs)) {
    throw new Error("official curated popular lineup response requires ETag and Last-Modified freshness evidence");
  }
  if (lastModifiedMs > now + 5 * 60 * 1000 || now - lastModifiedMs > maxAgeMs) {
    throw new Error("official curated popular lineup response is outside the configured freshness window");
  }
  return {
    etag,
    last_modified: new Date(lastModifiedMs).toISOString(),
    max_source_age_hours: Number(config.max_source_age_hours),
    version_binding: "official_mode_endpoint_plus_current_core_catalog",
  };
}

function identityValue(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && value !== "") return asString(value);
  }
  return null;
}

function normalizedSeason(value) {
  return asString(value)?.replace(/^s/iu, "") || null;
}

function acceptedStatus(value, configuredStatus) {
  if (configuredStatus !== undefined) return asString(value) === asString(configuredStatus);
  return new Set(["1", "5", "ok", "online", "published", "active", "success"]).has(String(value || "").toLowerCase());
}

function identityProblems(raw, row, target, config) {
  const scopes = [row, raw?.data, raw];
  const find = (names) => scopes.map((scope) => identityValue(scope, names)).find(Boolean) || null;
  const actual = {
    mode: find(["mode", "mode_id", "game_mode", "gameMode"]),
    upstream_season: find(["upstream_season", "season", "season_id", "seasonId"]),
    channel: find(["channel", "channel_id", "channelId"]),
    status: find(["status", "publish_status", "publishStatus", "state"]),
  };
  const expectedMode = asString(config.mode);
  const targetMode = asString(target.upstream_identity.mode)?.replace(/^mode/iu, "");
  const problems = [];
  if (!actual.mode || actual.mode.replace(/^mode/iu, "") !== expectedMode || (targetMode && targetMode !== expectedMode)) problems.push("mode_mismatch");
  if (!actual.upstream_season || normalizedSeason(actual.upstream_season) !== normalizedSeason(config.upstream_season)
    || (target.upstream_identity.season && normalizedSeason(target.upstream_identity.season) !== normalizedSeason(config.upstream_season))) problems.push("upstream_season_mismatch");
  if (!actual.channel || actual.channel !== asString(config.channel)) problems.push("channel_mismatch");
  if (!actual.status || !acceptedStatus(actual.status, config.status)) problems.push("status_not_published");
  return problems;
}

function isPlayerRow(row, detail) {
  const values = [
    row?.source_type, row?.source_kind, row?.lineup_type, row?.author_type,
    detail?.source_type, detail?.source_kind, detail?.lineup_type, detail?.author_type,
  ].map((value) => String(value || "").toLowerCase());
  if (values.some((value) => PLAYER_MARKERS.has(value))) return true;
  const hasNonZero = (value) => Boolean(asString(value) && asString(value) !== "0");
  for (const source of [row, detail]) {
    if (hasNonZero(source?.pid) || hasNonZero(source?.bid) || hasNonZero(source?.video_author_uuid)) return true;
    if (hasNonZero(source?.lineupauthor_data?.authorId)) return true;
  }
  return [row, detail].some((value) => [
    "is_ugc", "ugc", "is_player", "player_lineup", "is_player_lineup", "user_generated",
  ].some((key) => value?.[key] === true || value?.[key] === 1 || value?.[key] === "1"));
}

function itemReferences(hero) {
  return asArray(firstValue(
    hero?.items,
    hero?.item_ids,
    hero?.equip,
    hero?.equips,
    hero?.equipment,
    hero?.equipment_ids,
    hero?.equipment_id,
  )).flatMap((value) => typeof value === "string" ? value.split(/[,|]/u).map((part) => part.trim()).filter(Boolean) : [value]);
}

function roleForHero(hero) {
  if (hero?.is_carry_hero === true || hero?.is_carry_hero === 1 || hero?.is_carry_hero === "1") return "main_carry";
  return asString(firstValue(hero?.role, hero?.hero_role, hero?.position_role, hero?.job, hero?.type));
}

function positionForHero(hero) {
  const raw = firstValue(hero?.position, hero?.location, hero?.pos, hero?.site);
  if (raw && typeof raw === "object") {
    const x = firstValue(raw.x, raw.col, raw.column);
    const y = firstValue(raw.y, raw.row);
    return x !== undefined || y !== undefined ? { x: x ?? null, y: y ?? null } : null;
  }
  return asString(raw);
}

function sourceUnitType(value) {
  if (!value || typeof value !== "object") return "hero";
  return String(firstValue(
    value.chess_type,
    value.unit_type,
    value.entity_type,
    value.object_type,
    value.type,
    "hero",
  )).trim().toLowerCase() || "hero";
}

function hasExplicitSourceUnitType(value) {
  return Boolean(value && typeof value === "object" && [
    "chess_type", "unit_type", "entity_type", "object_type", "type",
  ].some((key) => value[key] !== undefined && value[key] !== null && String(value[key]).trim()));
}

function normalizeAuxiliaryUnit(rawUnit, indexes, {
  unitType = sourceUnitType(rawUnit),
  occupiesPopulation = null,
  catalogResolution = null,
  sourceDeclaredUnitType = null,
  sourceUnitName = null,
} = {}) {
  const reference = referenceParts(rawUnit, "champion");
  const resolvedItems = [];
  const unresolvedItemReferences = [];
  for (const rawItem of itemReferences(rawUnit)) {
    const item = resolveEntity(rawItem, indexes.items, "item");
    if (item) resolvedItems.push(item);
    else unresolvedItemReferences.push(referenceParts(rawItem, "item"));
  }
  return {
    source_unit_id: reference.id,
    source_unit_name: sourceUnitName ?? reference.name,
    unit_type: unitType,
    position: positionForHero(rawUnit),
    items: resolvedItems,
    occupies_population: occupiesPopulation ?? (rawUnit?.occupies_population === true
      || rawUnit?.occupies_population === 1
      || rawUnit?.occupies_population === "1"),
    ...(catalogResolution ? { catalog_resolution: catalogResolution } : {}),
    ...(sourceDeclaredUnitType ? { source_declared_unit_type: sourceDeclaredUnitType } : {}),
    ...(unresolvedItemReferences.length ? { unresolved_item_references: unresolvedItemReferences } : {}),
  };
}

export function buildRankingRecipeAuxiliaryRegistry(recipes = []) {
  const registry = new Map();
  const register = (unit) => {
    const sourceUnitId = asString(unit?.source_unit_id);
    if (!sourceUnitId) return;
    const normalized = {
      source_unit_id: sourceUnitId,
      source_unit_name: asString(unit?.source_unit_name),
      unit_type: asString(unit?.unit_type) || "auxiliary",
      occupies_population: unit?.occupies_population === true,
      catalog_resolution: asString(unit?.catalog_resolution),
      source_declared_unit_type: asString(unit?.source_declared_unit_type),
    };
    const existing = registry.get(sourceUnitId);
    if (!existing) registry.set(sourceUnitId, normalized);
    else if (canonicalJson(existing) !== canonicalJson(normalized)) registry.set(sourceUnitId, null);
  };
  for (const recipe of asArray(recipes)) {
    for (const unit of asArray(recipe?.final_auxiliary_units)) register(unit);
    for (const transition of asArray(recipe?.level_map)) {
      for (const unit of asArray(transition?.auxiliary_units)) register(unit);
    }
  }
  return registry;
}

function auxiliaryRegistryUnit(rawUnit, registry) {
  const reference = referenceParts(rawUnit, "champion");
  return reference.id && registry instanceof Map ? registry.get(reference.id) || null : null;
}

function normalizeRoster(rawRoster, indexes, { auxiliaryRegistry = null } = {}) {
  const roster = [];
  const auxiliaryUnits = [];
  const unresolved = [];
  for (const rawHero of asArray(rawRoster)) {
    const unitType = sourceUnitType(rawHero);
    if (!CHAMPION_UNIT_TYPES.has(unitType)) {
      auxiliaryUnits.push(normalizeAuxiliaryUnit(rawHero, indexes));
      continue;
    }
    const champion = resolveEntity(rawHero, indexes.champions, "champion");
    if (!champion) {
      const registeredAuxiliary = auxiliaryRegistryUnit(rawHero, auxiliaryRegistry);
      if (registeredAuxiliary) {
        auxiliaryUnits.push(normalizeAuxiliaryUnit(rawHero, indexes, {
          unitType: registeredAuxiliary.unit_type,
          occupiesPopulation: registeredAuxiliary.occupies_population,
          catalogResolution: registeredAuxiliary.catalog_resolution,
          sourceDeclaredUnitType: registeredAuxiliary.source_declared_unit_type,
          sourceUnitName: registeredAuxiliary.source_unit_name,
        }));
        continue;
      }
      if (hasExplicitSourceUnitType(rawHero) && CHAMPION_UNIT_TYPES.has(unitType)) {
        auxiliaryUnits.push(normalizeAuxiliaryUnit(rawHero, indexes, {
          unitType: "external_roster_unit",
          occupiesPopulation: true,
          catalogResolution: "unresolved_current_core_catalog",
          sourceDeclaredUnitType: unitType,
        }));
        continue;
      }
      unresolved.push({ kind: "champion", reference: referenceParts(rawHero, "champion") });
      continue;
    }
    const items = [];
    const unresolvedItemReferences = [];
    for (const rawItem of itemReferences(rawHero)) {
      const item = resolveEntity(rawItem, indexes.items, "item");
      if (!item) unresolvedItemReferences.push(referenceParts(rawItem, "item"));
      else items.push(item);
    }
    roster.push({
      champion_id: champion.id,
      champion_name: champion.name,
      role: roleForHero(rawHero),
      position: positionForHero(rawHero),
      items,
      ...(champion.source_mapping ? { source_mapping: champion.source_mapping } : {}),
      ...(champion.source_variant ? { source_variant: champion.source_variant } : {}),
      ...(unresolvedItemReferences.length ? { unresolved_item_references: unresolvedItemReferences } : {}),
    });
  }
  return { roster, auxiliary_units: auxiliaryUnits, unresolved };
}

function normalizeAugments(rawAugments, indexes, { ignoredIds = new Set() } = {}) {
  const augments = [];
  const unresolved = [];
  const ignored = [];
  for (const rawAugment of asArray(rawAugments)) {
    const reference = referenceParts(rawAugment, "augment");
    const augment = resolveEntity(rawAugment, indexes.augments, "augment");
    if (augment) {
      augments.push(augment);
      continue;
    }
    if (reference.id && ignoredIds.has(reference.id)) {
      ignored.push({ kind: "augment", reference, status: "stale_hidden_source_reference" });
      continue;
    }
    unresolved.push({ kind: "augment", reference });
  }
  return { augments, unresolved, ignored };
}

function gameplayText(row) {
  const fields = {
    summary: firstValue(row?.summary, row?.desc, row?.description, row?.lineup_desc, row?.line_feature),
    early_game: firstValue(row?.early_game, row?.early, row?.early_info, row?.early_operate),
    mid_game: firstValue(row?.mid_game, row?.metaphase, row?.middle_info, row?.mid_operate),
    late_game: firstValue(row?.late_game, row?.late, row?.late_info, row?.late_operate),
    operation: firstValue(row?.operation, row?.operational, row?.operate_info, row?.play_method, row?.d_time),
    equipment: firstValue(row?.equipment_text, row?.equipment_info, row?.equip_desc),
    replacement: firstValue(row?.replacement, row?.hero_replace, row?.replace_info),
    positioning: firstValue(row?.location_info, row?.positioning_info),
    matchup: firstValue(row?.enemy_info, row?.matchup_info),
    augment_notes: firstValue(row?.hex_info, row?.augment_info),
  };
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, asString(value)]).filter(([, value]) => value));
}

function normalizeLevelMap(value, indexes, options = {}) {
  const source = value && typeof value === "object" ? value : {};
  const entries = Array.isArray(source) ? source.map((row, index) => [asString(row?.level) || String(index), row]) : Object.entries(source);
  const transitions = [];
  const unresolved = [];
  for (const [level, raw] of entries) {
    const rosterRaw = firstValue(raw?.lineup, raw?.roster, raw?.heroes, raw?.hero_location, raw?.chess, raw);
    const normalized = normalizeRoster(rosterRaw, indexes, options);
    unresolved.push(...normalized.unresolved);
    transitions.push({
      level: asString(level),
      population: Number.isFinite(Number(level)) ? Number(level) : null,
      roster: normalized.roster,
      auxiliary_units: normalized.auxiliary_units,
      text: asString(firstValue(raw?.text, raw?.desc, raw?.description, raw?.operation)),
    });
  }
  return { transitions, unresolved };
}

function recipeId(sourceRole, sourceId, finalRoster, finalAuxiliaryUnits) {
  return sha256(canonicalJson({
    source_role: sourceRole,
    source_id: sourceId,
    final_roster: finalRoster,
    final_auxiliary_units: finalAuxiliaryUnits,
  })).slice(0, 32);
}

function normalizeSourceTraits(values) {
  return asArray(values).map((entry) => ({
    trait_id: asString(entry?.trait_id ?? entry?.id ?? entry),
    breakpoint: Number.isFinite(Number(entry?.hero_num ?? entry?.chess_num ?? entry?.count ?? entry?.breakpoint))
      ? Number(entry?.hero_num ?? entry?.chess_num ?? entry?.count ?? entry?.breakpoint)
      : null,
  })).filter((entry) => entry.trait_id);
}

function normalizeRecipe({ row, detail, indexes, sourceRole, sourceKind, sourceId, finalRosterRaw, augmentRaw, levelMapRaw, lineage, sourceTraits = [], sourceIdentityTraitIds = [], auxiliaryRegistry = null, ignoredAugmentIds = new Set() }) {
  const final = normalizeRoster(finalRosterRaw, indexes, { auxiliaryRegistry });
  if (final.roster.length === 0 || final.unresolved.some((entry) => entry.kind === "champion")) {
    return { recipe: null, reason: "unknown_final_champion", unresolved: final.unresolved };
  }
  const augments = normalizeAugments(augmentRaw, indexes, { ignoredIds: ignoredAugmentIds });
  const levels = normalizeLevelMap(levelMapRaw, indexes, { auxiliaryRegistry });
  const unresolvedReferences = [...augments.unresolved, ...levels.unresolved];
  const combined = { ...row, ...detail };
  const finalRoster = final.roster;
  const finalAuxiliaryUnits = final.auxiliary_units;
  return {
    recipe: {
      schema: "jcc-live-ranking-normalized-recipe-v2",
      recipe_id: recipeId(sourceRole, sourceId, finalRoster, finalAuxiliaryUnits),
      source_role: sourceRole,
      source_kind: sourceKind,
      source_id: sourceId,
      name: asString(firstValue(detail?.name, detail?.line_name, detail?.lineup_name, row?.name, row?.lineup_name, row?.title)),
      source_main_traits: normalizeSourceTraits(sourceTraits),
      source_identity_trait_ids: uniqueStrings(sourceIdentityTraitIds),
      final_roster: finalRoster,
      final_auxiliary_units: finalAuxiliaryUnits,
      roles: Object.fromEntries(finalRoster.filter((hero) => hero.role).map((hero) => [hero.role, hero.champion_id])),
      augments: augments.augments,
      ...(augments.ignored.length ? { ignored_source_references: augments.ignored } : {}),
      ...(unresolvedReferences.length ? { unresolved_catalog_references: unresolvedReferences } : {}),
      gameplay: gameplayText(combined),
      level_map: levels.transitions,
      lineup_code: asString(firstValue(detail?.lineup_code, detail?.lineupCode, detail?.shareCode, detail?.code, row?.lineup_code, row?.lineupCode, row?.code)),
      source_lineage: lineage,
    },
    reason: null,
    unresolved: unresolvedReferences,
  };
}

function popularRows(raw) {
  const rows = firstValue(raw?.lineup_list, raw?.data?.lineup_list, raw?.data?.list, raw?.list);
  return Array.isArray(rows) ? rows : [];
}

function normalizePopular(raw, target, config, catalogs) {
  const indexes = buildCatalogs(catalogs);
  const recipes = [];
  const quarantine = [];
  for (const [index, row] of popularRows(raw).entries()) {
    const sourceId = asString(firstValue(row?.id, row?.lineup_id, row?.lineupId, index));
    const detail = parseDetail(firstValue(row?.detail, row?.lineup_detail, row?.lineupDetail)) ?? null;
    if (!detail) {
      quarantine.push({ source_id: sourceId, reason: "invalid_detail_json" });
      continue;
    }
    if (isPlayerRow(row, detail)) {
      quarantine.push({ source_id: sourceId, reason: "player_or_ugc_lineup" });
      continue;
    }
    const problems = identityProblems(raw, row, target, config);
    if (problems.length) {
      quarantine.push({ source_id: sourceId, reason: "source_identity_mismatch", problems });
      continue;
    }
    const finalRosterRaw = firstValue(
      detail?.hero_location, detail?.final_roster, detail?.lineup, detail?.hero_list, detail?.heroList, detail?.chess_list,
      row?.hero_location, row?.final_roster, row?.lineup, row?.hero_list,
    );
    const result = normalizeRecipe({
      row,
      detail,
      indexes,
      sourceRole: "popular_recipe",
      sourceKind: "official_curated_popular_lineup",
      sourceId,
      finalRosterRaw,
      augmentRaw: firstValue(
        detail?.augments,
        detail?.augment_ids,
        detail?.rune_id_group,
        detail?.runes,
        detail?.hex,
        detail?.hexbuff ? uniqueStrings([detail.hexbuff.recomm, detail.hexbuff.replace]) : undefined,
        row?.augments,
      ),
      levelMapRaw: firstValue(detail?.levelMap, detail?.level_map, row?.levelMap, row?.level_map),
      sourceTraits: firstValue(
        detail?.main_trait_group,
        detail?.main_traits,
        detail?.main_trait_list,
        row?.main_trait_group,
        row?.main_traits,
        row?.main_trait_list,
      ),
      sourceIdentityTraitIds: firstValue(detail?.main_trait_list2, row?.main_trait_list2),
      lineage: {
        upstream_season: asString(config.upstream_season),
        mode: asString(config.mode),
        channel: asString(config.channel),
      },
      ignoredAugmentIds: new Set(asArray(config.known_unresolved_references)
        .filter((entry) => entry?.kind === "augment"
          && asString(entry?.observed_in_recipe_source_id) === sourceId
          && entry?.policy === "exclude_from_recipe_candidates_and_retain_audit_reference")
        .map((entry) => asString(entry?.source_id))
        .filter(Boolean)),
    });
    if (result.recipe) recipes.push(result.recipe);
    else quarantine.push({ source_id: sourceId, reason: result.reason, unresolved: result.unresolved });
  }
  recipes.sort((left, right) => left.recipe_id.localeCompare(right.recipe_id));
  quarantine.sort((left, right) => String(left.source_id).localeCompare(String(right.source_id)) || left.reason.localeCompare(right.reason));
  return { recipes, quarantine };
}

function winningGroups(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.main_traits_data)) return raw.main_traits_data;
  if (Array.isArray(raw?.lineup_group?.main_traits_data)) return raw.lineup_group.main_traits_data;
  if (raw?.info) return [raw];
  return [];
}

export function winningRecipeGroupsFromRaw(rawLineupGroup, catalogs, { auxiliaryRegistry = null } = {}) {
  const indexes = buildCatalogs(catalogs);
  const recipes = [];
  const quarantine = [];
  for (const [groupIndex, group] of winningGroups(rawLineupGroup).entries()) {
    const variants = asArray(group?.info?.list);
    for (const [variantIndex, variant] of variants.entries()) {
      const sourceId = `${asString(group?.id) || groupIndex}:${variantIndex}`;
      const mainCarryId = firstValue(group?.info?.main_c_chess_id, variant?.main_c_chess_id, variant?.main_c_chess);
      const supportIds = asArray(variant?.assist_chess);
      const carryItems = asArray(variant?.main_c_chess_equip);
      const supportItems = asArray(variant?.assist_chess_equip);
      const finalRosterRaw = asArray(variant?.lineup).map((champion) => {
        const championId = asString(champion);
        if (championId === asString(mainCarryId)) return { hero_id: championId, role: "main_carry", items: carryItems };
        const supportIndex = supportIds.map(asString).indexOf(championId);
        return { hero_id: championId, role: supportIndex >= 0 ? "support" : null, items: supportIndex >= 0 ? supportItems : [] };
      });
      const result = normalizeRecipe({
        row: group,
        detail: variant,
        indexes,
        sourceRole: "winning_recipe",
        sourceKind: "tencent_winning_lineup_group",
        sourceId,
        finalRosterRaw,
        augmentRaw: variant?.rune_id_group,
        levelMapRaw: firstValue(variant?.levelMap, variant?.level_map, variant?.excessive_content_data),
        sourceTraits: firstValue(variant?.main_trait_group, group?.main_trait_list),
        sourceIdentityTraitIds: firstValue(group?.main_trait_list2, group?.main_trait_list?.map((entry) => entry?.trait_id)),
        lineage: { lineup_group_id: asString(group?.id), variant_index: variantIndex },
        auxiliaryRegistry,
      });
      if (result.recipe) recipes.push(result.recipe);
      else quarantine.push({ source_id: sourceId, reason: result.reason, unresolved: result.unresolved });
    }
  }
  recipes.sort((left, right) => left.recipe_id.localeCompare(right.recipe_id));
  quarantine.sort((left, right) => left.source_id.localeCompare(right.source_id));
  return { recipes, quarantine };
}

async function publishRecipeGeneration({ rootDir, target, capability, recipes, quarantine, lease }) {
  const publicationRoot = path.resolve(rootDir);
  if (!lease || path.resolve(lease.rootDir || "") !== publicationRoot) {
    throw new Error("recipe publication requires the live-ranking lifecycle lease for the same root");
  }
  await lease.assertOwnership();
  const payload = canonicalize({
    schema: RECIPE_GENERATION_SCHEMA,
    identity: sourceIdentity(target),
    capability,
    recipes,
    quarantine,
  });
  const content = canonicalJson(payload);
  const generationId = sha256(content);
  const generationsDir = path.join(publicationRoot, "recipe-generations");
  const generationDir = path.join(generationsDir, generationId);
  const candidateDir = path.join(publicationRoot, "recipe-candidates");
  const generationFile = path.join(generationDir, "recipes.json");
  await mkdir(generationsDir, { recursive: true });
  await mkdir(candidateDir, { recursive: true });

  const existing = await readFile(generationFile, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing !== null && existing !== content) throw new Error("immutable recipe generation hash collision or content drift");
  if (existing === null) {
    const tempDir = path.join(generationsDir, `.tmp-${generationId}-${randomUUID()}`);
    try {
      await mkdir(tempDir);
      await writeFile(path.join(tempDir, "recipes.json"), content, { encoding: "utf8", flag: "wx" });
      try {
        await rename(tempDir, generationDir);
      } catch (error) {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
        const raced = await readFile(generationFile, "utf8");
        if (raced !== content) throw new Error("concurrent immutable recipe publication disagreed on content");
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const pointer = {
    schema: RECIPE_CANDIDATE_SCHEMA,
    core_profile_id: target.core_profile_id,
    season_id: target.season_id,
    patch_id: target.patch_id,
    generation_id: generationId,
    generation_path: `recipe-generations/${generationId}/recipes.json`,
    source_roles: [...new Set(recipes.map((recipe) => recipe.source_role))].sort(),
    status: capability.status,
  };
  const pointerFile = path.join(candidateDir, `${target.core_profile_id}.json`);
  const tempPointer = path.join(candidateDir, `.${target.core_profile_id}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPointer, canonicalJson(pointer), { encoding: "utf8", flag: "wx" });
    await lease.renew();
    await lease.assertOwnership();
    await rename(tempPointer, pointerFile);
  } finally {
    await rm(tempPointer, { force: true }).catch(() => {});
  }
  return { generation_id: generationId, generation_dir: generationDir, generation_file: generationFile, candidate_pointer_file: pointerFile };
}

export async function publishRankingRecipeCandidate({ target, rootDir, sourceCapabilities, recipes, quarantine, lease }) {
  const normalizedRecipes = asArray(recipes)
    .filter((recipe) => recipe && typeof recipe === "object")
    .sort((left, right) => String(left.recipe_id).localeCompare(String(right.recipe_id)));
  const normalizedQuarantine = asArray(quarantine)
    .filter((row) => row && typeof row === "object")
    .sort((left, right) => String(left.source_role).localeCompare(String(right.source_role))
      || String(left.source_id).localeCompare(String(right.source_id)));
  const freshness = buildRankingRecipeFreshnessProfile({
    rankingStatDate: target?.ranking_stat_date || target?.stat_date,
    sourceCapabilities,
  });
  const capability = {
    schema: RECIPE_CAPABILITY_SCHEMA,
    capability: "current_core_ranking_recipe_candidate",
    status: normalizedRecipes.length ? "available" : "unavailable",
    metrics_authority: false,
    player_lineups_enabled: false,
    accepted_recipe_count: normalizedRecipes.length,
    quarantined_row_count: normalizedQuarantine.length,
    source_capabilities: sourceCapabilities || {},
    freshness,
    identity: sourceIdentity(target),
  };
  const generation = await publishRecipeGeneration({
    rootDir,
    target,
    capability,
    recipes: normalizedRecipes,
    quarantine: normalizedQuarantine,
    lease,
  });
  return { capability, generation, recipes: normalizedRecipes, quarantine: normalizedQuarantine };
}

export async function fetchAndPublishRankingRecipeCandidate({ target, catalogs, rootDir, fetchImpl = globalThis.fetch, lease, now = Date.now() }) {
  const identity = sourceIdentity(target);
  const config = popularConfig(target);
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function");
  const response = await fetchImpl(config.url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response?.ok) throw new Error(`official curated popular lineup fetch failed with HTTP ${String(response?.status)}`);
  if (response.url && response.url !== config.url) throw new Error("official curated popular lineup response URL changed unexpectedly");
  const sourceReceipt = officialSourceReceipt(response, config, now);
  const raw = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
  const normalized = normalizePopular(raw, identity, config, catalogs);
  const capability = {
    schema: RECIPE_CAPABILITY_SCHEMA,
    capability: "official_curated_popular_lineup_recipes",
    status: normalized.recipes.length > 0 ? "available" : "unavailable",
    source_role: "popular_recipe",
    source_kind: "official_curated_popular_lineup",
    configured_url: config.url,
    fetched_url: config.url,
    source_receipt: sourceReceipt,
    source_stat_date: recipeSourceStatDate({ source_receipt: sourceReceipt }),
    source_row_count: popularRows(raw).length,
    metrics_authority: false,
    player_lineups_enabled: false,
    accepted_recipe_count: normalized.recipes.length,
    quarantined_row_count: normalized.quarantine.length,
    identity,
  };
  const generation = await publishRecipeGeneration({
    rootDir,
    target: identity,
    capability,
    recipes: normalized.recipes,
    quarantine: normalized.quarantine,
    lease,
  });
  return { capability, generation, recipes: normalized.recipes, quarantine: normalized.quarantine };
}

export async function pruneRankingRecipeGenerations({
  rootDir,
  protectedCoreProfileIds = [],
  protectedGenerationIds = [],
  keepPrevious = 2,
  lease,
} = {}) {
  const publicationRoot = path.resolve(rootDir || "data/live-rankings/jcc");
  if (!lease || path.resolve(lease.rootDir || "") !== publicationRoot) {
    throw new Error("recipe pruning requires the live-ranking lifecycle lease for the same root");
  }
  if (!Number.isInteger(keepPrevious) || keepPrevious < 0) throw new Error("recipe keepPrevious must be a non-negative integer");
  await lease.assertOwnership();
  const protectedCores = new Set(asArray(protectedCoreProfileIds).map(asString).filter(Boolean));
  for (const coreProfileId of protectedCores) {
    if (!SHA256_PATTERN.test(coreProfileId)) throw new Error(`invalid protected Core Profile id: ${coreProfileId}`);
  }
  const explicitlyProtectedGenerationIds = new Set(asArray(protectedGenerationIds).map(asString).filter(Boolean));
  for (const generationId of explicitlyProtectedGenerationIds) {
    if (!SHA256_PATTERN.test(generationId)) throw new Error(`invalid protected recipe generation id: ${generationId}`);
  }
  const candidatesDir = path.join(publicationRoot, "recipe-candidates");
  const generationsDir = path.join(publicationRoot, "recipe-generations");
  const referencedGenerationIds = new Set(explicitlyProtectedGenerationIds);
  const removedCandidateCoreProfileIds = [];
  const activePointerFile = path.join(publicationRoot, ACTIVE_RECIPE_POINTER_FILE);
  const activePointerInfo = await lstat(activePointerFile).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (activePointerInfo) {
    if (!activePointerInfo.isFile() || activePointerInfo.isSymbolicLink()) {
      throw new Error("active recipe pointer must be a regular file");
    }
    const activePointer = JSON.parse(await readFile(activePointerFile, "utf8"));
    const activeGenerationId = String(activePointer?.generation_id || "");
    if (activePointer?.schema !== ACTIVE_RECIPE_POINTER_SCHEMA
      || !SHA256_PATTERN.test(String(activePointer?.core_profile_id || ""))
      || !SHA256_PATTERN.test(activeGenerationId)
      || activePointer?.generation_path !== `recipe-generations/${activeGenerationId}/recipes.json`) {
      throw new Error("active recipe pointer is invalid");
    }
    const activeGenerationFile = path.join(generationsDir, activeGenerationId, "recipes.json");
    const activeGenerationInfo = await lstat(activeGenerationFile).catch(() => null);
    if (!activeGenerationInfo?.isFile() || activeGenerationInfo.isSymbolicLink()) {
      throw new Error("active recipe pointer references a missing or unsafe generation");
    }
    if (sha256(await readFile(activeGenerationFile, "utf8")) !== activeGenerationId) {
      throw new Error("active recipe generation hash mismatch");
    }
    referencedGenerationIds.add(activeGenerationId);
  }
  const candidateEntries = await readdir(candidatesDir, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  for (const entry of candidateEntries) {
    const candidateFile = path.join(candidatesDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`recipe candidate pointer must not be a symlink: ${entry.name}`);
    if (entry.name.startsWith(".") && entry.isFile()) {
      await rm(candidateFile, { force: true });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const pointer = JSON.parse(await readFile(candidateFile, "utf8"));
    const coreProfileId = String(pointer?.core_profile_id || "");
    const generationId = String(pointer?.generation_id || "");
    if (pointer?.schema !== RECIPE_CANDIDATE_SCHEMA
      || !SHA256_PATTERN.test(coreProfileId)
      || entry.name !== `${coreProfileId}.json`
      || !SHA256_PATTERN.test(generationId)
      || pointer?.generation_path !== `recipe-generations/${generationId}/recipes.json`) {
      throw new Error(`recipe candidate pointer is invalid: ${entry.name}`);
    }
    if (protectedCores.size && !protectedCores.has(coreProfileId)) {
      await lease.assertOwnership();
      await rm(candidateFile, { force: false });
      removedCandidateCoreProfileIds.push(coreProfileId);
      continue;
    }
    const generationFile = path.join(generationsDir, generationId, "recipes.json");
    const generationInfo = await lstat(generationFile).catch(() => null);
    if (!generationInfo?.isFile() || generationInfo.isSymbolicLink()) {
      throw new Error(`recipe candidate points to a missing or unsafe generation: ${entry.name}`);
    }
    if (sha256(await readFile(generationFile, "utf8")) !== generationId) {
      throw new Error(`recipe candidate generation hash mismatch: ${entry.name}`);
    }
    referencedGenerationIds.add(generationId);
  }

  const generationEntries = await readdir(generationsDir, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const generations = [];
  for (const entry of generationEntries) {
    const generationDir = path.join(generationsDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`recipe generation must not be a symlink: ${entry.name}`);
    if (entry.name.startsWith(".tmp-") && entry.isDirectory()) {
      await rm(generationDir, { recursive: true, force: true });
      continue;
    }
    if (!SHA256_PATTERN.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error(`recipe generation must be a directory: ${entry.name}`);
    const recipeFile = path.join(generationDir, "recipes.json");
    const recipeInfo = await lstat(recipeFile);
    if (!recipeInfo.isFile() || recipeInfo.isSymbolicLink()) {
      throw new Error(`recipe generation must contain a regular recipes.json: ${entry.name}`);
    }
    const identity = protectedCores.size
      ? JSON.parse(await readFile(recipeFile, "utf8")).identity
      : null;
    generations.push({ generation_id: entry.name, mtime_ms: (await stat(generationDir)).mtimeMs,
      current_core: !protectedCores.size || protectedCores.has(identity?.core_profile_id) });
  }
  generations.sort((left, right) => right.mtime_ms - left.mtime_ms || right.generation_id.localeCompare(left.generation_id));
  const previousGenerationIds = generations
    .filter((entry) => entry.current_core && !referencedGenerationIds.has(entry.generation_id))
    .slice(0, keepPrevious)
    .map((entry) => entry.generation_id);
  const retainedGenerationIds = new Set([...referencedGenerationIds, ...previousGenerationIds]);
  const deletedGenerationIds = [];
  for (const entry of generations) {
    if (retainedGenerationIds.has(entry.generation_id)) continue;
    await lease.assertOwnership();
    await rm(path.join(generationsDir, entry.generation_id), { recursive: true, force: false });
    deletedGenerationIds.push(entry.generation_id);
  }
  return {
    ok: true,
    referenced_generation_ids: [...referencedGenerationIds].sort(),
    explicitly_protected_generation_ids: [...explicitlyProtectedGenerationIds].sort(),
    previous_generation_ids: previousGenerationIds,
    deleted_generation_ids: deletedGenerationIds,
    retained_generation_ids: generations.map((entry) => entry.generation_id).filter((id) => retainedGenerationIds.has(id)),
    removed_candidate_core_profile_ids: removedCandidateCoreProfileIds.sort(),
  };
}
