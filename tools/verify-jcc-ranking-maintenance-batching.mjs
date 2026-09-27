import assert from "node:assert/strict";
import {
  buildRankingMaintenanceBatchPackets,
} from "./jcc_ranking_maintenance.mjs";
import { runRankingSemanticMaintenance } from "../ui/electron/runtime-service.js";

const identity = {
  runtime_season_id: "s18",
  active_patch_id: "s18_1",
  game_mode_id: "jcc-mode18",
  core_profile_id: "a".repeat(64),
  hard_data_manifest_fingerprint: "b".repeat(64),
  catalog_source_fingerprint: "c".repeat(64),
  battle_type: "31",
  lineup_version_id: "v6",
  ranking_set_id: "18",
};

const packet = {
  schema: "jcc-ranking-maintenance-packet-v1",
  target_identity: identity,
  stat_date: "20260827",
  authority: { model_role: "bounded_semantic_annotation_only" },
  common_summary: { principles: [] },
  core_summary: {},
  records: ["a", "b"].map((id) => ({
    lineup_id: `lineup-${id}`,
    semantic_hash: `${id}`.repeat(64),
    semantic_structure: "x".repeat(30000),
  })),
  reused_annotations: [],
  input_hash: "full-packet-hash",
};

const batches = buildRankingMaintenanceBatchPackets(packet);
assert.equal(batches.length, 2, "large maintenance input must be split into bounded batches");
assert.deepEqual(
  batches.flatMap((batch) => batch.records.map((record) => record.lineup_id)),
  ["lineup-a", "lineup-b"],
  "batching must preserve every changed lineup exactly once",
);
assert(batches.every((batch) => Buffer.byteLength(JSON.stringify(batch)) <= 48 * 1024));

function responseForPrompt(prompt) {
  const input = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
  return {
    schema: "jcc-ranking-maintenance-response-v1",
    target_identity: input.target_identity,
    input_hash: input.input_hash,
    annotations: input.records.map((record) => ({
      lineup_id: record.lineup_id,
      confidence: "medium",
      formation_burden: "medium",
      flexibility: "medium",
      strategy_style: "standard_leveling",
      condition_flags: [],
      rationale_codes: ["new_current_day_recipe"],
    })),
  };
}

let calls = 0;
const ready = await runRankingSemanticMaintenance(packet, {
  ensureHost: async () => ({ available: true, provider: "codex" }),
  runHost: async (_host, prompt, options) => {
    calls += 1;
    assert.equal(options.hostSessionKey, undefined);
    assert.equal(options.hostSessionId, undefined);
    return { ok: true, response: responseForPrompt(prompt) };
  },
  taskId: "verify-ranking-maintenance-batching",
});
assert.equal(calls, 2);
assert.equal(ready.receipt.status, "ready");
assert.equal(ready.receipt.batch_count, 2);
assert.equal(ready.receipt.annotated_record_count, 2);
assert.deepEqual(
  ready.response_envelope.annotations.map((annotation) => annotation.lineup_id),
  ["lineup-a", "lineup-b"],
);

const splitPacket = {
  ...packet,
  records: ["a", "b"].map((id) => ({
    lineup_id: `lineup-${id}`,
    semantic_hash: `${id}`.repeat(64),
    semantic_structure: "x".repeat(12000),
  })),
};
const splitBatches = buildRankingMaintenanceBatchPackets(splitPacket);
assert.equal(splitBatches.length, 1, "the adaptive split fixture must start as one batch");
let splitCalls = 0;
const splitReady = await runRankingSemanticMaintenance(splitPacket, {
  ensureHost: async () => ({ available: true, provider: "codex" }),
  runHost: async (_host, prompt) => {
    splitCalls += 1;
    const input = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
    const annotations = responseForPrompt(prompt).annotations;
    return {
      ok: true,
      response: {
        ...responseForPrompt(prompt),
        annotations: input.records.length > 1 ? annotations.slice(0, 1) : annotations,
      },
    };
  },
  taskId: "verify-ranking-maintenance-adaptive-split",
});
assert.equal(splitReady.receipt.status, "ready");
assert.equal(splitCalls, 4, "an invalid multi-record response must retry then split into two single-record calls");
assert.equal(splitReady.receipt.annotated_record_count, 2);

let failedCalls = 0;
const degraded = await runRankingSemanticMaintenance(packet, {
  ensureHost: async () => ({ available: true, provider: "codex" }),
  runHost: async (_host, prompt) => {
    failedCalls += 1;
    if (failedCalls >= 2) return { ok: false, error: "simulated transport failure" };
    return { ok: true, response: responseForPrompt(prompt) };
  },
  taskId: "verify-ranking-maintenance-batching-failure",
});
assert.equal(failedCalls, 5,
  "a persistently failed leaf is retried after later independent batches complete without rerunning successful batches");
assert.equal(degraded.receipt.status, "degraded");
assert.equal(degraded.receipt.failure_code, "host_request_failed");
assert.equal(degraded.receipt.failed_batch_index, 2);
assert.equal(degraded.receipt.failed_batch_path, "2");
assert.equal(degraded.receipt.failed_batch_record_count, 1);
assert.equal(degraded.receipt.failed_batch_attempt_count, 4,
  "initial and deferred phases must report the same cumulative attempt budget");
assert.equal(degraded.receipt.deferred_retry_count, 1);
assert.equal(degraded.receipt.failed_batch_count, 1);
assert.equal(degraded.receipt.failure_reason, "simulated transport failure");
assert.equal(degraded.response_envelope.input_hash, packet.input_hash);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-ranking-maintenance-batching-verification-v1",
  batch_count: batches.length,
  changed_record_count: packet.records.length,
  verified: [
    "all_changed_records_preserved_once_across_bounded_batches",
    "all_batches_are_under_48KB",
    "merged_response_revalidates_against_full_input_hash",
    "any_failed_batch_causes_atomic_degraded_result",
    "transient_failed_leaf_is_deferred_until_independent_batches_complete",
    "persistently_failed_leaf_keeps_atomic_publication_degraded",
    "invalid_multi_record_response_retries_then_adaptively_splits",
  ],
}, null, 2));
