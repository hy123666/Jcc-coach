import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/analyze-jcc-bench-coordinate-alignment.mjs --delta <current-match-action-delta.json> --champion-id <id> --reported-visible-index <n> [--out <alignment.json>]",
    "",
    "Purpose:",
    "  Aligns a user-reported visible bench position with the internal action-log bench slot.",
    "  This does not promote board_units/bench_units; it produces source-insight evidence only.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--delta") options.delta = argv[++index];
    else if (arg === "--champion-id") options.championId = String(argv[++index]);
    else if (arg === "--reported-visible-index") options.reportedVisibleIndex = Number(argv[++index]);
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function isBenchSell(action) {
  const position = action.position || action.payload?.position;
  return action.action === "sell_chess" && position?.y === -1;
}

function normalizeAction(action, index) {
  const hero = action.hero || action.payload?.hero || null;
  const position = action.position || action.payload?.position || null;
  return {
    index,
    action: action.action,
    actor_ref: action.actor_ref ?? action.payload?.actor_ref ?? null,
    action_chair_id_candidate: action.action_chair_id_candidate ?? action.payload?.action_chair_id_candidate ?? null,
    entity_id: action.entity_id ?? action.payload?.entity_id ?? null,
    raw_hero_id: action.raw_hero_id ?? action.payload?.raw_hero_id ?? null,
    champion_id: hero?.champion_id ?? null,
    name: hero?.name ?? null,
    position,
    internal_slot_x: position?.x ?? null,
    evidence: action.evidence ?? null,
  };
}

function actorKey(action) {
  return `${action.actor_ref || "actor:null"}|chair:${action.action_chair_id_candidate ?? "null"}`;
}

function buildHistoricalBenchSellOrder(actions) {
  return actions
    .filter((action) => action.position?.y === -1 && Number.isFinite(action.internal_slot_x))
    .sort((left, right) => {
      if (left.internal_slot_x !== right.internal_slot_x) return left.internal_slot_x - right.internal_slot_x;
      return (left.index ?? 0) - (right.index ?? 0);
    })
    .map((action, visibleIndex) => ({
      ...action,
      historical_order_by_internal_x: visibleIndex,
    }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.delta) throw new Error(`Missing --delta\n${usage()}`);
  if (!options.championId) throw new Error(`Missing --champion-id\n${usage()}`);
  if (!Number.isInteger(options.reportedVisibleIndex) || options.reportedVisibleIndex < 0) {
    throw new Error(`Missing or invalid --reported-visible-index\n${usage()}`);
  }

  const delta = await readJson(options.delta);
  const addedActions = Array.isArray(delta.added_actions) ? delta.added_actions : [];
  const benchSells = addedActions.filter(isBenchSell).map(normalizeAction);
  const targetSells = benchSells.filter((action) => String(action.champion_id) === options.championId);
  const primary = targetSells.at(-1) || null;

  const sameActorBenchSells = primary
    ? benchSells.filter((action) => actorKey(action) === actorKey(primary))
    : [];
  const historicalBenchSellOrder = buildHistoricalBenchSellOrder(sameActorBenchSells);
  const primaryVisible = primary
    ? historicalBenchSellOrder.find((action) => action.index === primary.index) || null
    : null;

  const alignment = {
    ok: Boolean(primary),
    current_match_only: delta.current_match_only === true,
    match: delta.match || null,
    target: {
      champion_id: options.championId,
      reported_visible_index: options.reportedVisibleIndex,
    },
    observed_internal_slot: primary ? {
      internal_slot_x: primary.internal_slot_x,
      internal_slot_y: primary.position?.y ?? null,
      actor_ref: primary.actor_ref,
      action_chair_id_candidate: primary.action_chair_id_candidate,
      entity_id: primary.entity_id,
      raw_hero_id: primary.raw_hero_id,
      champion_id: primary.champion_id,
      name: primary.name,
      evidence: primary.evidence,
    } : null,
    calibration: primary ? {
      reported_visible_index: options.reportedVisibleIndex,
      internal_slot_x: primary.internal_slot_x,
      internal_slot_y: primary.position?.y ?? null,
      interpretation: "reported_visible_index_maps_to_internal_absolute_bench_slot",
      confidence: 0.72,
      caveat: "single manual calibration point; collect multiple controlled sells to infer screen-to-internal ordering reliably",
    } : null,
    current_visible_order: {
      status: "unavailable_from_action_delta_only",
      reason: "sell action logs identify the sold unit and internal slot, but do not list all currently occupied bench slots immediately before the sell",
    },
    same_actor_historical_bench_sells_by_internal_x: historicalBenchSellOrder,
    target_historical_order_by_internal_x: primaryVisible?.historical_order_by_internal_x ?? null,
    mismatch: primary ? {
      reported_visible_index_equals_internal_x: options.reportedVisibleIndex === primary.internal_slot_x,
      reported_visible_index_equals_historical_order: options.reportedVisibleIndex === primaryVisible?.historical_order_by_internal_x,
    } : null,
    promotion_decision: {
      status: "not_promoted",
      reason: "coordinate alignment evidence is a manual screen-to-log calibration point, not a complete bench snapshot",
    },
  };

  if (options.out) {
    await writeFile(options.out, `${JSON.stringify(alignment, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(alignment, null, 2));
  if (!alignment.ok) process.exit(2);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
