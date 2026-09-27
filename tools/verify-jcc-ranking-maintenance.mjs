import assert from "node:assert/strict";
import {
  applyRankingMaintenance,
  buildRankingMaintenancePacket,
  createDegradedRankingMaintenance,
  RANKING_MAINTENANCE_PACKET_MAX_BYTES,
  validateRankingMaintenancePacketForStrategy,
  validateRankingMaintenanceResponse,
} from "./jcc_ranking_maintenance.mjs";
import { selectRankingSemanticMaintenanceBaseline } from "../ui/electron/runtime-service.js";

const identity = {
  runtime_season_id: "s18",
  active_patch_id: "s18_1",
  game_mode_id: "mode18",
  core_profile_id: "core-s18-test",
  hard_data_manifest_fingerprint: "hard-data-test",
  catalog_source_fingerprint: "catalog-test",
  battle_type: "31",
  lineup_version_id: "v6",
  ranking_set_id: "18",
};

function candidate(id, { top4 = 0.6, members = ["a", "b"], equipment = ["item-a"] } = {}) {
  return {
    lineup_group_id: id,
    strength_anchor: {
      anchor_id: `national:${id}`,
      metrics: { top4_rate: top4, top1_rate: 0.2, avg_rank: 3.4, use_rate: 0.04, use_num: 500 },
      quality: { current_day_score: 0.7, strength_band: "a" },
    },
    main_carry: { champion_id: members[0] },
    core_unit_ids: members,
    equipment_requirements: { main_carry_item_ids: equipment },
    lifecycle_prior: { target_population: 8 },
    condition_priors: { required_augment_ids: [] },
    variants: [{ variant_id: `${id}:v1`, lineup_ids: members }],
  };
}

const previous = {
  schema: "jcc-live-ranking-strategy-index-v3",
  stat_date: "20260822",
  source_identity: identity,
  tiers: {
    "0": {
      lineup_candidates: [
        candidate("numeric-only", { top4: 0.55 }),
        candidate("semantic-change", { members: ["a", "b"] }),
      ],
    },
  },
};

const current = {
  schema: "jcc-live-ranking-strategy-index-v3",
  stat_date: "20260823",
  source_identity: identity,
  tiers: {
    "0": {
      lineup_candidates: [
        candidate("numeric-only", { top4: 0.68 }),
        candidate("semantic-change", { members: ["a", "c"] }),
        candidate("new-lineup", { members: ["d", "e"] }),
      ],
    },
  },
};

previous.tiers["0"].lineup_candidates[0].semantic_annotation = {
  lineup_id: "numeric-only",
  confidence: "high",
  formation_burden: "low",
  flexibility: "high",
  strategy_style: "flexible_transition",
  condition_flags: [],
  rationale_codes: ["semantic_profile_unchanged"],
};

const packet = buildRankingMaintenancePacket({
  strategyIndex: current,
  previousStrategyIndex: previous,
  commonSummary: {
    principles: ["阵容必须有前排、输出与合法羁绊。", "当前日大师以上数据是强度权威。"],
  },
  coreSummary: {
    core_profile_id: identity.core_profile_id,
    season_id: identity.runtime_season_id,
    patch_id: identity.active_patch_id,
    champion_ids: ["a", "b", "c", "d", "e"],
  },
});

assert.equal(packet.schema, "jcc-ranking-maintenance-packet-v1");
assert.deepEqual(packet.target_identity, identity);
assert.equal(packet.records.length, 2, "only new or semantically changed lineups should use model maintenance");
assert.deepEqual(packet.records.map((entry) => entry.lineup_id), ["new-lineup", "semantic-change"]);
assert.equal(packet.records.some((entry) => entry.lineup_id === "numeric-only"), false,
  "pure current-day metric changes must be handled mechanically with zero model work");
assert.equal(packet.reused_annotations.length, 1,
  "a validated annotation with the same semantic hash must be reused without another model call");
assert.equal(packet.reused_annotations[0].lineup_id, "numeric-only");

const matchingBaseline = structuredClone(current);
for (const existingCandidate of matchingBaseline.tiers["0"].lineup_candidates) {
  existingCandidate.semantic_annotation = {
    lineup_id: existingCandidate.lineup_group_id,
    confidence: "medium",
    formation_burden: "medium",
    flexibility: "medium",
    strategy_style: "standard_leveling",
    condition_flags: [],
    rationale_codes: ["semantic_profile_unchanged"],
  };
}
const largerButStaleBaseline = structuredClone(matchingBaseline);
largerButStaleBaseline.stat_date = "20260824";
largerButStaleBaseline.tiers["0"].lineup_candidates.push(candidate("stale-extra"));
largerButStaleBaseline.tiers["0"].lineup_candidates.at(-1).semantic_annotation = {
  lineup_id: "stale-extra",
  confidence: "medium",
  formation_burden: "medium",
  flexibility: "medium",
  strategy_style: "standard_leveling",
  condition_flags: [],
  rationale_codes: ["semantic_profile_unchanged"],
};
largerButStaleBaseline.tiers["0"].lineup_candidates[0].core_unit_ids = ["stale", "roster"];
const selectedBaseline = selectRankingSemanticMaintenanceBaseline(current, [largerButStaleBaseline, matchingBaseline]);
assert.equal(selectedBaseline, matchingBaseline,
  "baseline selection must maximize reusable semantic hashes instead of choosing an older index with more annotations");
const idempotentPacket = buildRankingMaintenancePacket({
  strategyIndex: current,
  previousStrategyIndex: selectedBaseline,
  commonSummary: {},
  coreSummary: {
    core_profile_id: identity.core_profile_id,
    season_id: identity.runtime_season_id,
    patch_id: identity.active_patch_id,
  },
});
assert.equal(idempotentPacket.records.length, 0,
  "a same-day rerun over unchanged semantic structures must perform zero Host maintenance calls");
assert.equal(idempotentPacket.reused_annotations.length, 3);

const atomicMetricOnlyChange = structuredClone(current);
const atomicMetricOnlyPrevious = structuredClone(current);
for (const existingCandidate of atomicMetricOnlyPrevious.tiers["0"].lineup_candidates) {
  existingCandidate.semantic_annotation = {
    lineup_id: existingCandidate.lineup_group_id,
    confidence: "medium",
    formation_burden: "medium",
    flexibility: "medium",
    strategy_style: "standard_leveling",
    condition_flags: [],
    rationale_codes: ["semantic_profile_unchanged"],
  };
}
atomicMetricOnlyChange.tiers["0"].lineup_candidates[0].variants[0].atomic_roster_statistics = {
  stat_date: "20260823",
  use_num: 999999,
  top4_rate: 0.99,
};
const atomicMetricPacket = buildRankingMaintenancePacket({
  strategyIndex: atomicMetricOnlyChange,
  previousStrategyIndex: atomicMetricOnlyPrevious,
  commonSummary: {},
  coreSummary: {
    core_profile_id: identity.core_profile_id,
    season_id: identity.runtime_season_id,
    patch_id: identity.active_patch_id,
  },
});
assert.equal(atomicMetricPacket.records.length, 0,
  "atomic roster metric changes must remain mechanical and must not trigger semantic maintenance");
assert.match(packet.input_hash, /^[a-f0-9]{64}$/u);
assert.equal(RANKING_MAINTENANCE_PACKET_MAX_BYTES, 4 * 1024 * 1024);
assert(Buffer.byteLength(JSON.stringify(packet)) <= RANKING_MAINTENANCE_PACKET_MAX_BYTES,
  "maintenance packet must remain inside the 4MB aggregate maintenance ceiling");

const response = {
  schema: "jcc-ranking-maintenance-response-v1",
  target_identity: identity,
  input_hash: packet.input_hash,
  annotations: [
    {
      lineup_id: "semantic-change",
      confidence: "high",
      formation_burden: "medium",
      flexibility: "medium",
      strategy_style: "standard_leveling",
      condition_flags: ["item_dependent"],
      rationale_codes: ["core_roster_changed"],
    },
    {
      lineup_id: "new-lineup",
      confidence: "medium",
      formation_burden: "high",
      flexibility: "low",
      strategy_style: "fast_leveling",
      condition_flags: ["high_cost_core"],
      rationale_codes: ["new_current_day_recipe"],
    },
  ],
};

const validated = validateRankingMaintenanceResponse(packet, response);
assert.equal(validated.status, "ready");
assert.equal(validated.annotations.length, 2);
assert.equal(validateRankingMaintenancePacketForStrategy(packet, current), true);

const compiled = applyRankingMaintenance(current, validated, {
  provider: "codex",
  model: "runtime-selected",
  durationMs: 1200,
  reusedAnnotations: packet.reused_annotations,
});
assert.equal(compiled.semantic_maintenance.status, "ready");
assert.equal(compiled.semantic_maintenance.annotation_count, 3);
assert.equal(compiled.semantic_maintenance.reused_annotation_count, 1);
assert.equal(compiled.tiers["0"].lineup_candidates[0].semantic_annotation.strategy_style, "flexible_transition");
assert.equal(compiled.tiers["0"].lineup_candidates[1].semantic_annotation.strategy_style, "standard_leveling");
assert.deepEqual(
  compiled.tiers["0"].lineup_candidates[0].strength_anchor.quality,
  current.tiers["0"].lineup_candidates[0].strength_anchor.quality,
  "maintenance must not change deterministic current-day strength",
);
assert.equal(Object.hasOwn(compiled.semantic_maintenance, "prompt"), false);
assert.equal(Object.hasOwn(compiled.semantic_maintenance, "response"), false);

for (const [name, mutate] of [
  ["identity mismatch", (value) => { value.target_identity.active_patch_id = "s18_2"; }],
  ["stale input hash", (value) => { value.input_hash = "0".repeat(64); }],
  ["unknown lineup", (value) => { value.annotations[0].lineup_id = "unknown"; }],
  ["duplicate lineup", (value) => { value.annotations[1].lineup_id = value.annotations[0].lineup_id; }],
  ["omitted changed lineup", (value) => { value.annotations.pop(); }],
  ["numeric score injection", (value) => { value.annotations[0].score = 0.99; }],
  ["free-form action injection", (value) => { value.annotations[0].action = "强玩这套"; }],
  ["unsupported enum", (value) => { value.annotations[0].formation_burden = "best"; }],
]) {
  const invalid = structuredClone(response);
  mutate(invalid);
  assert.throws(() => validateRankingMaintenanceResponse(packet, invalid), undefined, name);
}

const degraded = createDegradedRankingMaintenance(packet, "host_timeout", "simulated timeout after bounded retries");
const degradedCompiled = applyRankingMaintenance(current, degraded, {
  provider: "codex",
  model: "runtime-selected",
  durationMs: 30000,
  reusedAnnotations: packet.reused_annotations,
});
assert.equal(degradedCompiled.semantic_maintenance.status, "degraded");
assert.equal(degradedCompiled.semantic_maintenance.failure_code, "host_timeout");
assert.equal(degradedCompiled.semantic_maintenance.failure_reason, "simulated timeout after bounded retries");
assert.equal(degradedCompiled.semantic_maintenance.annotation_count, current.tiers["0"].lineup_candidates.length,
  "AI degradation must preserve a complete low-confidence annotation coverage");
assert.deepEqual(
  degradedCompiled.tiers["0"].lineup_candidates.map((entry) => entry.strength_anchor.quality),
  current.tiers["0"].lineup_candidates.map((entry) => entry.strength_anchor.quality),
  "AI degradation must still preserve the complete deterministic current-day ranking result",
);

const degradedPrevious = structuredClone(previous);
delete degradedPrevious.tiers["0"].lineup_candidates[0].semantic_annotation;
const retryPacket = buildRankingMaintenancePacket({
  strategyIndex: current,
  previousStrategyIndex: degradedPrevious,
  commonSummary: { principles: ["测试"] },
  coreSummary: {
    core_profile_id: identity.core_profile_id,
    season_id: identity.runtime_season_id,
    patch_id: identity.active_patch_id,
  },
});
assert.equal(retryPacket.records.find((entry) => entry.lineup_id === "numeric-only")?.change_kind, "annotation_missing_retry",
  "an unchanged lineup without a reusable annotation must retry semantic maintenance after degradation");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-ranking-maintenance-verification-v1",
  changed_record_count: packet.records.length,
  compiled_status: compiled.semantic_maintenance.status,
  degraded_status: degradedCompiled.semantic_maintenance.status,
}, null, 2));
