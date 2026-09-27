import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import * as service from "../ui/electron/runtime-service.js";

const reportPath = process.argv.includes("--report")
  ? process.argv[process.argv.indexOf("--report") + 1]
  : ".omx/runtime-evidence/jcc-confirmed-lineup-card-size.json";

const bytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
const first = (value) => Array.isArray(value) ? value[0] : null;
const candidateIdOf = (value) => value?.candidate_id || value?.lineup_group_id || value?.id || null;
const canonicalVariantOf = (value) => value?.canonical_variant || value?.strategy_profile?.canonical_variant || null;
const evidenceIdOf = (value) => value?.candidate_evidence_id || canonicalVariantOf(value)?.candidate_evidence_id || null;
const variantIdOf = (value) => value?.selected_variant_id
  || value?.query_variant_id
  || canonicalVariantOf(value)?.variant_id
  || null;

function completeCandidateForTurn(value) {
  const candidate = value || {};
  const canonical = canonicalVariantOf(candidate);
  return {
    ...candidate,
    candidate_id: candidateIdOf(candidate),
    selected_variant_id: variantIdOf(candidate),
    candidate_evidence_id: evidenceIdOf(candidate),
    atomic_roster_id: candidate.atomic_roster_id || canonical?.atomic_roster_id || null,
    roster_is_atomic: candidate.roster_is_atomic ?? canonical?.roster_is_atomic ?? true,
    atomic_roster_members: candidate.atomic_roster_members || canonical?.atomic_roster_members || [],
    canonical_variant: canonical,
  };
}

function targetFor(candidate) {
  return {
    authority: "durable_target_plan",
    persisted: true,
    candidate_id: candidateIdOf(candidate),
    selected_variant_id: variantIdOf(candidate),
    candidate_evidence_id: evidenceIdOf(candidate),
  };
}

function buildRequest({ candidates, target = null, label }) {
  const workingSet = candidates.map(completeCandidateForTurn);
  return {
    request_id: `confirmed-lineup-card-size:${label}`,
    request_hash: `confirmed-lineup-card-size:${label}`,
    request_kind: "lineup_card",
    mode: "lineup_card",
    lineup_card_intent: "final_target",
    lineup_confirmation_requested: Boolean(target),
    pinned_result_required: true,
    user_message: target ? "确认这个候选作为最终阵容" : "从当前候选中选择并生成阵容卡",
    ...(target ? { target_plan: target } : {}),
    runtime_context: {
      schema: "jcc-runtime-host-context-v1",
      active_mode: "lineup_card",
      ...(target ? { match_facts: { target_plan: target } } : {}),
      strategy_fit_packet: {
        schema: "jcc-decision-evidence-packet-v1",
        candidate_working_set: workingSet,
        candidate_working_set_count: workingSet.length,
        candidate_working_set_source_count: workingSet.length,
        requested_display_count: target ? 1 : 3,
      },
    },
  };
}

function measure(request) {
  const summary = service.summarizeHostRequest(request);
  const capsule = service.hostContextCapsuleForRequest(request, {
    routeKey: "probe:confirmed-lineup-card-size",
    provider: "codex",
    staticContextSource: {},
  });
  const delta = service.compactHostTurnDelta(request, capsule);
  const candidates = delta.runtime_context?.strategy_fit_packet?.candidate_working_set || [];
  const candidateIds = candidates.map(candidateIdOf).filter(Boolean);
  const evidenceIds = candidates.map(evidenceIdOf).filter(Boolean);
  const uniqueEvidenceIds = [...new Set(evidenceIds)];
  const candidate = first(candidates);
  const canonical = canonicalVariantOf(candidate);
  const fields = {
    candidate_id: Boolean(candidateIdOf(candidate)),
    selected_variant_id: Boolean(variantIdOf(candidate)),
    candidate_evidence_id: Boolean(evidenceIdOf(candidate)),
    roster: Array.isArray(canonical?.atomic_roster_members) && canonical.atomic_roster_members.length > 0,
    target_population: Number.isInteger(canonical?.population) && canonical.population > 0,
    main_carry: Boolean(canonical?.main_carry?.champion_name),
    main_tank: Boolean(canonical?.primary_tank?.champion_name),
    traits: Array.isArray(canonical?.trait_signature?.traits) && canonical.trait_signature.traits.length > 0,
    metrics: Boolean(canonical?.atomic_roster_observation || canonical?.atomic_roster_statistics),
    equipment: Boolean(canonical?.equipment_priority),
    augment_fit: Array.isArray(canonical?.associated_augment_names),
    transition: Array.isArray(canonical?.transition_chain),
    formation: Boolean(canonical?.positioning_template || canonical?.formation_profile),
  };
  return {
    request_kind: request.request_kind,
    raw_runtime_strategy_packet_bytes: bytes(request.runtime_context.strategy_fit_packet),
    summary_bytes: bytes(summary),
    turn_delta_bytes: bytes(delta),
    strategy_fit_bytes: bytes(delta.runtime_context?.strategy_fit_packet),
    host_candidate_count: candidates.length,
    host_candidate_ids: candidateIds,
    unrelated_sibling_candidate_count: Math.max(0, candidates.length - 1),
    candidate_evidence_occurrences: Object.fromEntries(uniqueEvidenceIds.map((id) => [
      id,
      evidenceIds.filter((value) => value === id).length,
    ])),
    complete_roster_count: canonical?.atomic_roster_members?.length || 0,
    canonical_field_coverage: fields,
    all_required_canonical_fields_present: Object.values(fields).every(Boolean),
    largest_strategy_candidate_bytes: candidates.map((value) => bytes(value)).sort((a, b) => b - a)[0] || 0,
  };
}

const ranking = await service.readLiveRankingsSummary();
assert.equal(ranking.available, true, "Active Ranking must be available");
const selected = service.selectRelevantRankingCandidates(ranking, {
  mode: "lineup_card",
  ranking_recommendation: true,
  ranking_working_set_hint: 10,
  user_message: "给我当前版本上分阵容",
});
assert.ok(selected.candidates?.length >= 2, "production Ranking must provide at least two candidates");
const compactSelected = service.compactSelectedRankingCandidatesForTurn({
  ...selected,
  candidates: selected.candidates.slice(0, 10),
}, { maxCandidates: 10 });
const completeCandidates = compactSelected.candidates.map(completeCandidateForTurn);
assert.ok(completeCandidates[0]?.candidate_id, "the production candidate must have an identity");

const open = measure(buildRequest({ candidates: completeCandidates, label: "open" }));
const confirmed = measure(buildRequest({
  candidates: completeCandidates,
  target: targetFor(completeCandidates[0]),
  label: "confirmed",
}));

assert.equal(confirmed.host_candidate_count, 1, "confirmed target must keep one Host candidate");
assert.equal(confirmed.unrelated_sibling_candidate_count, 0, "confirmed target must drop sibling candidates");
assert.ok(open.host_candidate_count >= 2, "open lineup exploration must retain a bounded comparison set");
assert.equal(confirmed.all_required_canonical_fields_present, true, "confirmed target must retain canonical fields");
assert.ok(confirmed.turn_delta_bytes < open.turn_delta_bytes, "confirmed target delta must be smaller than open exploration");
assert.ok(confirmed.turn_delta_bytes < 100 * 1024, "confirmed target delta should remain a small request");
for (const count of Object.values(confirmed.candidate_evidence_occurrences)) {
  assert.equal(count, 1, "one candidate evidence identity may be materialized only once");
}

const report = {
  schema: "jcc-confirmed-lineup-card-size-report-v1",
  generated_at: new Date().toISOString(),
  ranking: {
    stat_date: ranking.stat_date || null,
    source_identity: ranking.source_identity || null,
    retrieval_pool_count: selected.candidates.length,
  },
  comparison: {
    open_exploration: open,
    confirmed_target: confirmed,
    turn_delta_reduction_bytes: open.turn_delta_bytes - confirmed.turn_delta_bytes,
    turn_delta_reduction_ratio: Number((1 - confirmed.turn_delta_bytes / Math.max(1, open.turn_delta_bytes)).toFixed(4)),
  },
  acceptance: {
    confirmed_target_is_single_candidate: confirmed.host_candidate_count === 1,
    complete_canonical_evidence_retained: confirmed.all_required_canonical_fields_present,
    no_sibling_candidates: confirmed.unrelated_sibling_candidate_count === 0,
    no_duplicate_candidate_evidence_materialization: Object.values(confirmed.candidate_evidence_occurrences).every((count) => count === 1),
    confirmed_delta_is_smaller: confirmed.turn_delta_bytes < open.turn_delta_bytes,
  },
};
await mkdir(reportPath.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
