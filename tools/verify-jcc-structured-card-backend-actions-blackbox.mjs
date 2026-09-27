import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureRuntimeServicePaths,
  detectRuntimeSemanticEvents,
  getRuntimeServiceState,
  handleRuntimeAction,
  mergeUserConfirmedEquipmentSections,
  setRuntimeServiceCanonicalStateWriter,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { resolveEquipmentFactLayers } from "../ui/electron/runtime-equipment-context.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-structured-card-backend-"));
const runtimePaths = createRuntimePaths(path.resolve(import.meta.dirname, ".."));
const activeCatalogSource = JSON.parse(await readFile(runtimePaths.activeDecisionInputCatalogFile, "utf8"));
const goldAugments = activeCatalogSource.entities.filter((entity) => entity.kind === "augment" && entity.tier_color === "gold");
const silverAugments = activeCatalogSource.entities.filter((entity) => entity.kind === "augment" && entity.tier_color === "silver");
const prismaticAugments = activeCatalogSource.entities.filter((entity) => entity.kind === "augment" && entity.tier_color === "prismatic");
assert(goldAugments.length >= 4 && silverAugments.length >= 3 && prismaticAugments.length >= 3);
const unknownGoldAugment = goldAugments.find((entity) => entity.stage_unknown === true);
assert(unknownGoldAugment, "fixture requires one official augment without supplemental stage authority");
const stageRows = new Map([
  ...goldAugments.slice(0, 3).map((entity) => [entity.address, ["2-1"]]),
  [goldAugments[3].address, ["3-2"]],
  ...silverAugments.slice(0, 3).map((entity) => [entity.address, ["3-2"]]),
  ...prismaticAugments.slice(0, 3).map((entity) => [entity.address, ["4-2"]]),
]);
const stageFixtureCatalogSource = {
  ...activeCatalogSource,
  entities: activeCatalogSource.entities.map((entity) => {
    if (stageRows.has(entity.address)) {
      return { ...entity, rounds: stageRows.get(entity.address), round_bucket: "known_round", stage_unknown: false, stage_authority: "verifier_fixture" };
    }
    if (entity.kind === "augment") {
      return { ...entity, rounds: [], round_bucket: "unknown_round", stage_unknown: true, stage_authority: null };
    }
    return entity;
  }),
};
const stageFixtureCatalogFile = path.join(tempRoot, "decision-input-catalog.json");
await writeFile(stageFixtureCatalogFile, JSON.stringify(stageFixtureCatalogSource));
let useStageFixture = false;
const canonicalWrites = [];
const previousDisableCodexExec = process.env.JCC_UI_DISABLE_CODEX_EXEC;
process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";

async function waitForStructuredCardRunner(taskId, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = getRuntimeServiceState().response_task;
    if (task?.response_task_id === taskId && (task.pipeline_file || task.status !== "preparing")) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return getRuntimeServiceState().response_task;
}

function activeMatchState({ mode = "augment_choice", stageRound = "2-1", missingKind = "augment" } = {}) {
  const state = {
    match_session: {
      status: "active",
      match_session_id: "match-structured-card-test",
      started_at: new Date().toISOString(),
    },
    match_connection: { status: "connected_to_live_match" },
    active_mode: mode,
    match_context: {
      schema: "jcc-runtime-ui-match-context-v1",
      match_session_id: "match-structured-card-test",
      latest_authoritative_facts: {
        match_session_id: "match-structured-card-test",
        stage_round: stageRound,
        updated_at: new Date().toISOString(),
      },
      reported_choice_sets_by_mode: {},
      choice_confirmations: [],
      recent_user_messages: [
        {
          text: "high-cap augment direction",
          observed_at: new Date().toISOString(),
        },
      ],
      target_plan: {
        text: "current target lineup",
        source: "user_confirmed",
        updated_at: new Date().toISOString(),
      },
      user_confirmed_equipment: useStageFixture ? {
        schema: "jcc-runtime-user-confirmed-equipment-v1",
        match_session_id: "match-structured-card-test",
        revision: 1,
        components: [{ name: "test-component" }],
        completed: [{ name: "test-completed" }],
        radiant: [],
        support: [],
        artifacts: [],
        emblems: [],
        special: [],
        equipped: [],
        item_bench: [],
        changed_sections: ["components", "completed"],
      } : null,
    },
    runtime_triggers: {
      missing_choice_prompts: {
        [`${stageRound}:${missingKind}`]: {
          key: `${stageRound}:${missingKind}`,
          kind: missingKind,
          choice_stage_round: stageRound,
          asked_at: new Date().toISOString(),
        },
      },
    },
    response_task: { status: "idle", response_task_id: null, revision: 0 },
    response_task_revision: 0,
  };
  if (useStageFixture) {
    state.match_session.season_version_snapshot = {
      core_profile_id: runtimePaths.activeCoreProfileId,
      core_profile_ref: runtimePaths.activeCoreProfile,
      core_profile_artifacts: { decision_input_catalog: stageFixtureCatalogFile },
      core_source_identity: activeCatalogSource.source_identity,
    };
  }
  return state;
}

try {
  configureRuntimeServicePaths({ dataRoot: tempRoot });
  setRuntimeServiceCanonicalStateWriter(async (snapshot, meta) => {
    canonicalWrites.push({ snapshot: structuredClone(snapshot), meta });
    return { ok: true, state: snapshot };
  });
  setRuntimeServiceState(activeMatchState());

  const activeOptions = await handleRuntimeAction("getDecisionInputOptions", {
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    limit: 10,
  });
  assert.equal(activeOptions.status, "decision_input_options_ready");
  assert.equal(activeOptions.catalog_source, "decision-input-catalog.js");
  assert.equal(activeOptions.catalog_metadata?.schema, "jcc-decision-input-catalog-v1");
  assert.equal(activeOptions.catalog_metadata?.search_options?.kind, "augment");
  assert.equal(activeOptions.options?.schema, "jcc-runtime-decision-input-options-v1");
  assert(activeOptions.options.candidates.length > 0, "exact-stage dropdown must use the active supplemental stage authority");
  assert(activeOptions.options.candidates.every((candidate) => candidate.rounds.includes("2-1") && candidate.tier_color === "gold"));
  assert.deepEqual(activeOptions.options.candidate_filters.categories.map((entry) => entry.id), ["economy", "combat", "equipment", "synergy", "exclusive", "other"]);
  assert(activeOptions.options.options_by_group && typeof activeOptions.options.options_by_group === "object");
  assert.equal(activeOptions.options.current_reported_set, null);
  assert(activeOptions.supported_modes.includes("augment_choice"));
  assert(!activeOptions.supported_modes.includes("god_sequence"));

  const fullStageOptions = await handleRuntimeAction("getDecisionInputOptions", {
    choice_kind: "augment",
    stage_round: "3-2",
  });
  assert(fullStageOptions.options.candidates.length > 0, "3-2 dropdown must expose exact-stage candidates");
  assert(fullStageOptions.options.candidates.every((candidate) => candidate.rounds.includes("3-2") && candidate.stage_unknown === false));
  const tierOptions = await handleRuntimeAction("getDecisionInputOptions", {
    choice_kind: "augment",
    stage_round: "3-2",
    tier_color: "silver",
  });
  assert(tierOptions.options.candidates.length > 0, "tier filtering must compose with S18 stage authority");
  assert(tierOptions.options.candidates.every((candidate) => candidate.rounds.includes("3-2") && candidate.tier_color === "silver"));
  const economyOptions = await handleRuntimeAction("getDecisionInputOptions", {
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    category_ids: ["economy"],
    limit: 100,
  });
  assert(economyOptions.options.candidates.length > 0, "Runtime category filter requires at least one exact-stage economy augment");
  assert(economyOptions.options.candidates.every((candidate) => candidate.category_ids.includes("economy")));
  const invalidCategory = await handleRuntimeAction("getDecisionInputOptions", {
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    category_ids: ["season-hardcoded-category"],
  });
  assert.equal(invalidCategory.ok, false);
  assert.equal(invalidCategory.status, "invalid_decision_input_category_filter");
  const activeUnknownSearch = await handleRuntimeAction("getDecisionInputOptions", {
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    query: unknownGoldAugment.name,
  });
  assert.equal(activeUnknownSearch.catalog_metadata.search_options.search_scope, "global_search");
  assert.equal(activeUnknownSearch.options.candidates[0].name, unknownGoldAugment.name);
  assert.equal(activeUnknownSearch.options.candidates[0].availability_match, "stage_unknown");
  assert.equal(activeUnknownSearch.options.candidates[0].current_stage_eligible, false);

  useStageFixture = true;
  setRuntimeServiceState(activeMatchState());
  const options = await handleRuntimeAction("getDecisionInputOptions", {
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    limit: 10,
  });
  assert.equal(options.options.candidates.length, 3, "generic structured-card coverage requires three descriptor-authorized fixture candidates");
  assert.equal(options.options.current_effective_equipment.schema, "jcc-runtime-current-effective-equipment-v1");
  assert.equal(options.options.options_by_group.components.length, 10);
  assert.equal(
    options.options.options_by_group.completed.length,
    activeCatalogSource.entities.filter((entity) => entity.kind === "item" && entity.item_category === "completed").length,
    "completed equipment options must follow the active catalog rather than a stale fixed count",
  );
  assert.equal(
    options.options.options_by_group.radiant.length,
    activeCatalogSource.entities.filter((entity) => entity.kind === "item" && entity.item_category === "radiant").length,
    "radiant equipment options must follow the active catalog rather than a stale fixed count",
  );
  assert(options.options.options_by_group.artifacts.length >= 30);
  assert(options.options.options_by_group.emblems.length >= 10);
  assert.deepEqual(options.options.payload_binding, options.payload_binding);
  assert.equal(options.catalog_candidates.length, options.options.candidates.length);

  const crossStageSearch = await handleRuntimeAction("getDecisionInputOptions", {
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    query: goldAugments[3].name,
  });
  assert.equal(crossStageSearch.catalog_metadata.search_options.search_scope, "global_search");
  assert.equal(crossStageSearch.options.candidates[0].name, goldAugments[3].name);
  assert.equal(crossStageSearch.options.candidates[0].availability_match, "stage_mismatch");
  assert.equal(crossStageSearch.options.candidates[0].current_stage_eligible, false);

  for (const leakedName of ["亚索的恩赐", "韦鲁斯的恩赐", "凯尔的恩赐", "拒绝", "次要任务", "全能任务"]) {
    const leakedSearch = await handleRuntimeAction("getDecisionInputOptions", {
      choice_kind: "augment",
      stage_round: "2-1",
      tier_color: "gold",
      query: leakedName,
    });
    assert(!leakedSearch.options.candidates.some((candidate) => candidate.name === leakedName), `${leakedName} must not leak into augment options`);
  }

  const unsupportedModeOptions = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "unknown_choice_ui",
    backend_mode: "unknown_choice_backend",
    stage_round: "2-1",
  });
  assert.equal(unsupportedModeOptions.ok, false);
  assert.equal(unsupportedModeOptions.status, "unsupported_decision_input_mode");
  assert.equal(unsupportedModeOptions.options?.candidates?.length || 0, 0);

  const mismatchedModeOptions = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "god",
    backend_mode: "god_sequence",
    choice_kind: "augment",
    stage_round: "2-1",
  });
  assert.equal(mismatchedModeOptions.ok, false);
  assert.equal(mismatchedModeOptions.status, "unsupported_decision_input_mode");
  assert.equal(mismatchedModeOptions.options?.candidates?.length || 0, 0);

  for (const [itemChoiceKind, minimum, expectedCategory, expectedSubtype] of [
    ["basic_component_forge", 10, "components", "component"],
    ["completed_item_forge", 30, "completed", "standard_completed"],
    ["artifact_forge", 30, "artifacts", "artifact"],
    ["radiant_item_choice", 30, "radiant", "radiant"],
  ]) {
    const itemOptions = await handleRuntimeAction("getDecisionInputOptions", {
      mode: "item",
      backend_mode: "item_choice",
      choice_kind: "item_choice_panel",
      item_choice_kind: itemChoiceKind,
    });
    assert.equal(itemOptions.catalog_metadata?.search_options?.kind, "item");
    assert.equal(itemOptions.choice_kind, "item");
    assert(itemOptions.options.options_by_group.champions.length >= 50, "item hydration must expose the active-season champion directory for holder search");
    assert(itemOptions.options.options_by_group.champions.every((candidate) => candidate.kind === "champion"), "holder search directory must contain only champions");
    assert(itemOptions.options.candidates.length >= minimum, `${itemChoiceKind} must return its catalog-backed item candidates`);
    assert(itemOptions.options.candidates.every((candidate) => candidate.item_category === expectedCategory), `${itemChoiceKind} must contain only ${expectedCategory}`);
    assert(itemOptions.options.candidates.every((candidate) => candidate.item_subtype === expectedSubtype), `${itemChoiceKind} must contain only ${expectedSubtype}`);
    if (expectedCategory !== "components") {
      assert(itemOptions.options.candidates.every((candidate) => candidate.ref?.address), `${itemChoiceKind} must preserve stable catalog refs`);
      assert(itemOptions.options.candidates.every((candidate) => Array.isArray(candidate.tags)), `${itemChoiceKind} must preserve catalog tag shape`);
      assert(itemOptions.options.candidates.every((candidate) => Array.isArray(candidate.browse_facets)), `${itemChoiceKind} must preserve optional browse-facet shape`);
      assert(itemOptions.options.options_by_group[expectedCategory].every((candidate) => Array.isArray(candidate.browse_facets)), `confirmed-equipment ${expectedCategory} group must preserve optional browse-facet shape`);
    }
  }

  const candidates = options.options.candidates.slice(0, 3).map((candidate, index) => ({
    slot: index + 1,
    name: candidate.name,
    ref: candidate.ref,
    tier: candidate.tier,
    tier_color: candidate.tier_color,
    reward_text: candidate.reward_text,
    god_name: candidate.god_name,
    item_category: candidate.item_category,
    item_subtype: candidate.item_subtype,
  }));
  const concurrentState = activeMatchState();
  setRuntimeServiceState(concurrentState);
  const concurrentOptions = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    limit: 10,
  });
  const concurrentPayload = {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    tier: "gold",
    payload_binding: concurrentOptions.payload_binding,
    candidates,
    request_advice: false,
  };
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    handleRuntimeAction("submitDecisionInput", concurrentPayload),
    handleRuntimeAction("submitDecisionInput", concurrentPayload),
  ]);
  assert.equal(concurrentFirst.ok, true);
  assert.equal(concurrentSecond.ok, true);
  assert.equal(concurrentFirst.reported_choice_set.report_id, concurrentSecond.reported_choice_set.report_id, "identical concurrent reports must share one canonical identity");
  assert.equal(
    getRuntimeServiceState().match_context.reported_choice_sets.filter((entry) => entry.report_id === concurrentFirst.reported_choice_set.report_id).length,
    1,
    "identical concurrent reports must append one canonical report",
  );

  setRuntimeServiceState(activeMatchState());
  const concurrentAdviceOptions = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    limit: 10,
  });
  const concurrentAdvicePayload = {
    ...concurrentPayload,
    payload_binding: concurrentAdviceOptions.payload_binding,
    request_advice: true,
    advice_action: "choice_advice",
  };
  const [concurrentAdviceFirst, concurrentAdviceSecond] = await Promise.all([
    handleRuntimeAction("submitDecisionInput", {
      ...concurrentAdvicePayload,
      structured_card_action_id: "verify-concurrent-advice-action-a",
    }),
    handleRuntimeAction("submitDecisionInput", {
      ...concurrentAdvicePayload,
      structured_card_action_id: "verify-concurrent-advice-action-b",
    }),
  ]);
  assert.equal(concurrentAdviceFirst.ok, true);
  assert.equal(concurrentAdviceSecond.ok, true);
  assert.equal(
    concurrentAdviceFirst.response_task.response_task_id,
    concurrentAdviceSecond.response_task.response_task_id,
    "concurrent retries for one card report must reuse one Host answer owner even with different transport action ids",
  );
  const concurrentAdviceEventKey = concurrentAdviceFirst.response_task.event_key;
  assert.equal(
    Object.keys(getRuntimeServiceState().runtime_event_advice.handled).filter((key) => key === concurrentAdviceEventKey).length,
    1,
    "one structured-card action replay must create one handled event",
  );

  setRuntimeServiceState(activeMatchState());
  const optionsAfterConcurrentProbe = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    limit: 10,
  });
  const missingSubmitBinding = await handleRuntimeAction("submitDecisionInput", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    tier: "gold",
    candidates,
  });
  assert.equal(missingSubmitBinding.ok, false);
  assert.equal(missingSubmitBinding.status, "decision_input_payload_binding_required");

  const submit = await handleRuntimeAction("submitDecisionInput", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    tier: "gold",
    payload_binding: optionsAfterConcurrentProbe.payload_binding,
    candidates,
    target_note: "default pivot note",
    equipment: {
      components: [{ name: "暴风之剑" }, { name: "暴风之剑" }],
      completed: [{ name: "test-completed", item_subtype: "standard_completed" }],
      radiant: [{ name: "光明版无尽之刃", item_subtype: "radiant" }],
      artifacts: [],
      emblems: [],
    },
    changed_sections: ["components", "completed", "radiant", "artifacts", "emblems"],
  });
  assert.equal(submit.status, "decision_input_recorded");
  assert(submit.status_codes.includes("decision_input_recorded"));
  assert(submit.status_codes.includes("user_confirmed_equipment_recorded"));
  assert.equal(submit.reported_choice_set.source, "structured_decision_input_card");
  assert.equal(submit.reported_choice_set.candidates[0].ref.address, candidates[0].ref.address);
  assert.equal(submit.reported_choice_set.candidates[0].tier_color, candidates[0].tier_color);
  assert.equal(submit.reported_choice_set.candidates[0].reward_text, candidates[0].reward_text);
  assert.equal(submit.reported_choice_set.target_note, "default pivot note");
  assert(submit.changed_sections.includes("components"));
  assert(submit.changed_sections.includes("artifacts"));
  assert.equal(submit.user_confirmed_equipment_update.components.length, 2, "owned equipment must preserve duplicate copies");
  assert.equal(submit.user_confirmed_equipment_update.completed[0].item_subtype, "standard_completed");
  assert.equal(submit.user_confirmed_equipment_update.radiant[0].item_subtype, "radiant");

  const stage32OptionsBeforeReport = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "3-2",
    tier_color: "silver",
    limit: 10,
  });
  assert.equal(stage32OptionsBeforeReport.options.current_reported_set, null, "3-2 must start with a fresh stage-scoped card binding");
  const stage32Candidates = stage32OptionsBeforeReport.options.candidates.slice(0, 3).map((candidate, index) => ({
    slot: index + 1,
    name: candidate.name,
    ref: candidate.ref,
    tier: candidate.tier,
    tier_color: candidate.tier_color,
  }));
  const stage32Submit = await handleRuntimeAction("submitDecisionInput", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "3-2",
    tier: "silver",
    payload_binding: stage32OptionsBeforeReport.payload_binding,
    candidates: stage32Candidates,
  });
  assert.equal(stage32Submit.ok, true);
  assert.notEqual(stage32Submit.reported_choice_set.report_id, submit.reported_choice_set.report_id);
  const restoredStage21 = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    tier_color: "gold",
    limit: 10,
  });
  assert.equal(restoredStage21.options.current_reported_set.report_id, submit.reported_choice_set.report_id, "returning to 2-1 must restore its own canonical report after 3-2 was saved");
  assert.deepEqual(restoredStage21.options.current_reported_set.candidates.map((candidate) => candidate.name), candidates.map((candidate) => candidate.name));

  const crossStageSubmit = await handleRuntimeAction("submitDecisionInput", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    tier: "gold",
    payload_binding: submit.payload_binding,
    candidates: [
      {
        slot: 1,
        name: crossStageSearch.options.candidates[0].name,
        ref: crossStageSearch.options.candidates[0].ref,
        tier_color: crossStageSearch.options.candidates[0].tier_color,
      },
      candidates[1],
      candidates[2],
    ],
  });
  assert.equal(crossStageSubmit.ok, false);
  assert.equal(crossStageSubmit.status, "augment_candidate_stage_mismatch");

  const factOnly = await handleRuntimeAction("submitDecisionInput", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    payload_binding: submit.payload_binding,
    equipment: {
      components: [{ name: "test-component" }],
    },
    changed_sections: ["components"],
  });
  assert.equal(factOnly.status, "structured_facts_recorded");
  assert.equal(factOnly.fact_update_only, true);
  assert.deepEqual(factOnly.changed_sections, ["components"]);
  assert.equal(factOnly.user_confirmed_equipment_update.components[0].name, "test-component");
  assert.equal(factOnly.user_confirmed_equipment_update.completed[0].name, "test-completed", "omitted completed category must be preserved");
  assert.deepEqual(factOnly.user_confirmed_equipment_update.artifacts, [], "explicit prior empty artifacts clear must remain empty");
  assert.equal(factOnly.state.response_task.status, "idle", "fact-update-only submit must not open a sibling Host answer");

  setRuntimeServiceState(activeMatchState({ mode: "item_choice", stageRound: "2-1", missingKind: "item" }));
  const equipmentOnlyOptions = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "2-1",
  });
  const sameEquipmentFromOlderMatch = mergeUserConfirmedEquipmentSections({
    schema: "jcc-runtime-user-confirmed-equipment-v1",
    match_session_id: "older-match-with-same-items",
    stage_round: "1-4",
    revision: 7,
    source: "current_match_user_confirmation",
    components: [{ name: "test-component", source: "user_confirmed_equipment" }],
    completed: [{ name: "test-completed", item_subtype: "standard_completed", source: "user_confirmed_equipment" }],
    radiant: [{ name: "test-radiant", item_subtype: "radiant", source: "user_confirmed_equipment" }],
    artifacts: [{ name: "test-artifact", item_subtype: "artifact", source: "user_confirmed_equipment" }],
    emblems: [{ name: "test-emblem", item_subtype: "emblem", source: "user_confirmed_equipment" }],
  }, {
    components: [{ name: "test-component" }],
    completed: [{ name: "test-completed", item_subtype: "standard_completed" }],
    radiant: [{ name: "test-radiant", item_subtype: "radiant" }],
    artifacts: [{ name: "test-artifact", item_subtype: "artifact" }],
    emblems: [{ name: "test-emblem", item_subtype: "emblem" }],
  }, {
    matchSessionId: "match-structured-card-test",
    stageRound: "2-1",
    observedAt: new Date().toISOString(),
    forceConfirmation: true,
  });
  assert.equal(sameEquipmentFromOlderMatch.changed_sections.length, 0);
  assert.equal(sameEquipmentFromOlderMatch.scope_changed, true);
  assert.equal(sameEquipmentFromOlderMatch.persistence_required, true);
  assert.equal(sameEquipmentFromOlderMatch.equipment.match_session_id, "match-structured-card-test");
  assert.equal(sameEquipmentFromOlderMatch.equipment.stage_round, "2-1");
  assert.equal(sameEquipmentFromOlderMatch.equipment.revision, 8);
  const firstExplicitEmptyInventory = mergeUserConfirmedEquipmentSections(null, {
    components: [],
    completed: [],
    radiant: [],
    support: [],
    artifacts: [],
    emblems: [],
    special: [],
  }, {
    matchSessionId: "match-structured-card-test",
    stageRound: "2-1",
    observedAt: new Date().toISOString(),
    forceConfirmation: true,
  });
  assert.equal(firstExplicitEmptyInventory.equipment.confirmed_fields.item_bench, true, "a whole explicitly empty inventory must be confirmed rather than unavailable");
  assert.equal(resolveEquipmentFactLayers({
    structuredEquipment: {},
    userConfirmedEquipment: firstExplicitEmptyInventory.equipment,
    activeMatchSessionId: "match-structured-card-test",
  }).effective_source_by_field.item_bench, "user_confirmed");
  const partialEmptyInventory = mergeUserConfirmedEquipmentSections(null, { components: [] }, {
    matchSessionId: "match-structured-card-test",
    stageRound: "2-1",
    observedAt: new Date().toISOString(),
  });
  assert.notEqual(partialEmptyInventory.equipment.confirmed_fields?.item_bench, true, "clearing one category must not confirm untouched inventory categories");
  assert.equal(resolveEquipmentFactLayers({
    structuredEquipment: {},
    userConfirmedEquipment: partialEmptyInventory.equipment,
    activeMatchSessionId: "match-structured-card-test",
  }).effective_source_by_field.item_bench, "unavailable");
  const equipmentScopeRefresh = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "2-1",
    action: "equipment_all_update",
    equipment: {
      components: [{ name: "test-component" }],
      completed: [{ name: "test-completed", item_subtype: "standard_completed" }],
      radiant: [{ name: "test-radiant", item_subtype: "radiant" }],
      artifacts: [{ name: "test-artifact", item_subtype: "artifact" }],
      emblems: [{ name: "test-emblem", item_subtype: "emblem" }],
    },
    changed_sections: ["components", "completed", "radiant", "artifacts", "emblems"],
    request_advice: false,
  });
  assert.equal(equipmentScopeRefresh.status, "structured_facts_recorded");
  assert.equal(equipmentScopeRefresh.response_task, null);
  assert.equal(equipmentScopeRefresh.semantic_followup_owner, null);
  assert.equal(equipmentScopeRefresh.user_confirmed_equipment_update.match_session_id, "match-structured-card-test");
  assert.equal(equipmentScopeRefresh.user_confirmed_equipment_update.stage_round, "2-1");
  assert(equipmentScopeRefresh.user_confirmed_equipment_update.revision > 0);
  assert.equal(getRuntimeServiceState().match_context.user_confirmed_equipment.match_session_id, "match-structured-card-test");
  const factOnlyWriteCount = canonicalWrites.length;
  const equipmentOnlyConfirm = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "2-1",
    action: "equipment_all_update",
    payload_binding: equipmentOnlyOptions.payload_binding,
    equipment: {
      components: [{ name: "test-component" }, { name: "test-component" }],
      completed: [{ name: "test-completed", item_subtype: "standard_completed" }],
      radiant: [{ name: "test-radiant", item_subtype: "radiant" }],
      artifacts: [{ name: "test-artifact", item_subtype: "artifact" }],
      emblems: [{ name: "test-emblem", item_subtype: "emblem" }],
    },
    changed_sections: ["components", "completed", "radiant", "artifacts", "emblems"],
    request_advice: false,
  });
  assert.equal(equipmentOnlyConfirm.status, "structured_facts_recorded");
  assert.equal(equipmentOnlyConfirm.fact_update_only, true);
  assert.equal(equipmentOnlyConfirm.candidate_report_recorded, false);
  assert.equal(equipmentOnlyConfirm.response_task, null);
  assert.equal(equipmentOnlyConfirm.semantic_followup_owner, null);
  assert.equal(equipmentOnlyConfirm.user_confirmed_equipment_update.components.length, 2);
  assert.equal(equipmentOnlyConfirm.state.response_task.status, "idle");
  assert.equal(
    canonicalWrites.slice(factOnlyWriteCount).some((write) => (
      write.meta?.source === "structured_decision_input_advice_runtime_event_followup_enqueued"
    )),
    false,
    "confirming a full equipment snapshot must not reserve the Host answer lane",
  );
  const equipmentOnlyAdvice = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "2-1",
    action: "equipment_all_advice",
    payload_binding: equipmentOnlyOptions.payload_binding,
    equipment: {
      components: [{ name: "test-component" }],
    },
    changed_sections: ["components"],
    request_advice: true,
    advice_action: "global_advice",
  });
  assert.equal(equipmentOnlyAdvice.status, "structured_facts_recorded");
  assert.equal(equipmentOnlyAdvice.candidate_report_recorded, false);
  assert.equal(equipmentOnlyAdvice.response_task.origin, "runtime_event");
  assert.equal(equipmentOnlyAdvice.response_task.preferred_trigger_id, "runtime_event_followup");
  assert.equal(equipmentOnlyAdvice.response_task.runtime_event_context.event_type, "equipment_fit_changed");
  assert.equal(equipmentOnlyAdvice.response_task.runtime_event_context.event_category, "equipment_fit_context");
  assert.equal(equipmentOnlyAdvice.response_task.runtime_event_context.effective_equipment.components[0].name, "test-component");
  const equipmentDecisionSnapshot = JSON.parse(await readFile(
    equipmentOnlyAdvice.response_task.runtime_event_context.decision_snapshot_file,
    "utf8",
  ));
  assert.equal(equipmentDecisionSnapshot.phase.stage_round, "2-1");
  assert.equal(equipmentDecisionSnapshot.structured_card_decision_snapshot.event_type, "equipment_fit_changed");
  assert.equal(equipmentOnlyAdvice.semantic_followup_owner.response_task_id, equipmentOnlyAdvice.response_task.response_task_id);
  const equipmentRunnerTask = await waitForStructuredCardRunner(equipmentOnlyAdvice.response_task.response_task_id);
  assert.equal(equipmentRunnerTask.response_task_id, equipmentOnlyAdvice.response_task.response_task_id);
  assert(equipmentRunnerTask.pipeline_file || equipmentRunnerTask.status !== "preparing", "structured equipment advice owner must start its Host pipeline");

  setRuntimeServiceState(activeMatchState());
  const restoredOptions = await handleRuntimeAction("getDecisionInputOptions", {
    choice_kind: "augment",
    stage_round: "2-1",
    limit: 10,
  });
  assert.equal(getRuntimeServiceState().match_context.recent_user_messages.at(-1).text, "high-cap augment direction");
  assert.equal(getRuntimeServiceState().match_context.target_plan.text, "current target lineup");

  const adviceSubmit = await handleRuntimeAction("submitDecisionInput", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    payload_binding: restoredOptions.payload_binding,
    candidates,
    request_advice: true,
    advice_action: "global_advice",
  });
  assert.equal(adviceSubmit.status, "decision_input_recorded");
  assert.equal(adviceSubmit.response_task.origin, "runtime_event");
  assert.equal(adviceSubmit.response_task.mode, "augment_choice");
  assert.equal(adviceSubmit.response_task.structured_card_action, true);
  assert.equal(adviceSubmit.response_task.expiry_policy, "structured_card_action_must_return_unless_superseded_by_user");
  assert.equal(adviceSubmit.response_task.preferred_trigger_id, "runtime_event_followup");
  assert.equal(adviceSubmit.response_task.runtime_event_context.event_type, "reported_choices_changed");
  assert.equal(adviceSubmit.response_task.runtime_event_context.event_category, "global_choice_advice");
  assert.equal(adviceSubmit.response_task.runtime_event_context.effective_equipment.components[0].name, "test-component");
  assert.equal(adviceSubmit.response_task.runtime_event_context.effective_equipment.completed[0].name, "test-completed");
  assert.equal(adviceSubmit.response_task.runtime_event_context.latest_user_intent.text, "high-cap augment direction");
  assert.equal(adviceSubmit.response_task.runtime_event_context.target_plan.text, "current target lineup");
  assert.equal(adviceSubmit.semantic_followup_owner.response_task_id, adviceSubmit.response_task.response_task_id);
  assert.deepEqual(
    adviceSubmit.response_task.runtime_event_context.reported_choice_set.candidates.map((candidate) => candidate.name),
    candidates.map((candidate) => candidate.name),
  );
  const staleCandidateReplay = await handleRuntimeAction("submitDecisionInput", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    payload_binding: restoredOptions.payload_binding,
    candidates: [...candidates].reverse().map((candidate, index) => ({ ...candidate, slot: index + 1 })),
    request_advice: false,
  });
  assert.equal(staleCandidateReplay.ok, false, "an older candidate card must not overwrite a newer canonical report");
  assert.equal(staleCandidateReplay.status, "stale_decision_input_payload");
  assert.deepEqual(
    getRuntimeServiceState().match_context.reported_choice_sets_by_mode.augment_choice.candidates.map((candidate) => candidate.name),
    candidates.map((candidate) => candidate.name),
    "replaying a stale card must leave the current canonical candidate set unchanged",
  );
  const staleEquipmentFactUpdate = await handleRuntimeAction("submitDecisionInput", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    action: "equipment_all_update",
    payload_binding: restoredOptions.payload_binding,
    equipment: {
      components: [{ name: "test-component" }, { name: "test-component" }],
      completed: [{ name: "test-completed", item_subtype: "standard_completed" }],
      radiant: [{ name: "test-radiant", item_subtype: "radiant" }],
      artifacts: [{ name: "test-artifact", item_subtype: "artifact" }],
      emblems: [{ name: "test-emblem", item_subtype: "emblem" }],
    },
    changed_sections: ["components", "completed", "radiant", "artifacts", "emblems"],
    request_advice: false,
  });
  assert.equal(staleEquipmentFactUpdate.ok, true, "fact-only equipment updates must not fail because the surrounding choice card revision advanced");
  assert.equal(staleEquipmentFactUpdate.status, "structured_facts_recorded");
  assert.equal(staleEquipmentFactUpdate.response_task, null);
  const statusPing = await handleRuntimeAction("sendMessage", {
    mode: "augment_choice",
    text: "?",
  });
  assert.equal(statusPing.status, "response_status_pending");
  assert.equal(statusPing.response_task.response_task_id, adviceSubmit.response_task.response_task_id);
  assert.equal(getRuntimeServiceState().response_task.response_task_id, adviceSubmit.response_task.response_task_id);
  assert.equal(canonicalWrites.filter((write) => (
    write.meta?.source === "structured_decision_input_advice_runtime_event_followup_enqueued"
    && write.snapshot.response_task?.response_task_id === adviceSubmit.response_task.response_task_id
  )).length, 1);
  const adviceRunnerTask = await waitForStructuredCardRunner(adviceSubmit.response_task.response_task_id);
  setRuntimeServiceState({
    ...getRuntimeServiceState(),
    active_mode: "augment_choice",
    response_task: {
      ...adviceRunnerTask,
      status: "failed",
      error: "fixture_structured_card_failure",
    },
  });
  const failedAdviceAck = await handleRuntimeAction("ackDeliveredResponse", {
    response_task_id: adviceRunnerTask.response_task_id,
    response_task_revision: adviceRunnerTask.revision,
    reason: "structured_card_failure_rendered",
  });
  assert.equal(failedAdviceAck.ok, true);
  assert.equal(failedAdviceAck.state.active_mode, "augment_choice", "failed structured-card delivery must keep the card mode open for retry");
  setRuntimeServiceState({
    ...getRuntimeServiceState(),
    active_mode: "augment_choice",
    response_task: {
      ...adviceRunnerTask,
      status: "completed",
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        final_text: "structured card test response",
        confidence: "high",
      },
    },
  });
  const adviceAck = await handleRuntimeAction("ackDeliveredResponse", {
    response_task_id: adviceRunnerTask.response_task_id,
    response_task_revision: adviceRunnerTask.revision,
    reason: "structured_card_blackbox_rendered",
  });
  assert.equal(adviceAck.ok, true);
  assert.equal(adviceAck.state.active_mode, "cruise", "structured card delivery must return to cruise only after ACK");
  const missingConfirmBinding = await handleRuntimeAction("confirmDecisionSelection", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    slot: 1,
    ref: candidates[0].ref,
  });
  assert.equal(missingConfirmBinding.ok, false);
  assert.equal(missingConfirmBinding.status, "decision_input_payload_binding_required");

  const slotOnlyConfirm = await handleRuntimeAction("confirmDecisionSelection", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    payload_binding: adviceSubmit.payload_binding,
    slot: 1,
  });
  assert.equal(slotOnlyConfirm.ok, false, "final confirmation must include candidate identity, not only a slot number");
  assert.equal(slotOnlyConfirm.status, "selected_choice_identity_required");

  const badConfirm = await handleRuntimeAction("confirmDecisionSelection", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    payload_binding: restoredOptions.payload_binding,
    slot: 1,
    ref: candidates[1].ref,
  });
  assert.equal(badConfirm.status, "selected_choice_not_in_current_choice_set");
  assert.equal(badConfirm.ok, false);
  assert.equal(getRuntimeServiceState().match_context.target_plan.text, "current target lineup");
  assert.equal(getRuntimeServiceState().match_context.recent_user_messages.at(-1).text, "high-cap augment direction");

  const goodConfirm = await handleRuntimeAction("confirmDecisionSelection", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    payload_binding: restoredOptions.payload_binding,
    slot: 1,
    ref: candidates[0].ref,
  });
  assert.equal(goodConfirm.status, "choice_confirmation_recorded");
  assert(goodConfirm.status_codes.includes("choice_confirmation_recorded"));
  assert(goodConfirm.status_codes.includes("decision_selection_recorded"));
  assert.equal(goodConfirm.confirmation.selected_ref.address, candidates[0].ref.address);
  assert.equal(goodConfirm.confirmation.selected_candidate_metadata.tier_color, candidates[0].tier_color);
  assert.equal(goodConfirm.confirmation.selected_candidate_metadata.reward_text, candidates[0].reward_text);
  assert.equal(goodConfirm.confirmation.final_state_field, "augments.selected_augments");
  assert.equal(goodConfirm.state.match_context.augments.selected_augments[0].choice, candidates[0].name);
  assert.equal(goodConfirm.state.match_context.reported_choice_sets_by_mode.augment_choice.final_selection.choice, candidates[0].name);
  const confirmedScopeBinding = goodConfirm.payload_binding;
  const confirmedScopeReplacement = await handleRuntimeAction("submitDecisionInput", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    tier: "gold",
    payload_binding: confirmedScopeBinding,
    candidates: [candidates[1], candidates[0], candidates[2]].map((candidate, index) => ({ ...candidate, slot: index + 1 })),
    request_advice: false,
  });
  assert.equal(confirmedScopeReplacement.ok, false, "a confirmed stage must not be overwritten by a different candidate set");
  assert.equal(confirmedScopeReplacement.status, "structured_choice_scope_already_confirmed");
  assert.equal(
    getRuntimeServiceState().match_context.reported_choice_sets_by_scope["augment_choice:augment:2-1"].final_selection.choice,
    candidates[0].name,
    "rejected post-confirmation candidate churn must preserve the canonical final selection",
  );
  assert.equal(goodConfirm.state.runtime_triggers.missing_choice_prompts["2-1:augment"].confirmed_at, goodConfirm.confirmation.confirmed_at);
  assert.equal(goodConfirm.response_task, null);
  assert.equal(goodConfirm.confirmation.response_policy, "state_only_no_host_task");
  assert.equal(goodConfirm.semantic_followup_owner.response_policy, "no_confirmation_followup");
  assert.equal(getRuntimeServiceState().response_task.response_task_id, null, "final confirmation must not occupy the Host lane");
  setRuntimeServiceState({
    ...getRuntimeServiceState(),
    runtime_event_detector: null,
  });
  const confirmationObserverEvents = detectRuntimeSemanticEvents({
    schema: "jcc-match-live-state-v1",
    match_session_id: "match-structured-card-test",
    phase: { stage_round: "2-1" },
    economy: { gold: 20, level: 4 },
    board: { units: [] },
    bench: { units: [] },
    shop: { units: [] },
  }, {
    match_context: getRuntimeServiceState().match_context,
    source: "verify_structured_confirmation_observer_dedupe",
  });
  const observedConfirmationEvent = confirmationObserverEvents.find((event) => event.type === "confirmed_choices_changed");
  assert.equal(observedConfirmationEvent, undefined, "state-only confirmation must not create a sibling observer answer event");
  const confirmationFollowupWriteCount = canonicalWrites.filter((write) => (
    write.meta?.source === "structured_decision_selection_runtime_event_followup_enqueued"
    && write.snapshot.response_task?.runtime_event_context?.confirmation?.confirmation_id === goodConfirm.confirmation.confirmation_id
  )).length;
  assert.equal(confirmationFollowupWriteCount, 0, "final confirmation must not enqueue a Host follow-up");
  const duplicateConfirm = await handleRuntimeAction("confirmDecisionSelection", {
    mode: "augment_choice",
    choice_kind: "augment",
    stage_round: "2-1",
    payload_binding: adviceSubmit.payload_binding,
    slot: 1,
    ref: candidates[0].ref,
  });
  assert.equal(duplicateConfirm.status, "choice_confirmation_already_recorded");
  const followupWriteCountAfterDuplicate = canonicalWrites.filter((write) => (
    write.meta?.source === "structured_decision_selection_runtime_event_followup_enqueued"
    && write.snapshot.response_task?.runtime_event_context?.confirmation?.confirmation_id === goodConfirm.confirmation.confirmation_id
  )).length;
  assert.equal(duplicateConfirm.response_task, null);
  assert.equal(followupWriteCountAfterDuplicate, confirmationFollowupWriteCount, "duplicate confirmation must not gain a Host answer");

  const retiredGodMode = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "god",
    backend_mode: "god_sequence",
    choice_kind: "god",
    stage_round: "2-4",
  });
  assert.equal(retiredGodMode.ok, false);
  assert.equal(retiredGodMode.status, "unsupported_decision_input_mode");
  assert.equal(retiredGodMode.options?.candidates?.length || 0, 0);
  assert.equal(activeCatalogSource.entities.some((entity) => entity.kind === "star_god"), false, "active S18 catalog must not expose S17 star-god choices");
  assert.equal(activeCatalogSource.entities.some((entity) => entity.kind === "god_reward"), false, "active S18 catalog must not expose S17 god rewards");
  assert.deepEqual(activeCatalogSource.choice_descriptors?.augment?.stages, ["2-1", "3-2", "4-2"]);
  setRuntimeServiceState(activeMatchState({ mode: "item_choice", stageRound: "4-2", missingKind: "item" }));
  const itemOptions = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
    limit: 4,
  });
  assert.equal(itemOptions.options.candidates.length, 4, "artifact forge must expose four card candidates");
  assert(itemOptions.options.candidates.every((candidate) => candidate.item_category === "artifacts"));
  const bowOption = itemOptions.options.options_by_group.components.find((candidate) => candidate.name === "反曲之弓");
  assert(bowOption?.search_terms?.includes("攻速"), "shared equipment card options must carry compiled player aliases");
  const birdOption = itemOptions.options.options_by_group.champions.find((candidate) => candidate.name === "深红锋喙鸟");
  assert(birdOption?.search_terms?.includes("小鸡"), "holder champion options must carry patch-owned player aliases");
  const unresolvedEquippedAlias = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    action: "equipment_equipped_update",
    request_advice: false,
    changed_sections: ["equipped"],
    equipment: {
      equipped: [{ name: "攻速", owner_unit: "深红锋喙鸟", slot: 1 }],
    },
  });
  assert.equal(unresolvedEquippedAlias.ok, false, "raw aliases must not persist as equipped canonical facts");
  assert.equal(unresolvedEquippedAlias.status, "structured_equipped_entity_unresolved");
  const canonicalEquippedItem = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    action: "equipment_equipped_update",
    request_advice: false,
    changed_sections: ["equipped"],
    equipment: {
      equipped: [{ name: bowOption.name, ref: bowOption.ref, owner_unit: birdOption.name, slot: 1 }],
    },
  });
  assert.equal(canonicalEquippedItem.ok, true);
  assert.equal(canonicalEquippedItem.user_confirmed_equipment_update?.equipped?.[0]?.name, "反曲之弓");
  assert.equal(canonicalEquippedItem.user_confirmed_equipment_update?.equipped?.[0]?.owner_unit, "深红锋喙鸟");
  assert.equal(canonicalEquippedItem.user_confirmed_equipment_update?.equipped?.[0]?.ref?.address, bowOption.ref.address);
  const refOnlyEquippedItem = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    action: "equipment_equipped_update",
    request_advice: false,
    changed_sections: ["equipped"],
    equipment: {
      equipped: [{ ref: bowOption.ref, owner_unit: birdOption.name, slot: 1 }],
    },
  });
  assert.equal(refOnlyEquippedItem.ok, true, "stable ref-only equipped entries must remain valid canonical input");
  assert.equal(refOnlyEquippedItem.user_confirmed_equipment_update?.equipped?.[0]?.name, "反曲之弓");
  const equippedBeforeMalformedInput = structuredClone(getRuntimeServiceState().match_context?.user_confirmed_equipment?.equipped || []);
  const malformedEquippedItem = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    action: "equipment_equipped_update",
    request_advice: false,
    changed_sections: ["equipped"],
    equipment: {
      equipped: [{ owner_unit: birdOption.name, slot: 1 }],
    },
  });
  assert.equal(malformedEquippedItem.ok, false, "nonempty equipped input without an entity identity must fail closed");
  assert.equal(malformedEquippedItem.status, "structured_equipped_entity_unresolved");
  assert.deepEqual(
    getRuntimeServiceState().match_context?.user_confirmed_equipment?.equipped || [],
    equippedBeforeMalformedInput,
    "malformed nonempty equipped input must not clear previously persisted equipment",
  );
  const wrongCategoryCandidate = itemOptions.options.options_by_group.completed[0];
  const wrongCategorySubmit = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
    payload_binding: itemOptions.payload_binding,
    candidates: [wrongCategoryCandidate, ...itemOptions.options.candidates.slice(1, 4)].map((candidate, index) => ({
      slot: index + 1,
      name: candidate.name,
      ref: candidate.ref,
      item_category: candidate.item_category,
      item_subtype: candidate.item_subtype,
    })),
  });
  assert.equal(wrongCategorySubmit.ok, false);
  assert.equal(wrongCategorySubmit.status, "item_candidate_category_mismatch");
  const shortItemSubmit = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
    payload_binding: itemOptions.payload_binding,
    candidates: itemOptions.options.candidates.slice(0, 3),
  });
  assert.equal(shortItemSubmit.ok, false);
  assert.equal(shortItemSubmit.status, "decision_candidate_count_mismatch");
  const itemCandidates = itemOptions.options.candidates.map((candidate, index) => ({
    slot: index + 1,
    name: candidate.name,
    ref: candidate.ref,
    item_category: candidate.item_category,
    item_subtype: candidate.item_subtype,
  }));
  const itemSubmit = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
    payload_binding: itemOptions.payload_binding,
    candidates: itemCandidates,
  });
  assert.equal(itemSubmit.status, "decision_input_recorded");
  const itemConfirm = await handleRuntimeAction("confirmDecisionSelection", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
    payload_binding: itemSubmit.payload_binding,
    slot: 2,
    ref: itemCandidates[1].ref,
  });
  assert.equal(itemConfirm.status, "choice_confirmation_recorded");
  assert.equal(itemConfirm.confirmation.final_state_field, "items.confirmed_choice");
  assert.equal(itemConfirm.state.match_context.items.confirmed_choice.choice, itemCandidates[1].name);
  assert.equal(itemConfirm.state.match_context.items.confirmed_choice.item_choice_kind, "artifact_forge");
  assert.equal(itemConfirm.state.match_context.reported_choice_sets_by_mode.item_choice.final_selection.choice, itemCandidates[1].name);
  const restoredItemWindow = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
  });
  assert.equal(
    restoredItemWindow.payload_binding.choice_window_instance_id,
    itemConfirm.payload_binding.choice_window_instance_id,
    "ordinary reopen must hydrate the current canonical item window",
  );
  const secondWindowId = "verify-second-artifact-window";
  const secondItemWindow = await handleRuntimeAction("getDecisionInputOptions", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
    choice_window_instance_id: secondWindowId,
  });
  assert.equal(secondItemWindow.options.current_reported_set, null, "an explicit next item choice must start with no reported candidates");
  assert.equal(secondItemWindow.payload_binding.choice_window_instance_id, secondWindowId);
  const secondItemCandidates = secondItemWindow.options.candidates.slice(0, 4).reverse().map((candidate, index) => ({
    slot: index + 1,
    name: candidate.name,
    ref: candidate.ref,
    item_category: candidate.item_category,
    item_subtype: candidate.item_subtype,
  }));
  const secondItemSubmit = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
    choice_window_instance_id: secondWindowId,
    payload_binding: secondItemWindow.payload_binding,
    candidates: secondItemCandidates,
  });
  assert.equal(secondItemSubmit.ok, true, `a second explicit forge in the same stage must not be treated as candidate churn on the first forge: ${secondItemSubmit.status}`);
  assert.notEqual(secondItemSubmit.reported_choice_set.report_id, itemSubmit.reported_choice_set.report_id);
  const secondItemConfirm = await handleRuntimeAction("confirmDecisionSelection", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
    choice_window_instance_id: secondWindowId,
    payload_binding: secondItemSubmit.payload_binding,
    slot: 1,
    ref: secondItemCandidates[0].ref,
  });
  assert.equal(secondItemConfirm.status, "choice_confirmation_recorded");
  assert.equal(secondItemConfirm.confirmation.choice_window_instance_id, secondWindowId);
  assert.notEqual(secondItemConfirm.confirmation.confirmation_id, itemConfirm.confirmation.confirmation_id);
  const staleFirstWindowMutation = await handleRuntimeAction("submitDecisionInput", {
    mode: "item_choice",
    choice_kind: "item",
    stage_round: "4-2",
    item_choice_kind: "artifact_forge",
    payload_binding: itemSubmit.payload_binding,
    candidates: secondItemCandidates,
  });
  assert.equal(staleFirstWindowMutation.ok, false, "the confirmed first window must remain protected after a second window opens");
  assert.equal(staleFirstWindowMutation.status, "structured_choice_scope_already_confirmed");

  console.log(JSON.stringify({
    schema: "jcc-structured-card-backend-actions-blackbox-v1",
    ok: true,
    checks: [
      "runtime_bridge_nested_options_shape",
      "catalog_options_and_metadata",
      "official_exact_stage_augments_and_unmatched_official_search_only_rows",
      "augment_stage_tier_and_category_filtering",
      "invalid_or_mismatched_decision_input_modes_fail_closed",
      "item_choice_and_confirmed_equipment_facet_tags_preserved",
      "structured_report_preserves_refs_and_metadata",
      "explicit_empty_equipment_sections_changed",
      "omitted_equipment_sections_preserved",
      "fact_update_only_no_sibling_host_answer",
      "equipment_only_advice_enqueues_exactly_one_runtime_event_followup_owner",
      "structured_card_advice_owner_starts_runtime_event_host_pipeline",
      "submit_advice_enqueues_exactly_one_runtime_event_followup_owner",
      "explicit_global_advice_preserves_whole_card_semantics",
      "missing_submit_or_confirm_payload_binding_rejected",
      "invalid_mixed_slot_ref_selection_rejected",
      "cross_stage_augment_submission_rejected",
      "canonical_choice_confirmation_recorded_status",
      "descriptor_declared_final_state_materialized",
      "valid_selection_persists_without_runtime_event_followup",
      "missing_prompt_exact_stage_kind_eliminated",
      "s18_retired_star_god_mode_rejected",
      "s18_active_catalog_excludes_star_god_entities_and_rewards",
      "duplicate_confirmation_is_idempotent_without_host_task",
      "structured_candidate_count_enforced",
      "item_choice_cross_category_submit_rejected",
      "item_choice_descriptor_final_state_materialized",
    ],
  }, null, 2));
} finally {
  await handleRuntimeAction("shutdown", { reason: "verify_structured_card_backend_blackbox_cleanup" }, null).catch(() => {});
  setRuntimeServiceState({});
  setRuntimeServiceCanonicalStateWriter(null);
  if (previousDisableCodexExec === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
  else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisableCodexExec;
  await rm(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 75,
  });
}
