import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-choice-confirmation-state.mjs --compatibility-fixture --events <jsonl> [--out <json>]",
    "",
    "Builds a season-neutral confirmation regression fixture. Production choice state is owned by SQLite canonical runtime state and compiled active rules.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--compatibility-fixture") options.compatibilityFixture = true;
    else if (arg === "--events") options.events = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isoNow() {
  return new Date().toISOString();
}

function eventTime(event) {
  return event.observed_at || event.received_at || event.created_at || isoNow();
}

function normalizedChoice(event) {
  const choice = event.choice || event.selected_choice || {};
  const stageRound = event.choice_stage_round || event.stage_round || choice.choice_stage_round || choice.stage_round || null;
  return {
    choice_id: choice.choice_id ?? event.choice_id ?? null,
    entity_id: choice.entity_id ?? event.entity_id ?? choice.id ?? null,
    name: choice.name ?? event.name ?? choice.text ?? event.text ?? null,
    choice_stage_round: stageRound,
    slot_index: Number.isFinite(Number(choice.slot_index ?? event.slot_index)) ? Number(choice.slot_index ?? event.slot_index) : null,
    action_taken: event.action_taken || event.recommendation_action || "choose",
    source: event.source || "user_confirmed_runtime_ui_or_chat",
    confidence: Number.isFinite(Number(event.confidence)) ? Number(event.confidence) : 1,
  };
}

function choiceKindFromRuntimeMode(event, state) {
  const explicit = event.choice_kind || event.screen_type;
  if (explicit) return explicit;
  const mode = event.runtime_ui_mode || event.mode;
  if (mode === "augment_choice") return "augment_choice";
  if (mode === "item_choice") return "item_choice_panel";
  return mode || "unknown_choice_panel";
}

function emptyState() {
  return {
    schema: "jcc-choice-confirmation-state-v1",
    match_session_id: null,
    phase: {
      mumu_status_code: null,
      previous_mumu_status_code: null,
      stage: null,
      round: null,
      latest_stage_round_key: null,
      latest_combat_to_actionable_at: null,
    },
    choices: {
      pending_confirmation: null,
      history: [],
    },
    augments: {
      selected_augments: [],
      unresolved_owned_augment_texts: [],
      reroll_events: [],
    },
    season_choices: {
      confirmed: [],
    },
    scheduled_hooks: {
      expected_choice: null,
      fired: [],
      fired_keys: [],
    },
    field_status: {},
    pollution_guard: {
      match_scoped: true,
      cross_match_fusion_allowed: false,
      reset_on_new_match_required: true,
    },
  };
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function stageRoundKey(stage, round) {
  const stageNumber = numberOrNull(stage);
  const roundNumber = numberOrNull(round);
  if (stageNumber == null || roundNumber == null) return null;
  return `${stageNumber}-${roundNumber}`;
}

function normalizeMumuStatusCode(event) {
  if (event.type === "mumu_gi_message" && Number(event.command ?? event.cmd) === 4358) {
    return numberOrNull(event.payload?.s ?? event.raw_payload?.s);
  }
  if (event.type === "game_status_candidate") {
    return numberOrNull(event.phase_patch?.mumu_status_code ?? event.mumu_status_code ?? event.status_code);
  }
  if (event.type === "phase_status_changed" || event.type === "mumu_status_changed") {
    return numberOrNull(event.mumu_status_code ?? event.status_code ?? event.status);
  }
  return null;
}

function normalizeStageRound(event) {
  const stage = numberOrNull(event.stage ?? event.round_stage?.stage ?? event.phase?.stage ?? event.payload?.stage);
  const round = numberOrNull(event.round ?? event.round_stage?.round ?? event.phase?.round ?? event.payload?.round);
  if (stage != null || round != null) return { stage, round };
  const text = event.stage_round || event.round_stage || event.round_label || event.payload?.stage_round;
  if (typeof text === "string") {
    const match = /^(\d+)-(\d+)$/.exec(text.trim());
    if (match) return { stage: Number(match[1]), round: Number(match[2]) };
  }
  return null;
}

function sameMatchOrEmpty(state, event) {
  const id = event.match_session_id || null;
  if (!state.match_session_id && id) {
    state.match_session_id = id;
    return true;
  }
  if (!id || !state.match_session_id || id === state.match_session_id) return true;
  return false;
}

function setPending(state, event, source) {
  const choiceKind = event.choice_kind || event.screen_type || "unknown_choice_panel";
  state.choices.pending_confirmation = {
    choice_kind: choiceKind,
    options: event.choices || event.options || [],
    advice: event.advice || event.recommendation || null,
    requested_at: eventTime(event),
    source,
    semantic_status: "pending_user_confirmation",
    needs_user_confirmation: true,
    runtime_ui_mode: event.runtime_ui_mode || null,
    sequence_id: event.sequence_id || null,
  };
  state.field_status["choices.pending_confirmation"] = {
    status: "pending_user_confirmation",
    source_type: source,
    evidence: event.type,
    promotion_policy: "final_state_requires_user_confirmation",
  };
}

function clearPending(state, reason, at) {
  if (!state.choices.pending_confirmation) return;
  state.choices.history.push({
    ...state.choices.pending_confirmation,
    resolved_at: at,
    resolution: reason,
  });
  state.choices.pending_confirmation = null;
}

function shouldReturnToCruiseAfterConfirmation(kind, state) {
  return true;
}

function recordAugment(state, event, choice, at) {
  const choiceStageRound = choice.choice_stage_round || event.choice_stage_round || event.stage_round || null;
  if (event.type === "owned_augment_text_panel_confirmed" && !choiceStageRound) {
    state.augments.unresolved_owned_augment_texts.push({
      ...choice,
      confirmed_at: at,
      semantic_status: "needs_choice_stage_round",
      source: choice.source,
    });
    state.field_status["augments.unresolved_owned_augment_texts"] = {
      status: "needs_user_confirmation",
      source_type: choice.source,
      evidence: event.type,
      reason: "owned augment text panel OCR did not include fixed row stage binding",
    };
    return;
  }
  if (choice.action_taken === "reroll") {
    state.augments.reroll_events.push({
      at,
      choice_kind: event.choice_kind || "augment_choice",
      choice_stage_round: choiceStageRound,
      source: choice.source,
      semantic_status: "user_confirmed_reroll",
    });
    state.field_status["augments.reroll_events"] = {
      status: "user_confirmed",
      source_type: choice.source,
      evidence: event.type,
    };
    return;
  }
  state.augments.selected_augments.push({
    ...choice,
    choice_stage_round: choiceStageRound,
    confirmed_at: at,
    semantic_status: "user_confirmed",
  });
  state.field_status["augments.selected_augments"] = {
    status: "user_confirmed",
    source_type: choice.source,
    evidence: event.type,
    promotion_policy: "confirmed_current_match_only",
  };
}

function recordScheduledHook(state, event, at) {
  const stage = event.stage || event.round_stage || event.phase?.stage || state.phase.latest_stage_round_key || null;
  const hook = {
    at,
    stage,
    trigger: event.trigger || "combat_end_to_actionable",
    expected_choice_kind: event.expected_choice_kind || "descriptor_choice",
    source: event.source || "scheduled_round_hook",
  };
  state.scheduled_hooks.fired.push(hook);
  state.scheduled_hooks.expected_choice = {
    choice_kind: hook.expected_choice_kind,
    stage,
    reason: hook.trigger,
    created_at: at,
    semantic_status: "expected_next_panel",
  };
  state.field_status["scheduled_hooks.expected_choice"] = {
    status: "expected",
    source_type: hook.source,
    evidence: event.type,
    caveat: "Requires verified round/stage source; 4358 alone does not include the stage number.",
  };
}

function mergePhaseAndScheduleEvent(state, event, at) {
  const stageRound = normalizeStageRound(event);
  if (stageRound) {
    if (stageRound.stage != null) state.phase.stage = stageRound.stage;
    if (stageRound.round != null) state.phase.round = stageRound.round;
    state.phase.latest_stage_round_key = stageRoundKey(state.phase.stage, state.phase.round);
  }

  const statusCode = normalizeMumuStatusCode(event);
  if (statusCode != null) {
    const previous = state.phase.mumu_status_code;
    state.phase.previous_mumu_status_code = previous;
    state.phase.mumu_status_code = statusCode;
    if (previous === 2 && statusCode === 1) {
      state.phase.latest_combat_to_actionable_at = at;
    }
    if (statusCode === 4) {
      setPending(state, {
        ...event,
        choice_kind: "unknown_choice_panel",
        choices: [],
        advice: null,
        observed_at: at,
      }, "4358_s4_visual_attention_trigger");
    }
    return true;
  }
  return Boolean(stageRound);
}

function mergeEvent(state, event) {
  if (!sameMatchOrEmpty(state, event)) {
    state.field_status["pollution_guard.rejected_cross_match_event"] = {
      status: "rejected",
      source_type: event.source || "unknown",
      evidence: event.type,
      incoming_match_session_id: event.match_session_id,
      active_match_session_id: state.match_session_id,
    };
    return;
  }

  const at = eventTime(event);
  if (event.type === "new_game_start") {
    state.match_session_id = event.match_session_id || state.match_session_id;
    return;
  }
  if (mergePhaseAndScheduleEvent(state, event, at)) {
    if (!["choice_window_detected", "choice_advice_ready", "choice_confirmation_requested", "scheduled_choice_hook"].includes(event.type)) {
      return;
    }
  }
  if (event.type === "runtime_ui_mode_requested") {
    setPending(state, {
      ...event,
      choice_kind: choiceKindFromRuntimeMode(event, state),
      choices: event.choices || [],
      advice: null,
      observed_at: at,
    }, "runtime_ui_mode_button");
    return;
  }
  if (event.type === "choice_window_detected" || event.type === "choice_advice_ready" || event.type === "choice_confirmation_requested") {
    setPending(state, event, event.source || event.type);
    return;
  }
  if (event.type === "scheduled_choice_hook") {
    recordScheduledHook(state, event, at);
    return;
  }
  if (event.type === "choice_skipped") {
    clearPending(state, "user_skipped", at);
    state.field_status["choices.pending_confirmation"] = {
      status: "missing_user_skipped",
      source_type: event.source || "user_confirmed_runtime_ui_or_chat",
      evidence: event.type,
    };
    return;
  }

  if (
    event.type === "choice_confirmed" ||
    event.type === "augment_choice_confirmed" ||
    event.type === "owned_augment_text_panel_confirmed"
  ) {
    if (event.type === "owned_augment_text_panel_confirmed") {
      const source = event.source || event.choice?.source || event.selected_choice?.source || null;
      if (source !== "user_triggered_owned_augment_text_panel_ocr") {
        state.field_status["pollution_guard.rejected_owned_augment_text_panel_event"] = {
          status: "rejected",
          source_type: source || "unknown",
          evidence: event.type,
          reason: "owned augment text-panel confirmation requires user_triggered_owned_augment_text_panel_ocr source",
        };
        return;
      }
    }
    const choice = normalizedChoice(event);
    const kind = event.choice_kind
      || (event.type === "augment_choice_confirmed" || event.type === "owned_augment_text_panel_confirmed" ? "augment_choice" : state.choices.pending_confirmation?.choice_kind);
    if (kind === "augment_choice") recordAugment(state, event, choice, at);
    else {
      state.season_choices.confirmed.push({
        choice_kind: kind || "unknown_choice_panel",
        selected_choice: choice,
        confirmed_at: at,
        semantic_status: "user_confirmed",
      });
      state.choices.history.push({
        choice_kind: kind || "unknown_choice_panel",
        selected_choice: choice,
        confirmed_at: at,
        semantic_status: "user_confirmed",
      });
      state.field_status[`choices.${kind || "unknown"}`] = {
        status: "user_confirmed",
        source_type: choice.source,
        evidence: event.type,
      };
    }
    if (shouldReturnToCruiseAfterConfirmation(kind, state)) clearPending(state, "user_confirmed", at);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  assert(options.compatibilityFixture === true, "This confirmation fold fixture requires --compatibility-fixture and is not a product runtime path");
  assert(options.events, "Missing --events");
  const events = parseJsonl(await readFile(options.events, "utf8"));
  const state = emptyState();
  for (const event of events) mergeEvent(state, event);
  const json = `${JSON.stringify(state, null, 2)}\n`;
  if (options.out) await writeFile(options.out, json, "utf8");
  else process.stdout.write(json);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
