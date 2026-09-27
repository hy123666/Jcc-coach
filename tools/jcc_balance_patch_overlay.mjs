import { isDeepStrictEqual } from 'node:util';

function fail(message) {
  throw new Error(message);
}

function clone(value) {
  return structuredClone(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceStrings(value, replacements) {
  if (typeof value === 'string') {
    const active = replacements
      .filter((replacement) => String(replacement.from) !== String(replacement.to))
      .sort((left, right) => String(right.from).length - String(left.from).length);
    if (!active.length) return value;
    const replacementsBySource = new Map(active.map((replacement) => [String(replacement.from), String(replacement.to)]));
    const pattern = new RegExp(active.map((replacement) => escapeRegExp(replacement.from)).join('|'), 'g');
    return value.replace(pattern, (match) => replacementsBySource.get(match));
  }
  if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceStrings(entry, replacements)]));
  }
  return value;
}

function refreshTypedEffects(value) {
  if (Array.isArray(value)) return value.map(refreshTypedEffects);
  if (!value || typeof value !== 'object') return value;
  if (value.schema === 'jcc-common-typed-effect-v1' && typeof value.source_text === 'string') {
    return {
      ...parseTypedEffectEnvelope(value.source_text),
      exact_effect_blocks: value.exact_effect_blocks || [],
    };
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, refreshTypedEffects(entry)]));
}

function getPath(value, path) {
  return String(path).split('.').reduce((current, key) => current?.[key], value);
}

function setPath(value, path, next) {
  const keys = String(path).split('.');
  const leaf = keys.pop();
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || !(key in current)) fail(`balance patch path does not exist: ${path}`);
    current = current[key];
  }
  if (!current || typeof current !== 'object' || !(leaf in current)) fail(`balance patch path does not exist: ${path}`);
  current[leaf] = clone(next);
}

function mergeFields(target, fields) {
  for (const [key, value] of Object.entries(fields || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      mergeFields(target[key], value);
    } else {
      target[key] = clone(value);
    }
  }
}

function synchronizeProgression(mechanics) {
  const progression = mechanics?.progression;
  if (!progression?.xp_to_next_level) return;
  const levels = Object.keys(progression.xp_to_next_level).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const cumulative = {};
  let total = 0;
  const startingLevel = Number(progression.starting_level || levels[0] || 2);
  cumulative[String(startingLevel)] = 0;
  for (const level of levels) {
    total += Number(progression.xp_to_next_level[String(level)] || 0);
    cumulative[String(level + 1)] = total;
  }
  progression.cumulative_xp_to_level = cumulative;
  if (mechanics.formulas?.level_timing?.tables) {
    mechanics.formulas.level_timing.tables.xp_curve = Object.entries(cumulative)
      .map(([level, totalXp]) => ({ level: Number(level), totalXp }));
  }
}

function synchronizeDerivedCatalogFields(catalogs) {
  const sprites = catalogs?.sprites;
  for (const sprite of sprites || []) {
    if (!Array.isArray(sprite.source_variants) || !sprite.source_variants.length) continue;
    const [baseVariant, upgradeVariant, prismaticVariant] = sprite.source_variants;
    if (baseVariant) {
      if (Object.prototype.hasOwnProperty.call(sprite, 'cost')) sprite.cost = baseVariant.cost;
      if (Object.prototype.hasOwnProperty.call(sprite, 'description')) sprite.description = baseVariant.description;
      if (Object.prototype.hasOwnProperty.call(sprite, 'base_effect')) sprite.base_effect = baseVariant.description;
      if (Object.prototype.hasOwnProperty.call(sprite, 'effects')) sprite.effects = baseVariant.effects;
    }
    if (upgradeVariant && sprite.upgrade) {
      sprite.upgrade.cost = upgradeVariant.cost;
      sprite.upgrade.effect = upgradeVariant.description;
      sprite.upgrade.effects = upgradeVariant.effects;
      if (upgradeVariant.source_proof) sprite.upgrade.source_proof = upgradeVariant.source_proof;
    }
    if (prismaticVariant && sprite.prismatic) {
      sprite.prismatic.cost = prismaticVariant.cost;
      sprite.prismatic.effect = prismaticVariant.description;
      sprite.prismatic.effects = prismaticVariant.effects;
      if (prismaticVariant.source_proof) sprite.prismatic.source_proof = prismaticVariant.source_proof;
    }
  }
  for (const mechanics of catalogs?.mechanics_parameters || []) synchronizeProgression(mechanics);
}

function findEntity(catalogs, operation) {
  const rows = catalogs?.[operation.catalog];
  if (!Array.isArray(rows)) fail(`balance patch catalog is unavailable: ${operation.catalog}`);
  if (operation.singleton === true) {
    if (rows.length !== 1) fail(`balance patch singleton catalog is not unique: ${operation.catalog}`);
    return rows[0];
  }
  const requestedIds = operation.ids || (operation.id == null ? null : [operation.id]);
  const matches = requestedIds
    ? rows.filter((row) => requestedIds.map(String).includes(String(row.id ?? row.official_id ?? row.title_id ?? '')))
    : rows.filter((row) => String(row.name || row.title || row.canonical_name || row.source_key || '') === String(operation.name));
  if (operation.variant_id != null) {
    const parentMatches = matches.filter((row) => Array.isArray(row.source_variants)
      && row.source_variants.some((variant) => String(variant.id ?? '') === String(operation.variant_id)));
    if (parentMatches.length !== 1) {
      fail(`balance patch variant is not unique: ${operation.catalog}/${operation.id || operation.name}/${operation.variant_id}`);
    }
    return parentMatches[0].source_variants.filter((variant) => String(variant.id ?? '') === String(operation.variant_id));
  }
  if (operation.all === true) {
    if (!matches.length) fail(`balance patch entity is absent: ${operation.catalog}/${operation.name || requestedIds.join(',')}`);
    return matches;
  }
  if (matches.length !== 1) fail(`balance patch entity is not unique: ${operation.catalog}/${operation.name || requestedIds?.join(',')}`);
  return matches[0];
}

function assertExpected(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) fail(`balance patch baseline mismatch at ${label}`);
}

function normalizeReward(reward) {
  const title = String(reward?.title || reward?.display_title || '').trim();
  if (!title) fail('balance patch reward requires a title');
  return {
    title,
    display_title: String(reward?.display_title || title),
    count: Number(reward?.count ?? 1),
    type: reward?.type ?? null,
    item_id: reward?.item_id == null ? null : String(reward.item_id),
    champion_id: reward?.champion_id == null ? null : String(reward.champion_id),
    champion_stars: reward?.champion_stars == null ? null : Number(reward.champion_stars),
    icon: reward?.icon ?? null,
  };
}

function rewardSignature(rewards) {
  return (rewards || []).map((reward) => {
    const normalized = normalizeReward(reward);
    return [
      normalized.title,
      normalized.count,
      normalized.type,
      normalized.item_id,
      normalized.champion_id,
      normalized.champion_stars,
    ];
  });
}

function patchRewardGroup(rewardTables, operation, patch) {
  const tables = [
    ...(rewardTables.entity_tables || []),
    ...(rewardTables.season_tables || []),
    ...(rewardTables.supplemental_unbound_tables || []),
  ];
  const matchingTables = tables.filter((table) => String(table.table_id) === String(operation.table_id));
  if (matchingTables.length !== 1) fail(`balance patch reward table is not unique: ${operation.table_id}`);
  const groups = matchingTables[0].groups || [];
  const matchingGroups = groups.filter((group) => String(group.label) === String(operation.group_label));
  if (matchingGroups.length !== 1) {
    fail(`balance patch reward group is not unique: ${operation.table_id}/${operation.group_label}`);
  }
  const group = matchingGroups[0];
  for (const change of operation.changes || []) {
    if (change.kind === 'add_outcome') {
      group.outcomes.push({
        ordinal: Math.max(0, ...group.outcomes.map((outcome) => Number(outcome.ordinal) || 0)) + 1,
        probability_pct: null,
        probability_text: null,
        condition: null,
        reward_text: null,
        display_reward_text: null,
        rewards: (change.rewards || []).map(normalizeReward),
      });
      continue;
    }
    if (change.kind === 'replace_outcome') {
      const expectedSignature = rewardSignature(change.match_rewards);
      const matches = group.outcomes.filter((outcome) => (
        JSON.stringify(rewardSignature(outcome.rewards)) === JSON.stringify(expectedSignature)
      ));
      if (matches.length !== 1) {
        fail(`balance patch reward outcome is not unique: ${operation.table_id}/${operation.group_label}/${JSON.stringify(expectedSignature)}`);
      }
      matches[0].rewards = (change.rewards || []).map(normalizeReward);
      continue;
    }
    if (change.kind === 'append_reward_to_all_outcomes') {
      const reward = normalizeReward(change.reward);
      for (const outcome of group.outcomes) outcome.rewards.push(clone(reward));
      continue;
    }
    fail(`unsupported reward group change: ${change.kind}`);
  }
  if (operation.invalidate_probabilities === true) {
    group.probability_status = operation.probability_status || 'rebalanced_values_not_published';
    for (const outcome of group.outcomes) {
      outcome.probability_pct = null;
      outcome.probability_text = null;
    }
  }
  group.patch_provenance = {
    release_version: patch.release_version,
    source_note_sha256: patch.source_note_sha256 || null,
  };
}

export function applyBalancePatchSet(input, patch) {
  if (patch?.schema !== 'jcc-core-balance-patch-v1') fail('invalid Core balance patch schema');
  const identity = input?.identity || {};
  for (const field of ['season_id', 'patch_id', 'mode_id', 'hard_data_generation_id']) {
    if (patch.baseline?.[field] == null) continue;
    if (String(patch.baseline?.[field] || '') !== String(identity[field] || '')) {
      fail(`balance patch baseline mismatch: ${field}`);
    }
  }
  const catalogs = clone(input);
  const applied = [];
  for (const [index, operation] of (patch.operations || []).entries()) {
    if (operation.kind === 'add_entity') {
      const rows = catalogs?.[operation.catalog];
      if (!Array.isArray(rows)) fail(`balance patch catalog is unavailable: ${operation.catalog}`);
      const entity = clone(operation.entity);
      const entityId = String(entity.id ?? entity.official_id ?? entity.title_id ?? '');
      const entityName = String(entity.name ?? entity.title ?? entity.canonical_name ?? '');
      if (!entityId || !entityName) fail(`balance patch add_entity requires id and name: ${operation.catalog}`);
      if (rows.some((row) => String(row.id ?? row.official_id ?? row.title_id ?? '') === entityId)) {
        fail(`balance patch add_entity id already exists: ${operation.catalog}/${entityId}`);
      }
      rows.push(entity);
      applied.push({ index, catalog: operation.catalog, name: entityName, id: entityId, kind: operation.kind });
      continue;
    }
    const entities = findEntity(catalogs, operation);
    const targets = Array.isArray(entities) ? entities : [entities];
    if (operation.kind === 'patch_reward_group') {
      if (targets.length !== 1) fail('balance patch reward_tables catalog must be a singleton');
      patchRewardGroup(targets[0], operation, patch);
    } else if (operation.kind === 'replace_text') {
      const replacements = operation.replacements || [];
      if (!replacements.length) fail(`balance patch operation ${index} has no replacements`);
      const before = JSON.stringify(targets);
      const next = targets.map((entity) => replaceStrings(entity, replacements));
      for (const replacement of replacements) {
        const from = String(replacement.from);
        const to = String(replacement.to);
        if (from === to) continue;
        if (before.includes(from) && !JSON.stringify(next).includes(to)) fail(`balance patch replacement did not apply: ${operation.name || operation.id}/${from}`);
        if (!before.includes(from) && !before.includes(to)) fail(`balance patch source value is absent: ${operation.name}/${from}`);
      }
      targets.forEach((entity, targetIndex) => Object.assign(entity, next[targetIndex]));
    } else if (operation.kind === 'replace_field') {
      if (targets.length !== 1) fail(`balance patch replace_field requires one target: ${operation.catalog}/${operation.name || operation.id}`);
      const entity = targets[0];
      const actual = getPath(entity, operation.path);
      assertExpected(actual, operation.from, `${operation.catalog}/${operation.name || operation.id}/${operation.path}`);
      setPath(entity, operation.path, operation.to);
      if (operation.sync_base_variant === true) {
        if (operation.variant_id != null || !Array.isArray(entity.source_variants)) {
          fail(`balance patch sync_base_variant requires a composite base entity: ${operation.catalog}/${operation.name || operation.id}`);
        }
        const baseVariant = entity.source_variants.find((variant) => String(variant.id ?? '') === String(entity.id ?? operation.id));
        if (!baseVariant) fail(`balance patch base variant is absent: ${operation.catalog}/${operation.name || operation.id}`);
        const baseValue = getPath(baseVariant, operation.path);
        assertExpected(baseValue, operation.from, `${operation.catalog}/${operation.name || operation.id}/source_variants[base]/${operation.path}`);
        setPath(baseVariant, operation.path, operation.to);
      }
    } else if (operation.kind === 'disable') {
      targets.forEach((entity) => {
        entity.availability_status = 'disabled';
        entity.enabled = false;
        entity.disabled_reason = operation.reason || `disabled_by_${patch.release_version}`;
      });
    } else if (operation.kind === 'enable') {
      targets.forEach((entity) => {
        entity.availability_status = 'enabled';
        entity.enabled = true;
        delete entity.disabled_reason;
      });
    } else if (operation.kind === 'merge_fields') {
      targets.forEach((entity) => mergeFields(entity, operation.fields));
    } else {
      fail(`unsupported balance patch operation: ${operation.kind}`);
    }
    applied.push({
      index,
      catalog: operation.catalog,
      name: operation.name,
      id: operation.id,
      variant_id: operation.variant_id,
      sync_base_variant: operation.sync_base_variant,
      kind: operation.kind,
    });
  }
  synchronizeDerivedCatalogFields(catalogs);
  return {
    catalogs: refreshTypedEffects(catalogs),
    audit: {
      schema: 'jcc-core-balance-patch-audit-v1',
      release_version: patch.release_version,
      baseline: clone(patch.baseline),
      applied_operations: applied.length,
      operations: applied,
    },
  };
}
import { parseTypedEffectEnvelope } from './jcc_typed_effect_parser.mjs';
