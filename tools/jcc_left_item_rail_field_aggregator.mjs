import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE = "left_item_rail_roi_icon";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--icon-matches") options.iconMatches = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/jcc_left_item_rail_field_aggregator.mjs --icon-matches <matches.json> [--out <visual-observations.json>]",
    "",
    "Aggregates left item rail icon matches into item_bench_candidates only. MuMu 4357 owns items.item_bench.",
  ].join("\n");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function isPotentialItemMatch(match) {
  return String(match?.field || "").startsWith("items.item_bench.")
    && match.source === SOURCE
    && match.kind === "item"
    && !match.evidence?.presence_status?.reject
    && match.candidates?.[0];
}

function confirmedMatch(match) {
  const score = Number(match.candidates?.[0]?.score || match.confidence || 0);
  return isPotentialItemMatch(match)
    && match.status === "visual_icon_candidate_high_confidence"
    && !match.disambiguation_needed
    && score >= 0.72
    && Number(match.top_gap ?? 0) >= 0.08;
}

function candidateMatch(match) {
  const score = Number(match.candidates?.[0]?.score || match.confidence || 0);
  const slot = Number(match.slot);
  const secondColumn = Number.isFinite(slot) && slot >= 10;
  const hasSecondColumnEvidence = !secondColumn
    || (match.status === "visual_icon_candidate_high_confidence" && score >= 0.72 && Number(match.top_gap ?? 0) >= 0.08);
  return isPotentialItemMatch(match)
    && !confirmedMatch(match)
    && hasSecondColumnEvidence
    && score >= 0.62;
}

function itemFromMatch(match, layer) {
  const top = match.candidates[0];
  const confidence = Number(top.score || match.confidence || 0);
  const uncertain = layer !== "confirmed";
  return {
    slot: Number(match.slot),
    item_id: `item:${top.id}`,
    id: String(top.id),
    name: top.name,
    item_class: top.item_class || null,
    template_sets: top.template_sets || [],
    status: layer === "confirmed" ? "visual_candidate" : "visual_uncertain_candidate",
    semantic_status: layer === "confirmed" ? "left_item_rail_roi_icon_confirmed_candidate" : "left_item_rail_roi_icon_uncertain_candidate",
    evidence_layer: layer,
    confidence,
    source: SOURCE,
    owner_scope: "self",
    catalog_match: {
      kind: "item",
      id: String(top.id),
      name: top.name,
      item_class: top.item_class || null,
      template_sets: top.template_sets || [],
      icon_url: top.icon_url || null,
      confidence,
      match_type: "left_item_rail_icon_template",
    },
    possible_ids: match.possible_ids || [],
    disambiguation_needed: Boolean(match.disambiguation_needed || uncertain),
    promotion_status: layer === "confirmed" ? "validation_candidate_not_promoted_to_item_bench" : "candidate_not_promoted_to_hard_item_bench",
    evidence: {
      field: match.field,
      task_id: match.task_id,
      crop_image: match.evidence?.crop_image || null,
      crop_variant: match.evidence?.crop_variant || null,
      slot: Number(match.slot),
      source_contract: "left item rail ROI crop -> item icon matcher -> field aggregator",
      matcher: {
        status: match.status,
        top_gap: match.top_gap ?? null,
        confidence_reason: match.confidence_reason || null,
        presence_status: match.evidence?.presence_status || null,
      },
    },
  };
}

export function aggregateLeftItemRailMatches(iconMatchesPayload, options = {}) {
  const matches = iconMatchesPayload.matches || [];
  const confirmedCandidates = matches
    .filter(confirmedMatch)
    .map((match) => itemFromMatch(match, "confirmed"))
    .sort((left, right) => left.slot - right.slot);
  const uncertainCandidates = matches
    .filter(candidateMatch)
    .map((match) => itemFromMatch(match, "candidate"))
    .sort((left, right) => left.slot - right.slot);
  const itemBenchCandidates = [...confirmedCandidates, ...uncertainCandidates].sort((left, right) => left.slot - right.slot);
  const observedAt = options.observedAt || new Date().toISOString();
  const rejectedCount = matches.length - itemBenchCandidates.length;
  return {
    schema: "jcc-visual-observations-v1",
    frame_id: iconMatchesPayload.frame || null,
    items: {
      item_bench: [],
      item_bench_candidates: itemBenchCandidates,
      equipped_items: [],
    },
    augments: {},
    choices: {},
    opponents: {},
    phase: {},
    economy: {},
    metadata: {
      source: SOURCE,
      mode: "refresh_self_state",
      observed_at: observedAt,
      created_at: observedAt,
      scope: "items.item_bench_only",
      recognition_layer: "item_icon_matcher",
      accepted_count: 0,
      candidate_count: itemBenchCandidates.length,
      confirmed_candidate_count: confirmedCandidates.length,
      uncertain_candidate_count: uncertainCandidates.length,
      rejected_count: rejectedCount,
    },
    field_status: {
      "items.item_bench_candidates": {
        status: itemBenchCandidates.length ? "candidate" : "missing",
        source: SOURCE,
        source_type: "left_item_rail_icon_matcher",
        confidence: itemBenchCandidates.length ? Math.max(...itemBenchCandidates.map((item) => item.confidence || 0)) : 0,
        count: itemBenchCandidates.length,
        confirmed_candidate_count: confirmedCandidates.length,
        uncertain_candidate_count: uncertainCandidates.length,
        promotion_status: itemBenchCandidates.length ? "validation_or_fallback_candidates_not_item_bench" : "not_promoted",
      },
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.iconMatches) throw new Error("--icon-matches is required");
  const payload = aggregateLeftItemRailMatches(await readJson(options.iconMatches));
  if (options.out) await writeJson(path.resolve(options.out), payload);
  console.log(JSON.stringify(payload, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("jcc_left_item_rail_field_aggregator.mjs")) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
