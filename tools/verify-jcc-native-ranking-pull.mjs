import assert from "node:assert/strict";
import { buildRuntimeHostContext, buildHostTurnDeltaPrompt, createReadonlyBrokerForHostTurn, setRuntimeServiceState, captureMatchSeasonVersionSnapshot, hostCoachNativeOutputSchemaForRequest, normalizeHostCoachResponse, hostRequestWithStrategicObligationEnvelope, resolveHostResponseCandidateReferences } from "../ui/electron/runtime-service.js";
import { knowledgeQueryScope } from "../ui/electron/host-knowledge-turn.js";
import { restoreHostEvidence } from "../ui/electron/host-evidence-materialization.js";
import { KIMI_MCP_MAX_RESULT_BYTES } from "../ui/electron/kimi-readonly-mcp-transport.js";

const testState = {
  active_mode: "daily_chat", match_session: { status: "idle", match_session_id: null },
  daily_session: { status: "active", generation: 991 },
  host_cli: { provider: "codex" }, response_task: { status: "idle" }, match_context: {},
  user_preferences: { rank_tier: "master" },
};
setRuntimeServiceState(testState);
// Content-selection hints must never remove access to the owning snapshot.
for (const inMatch of [false, true]) {
  setRuntimeServiceState({ ...testState, ...(inMatch ? {
    match_session: { status: "active", match_session_id: "short-followup-match",
      season_version_snapshot: captureMatchSeasonVersionSnapshot() },
  } : {}) });
  let previousCandidate;
  for (const [index, user_message] of ["推荐当前上分阵容", "再给我一套", "没过期吧，你再试一下"].entries()) {
    const request = { request_id: `followup:${inMatch}:${index}`, mode: "daily_chat",
      provider_readonly_tool_mode: "native_dynamic_tools", user_message };
    request.runtime_context = await buildRuntimeHostContext(request.mode, null, request);
    assert.equal(request.runtime_context.selected_ranking_candidates, null);
    const broker = createReadonlyBrokerForHostTurn(request, {
      capsule: { capsule_id: "short-followup", fingerprint: "short-followup" }, turn_prompt_bytes: 20000,
    });
    const args = { operation: "search_lineups", search_constraints: "", limit: 1 };
    const page = restoreHostEvidence(await broker.call("jcc.query_knowledge", args)).result;
    assert.ok(page.candidates?.length, `${user_message} must allow native search`);
    assert.ok(!request.runtime_context.knowledge_snapshot.ranking_overlay_id.startsWith("unavailable:"));
    if (index === 1) {
      const expired = structuredClone(request);
      expired.runtime_context.strategy_evidence_snapshot.identity.ranking_overlay_id = "obsolete-ranking";
      const expiredBroker = createReadonlyBrokerForHostTurn(expired, {
        capsule: { capsule_id: "expired-followup", fingerprint: "expired-followup" }, turn_prompt_bytes: 20000,
      });
      await assert.rejects(() => expiredBroker.call("jcc.query_knowledge", args),
        /readonly_tool_ranking_snapshot_expired/, "real snapshot mismatches must still be rejected");
    }
    if (previousCandidate) {
      const exact = restoreHostEvidence(await broker.call("jcc.query_knowledge", {
        operation: "get_lineup", candidate_id: previousCandidate.candidate_id,
        selected_variant_id: previousCandidate.selected_variant_id,
        recover: true, recovery_reason: "lost_evidence",
      }));
      assert.equal(exact.result.status, "ok", "explicit recovery remains available after earlier delivery");
      assert.ok(exact.result.roster.length);
      const variants = restoreHostEvidence(await broker.call("jcc.query_knowledge", {
        operation: "get_lineup_variants", candidate_id: previousCandidate.candidate_id,
        selected_variant_id: previousCandidate.selected_variant_id,
      }));
      assert.equal(variants.result.status, "ok");
    }
    const calculated = restoreHostEvidence(await broker.call("jcc.calculate", {
      operation: "solve_trait_roster_role_coverage", question: "搭上去", population: 9,
      main_carry: "乐芙兰", main_tank: "赫卡里姆",
      target_traits: [{ trait: "永恒之森", count: 7 }], emblems: [{ trait: "永恒之森", count: 1 }],
    }));
    assert.equal(calculated.result.executable, true);
    previousCandidate = page.candidates[0];
  }
}
setRuntimeServiceState(testState);
const report = [];
for (const args of [
  { operation: "search_lineups", question: "当前上分阵容", limit: 5 },
  { operation: "search_lineups", question: "婕拉主C阵容", entity_names: ["婕拉"], role: "main_carry", limit: 5 },
  { operation: "search_lineups", question: "7地狱火阵容", limit: 5 },
]) {
  const request = { request_id: `native:${report.length}`, request_hash: `native:${report.length}`,
    mode: "daily_chat", provider_readonly_tool_mode: "native_dynamic_tools", request_kind: "host_question", user_message: args.question };
  request.runtime_context = await buildRuntimeHostContext(request.mode, null, request);
  assert.equal(request.runtime_context.selected_ranking_candidates, null);
  const capsule = { capsule_id: "native-pull-test", fingerprint: "native-pull-test" };
  const prompt = buildHostTurnDeltaPrompt(request, capsule);
  const bytes = Buffer.byteLength(prompt);
  assert.ok(bytes < 100000, `initial prompt unexpectedly large: ${bytes}`);
  const broker = createReadonlyBrokerForHostTurn(request, { capsule, turn_prompt_bytes: bytes });
  assert.ok(broker);
  if (!report.length) {
    const trendBroker = createReadonlyBrokerForHostTurn(request, { capsule, turn_prompt_bytes: bytes });
    const trend = restoreHostEvidence(await trendBroker.call("query_knowledge", { operation: "get_ranking_trend", limit: 1 }));
    assert.equal(trend.ok, true, "native trends cannot depend on an empty prefetch store");
    assert.ok(trend.result.entities.length);
    assert.ok(trend.result.entities[0].historical_trend,
      "trend retrieval must carry compiled historical evidence, not only current metrics");
    const paging = createReadonlyBrokerForHostTurn(request, { capsule, turn_prompt_bytes: bytes });
    const broadArgs = { operation: "search_lineups", search_constraints: "", question: "婕拉主C只是当前背景，不限制候选", limit: 5 };
    const firstPage = restoreHostEvidence(await paging.call("query_knowledge", broadArgs)).result;
    assert.ok(firstPage.next_cursor);
    const nextPage = restoreHostEvidence(await paging.call("query_knowledge", { ...broadArgs, cursor: firstPage.next_cursor })).result;
    assert.equal(firstPage.total_matching_count, nextPage.total_matching_count);
    assert.ok(nextPage.candidates.every(candidate => !firstPage.candidates.some(prior => prior.candidate_id === candidate.candidate_id)));
    assert.deepEqual(firstPage.candidates.map(c => c.candidate_id),
      restoreHostEvidence(await paging.call("query_knowledge", { ...broadArgs, question: "不同背景" })).result.candidates.map(c => c.candidate_id),
      "explicit empty constraints must keep background text out of retrieval filters");
  }
  const wireResult = await broker.call("query_knowledge", args);
  const result = restoreHostEvidence(wireResult);
  const page = result.result;
  assert.ok(page, JSON.stringify(result));
  if (!report.length) assert.ok(page.candidates?.length, "Active Master+ search must return complete candidates");
  assert.ok(page.candidates?.every((candidate) => !candidate.snapshot_fit),
    "lobby search without Match state must not invent a stage-specific fit score");
  if (!report.length) {
    setRuntimeServiceState({ ...testState, host_cli: { provider: "kimi" } });
    try {
      const kimiRequest = { ...request, request_id: "native:kimi-pages", request_hash: "native:kimi-pages" };
      const kimiBroker = createReadonlyBrokerForHostTurn(kimiRequest, { capsule, turn_prompt_bytes: bytes });
      const collected = [];
      let cursor;
      do {
        const wire = await kimiBroker.call("query_knowledge", { ...args, ...(cursor ? { cursor } : {}) });
        assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= KIMI_MCP_MAX_RESULT_BYTES);
        const restored = restoreHostEvidence(wire);
        assert.equal(restored.ok, true);
        assert.equal(restored.delivery.complete_atomic_candidates, true);
        collected.push(...restored.result.candidates);
        cursor = restored.next_cursor;
      } while (cursor?.startsWith("tool-page:"));
      assert.deepEqual(collected, page.candidates, "Kimi transport pages must preserve every complete Active Ranking candidate");
    } finally {
      setRuntimeServiceState(testState);
    }
  }
  if (!report.length && page.candidates?.length) {
    const lineupId = page.candidates[0].candidate_id;
    const related = restoreHostEvidence(await broker.call("query_knowledge", {
      operation: "get_related_entities",
      entity_names: [lineupId],
      limit: 10,
    }));
    assert.equal(related.ok, true, "broker relation lookup must reach the pinned Core+Ranking relation index");
    assert.ok(related.result.entities.some((entity) => entity.id === lineupId));
    assert.ok(related.result.relations.some((relation) => relation.from?.id === lineupId),
      "broker relation lookup must return Ranking relations for a searched lineup identity");
    const carryId = related.result.relations.find((relation) => relation.relation === "relation.has_main_carry")?.to?.id;
    assert.ok(carryId);
    const carryRelated = restoreHostEvidence(await broker.call("query_knowledge", {
      operation: "get_related_entities", entity_names: [carryId], limit: 100,
    }));
    assert.ok(carryRelated.result.relations.some((relation) => relation.source_domain === "core"),
      "the combined relation route must retain Core relations for a Ranking champion");
    const matchRequest = {
      ...request, request_id: "native:scored-match", request_hash: "native:scored-match", mode: "cruise",
      context: { live_state_summary: {
        phase: { stage_round: "4-2" }, economy: { hp: 60, gold: 30, level: 8 },
        own_board: { units: [] }, own_bench: { units: [] }, shop: { units: [] },
      } },
    };
    matchRequest.runtime_context = await buildRuntimeHostContext(matchRequest.mode, null, matchRequest);
    const matchBroker = createReadonlyBrokerForHostTurn(matchRequest, { capsule, turn_prompt_bytes: bytes });
    const scoredPage = restoreHostEvidence(await matchBroker.call("query_knowledge", args)).result;
    assert.ok(scoredPage.candidates?.length && scoredPage.candidates.every((candidate) => (
      candidate.snapshot_fit?.schema === "jcc-ranking-candidate-snapshot-fit-v1"
      && Number.isFinite(candidate.snapshot_fit.combined_fit_score) && candidate.snapshot_fit.fit_weights
    )), "native search with captured Match facts must include registered fit evidence");
    assert.ok(scoredPage.candidates.every((candidate) => candidate.snapshot_fit.selected_variant_id === candidate.selected_variant_id),
      "fit evidence and the delivered complete roster must refer to the same atomic variant");
    const seen = new Set(scoredPage.candidates.map((candidate) => candidate.candidate_id));
    let cursor = scoredPage.next_cursor;
    for (let index = 0; index < 2 && cursor; index += 1) {
      const following = restoreHostEvidence(await matchBroker.call("query_knowledge", { ...args, cursor })).result;
      assert.ok(following.candidates.length, "scored candidate pagination must not stop at the first working set");
      for (const candidate of following.candidates) {
        assert.ok(!seen.has(candidate.candidate_id), "scored pages must not repeat previously returned candidates");
        seen.add(candidate.candidate_id);
      }
      cursor = following.next_cursor;
    }
    assert.ok(seen.size > 10, "the native retrieval pool must remain accessible beyond ten candidates");
  }
  for (const candidate of page.candidates || []) {
    assert.ok(candidate.candidate_id || candidate.id);
    const exact = await broker.call("query_knowledge", { operation: "get_lineup", candidate_id: candidate.candidate_id || candidate.id,
      selected_variant_id: candidate.selected_variant_id, candidate_evidence_id: candidate.candidate_evidence_id });
    if (exact.delivery?.reused_result) {
      assert.equal(exact.result?.status, undefined, "a reused lookup must not pretend to be a second source query");
      assert.equal(exact.delivery.already_retrieved, true);
      assert.equal(exact.delivery.reuse_reason, "candidate_already_delivered_by_complete_search_projection");
    } else {
      assert.equal(exact.result?.status, "ok", JSON.stringify({ exact, keys: Object.keys(candidate), canonical: candidate.canonical_variant, profileKeys: Object.keys(candidate.strategy_profile || {}) }).slice(0,1800));
      assert.ok(exact.result.roster.length);
    }
    const sibling = candidate.available_variant_refs?.[0];
    if (sibling) {
      const index = restoreHostEvidence(await broker.call("query_knowledge", { operation: "get_lineup_variants",
        candidate_id: candidate.candidate_id, selected_variant_id: candidate.selected_variant_id,
        candidate_evidence_id: candidate.candidate_evidence_id }));
      assert.equal(index.result?.status, "ok");
      assert.ok(index.result.variants.every(v => v.candidate_id === candidate.candidate_id));
      assert.ok(index.result.variants.every(v => Number.isInteger(v.roster_unit_count) && v.roster_unit_count > 0));
      assert.ok(index.result.variants.every(v => Number.isInteger(v.occupied_population) && v.occupied_population > 0));
      assert.ok(index.result.variants.every(v => Number.isInteger(v.effective_team_size) && v.effective_team_size > 0));
      assert.ok(index.result.variants.some(v => v.selected_variant_id === sibling.selected_variant_id));
      const siblingResult = await broker.call("query_knowledge", { operation: "get_lineup",
        candidate_id: sibling.candidate_id, selected_variant_id: sibling.selected_variant_id,
        ...(sibling.candidate_evidence_id ? { candidate_evidence_id: sibling.candidate_evidence_id } : {}) });
      assert.equal(siblingResult.result?.status, "ok", "indexed alternative remains explicitly retrievable");
      assert.equal(siblingResult.result.selected_variant_id, sibling.selected_variant_id);
    }
    const recoveredRequest = { ...request, request_id: `${request.request_id}:recovered` };
    const recoveryBroker = createReadonlyBrokerForHostTurn(recoveredRequest, { capsule, turn_prompt_bytes: bytes });
    const recovered = await recoveryBroker.call("query_knowledge", { operation: "get_lineup", candidate_id: candidate.candidate_id || candidate.id,
      selected_variant_id: candidate.selected_variant_id, candidate_evidence_id: candidate.candidate_evidence_id });
    assert.equal(recovered.result?.status, "ok", "exact lookup must work without a request-local candidate pool");
    const wrong = await recoveryBroker.call("query_knowledge", { operation: "get_lineup", candidate_id: candidate.candidate_id || candidate.id,
      selected_variant_id: "foreign-variant" });
    assert.notEqual(wrong.result?.status, "ok", "wrong explicit variant must never fall back to a different roster");
    const unresolved = await recoveryBroker.call("query_knowledge", { operation: "get_lineup_variants", question: "Any alternative?" });
    assert.equal(unresolved.result?.status, "query_required", "unresolved conversational identity cannot choose a lineup");
    const wrongIndex = await recoveryBroker.call("query_knowledge", { operation: "get_lineup_variants",
      candidate_id: candidate.candidate_id || candidate.id, selected_variant_id: "foreign-variant" });
    assert.notEqual(wrongIndex.result?.status, "ok", "variant index must validate explicit baseline identity");
    break;
  }
  assert.ok(knowledgeQueryScope(request).rankingQueried);
  assert.equal(buildHostTurnDeltaPrompt(request, capsule), prompt, "tool results must not re-enter prompt");
  if (!report.length) {
    const expansion = await broker.call("query_knowledge", { operation: "expand_ranking_candidates", candidate_working_set_hint: 10 });
    const priorIds = new Set(page.candidates.map(c => c.candidate_id));
    assert.ok(expansion.result.selected_ranking_candidates.candidates.every(c => !priorIds.has(c.candidate_id)), "expansion must not replay delivered candidate IDs");
    const { shareKnowledgeQueryScope } = await import("../ui/electron/host-knowledge-turn.js");
    const strategic = hostRequestWithStrategicObligationEnvelope({ ...request, mode: "cruise" }, {
      queue_revision: 1, completion_receipts: [{ block_id: "lineup_direction", revision: 1, latest_checkpoint_id: "direction_exploration" }],
      checkpoint_contracts: [{ checkpoint_id: "direction_exploration" }],
      required_decisions: [], complete_candidate_rosters_required: true,
    });
    shareKnowledgeQueryScope(request, strategic);
    const refs = page.candidates.slice(0, 3).map(({ candidate_id, selected_variant_id, candidate_evidence_id }) => ({ candidate_id, selected_variant_id, candidate_evidence_id }));
    const rememberedRequest = { ...request };
    await resolveHostResponseCandidateReferences(rememberedRequest, { strategy_selection: { selected_candidate_refs: refs } });
    assert.equal(knowledgeQueryScope(rememberedRequest).candidates.size, 3, "remembered identities resolve locally without replay");
    assert.equal(buildHostTurnDeltaPrompt(rememberedRequest, capsule), prompt);
    const normalized = normalizeHostCoachResponse({
      schema: "jcc-host-cli-coach-response-v1", generated_by: "current_cli_agent_main_model",
      request_id: request.request_id, request_hash: request.request_hash, mode: "cruise",
      final_text: "按这三套候选结合来牌选择主线，保留转向空间。",
      strategy_selection: { status: "selected", selected_candidate_ids: refs.map(r => r.candidate_id), selected_candidate_refs: refs },
      strategic_completion: { decision_outputs: {} },
    }, strategic);
    assert.equal(normalized.strategy_selection.selected_candidate_ids.length, 3);
  }
  report.push({ question: args.question, prompt_bytes: bytes, tool_bytes: Buffer.byteLength(JSON.stringify(wireResult)),
    candidates: page.candidates?.length || 0, query_status: page.query_status, next_page: Boolean(result.next_cursor),
    identities: page.candidates?.map((c) => ({ id: c.candidate_id, variant: c.selected_variant_id, evidence: c.candidate_evidence_id, profile_evidence: c.strategy_profile?.candidate_evidence_id })) });
}
console.log(JSON.stringify({ ok: true, report }, null, 2));

if (process.argv.includes("--live")) {
  const { detectHostAgent, runHostAgentRequest, closeHostAgentSession } = await import("../ui/electron/host-adapters.js");
  const { createStrategicObligationQueueState, enqueueStrategicObligation, strategicObligationDeliveryEnvelope } = await import("../ui/electron/cruise-strategic-obligation-queue.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const detected = await detectHostAgent({ provider: "codex", model: "gpt-5.5", reasoning_effort: "low" });
  assert.ok(detected.available, detected.error);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "jcc-native-pull-live-"));
  const key = `native-pull-live:${Date.now()}`;
  const productionSession = process.argv.includes("--production-session");
  const service = await import("../ui/electron/runtime-service.js");
  if (productionSession) {
    service.configureRuntimeServicePaths({ dataRoot: cwd });
    const snapshot = { ...service.captureMatchSeasonVersionSnapshot(), wiki_snapshot: service.captureMatchWikiSnapshot() };
    setRuntimeServiceState({ active_mode: "cruise", host_cli: { provider: "codex" }, response_task: { status: "idle" },
      match_session: { status: "active", match_session_id: key, season_version_snapshot: snapshot },
      match_context: { match_session_id: key, choice_confirmations: [{ stage_round: "2-1", kind: "augment", name: "大买特买" }] },
      user_preferences: { rank_tier: "master" }, runtime_events: { latest: [] } });
  }
  let sessionId;
  try {
    const questions = ["当前2-2，已确认大买特买，95生命16金币3级。请提供3个完整Master+候选方向并解释取舍。", "结合当前阶段，查询与这局决策有关的大数据。具体想查：有什么强力一点的法系8认可阵容"];
    for (const [index, question] of (productionSession ? Array(3).fill(questions[0]) : questions).entries()) {
      if (index && process.argv.includes("--only-exploration")) break;
      const preparationStart = performance.now();
      let request = { request_id: `${key}:${index}`, request_hash: `${key}:${index}`, mode: "cruise",
        provider_readonly_tool_mode: "native_dynamic_tools", request_kind: "host_question", user_message: question };
      request.runtime_context = await buildRuntimeHostContext("cruise", null, request);
      if (index === 0 || productionSession) {
        const queue = enqueueStrategicObligation(createStrategicObligationQueueState(), {
          stage_round: "2-2", fixed_checkpoint_stage_round: "2-2", fixed_checkpoint_id: "direction_exploration",
          decision_trigger_id: "lineup_convergence_checkpoint", event_key: `${key}:checkpoint`,
        });
        request = hostRequestWithStrategicObligationEnvelope(request, strategicObligationDeliveryEnvelope(queue));
      }
      const capsule = productionSession ? service.hostContextCapsuleForRequest(request, { routeKey: `match:${key}`, provider: "codex" }) : { capsule_id: key, fingerprint: key };
      const deltaPrompt = buildHostTurnDeltaPrompt(request, capsule);
      const prompt = productionSession && index === 0 ? service.buildHostSessionBootstrapPrompt(request, capsule, { turnPrompt: deltaPrompt }) : deltaPrompt;
      const broker = createReadonlyBrokerForHostTurn(request, { capsule, turn_prompt_bytes: Buffer.byteLength(prompt) });
      const start = Date.now();
      const timing = { model: "gpt-5.5", reasoning_effort: "low", question,
        session_condition: productionSession ? (index === 0 ? "production_bootstrap_fixture" : "production_warm_fixture") : "delta_only_fixture",
        provider_version: detected.version, capsule_bytes: Buffer.byteLength(JSON.stringify(capsule)),
        knowledge_snapshot: request.runtime_context.knowledge_snapshot,
        evidence_snapshot_id: broker.evidence_snapshot_id,
        preparation_ms: performance.now() - preparationStart, calls: [], prompt_bytes: Buffer.byteLength(prompt) };
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(".omx/runtime-evidence", { recursive: true });
      const persistTiming = async () => {
        timing.elapsed_ms = Date.now() - start;
        timing.tool_bytes = timing.calls.reduce((n, call) => n + call.bytes, 0);
        const suffix = process.env.JCC_PERF_RUN_ID || "";
        assert.match(suffix, /^[a-zA-Z0-9_-]*$/);
        await writeFile(`.omx/runtime-evidence/native-ranking-pull-timing-${index}${suffix ? `-${suffix}` : ""}.json`, JSON.stringify(timing, null, 2));
      };
      const measureTool = async (name, args, phase = "answer") => {
        const toolStart = performance.now();
        try {
          const value = await broker.call(name, args);
          timing.calls.push({ phase, tool: name, operation: args.operation || name, args, at_ms: Date.now() - start,
            local_ms: performance.now() - toolStart, bytes: Buffer.byteLength(JSON.stringify(value)),
            cache_hit: broker.audit.at(-1)?.cache_hit,
            returned: value.delivery?.returned_count, repeated: value.delivery?.previously_delivered_count });
          await persistTiming();
          console.log(JSON.stringify({ live_tool: index, operation: args.operation, bytes: Buffer.byteLength(JSON.stringify(value)), candidates: knowledgeQueryScope(request).candidates.size }));
          return value;
        } catch (error) {
          timing.calls.push({ phase, operation: args.operation, args, local_ms: performance.now() - toolStart, bytes: 0, error: error.message });
          await persistTiming();
          throw error;
        }
      };
      console.log(JSON.stringify({ live_start: index, prompt_bytes: Buffer.byteLength(prompt) }));
      const result = await runHostAgentRequest(detected, prompt, {
        parseJson: true, jsonResponseKind: "coach", outputSchema: hostCoachNativeOutputSchemaForRequest(request),
        repoRoot: path.resolve(import.meta.dirname, ".."), hostCwd: cwd, hostSessionKey: key,
        hostSessionId: sessionId, taskId: request.request_id, timeoutMs: 180000,
        onProviderTurnDispatched: () => { timing.dispatched_ms = Date.now() - start; },
        onProviderTurnStarted: () => { timing.accepted_ms = Date.now() - start; },
        onProviderFirstToken: () => { timing.first_token_ms ??= Date.now() - start; },
        onReadonlyToolCall: measureTool,
      });
      timing.provider_finished_ms = Date.now() - start;
      timing.provider_ok = result.ok;
      timing.error = result.error || null;
      await persistTiming();
      assert.ok(result.ok, result.error);
      sessionId = result.session_id || result.thread_id;
      let response;
      timing.provider_finished_ms = Date.now() - start;
      const validationStart = performance.now();
      let corrected = false;
      try {
        if (productionSession) await resolveHostResponseCandidateReferences(request, result.response);
        response = normalizeHostCoachResponse(result.response, request);
      }
      catch (error) {
        console.log(JSON.stringify({ failed_response_refs: result.response?.strategy_selection?.selected_candidate_refs,
          first_validation_error: error.message,
          available_refs: [...knowledgeQueryScope(request).candidates.values()].map(c => ({ id: c.candidate_id, variant: c.selected_variant_id, evidence: c.candidate_evidence_id })) }));
        response = normalizeHostCoachResponse(result.response, request);
        corrected = false;
      }
      if (index === 0 || productionSession) assert.ok(response.strategy_selection?.selected_candidate_ids?.length >= 3, "2-2 must deliver actual candidates");
      timing.validation_ms = performance.now() - validationStart;
      timing.elapsed_ms = Date.now() - start;
      timing.corrected = corrected;
      timing.selected_count = response.strategy_selection?.selected_candidate_ids?.length || 0;
      timing.tool_bytes = timing.calls.reduce((n,call) => n+call.bytes,0);
      await persistTiming();
      console.log(JSON.stringify({ timing }));
      assert.doesNotMatch(response.final_text, /candidate_archetype_and_lifecycle/);
      console.log(JSON.stringify({ live_pass: index, corrected, elapsed_ms: Date.now() - start, selected: response.strategy_selection?.selected_candidate_ids, text: response.final_text }));
    }
  } finally {
    await closeHostAgentSession(key).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}
