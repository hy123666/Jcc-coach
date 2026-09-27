import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

const reportArg = process.argv.find((value) => value.startsWith("--report="));
const reportIndex = process.argv.indexOf("--report");
const reportPath = path.resolve(reportArg?.slice(9)
  || (reportIndex >= 0 ? process.argv[reportIndex + 1] : ".omx/runtime-evidence/jcc-confirmed-lineup-card-runtime-projection.json"));
const repoRoot = process.cwd();
const runtimeDataDir = await mkdtemp(path.join(os.tmpdir(), "jcc-confirmed-lineup-runtime-projection-"));
process.env.JCC_RUNTIME_DATA_DIR = runtimeDataDir;
process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";

const store = await import("../ui/electron/runtime-state-store.js");
const fixture = await import("./jcc_test_core_profile_fixture.mjs");
const service = await import("../ui/electron/runtime-service.js");

const bytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
const candidatesOf = (value) => Array.isArray(value) ? value : [];
const candidateIdOf = (value) => value?.candidate_id || value?.lineup_group_id || value?.id || null;
const strategyProfileOf = (value) => value?.strategy_profile || value?.canonical_variant || null;
const variantIdOf = (value) => value?.selected_variant_id
  || value?.query_variant_id
  || value?.canonical_variant?.variant_id
  || value?.strategy_profile?.variants?.[0]?.variant_id
  || null;
const evidenceIdOf = (value) => value?.candidate_evidence_id
  || value?.strategy_profile?.candidate_evidence_id
  || value?.canonical_variant?.candidate_evidence_id
  || null;

const ranking = await service.readLiveRankingsSummary();
assert.equal(ranking.available, true, "Active Ranking must be available");
const selected = service.selectRelevantRankingCandidates(ranking, {
  mode: "lineup_card",
  ranking_recommendation: true,
  ranking_working_set_hint: 10,
  user_message: "给我当前版本上分阵容",
});
assert.ok(selected.candidates?.length >= 2, "production Ranking must provide at least two candidates");
const targetCandidate = selected.candidates[0];
const target = {
  authority: "durable_target_plan",
  persisted: true,
  candidate_id: candidateIdOf(targetCandidate),
  selected_variant_id: variantIdOf(targetCandidate),
  candidate_evidence_id: evidenceIdOf(targetCandidate),
};
assert.ok(target.candidate_id, "the production target must have a candidate identity");

const paths = store.createRuntimePaths(repoRoot);
const seasonVersionSnapshot = fixture.createActiveCoreProfileSnapshot(repoRoot, { runtimePaths: paths });
const initialState = (await service.handleRuntimeAction("getState", {}, {})).state;
const baseRequest = {
  request_id: "confirmed-lineup-runtime-projection",
  request_hash: "confirmed-lineup-runtime-projection",
  request_kind: "lineup_card",
  mode: "lineup_card",
  lineup_card_intent: "final_target",
  pinned_result_required: true,
  provider_readonly_tool_mode: "prefetch_complete",
};

async function buildMeasuredContext(targetPlan) {
  service.setRuntimeServiceState({
    ...initialState,
    match_session: {
      status: "active",
      match_session_id: "confirmed-lineup-runtime-projection-match",
      season_version_snapshot: seasonVersionSnapshot,
    },
    match_context: targetPlan
      ? { target_plan: targetPlan, target_context_authority: "durable_target_plan" }
      : {},
    active_mode: "lineup_card",
    host_cli: { ...(initialState.host_cli || {}), provider: "codex" },
  });
  const request = targetPlan
    ? {
        ...baseRequest,
        lineup_confirmation_requested: true,
        target_plan: targetPlan,
        user_message: "确认这个候选作为最终阵容",
      }
    : {
        ...baseRequest,
        lineup_confirmation_requested: false,
        user_message: "从当前候选中选择并生成阵容卡",
      };
  const context = await service.buildRuntimeHostContext("lineup_card", null, request);
  const fit = context.strategy_fit_packet || {};
  const workingSet = candidatesOf(fit.candidate_working_set);
  const candidate = workingSet[0] || null;
  const canonical = candidate?.canonical_variant || candidate?.strategy_profile?.canonical_variant || null;
  return {
    context_bytes: bytes(context),
    strategy_fit_bytes: bytes(fit),
    selected_candidate_count: candidatesOf(context.selected_ranking_candidates?.candidates).length,
    agent_candidate_count: workingSet.length,
    candidate_id: candidateIdOf(candidate),
    candidate_evidence_id: evidenceIdOf(candidate),
    selected_variant_id: variantIdOf(candidate),
    roster_count: candidatesOf(canonical?.atomic_roster_members).length,
    complete_roster: candidatesOf(canonical?.atomic_roster_members).length > 0,
    strategy_profile_bytes: bytes(strategyProfileOf(candidate)),
  };
}

const open = await buildMeasuredContext(null);
const confirmed = await buildMeasuredContext(target);
assert.equal(confirmed.selected_candidate_count, 1, "confirmed target must select one candidate");
assert.equal(confirmed.agent_candidate_count, 1, "confirmed target must expose one Agent candidate");
assert.equal(confirmed.candidate_id, target.candidate_id, "confirmed target candidate identity must be preserved");
assert.equal(confirmed.complete_roster, true, "confirmed target must retain the canonical roster");
assert.ok(open.selected_candidate_count >= 2, "open lineup must retain a comparison set");
assert.ok(open.agent_candidate_count > confirmed.agent_candidate_count, "confirmed target must narrow the Agent working set");
assert.ok(confirmed.context_bytes < open.context_bytes, "confirmed target Runtime Context must be smaller");
assert.ok(confirmed.strategy_fit_bytes < open.strategy_fit_bytes, "confirmed target strategy fit must be smaller");

const report = {
  schema: "jcc-confirmed-lineup-card-runtime-projection-report-v1",
  generated_at: new Date().toISOString(),
  ranking: {
    stat_date: ranking.stat_date || null,
    source_identity: ranking.source_identity || null,
    retrieval_pool_count: selected.candidates.length,
  },
  target,
  open_exploration: open,
  confirmed_target: confirmed,
  reduction: {
    context_bytes: open.context_bytes - confirmed.context_bytes,
    strategy_fit_bytes: open.strategy_fit_bytes - confirmed.strategy_fit_bytes,
    context_ratio: Number((1 - confirmed.context_bytes / Math.max(1, open.context_bytes)).toFixed(4)),
    strategy_fit_ratio: Number((1 - confirmed.strategy_fit_bytes / Math.max(1, open.strategy_fit_bytes)).toFixed(4)),
  },
  acceptance: {
    confirmed_target_is_single_candidate: confirmed.selected_candidate_count === 1
      && confirmed.agent_candidate_count === 1,
    complete_canonical_roster_retained: confirmed.complete_roster,
    confirmed_source_context_is_smaller: confirmed.context_bytes < open.context_bytes,
    confirmed_strategy_fit_is_smaller: confirmed.strategy_fit_bytes < open.strategy_fit_bytes,
  },
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
