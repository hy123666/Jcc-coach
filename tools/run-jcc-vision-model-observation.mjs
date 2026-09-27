import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";

const VISUAL_CONTRACT_REF = "data/runtime/jcc/visual-live-state-contract.json";
const VISION_CONTRACT_REF = "data/runtime/jcc/vision-model-sensing-contract.json";
const DEFAULT_CATALOG = "data/runtime/jcc/mumu-catalog-overlay.json";
const DEFAULT_ICON_MANIFEST = "data/runtime/jcc/visual-icons/manifest.json";

const SELF_MODES = new Set(["augment_choice", "item_choice", "refresh_self_state", "cruise"]);
const VISUAL_NAME_ALIASES = new Map([
  ["荆刺背心", "棘刺背心"],
  ["荆棘背心", "棘刺背心"],
  ["旋风切割机", "旋风切割器"],
  ["青龙刀", "朔极之矛"],
  ["法爆", "珠光护手"],
]);

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-vision-model-observation.mjs --frame <visual-frame.json> --vision-response <vision-json> --mode <mode> [--live-state <state.json>] [--catalog <mumu-catalog-overlay.json>] [--out <visual-observations.json>]",
    "  node tools/run-jcc-vision-model-observation.mjs --frame <visual-frame.json> --mode <mode> --emit-request [--live-state <state.json>] [--out <vision-request.json>]",
    "",
    "Converts a host CLI agent multimodal JSON response into visual_observations.",
    "This tool does not call a model directly; Codex CLI / Claude CLI / Kimi CLI style host agents write the JSON consumed by --vision-response.",
  ].join("\n");
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseArgs(argv) {
  const options = { catalog: DEFAULT_CATALOG, iconManifest: DEFAULT_ICON_MANIFEST };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--frame") options.frame = argv[++index];
    else if (arg === "--vision-response") options.visionResponse = argv[++index];
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--catalog") options.catalog = argv[++index];
    else if (arg === "--icon-manifest") options.iconManifest = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--emit-request") options.emitRequest = true;
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function valuesOf(record) {
  if (!record || typeof record !== "object") return [];
  if (Array.isArray(record)) return record;
  return Object.values(record);
}

function catalogNameKeys(rawName) {
  const original = String(rawName ?? "");
  const aliases = [original];
  const mapped = VISUAL_NAME_ALIASES.get(original);
  if (mapped) aliases.push(mapped);
  return [...new Set(aliases.map(normalize).filter(Boolean))];
}

function buildIndex(catalog) {
  const kinds = {
    champion: valuesOf(catalog.champions_by_id),
    item: valuesOf(catalog.items_by_id),
    augment: valuesOf(catalog.augments_by_id),
    trait: valuesOf(catalog.traits_by_id),
  };
  const byKind = {};
  for (const [kind, entities] of Object.entries(kinds)) {
    const byId = new Map();
    const byName = new Map();
    for (const entity of entities) {
      if (!entity) continue;
      const id = String(entity.id ?? entity.item_id ?? entity.augment_id ?? entity.champion_id ?? "");
      if (id) byId.set(id, entity);
      for (const name of [entity.name, entity.normalized_name, entity.mumu_name, entity.hard_data_name]) {
        const key = normalize(name);
        if (!key) continue;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(entity);
      }
    }
    byKind[kind] = { byId, byName, entities };
  }
  return byKind;
}

function resolveCatalog(index, kind, input) {
  const bucket = index[kind] || { byId: new Map(), byName: new Map(), entities: [] };
  const rawId = input?.id ?? input?.entity_id ?? input?.item_id ?? input?.augment_id ?? input?.champion_id ?? input?.trait_id;
  const rawName = input?.name ?? input?.text ?? input?.candidate_name ?? input?.champion_name ?? input?.item_name ?? input?.augment_name;
  if (rawId != null && rawId !== "") {
    const entity = bucket.byId.get(String(rawId));
    if (entity) {
      return {
        status: "catalog_matched",
        id: String(entity.id ?? rawId),
        name: entity.name ?? rawName ?? String(rawId),
        normalized_name: entity.normalized_name ?? normalize(entity.name ?? rawName),
        kind,
        source: "mumu_catalog_overlay",
      };
    }
  }
  for (const key of catalogNameKeys(rawName)) {
    const exact = bucket.byName.get(key) || [];
    const uniqueExact = [...new Map(exact.map((entity) => [String(entity.id), entity])).values()];
    if (uniqueExact.length === 1) {
      const entity = uniqueExact[0];
      return {
        status: "catalog_matched",
        id: String(entity.id ?? rawId ?? ""),
        name: entity.name ?? rawName,
        normalized_name: entity.normalized_name ?? key,
        kind,
        source: "mumu_catalog_overlay",
      };
    }
    if (uniqueExact.length > 1) {
      return {
        status: "catalog_ambiguous",
        id: null,
        name: rawName,
        normalized_name: key,
        kind,
        possible_ids: uniqueExact.map((entity) => String(entity.id)).filter(Boolean),
        source: "mumu_catalog_overlay",
      };
    }
  }
  const key = normalize(rawName);
  return {
    status: "catalog_unresolved",
    id: rawId != null ? String(rawId) : null,
    name: rawName ?? null,
    normalized_name: key || null,
    kind,
    source: "vision_model",
  };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function confidenceOf(entry, fallback = 0.7) {
  const value = Number(entry?.confidence ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function evidence(frame, mode, extra = {}) {
  return {
    source: "vision_model",
    contract_ref: VISION_CONTRACT_REF,
    frame_id: frame.frame_id || null,
    frame_hash: frame.sha256 || frame.frame_hash || null,
    mode,
    storage_policy: "structured_json_only_no_embedded_image_bytes",
    ...extra,
  };
}

function field(value, status, confidence, frame, mode, extra = {}) {
  return {
    value,
    status,
    source: "vision_model",
    confidence,
    evidence: evidence(frame, mode, extra),
  };
}

function candidate(kind, entry, index, frame, mode, extra = {}) {
  const catalogMatch = resolveCatalog(index, kind, entry || {});
  const confidence = confidenceOf(entry, catalogMatch.status === "catalog_matched" ? 0.82 : 0.55);
  const minConfidence = Number.isFinite(Number(extra.min_confidence)) ? Number(extra.min_confidence) : 0.7;
  const needsConfirmation = entry?.needs_confirmation === true || entry?.needsConfirmation === true;
  const lowConfidence = confidence < minConfidence;
  let status = "visual_model_candidate_unresolved";
  let promotionBlockedReason = catalogMatch.status === "catalog_matched" ? null : "catalog_not_uniquely_matched";
  if (catalogMatch.status === "catalog_matched" && !needsConfirmation && !lowConfidence) {
    status = "visual_candidate";
  } else if (catalogMatch.status === "catalog_matched") {
    status = "visual_low_confidence_candidate";
    promotionBlockedReason = needsConfirmation ? "needs_visual_or_user_confirmation" : "confidence_below_field_threshold";
  }
  return {
    kind,
    text: entry?.text ?? entry?.name ?? catalogMatch.name ?? catalogMatch.id,
    catalog_match: catalogMatch,
    status,
    source: "vision_model",
    confidence,
    min_confidence: minConfidence,
    needs_confirmation: needsConfirmation,
    promotion_blocked_reason: promotionBlockedReason,
    possible_ids: catalogMatch.possible_ids || entry?.possible_ids || null,
    rect: entry?.rect || entry?.bbox || null,
    slot: entry?.slot ?? entry?.index ?? null,
    owner_scope: extra.owner_scope || entry?.owner_scope || null,
    evidence: evidence(frame, mode, {
      source_model: extra.source_model || null,
      note: entry?.note || null,
      unit_ref: extra.unit_ref || null,
    }),
  };
}

function scalarVisualField(entry, frame, mode, defaultConfidence = 0.8) {
  if (entry == null) return undefined;
  if (typeof entry === "object" && !Array.isArray(entry)) {
    const value = entry.value !== undefined
      ? entry.value
      : entry.display !== undefined
        ? entry.display
        : entry.text;
    return field(value, "visual_candidate", confidenceOf(entry, defaultConfidence), frame, mode, {
      source_model: entry.source_model || null,
      note: entry.note || null,
    });
  }
  return field(entry, "visual_candidate", defaultConfidence, frame, mode);
}

function xpVisualField(entry, frame, mode) {
  if (entry == null) return undefined;
  if (typeof entry === "object" && !Array.isArray(entry)) {
    const value = entry.value ?? entry.current ?? null;
    const toNext = entry.to_next ?? entry.toNext ?? entry.max ?? null;
    const display = entry.display ?? (value != null && toNext != null ? `${value}/${toNext}` : undefined);
    return {
      ...field({ value, to_next: toNext, display }, "visual_candidate", confidenceOf(entry, 0.8), frame, mode, {
        source_model: entry.source_model || null,
        note: entry.note || null,
      }),
    };
  }
  return field({ value: null, to_next: null, display: String(entry) }, "visual_candidate", 0.65, frame, mode);
}

function phaseVisualField(entry, frame, mode) {
  if (entry == null) return field(mode, "visual_candidate", 0.8, frame, mode);
  if (typeof entry === "object" && !Array.isArray(entry)) {
    const stageRound = entry.stage_round ?? entry.stageRound ?? entry.current_round ?? entry.currentRound ?? entry.round_key ?? entry.roundKey ?? null;
    const phaseName = entry.phase ?? entry.name ?? entry.value ?? mode;
    return field({
      value: phaseName,
      stage_round: stageRound,
      current_round_text: entry.current_round_text ?? entry.currentRoundText ?? entry.display ?? stageRound ?? null,
      status_code: entry.status_code ?? entry.mumu_status_code ?? null,
    }, "visual_candidate", confidenceOf(entry, 0.8), frame, mode, {
      source_model: entry.source_model || null,
      note: entry.note || null,
    });
  }
  return field({ value: String(entry), stage_round: null, current_round_text: String(entry) }, "visual_candidate", 0.7, frame, mode);
}

function allLiveUnits(liveState) {
  const state = liveState?.live_state || liveState || {};
  const currentView = state.current_view?.filtered_units || state.current_view?.units || state.current_view?.raw_units || [];
  const ownBoard = state.board?.board_units || state.board?.local_board_units_candidate || state.local?.board_units || [];
  const ownBench = state.bench?.bench_units || state.bench?.local_bench_units_candidate || state.local?.bench_units || [];
  return [...asArray(currentView), ...asArray(ownBoard), ...asArray(ownBench)].filter(Boolean);
}

function compactUnit(unit) {
  return {
    hero_id: unit.hero_id ?? unit.champion_id ?? unit.base_hero_id ?? unit.id ?? unit.base_id ?? null,
    raw_hero_id: unit.raw_hero_id ?? unit.raw_id ?? null,
    name: unit.champion_name ?? unit.hero_name ?? unit.name ?? null,
    star_level_hint: unit.star_level_hint ?? null,
    position: unit.position || (unit.x != null && unit.y != null ? { x: unit.x, y: unit.y } : null),
    trait_codes: unit.trait_codes || null,
  };
}

function compactIconManifestHints(iconManifest, iconManifestRef = DEFAULT_ICON_MANIFEST) {
  if (!iconManifest) {
    return {
      manifest_ref: iconManifestRef,
      role: "reference_assets_for_multimodal_agent_not_live_template_matching",
      available: false,
    };
  }
  const templates = valuesOf(iconManifest.templates);
  const byKind = {};
  for (const template of templates) {
    const kind = template?.kind || "unknown";
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  const samples = templates
    .filter((template) => template?.kind && template?.id && template?.local_path)
    .slice(0, 16)
    .map((template) => ({
      kind: template.kind,
      id: String(template.id),
      name: template.name || null,
      local_path: template.local_path,
      icon_url: template.icon_url || null,
    }));
  return {
    manifest_ref: iconManifestRef,
    role: "reference_assets_for_multimodal_agent_not_live_template_matching",
    available: true,
    counts: {
      total: iconManifest.counts?.total ?? templates.length,
      available: iconManifest.counts?.available ?? templates.filter((template) => template?.template_status === "available").length,
      by_kind: byKind,
    },
    samples,
    policy: "Use these icon assets as visual/candidate references when matching visible UI; do not treat local template-match scores as product truth.",
  };
}

function compactCatalogHints(catalog, iconManifest, iconManifestRef = DEFAULT_ICON_MANIFEST, visionReferencePack = null) {
  const counts = catalog.counts || {};
  const sampleNames = (record, limit = 12) => valuesOf(record)
    .map((entity) => ({ id: String(entity.id ?? ""), name: entity.name ?? entity.normalized_name ?? "" }))
    .filter((entity) => entity.id && entity.name)
    .slice(0, limit);
  return {
    catalog_ref: DEFAULT_CATALOG,
    counts,
    candidate_kinds: ["champion", "item", "augment", "trait"],
    samples: {
      items: sampleNames(catalog.items_by_id, 10),
      augments: sampleNames(catalog.augments_by_id, 10),
      champions: sampleNames(catalog.champions_by_id, 10),
      traits: sampleNames(catalog.traits_by_id, 10),
    },
    icon_assets: compactIconManifestHints(iconManifest, iconManifestRef),
    vision_reference_pack: visionReferencePack
      ? {
        schema: visionReferencePack.schema,
        role: visionReferencePack.role,
        not_a_matcher: visionReferencePack.not_a_matcher === true,
        inspection_targets: visionReferencePack.inspection_targets || [],
        live_context: visionReferencePack.live_context || null,
        response_constraints: visionReferencePack.response_constraints || null,
        counts: visionReferencePack.counts || {},
        candidates: visionReferencePack.candidates || {},
        visual_groups: (visionReferencePack.visual_groups || []).slice(0, 40),
        policy: visionReferencePack.policy || null,
      }
      : null,
    matching_policy: "Pair visible UI against catalog candidates. Return ids when exact, possible_ids when ambiguous, unresolved candidates when not found.",
  };
}

function buildVisionRequest({ frame, liveState, catalog, iconManifest, iconManifestRef, visionReferencePack, mode }) {
  const state = liveState?.live_state || liveState || {};
  const units = allLiveUnits(liveState).slice(0, 20).map(compactUnit);
  const inspectionTargets = visionReferencePack?.inspection_targets || [];
  const responseConstraints = visionReferencePack?.response_constraints || {};
  const liveContext = visionReferencePack?.live_context || null;
  const groundingPolicy = asArray(responseConstraints.grounding_policy);
  return {
    ok: true,
    type: "jcc_vision_model_request",
    contract_ref: VISION_CONTRACT_REF,
    mode,
    frame: {
      frame_id: frame.frame_id || null,
      sha256: frame.sha256 || null,
      image_reference: frame.image?.path ? { path: frame.image.path, persisted: frame.image.persisted === true } : null,
      width: frame.image?.width || null,
      height: frame.image?.height || null,
      storage_policy: "do not retain raw frame after structured response unless explicit fixture/debug",
    },
    context: {
      scope: "self_or_visible_choice",
      mumu_status_code: state.phase?.mumu_status_code || state.phase?.status_code || null,
      match_session_id: state.metadata?.match_session_id || liveState?.match_session_id || frame.match_session_id || null,
      mumu_current_view_units: units,
      live_context: liveContext,
      inspection_targets: inspectionTargets,
      response_constraints: responseConstraints,
      confirmed_selected_augments: state.augments?.selected_augments || state.choices?.confirmed_augments || [],
      match_variables: state.match_variables || {},
      target_plan: state.target_plan || null,
      candidate_database: compactCatalogHints(catalog, iconManifest, iconManifestRef, visionReferencePack),
    },
    instructions: [
      "You are the multimodal main runtime agent, not a detached OCR worker.",
      "Only report facts visible in the current frame or constrained by the provided MuMu unit anchors.",
      "Use the candidate database to pair visible icons/text with known champion/item/augment/trait IDs.",
      "Use icon assets and the vision_reference_pack as reference data only; do not rely on a local icon matcher score as truth.",
      "Prefer the mode-specific vision_reference_pack over the full icon manifest when pairing hard visual facts.",
      "Do not invent hidden items, augments, or selections.",
      "Tiny equipped-item icons are high risk. If an item icon is not clearly readable, return needs_confirmation=true, possible_ids, or omit it instead of guessing.",
      "Never use target build plans, expected best-in-slot items, or catalog frequency to infer an equipped item that is not visibly present.",
      "For unit equipment, prefer explicit visible text, a clear large icon, or a very clear small icon. Use confidence below 0.75 when visibility is partial, compressed, overlapped, or ambiguous.",
      "Use catalog names/IDs when known; keep unresolved names as candidates.",
      "Do not output board_units or bench_units; MuMu bridge owns unit identity.",
      mode === "refresh_self_state"
        ? "For self-state refresh, do not read or guess HUD phase/economy numbers. Stage, HP, gold, level, and XP are owned by the RapidOCR HUD fast path; return phase/economy as omitted/null even if they appear visible."
        : "If current stage round or economy HUD is clearly visible, include it; otherwise omit it.",
      inspectionTargets.length
        ? `This request asks for these fields only: ${inspectionTargets.join(", ")}.`
        : "This request asks only for mode-relevant visible fields.",
      liveContext?.current_view_units?.length
        ? "For unit-attached equipment, use context.live_context.current_view_units as the unit list and inspect only the visible equipment row below those units' HP bars."
        : "If no MuMu unit anchors are provided, do not guess unit-attached equipment ownership.",
      "All item, augment, champion, and trait names should come from context.candidate_database.vision_reference_pack.candidates or visible text; if the exact entity is ambiguous, return possible_ids and needs_confirmation=true.",
      ...groundingPolicy.map((line) => `Grounding rule: ${line}`),
      "Write self visual facts as candidates only; final selections require user confirmation.",
      "Opponent board, opponent power, and counter-positioning are not product visual paths; do not create opponent unit or positioning facts.",
      "Return JSON only. Do not include image bytes or base64.",
    ],
    expected_response_shape: {
      source: "host_cli_agent_native",
      model: "string",
      confidence: "0..1",
      observations: {
        phase: {
          value: "optional visible screen phase",
          stage_round: "optional string like 3-6",
          current_round_text: "optional raw visible round text",
          confidence: "0..1",
        },
        economy: {
          hp: "optional number",
          gold: "optional number",
          level: "optional number",
          xp: "optional { value:number, to_next:number, display:string }",
        },
        augment_choices: [{ name: "string", id: "optional", slot: "number", confidence: "0..1" }],
        selected_augments: [{ name: "string", id: "optional", slot: "number", confidence: "0..1", needs_confirmation: "optional boolean" }],
        item_bench: [{ name: "string", id: "optional", slot: "number", confidence: "0..1", needs_confirmation: "optional boolean" }],
        equipped_items: [
          {
            hero_id: "optional number",
            hero_name: "optional string",
            items: [{ name: "string", id: "optional", slot: "0|1|2", confidence: "0..1", needs_confirmation: "optional boolean", possible_ids: "optional array" }],
          },
        ],
        choice_options: [{ kind: "item|champion|augment", name: "string", id: "optional", slot: "number", confidence: "0..1" }],
        trait_text_candidates: [{ text: "string", confidence: "0..1" }],
      },
    },
  };
}

function unitRefFromMatch(match, anchorMatch) {
  return {
    hero_id: match.hero_id ?? match.champion_id ?? match.base_hero_id ?? match.id ?? match.base_id ?? null,
    champion_name: match.champion_name ?? match.hero_name ?? match.name ?? null,
    position: match.position || (match.x != null && match.y != null ? { x: match.x, y: match.y, source: "mumu_4353" } : null),
    source: match.evidence_source || "mumu_4353_current_view",
    anchor_match: anchorMatch,
  };
}

function findUnitRef(entry, liveState) {
  const units = allLiveUnits(liveState);
  const targetId = entry?.hero_id ?? entry?.champion_id ?? entry?.unit_id;
  const targetName = normalize(entry?.hero_name ?? entry?.champion_name ?? entry?.unit_name);
  const targetPosition = entry?.position || entry?.unit_position || null;
  const targetX = Number(targetPosition?.x ?? entry?.x);
  const targetY = Number(targetPosition?.y ?? entry?.y);
  if (Number.isFinite(targetX) && Number.isFinite(targetY)) {
    const positionalMatch = units
      .map((unit) => {
        const unitX = Number(unit.position?.x ?? unit.x);
        const unitY = Number(unit.position?.y ?? unit.y);
        if (!Number.isFinite(unitX) || !Number.isFinite(unitY)) return null;
        return { unit, distance: Math.hypot(unitX - targetX, unitY - targetY) };
      })
      .filter(Boolean)
      .filter(({ distance }) => distance <= 32)
      .sort((left, right) => left.distance - right.distance)[0]?.unit;
    if (positionalMatch) return unitRefFromMatch(positionalMatch, "position");
  }
  const match = units.find((unit) => {
    const ids = [unit.hero_id, unit.champion_id, unit.base_hero_id, unit.id, unit.base_id, unit.raw_hero_id, unit.raw_id].filter((value) => value != null).map(String);
    if (targetId != null && ids.includes(String(targetId))) return true;
    if (targetName && normalize(unit.name ?? unit.hero_name ?? unit.champion_name) === targetName) return true;
    return false;
  });
  if (!match) return null;
  return unitRefFromMatch(match, targetId != null ? "id" : "name");
}

function mapEquipment(entries, index, frame, mode, liveState, ownerScope, sourceModel) {
  const output = [];
  for (const entry of asArray(entries)) {
    const unitRef = findUnitRef(entry, liveState);
    for (const item of asArray(entry.items || entry.item || entry.equipment)) {
      output.push({
        ...candidate("item", item, index, frame, mode, {
          owner_scope: entry.owner_scope || ownerScope,
          unit_ref: unitRef,
          source_model: sourceModel,
          min_confidence: 0.75,
        }),
        unit_ref: unitRef,
        hero_id: entry.hero_id ?? entry.champion_id ?? unitRef?.hero_id ?? null,
        hero_name: entry.hero_name ?? entry.champion_name ?? unitRef?.champion_name ?? null,
        equipment_slot: item.slot ?? item.index ?? null,
        anchor_status: unitRef ? "mumu_unit_anchor_matched" : "needs_mumu_unit_anchor",
      });
    }
  }
  return output;
}

function emptyObservations(frame, mode, response, matchSessionId) {
  return {
    contract_ref: VISUAL_CONTRACT_REF,
    vision_contract_ref: VISION_CONTRACT_REF,
    frame_id: frame.frame_id || null,
    frame_hash: frame.sha256 || frame.frame_hash || null,
    match_session_id: matchSessionId || frame.match_session_id || null,
    phase: field({ value: mode, stage_round: null, current_round_text: null }, "visual_candidate", 0.8, frame, mode),
    economy: {},
    shop: { shop_units: [] },
    board: { board_units: [] },
    bench: { bench_units: [] },
    augments: {
      selection_active: field(mode === "augment_choice", mode === "augment_choice" ? "visual_candidate" : "missing", mode === "augment_choice" ? 0.85 : 0.2, frame, mode),
      choices: [],
      selected_augments: [],
    },
    items: {
      choice_options: [],
      item_bench: [],
      equipped_items: [],
    },
    metadata: {
      source: "vision_model",
      vision_model: {
        source: response.source || "host_cli_agent_native",
        model: response.model || null,
        confidence: confidenceOf(response, 0.75),
        mode,
      },
      storage_policy: "structured_json_only_no_raw_frame_retention",
      image_reference: frame.image?.path ? { path: frame.image.path, persisted: frame.image.persisted === true } : null,
    },
  };
}

function buildObservations({ frame, response, liveState, catalog, mode }) {
  const index = buildIndex(catalog);
  const observationsInput = response.observations || response;
  const matchSessionId =
    observationsInput.match_session_id ||
    response.match_session_id ||
    liveState?.live_state?.metadata?.match_session_id ||
    liveState?.metadata?.match_session_id ||
    liveState?.match_session_id ||
    frame.match_session_id ||
    null;
  const output = emptyObservations(frame, mode, response, matchSessionId);
  const sourceModel = response.model || null;
  const defaultScope = "self";
  if (mode === "refresh_self_state") {
    output.phase = field({ value: mode, stage_round: null, current_round_text: null }, "self_state_roi_ocr_owned", 0, frame, mode);
    output.economy = {};
  } else {
    output.phase = phaseVisualField(observationsInput.phase || observationsInput.screen_phase || observationsInput.current_phase, frame, mode);
    const economy = observationsInput.economy || {};
    output.economy = {
      hp: scalarVisualField(economy.hp ?? economy.health, frame, mode),
      gold: scalarVisualField(economy.gold, frame, mode),
      level: scalarVisualField(economy.level, frame, mode),
      xp: xpVisualField(economy.xp, frame, mode),
    };
  }

  const augmentChoices = asArray(observationsInput.augment_choices || observationsInput.augments?.choices);
  output.augments.choices = augmentChoices.map((entry) => candidate("augment", entry, index, frame, mode, { owner_scope: "visible_choice", source_model: sourceModel }));

  const selectedAugments = asArray(observationsInput.selected_augments || observationsInput.augments?.selected_augments);
  const selectedAugmentCandidates = selectedAugments.map((entry) => candidate("augment", entry, index, frame, mode, { owner_scope: entry.owner_scope || defaultScope, source_model: sourceModel }));
  output.augments.selected_augments = selectedAugmentCandidates;

  const itemBench = asArray(observationsInput.item_bench || observationsInput.items?.item_bench);
  const itemBenchCandidates = itemBench.map((entry) => candidate("item", entry, index, frame, mode, { owner_scope: entry.owner_scope || defaultScope, source_model: sourceModel }));
  output.items.item_bench = itemBenchCandidates;

  const choiceOptions = asArray(observationsInput.choice_options || observationsInput.items?.choice_options);
  output.items.choice_options = choiceOptions.map((entry) => {
    const kind = entry.kind === "champion" ? "champion" : "item";
    return candidate(kind, entry, index, frame, mode, { owner_scope: "visible_choice", source_model: sourceModel });
  });

  const equippedItems = mapEquipment(
    observationsInput.equipped_items || observationsInput.items?.equipped_items,
    index,
    frame,
    mode,
    liveState,
    defaultScope,
    sourceModel,
  );
  output.items.equipped_items = equippedItems;

  return {
    ok: true,
    contract_ref: VISUAL_CONTRACT_REF,
    vision_contract_ref: VISION_CONTRACT_REF,
    visual_observations: output,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.frame) throw new Error(`Missing --frame\n${usage()}`);
  if (!options.mode) throw new Error(`Missing --mode\n${usage()}`);
  if (!SELF_MODES.has(options.mode)) throw new Error(`Unsupported --mode ${options.mode}`);
  const frame = await readJson(options.frame);
  const liveState = options.liveState ? await readJson(options.liveState) : {};
  const catalog = await readJson(options.catalog);
  const iconManifest = await readJsonIfExists(options.iconManifest);
  if (!options.visionResponse) {
    if (!options.emitRequest) {
      throw new Error("Missing --vision-response. Use --emit-request to generate the host CLI agent visual task envelope instead.");
    }
    const tmp = await mkdtemp(path.join(tmpdir(), "jcc-vision-ref-"));
    try {
      const liveStatePath = path.join(tmp, "live-state.json");
      const referencePackPath = path.join(tmp, "vision-reference-pack.json");
      await writeFile(liveStatePath, `${JSON.stringify(liveState, null, 2)}\n`, "utf8");
      const packResult = await runNode([
        "tools/build-jcc-vision-reference-pack.mjs",
        "--mode", options.mode,
        "--live-state", liveStatePath,
        "--icon-manifest", options.iconManifest,
        "--out", referencePackPath,
      ]);
      if (packResult.code !== 0) {
        throw new Error(`vision reference pack failed: ${packResult.stderr || packResult.stdout}`);
      }
      const visionReferencePack = await readJson(referencePackPath);
      const request = buildVisionRequest({
        frame,
        liveState,
        catalog,
        iconManifest,
        iconManifestRef: options.iconManifest,
        visionReferencePack,
        mode: options.mode,
      });
      const text = `${JSON.stringify(request, null, 2)}\n`;
      if (options.out) await writeFile(options.out, text, "utf8");
      else process.stdout.write(text);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    return;
  }
  const response = await readJson(options.visionResponse);
  const output = buildObservations({ frame, response, liveState, catalog, mode: options.mode });
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
