import runtimeUiModeContractJson from "../../data/runtime/jcc/runtime-ui-mode-contract.json";
import type { RankingStatusViewModel } from "../electron/ranking-status-view-model.js";

type RuntimePreviewCapabilities = {
  active_season_id?: string | null;
  active_patch_id?: string | null;
  options?: ManualVariableOptions;
  season_variable_fields?: SeasonVariableField[];
  prompt_at_match_start?: string[];
  active_season_ui_modes?: RuntimeUiModeDefinitions;
  decision_options?: Record<string, DecisionInputOptions>;
  runtime_state?: Partial<RuntimeState>;
  submission_log?: Array<{
    action: "submitDecisionInput" | "confirmDecisionSelection";
    payload: DecisionInputPayload | DecisionSelectionPayload;
  }>;
};

declare global {
  interface Window {
    __JCC_RUNTIME_PREVIEW_CAPABILITIES__?: RuntimePreviewCapabilities;
  }
}

export type RuntimeModeId =
  | "cruise"
  | "augment"
  | "item"
  | "lineup"
  | "vars"
  | (string & {});

export type ItemChoiceKind =
  | "basic_component_forge"
  | "completed_item_forge"
  | "artifact_forge"
  | "radiant_item_choice";

export type DailyModeId = "chat" | "prefs" | "wiki" | "review";

export type BackendRuntimeModeId =
  | "daily_chat"
  | "postgame_review"
  | "user_preferences"
  | "strategy_wiki"
  | "cruise"
  | "augment_choice"
  | "item_choice"
  | "lineup_card"
  | "refresh_self_state"
  | "manual_match_variables"
  | (string & {});

export type RuntimeState = {
  device_connection?: {
    status?: string;
    checked_at?: string | null;
    adb_path?: string | null;
    adb_target?: { serial?: string; port?: number; score?: number } | null;
    ui_hint?: string | null;
  };
  match_session?: {
    status?: string;
    ui_status?: "preparing" | "ready" | "degraded" | "failed" | string;
    ui_ready?: boolean;
    match_session_id?: string | null;
  };
  match_connection?: {
    status?: string;
    connected_at?: string | null;
    last_live_state_at?: string | null;
    last_live_state_match_session_id?: string | null;
    rejected_live_state_match_session_id?: string | null;
    source_health?: {
      adb_connected?: boolean;
      adb_target?: string | null;
      structured_source_status?: string | null;
      source_revision?: number | null;
      diagnostic?: string | null;
      updated_at?: string | null;
    } | null;
  };
  rankings_status?: {
    status?: string | null;
    ok?: boolean | null;
    stat_date?: string | null;
    generated_at?: string | null;
    updated_at?: string | null;
    published_at?: string | null;
    completed_at?: string | null;
    error?: string | null;
    snapshot_in_use?: string | null;
    ranking_overlay_identity?: {
      ranking_overlay_id?: string | null;
      ranking_stat_date?: string | null;
      core_profile_id?: string | null;
      season_id?: string | null;
      patch_id?: string | null;
    } | null;
    capability_status?: {
      overall_status?: string | null;
      strength_status?: string | null;
      recipe_status?: string | null;
      hero_status?: string | null;
      item_status?: string | null;
      roster_status?: string | null;
      semantic_maintenance_status?: string | null;
      full_ranking_overlay_available?: boolean;
      partial_domains?: string[];
      blocking?: boolean;
    } | null;
    strength_status?: string | null;
    recipe_status?: string | null;
    hero_status?: string | null;
    item_status?: string | null;
    roster_status?: string | null;
    semantic_maintenance_status?: string | null;
    full_ranking_overlay_available?: boolean;
    partial_domains?: string[];
    candidate_stat_date?: string | null;
    candidate_generation_id?: string | null;
    pending_maintenance_input_hash?: string | null;
    pending_maintenance_failure_code?: string | null;
    pending_maintenance_failure_reason?: string | null;
    active_snapshot_unchanged?: boolean;
    retryable?: boolean;
  } | null;
  ranking_status_view?: RankingStatusViewModel | null;
  ranking_update_task?: {
    schema?: string;
    task_id?: string | null;
    owner_instance_id?: string | null;
    status?: string | null;
    terminal?: boolean;
    progress?: {
      phase?: string | null;
      completed_steps?: number;
      total_steps?: number;
    } | null;
    created_at?: string | null;
    queued_at?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    failed_at?: string | null;
    error?: string | null;
    result_status?: string | null;
    candidate_stat_date?: string | null;
    candidate_generation_id?: string | null;
    published_stat_date?: string | null;
    published_snapshot_id?: string | null;
    published_at?: string | null;
  } | null;
  self_state_refresh?: {
    status?: string | null;
    last_stage_round?: string | null;
    last_economy?: {
      hp?: number | null;
      gold?: number | null;
      level?: number | null;
      xp?: number | string | { value?: number; to_next?: number; display?: string } | null;
    } | null;
    last_missing_fields?: string[];
    phase?: string | null;
    stage_round?: string | null;
    hp?: number | string | null;
    gold?: number | string | null;
    level?: number | string | null;
    xp?: number | string | null;
    reason?: string | null;
    last_started_at?: string | null;
    last_completed_at?: string | null;
    last_failed_at?: string | null;
    last_self_state_roi_completed_at?: string | null;
    last_error?: string | null;
    error?: string | null;
    run_id?: string | null;
    source?: string | null;
  } | null;
  manual_match_variables?: {
    schema?: string;
    match_session_id?: string | null;
    source?: string | null;
    confidence?: string | null;
    confirmed_at?: string | null;
    values?: {
      target_plan_text?: string | null;
      season_variables?: Record<string, string | string[] | null>;
      [key: string]: unknown;
    };
  } | null;
  visual_request_status?: {
    status?: string;
    mode?: string;
    phase?: string | null;
    stage_round?: string | null;
    reason?: string;
    request_id?: string | null;
    pipeline_file?: string | null;
    fast_choice_hint?: FastChoiceHint | null;
    queued_at?: string;
  } | null;
  response_task?: {
    status?: string;
    response_task_id?: string | null;
    revision?: number;
    mode?: string;
    origin?: string | null;
    structured_card_action?: boolean;
    match_session_id?: string | null;
    delivered_at?: string | null;
    error?: string;
    host_diagnostics?: HostDiagnostics | null;
    expiry_policy?: string | null;
    fast_choice_hint?: FastChoiceHint | null;
    fallback_response?: CoachResponse | null;
    response?: CoachResponse | null;
  } | null;
  watcher?: {
    status?: string;
    pid?: number;
    exit_code?: number | null;
    error?: string | null;
  } | null;
  active_mode?: string;
  host_cli?: {
    provider?: string;
    display_name?: string | null;
    available?: boolean;
    version?: string | null;
    default_model?: string | null;
    default_model_label?: string | null;
    error?: string | null;
    codex_available?: boolean;
    codex_version?: string | null;
    codex_error?: string | null;
    command?: string | null;
    kimi_home?: string | null;
    selected_model?: string | null;
    reasoning_effort?: string | null;
    capabilities?: {
      schema?: string;
      selected_model?: string | null;
      reasoning_effort_source?: string;
      reasoning_effort_options?: ReasoningEffortOption[];
      policy?: string;
    } | null;
    model_options?: ModelOption[];
    model_options_error?: string | null;
  };
  user_preferences?: {
    schema?: string;
    rank_tier?: string;
    operation_speed?: string;
    default_goal?: string;
    source?: string;
    updated_at?: string;
  };
  runtime_settings?: {
    schema?: string;
    diagnostic_evidence_enabled?: boolean;
    diagnostic_retention_days?: number;
    source?: string;
    updated_at?: string;
  };
  resolved_decision_snapshot?: {
    live_state_summary?: {
      phase?: { stage_round?: string | null } | null;
      own_board?: {
        units?: Array<{
          name?: string | null;
          champion_name?: string | null;
          star?: number | null;
          position?: { row?: number | null; col?: number | null } | null;
        }>;
      } | null;
    } | null;
  } | null;
};

export type HostDiagnostics =
  | string
  | number
  | boolean
  | null
  | HostDiagnostics[]
  | { [key: string]: HostDiagnostics };

export type HostCliAgentCandidate = {
  provider: string;
  display_name?: string | null;
  available?: boolean;
  discovery_status?: "available" | "not_found" | "probe_failed" | "runtime_required" | string;
  command?: string | null;
  kimi_home?: string | null;
  version?: string | null;
  default_model?: string | null;
  default_model_label?: string | null;
  error?: string | null;
  protocol?: string | null;
  login_status?: string | null;
  capabilities?: NonNullable<RuntimeState["host_cli"]>["capabilities"];
  model_options?: ModelOption[];
  model_options_error?: string | null;
};

export type ModelOption = {
  value: string;
  label: string;
  native?: boolean;
  display_name?: string | null;
  default_model_label?: string | null;
  capabilities?: string[];
  supported_reasoning_levels?: string[];
  default_reasoning_level?: string | null;
};

export type ReasoningEffortOption = {
  value: string;
  label: string;
  native?: boolean;
};

export function hostCliCandidateStatusLabel(candidate?: HostCliAgentCandidate | null) {
  if (candidate?.available || candidate?.discovery_status === "available") return "Found";
  if (candidate?.discovery_status === "runtime_required") return "Electron required";
  if (candidate?.discovery_status === "probe_failed") return "Detected, unavailable";
  return "Not found";
}

export function preferredAvailableHostProvider({
  agents,
  selectedProvider,
  canonicalProvider,
}: {
  agents: HostCliAgentCandidate[];
  selectedProvider?: string | null;
  canonicalProvider?: string | null;
}) {
  for (const provider of [selectedProvider, canonicalProvider]) {
    if (provider && agents.some((agent) => agent.provider === provider && agent.available)) return provider;
  }
  return agents.find((agent) => agent.available)?.provider ?? null;
}

export function pinnedPanelShouldBeVisible({
  explicitlyOpen,
  lineupPlan,
  lineupStatus,
  activeMode,
}: {
  explicitlyOpen: boolean;
  lineupPlan?: unknown;
  lineupStatus: string;
  activeMode: RuntimeModeId;
}) {
  return explicitlyOpen
    || Boolean(lineupPlan)
    || lineupStatus !== "idle"
    || activeMode === "lineup"
    || activeMode === "vars";
}

export type RuntimeResult<T = Record<string, unknown>> = {
  ok: boolean;
  error?: string;
  status?: string;
  message?: string;
  state?: RuntimeState;
  task_id?: string | null;
  ranking_update_task?: RuntimeState["ranking_update_task"];
  rejected_base_match_session_id?: string | null;
  fast_choice_hint?: FastChoiceHint;
} & T;

export type RankingUpdateResult = {
  ok: boolean;
  error?: string;
  status?: string;
  message?: string;
  state?: RuntimeState;
  task_id?: string | null;
  ranking_update_task?: RuntimeState["ranking_update_task"];
};

export type StartMatchResult = {
  match_created?: boolean;
  ready?: boolean;
  watcher_ready?: boolean;
  host_ready?: boolean;
  degraded_reasons?: string[];
  watcher?: RuntimeWatcherResult;
  host_warmup?: {
    ok?: boolean;
    status?: string;
    route_key?: string;
    capsule_id?: string;
    provider_session_id?: string | null;
    error?: string;
  };
  previous_match_route_close?: {
    accepted?: boolean;
    host_session_key?: string | null;
    error?: string;
  } | null;
};

export type StrategyWikiPage = {
  page_id?: string;
  category?: string;
  title?: string;
  status?: string;
  summary?: string;
  confidence?: string;
  updated_at?: string;
  scope?: "cross_season" | "current_season" | "unclassified" | string;
};

export type StrategyWikiStatus = {
  schema?: string;
  draft_pages?: StrategyWikiPage[];
  published_pages?: StrategyWikiPage[];
  stale_pages?: StrategyWikiPage[];
  pending_questions?: string[];
  recent_runs?: Array<{
    run_id?: string;
    trigger_type?: string;
    status?: string;
    created_at?: string;
    completed_at?: string | null;
    page_ids?: string[];
    stale_page_ids?: string[];
    user_questions?: string[];
  }>;
  latest_completed_run?: {
    run_id?: string;
    status?: string;
    completed_at?: string | null;
    user_questions?: string[];
  } | null;
};

export type RuntimeEvent = {
  schema?: string;
  event_id?: number;
  sequence?: number;
  type?: string;
  payload?: Record<string, unknown>;
  observed_at?: string;
};

export type RuntimeWatcherResult = {
  ok?: boolean;
  watcher?: {
    error?: string;
    status?: string;
    pid?: number;
  };
  status?: string;
  error?: string;
};

export type CoachResponse = {
  schema?: string;
  generated_by?: string;
  request_id?: string;
  request_hash?: string;
  mode?: BackendRuntimeModeId;
  final_text?: string;
  delivery_text?: string;
  host_final_text?: string;
  runtime_fact_appendix?: string | null;
  runtime_materialization?: {
    schema?: string;
    selected_candidate_refs?: Array<Record<string, unknown>>;
    candidate_presentations?: Array<Record<string, unknown>>;
    selection_resolution_errors?: Array<Record<string, unknown>>;
  } | null;
  confidence?: string;
  recommended_action?: string | null;
  pinned_result?: PinnedResultPayload | null;
};

export type FastChoiceHint = {
  hint_id?: string;
  final_text?: string;
  confidence?: string;
  user_visible?: number | boolean;
  answer_layer?: string;
  mode?: string;
};

export type RuntimePhaseTrigger = {
  mode?: BackendRuntimeModeId;
  stage_round?: string;
  reason?: string;
  status?: string;
  visual_request_id?: string | null;
};

export type MissingChoicePrompt = {
  key?: string;
  kind?: "augment" | "god" | string;
  label?: string;
  choice_stage_round?: string;
  current_stage_round?: string;
  prompt?: string;
};

export type PinnedResultPayload = {
  schema?: "jcc-internal-lineup-plan-v1";
  slot?: "lineup" | "target" | "transition";
  title?: string;
  summary?: string;
  degraded?: boolean;
  provenance?: Record<string, unknown>;
  units?: {
    row?: number;
    col?: number;
    name?: string;
    mark?: "move" | "danger" | "anchor";
  }[];
  loadouts?: {
    unit?: string;
    items?: string[];
    note?: string;
  }[];
  equipment_status?: "provided" | "not_provided_in_evidence" | "unknown" | "pending";
  moves?: string[];
};

export type ManualVariablesPayload = {
  target: string;
  seasonVariables: Record<string, string | string[]>;
};

export type ManualVariableOption = {
  id?: string;
  name: string;
  desc?: string | null;
  short_note?: string | null;
  user_hint?: string | null;
  item_subtype?: string | null;
  item_category?: string | null;
  kind?: string | null;
  tier?: string | null;
  tier_color?: string | null;
  rounds?: string[];
  round_bucket?: string | null;
  stage_num?: number | string | null;
  stage_rounds?: string[];
  category_ids?: string[];
  category_labels?: string[];
  tags?: string[];
  search_terms?: string[];
};

export type ManualVariableOptions = Record<string, ManualVariableOption[]>;

export type DecisionCandidate = {
  slot?: number | null;
  option_id?: string | null;
  id?: string | null;
  label?: string | null;
  name?: string | null;
  display_text?: string | null;
  tier?: string | null;
  tier_color?: string | null;
  item_subtype?: string | null;
  item_category?: string | null;
  kind?: string | null;
  rounds?: string[];
  round_bucket?: string | null;
  stage_num?: number | string | null;
  stage_rounds?: string[];
  category_ids?: string[];
  category_labels?: string[];
  availability_match?: "current_stage" | "stage_mismatch" | "stage_unknown" | string | null;
  current_stage_eligible?: boolean | null;
  stage_unknown?: boolean | null;
  tags?: string[];
  primary_role?: string | null;
  browse_facets?: string[];
  usage_taxonomy_status?: string | null;
  catalog_score?: number | null;
  search_terms?: string[];
  alias_evidence?: Array<{
    kind?: string | null;
    matched?: string | null;
    confidence?: string | null;
  }>;
  ref?: {
    kind?: string | null;
    id?: string | null;
    address?: string | null;
    season_id?: string | null;
    source?: string | null;
  } | null;
};

export type DecisionEquipmentEntry = {
  name: string;
  ref?: DecisionCandidate["ref"];
  item_subtype?: string | null;
  owner_unit?: string | null;
  holder_intent?: string | null;
  slot?: number | null;
};

export type DecisionEquipmentPayload = {
  components?: DecisionEquipmentEntry[];
  completed?: DecisionEquipmentEntry[];
  radiant?: DecisionEquipmentEntry[];
  support?: DecisionEquipmentEntry[];
  artifacts?: DecisionEquipmentEntry[];
  emblems?: DecisionEquipmentEntry[];
  special?: DecisionEquipmentEntry[];
  equipped?: DecisionEquipmentEntry[];
  holder?: string | null;
};

export type DecisionPayloadBinding = {
  schema?: string;
  match_session_id?: string | null;
  stage_round?: string | null;
  choice_kind?: string | null;
  choice_window_instance_id?: string | null;
  choice_set_revision?: number;
  report_id?: string | null;
};

export type DecisionInputAction =
  | "local_advice"
  | "global_advice"
  | "equipment_all"
  | "equipment_components"
  | "equipment_completed"
  | "equipment_radiant"
  | "equipment_artifacts"
  | "equipment_emblems"
  | string;

export type DecisionInputOptions = {
  schema?: string;
  candidates?: DecisionCandidate[];
  options_by_group?: ManualVariableOptions;
  max_candidates?: number;
  current_reported_set?: {
    choice_stage_round?: string | null;
    candidates?: DecisionCandidate[];
    revision?: number;
    report_id?: string | null;
    choice_window_instance_id?: string | null;
    target_note?: string | null;
    final_selection?: unknown;
  } | null;
  current_reported_options?: DecisionCandidate[];
  current_final_selection?: {
    kind?: string | null;
    choice_stage_round?: string | null;
    choice?: string | null;
    selected_ref?: DecisionCandidate["ref"] | null;
    source?: string | null;
    confirmed_at?: string | null;
  } | null;
  inherited_candidates?: DecisionCandidate[];
  candidate_seed_variable_field?: string | null;
  current_effective_equipment?: {
    components?: DecisionEquipmentEntry[];
    completed?: DecisionEquipmentEntry[];
    radiant?: DecisionEquipmentEntry[];
    support?: DecisionEquipmentEntry[];
    artifacts?: DecisionEquipmentEntry[];
    emblems?: DecisionEquipmentEntry[];
    special?: DecisionEquipmentEntry[];
    equipped?: DecisionEquipmentEntry[];
    revision?: number;
  } | null;
  payload_binding?: DecisionPayloadBinding | null;
  choice_window_instance_id?: string;
  candidate_filters?: {
    categories?: Array<{ id: string; label: string }>;
    selected_category_ids?: string[];
    category_match_policy?: string;
  } | null;
};

export type DecisionInputPayload = {
  mode: RuntimeModeId;
  backend_mode?: string | null;
  choice_kind?: string;
  stage_round?: string;
  tier?: string | null;
  action: DecisionInputAction;
  request_advice?: boolean;
  structured_card_action_id?: string;
  advice_action?: "choice_advice" | "global_advice" | string;
  report_text?: string;
  target_note?: string;
  candidates?: DecisionCandidate[];
  equipment?: DecisionEquipmentPayload;
  changed_sections?: string[];
  changed_slots?: number[];
  payload_binding?: DecisionPayloadBinding | null;
  choice_window_instance_id?: string;
  item_choice_kind?: ItemChoiceKind;
};

export type DecisionSelectionPayload = {
  mode: RuntimeModeId;
  backend_mode?: string | null;
  choice_kind?: string;
  stage_round?: string;
  slot: number;
  selected_choice: string;
  ref?: DecisionCandidate["ref"];
  payload_binding?: DecisionPayloadBinding | null;
  choice_window_instance_id?: string;
  equipment?: DecisionEquipmentPayload;
  item_choice_kind?: ItemChoiceKind;
};

export type SeasonVariableField = {
  key: string;
  label: string;
  control: "single_select" | "multi_select";
  option_source_key: string;
  option_group: string;
  section: "primary" | "advanced";
  max_items: number;
  item_labels: string[];
  include_in_confirmation_summary?: boolean;
  source_layer?: string;
};

export type RuntimeModeIconKey = "bot" | "sparkles" | "gem" | "dumbbell" | "shield" | "eye";

export type RuntimeMatchModeDescriptor = {
  id: RuntimeModeId;
  backendMode: string;
  label: string;
  prompt: string;
  iconKey: RuntimeModeIconKey;
  secondary: boolean;
  manualChoice: boolean;
  variablePanelRole: string | null;
  factCaptureAction: {
    label: string;
    prompt: string;
    description: string | null;
    requestKind: "match_fact_capture";
  } | null;
  hardDataAction: {
    label: string;
    prompt: string;
    description: string | null;
    requestKind: "hard_data_query";
    sourcePolicy: "active_core_profile_only";
    evidencePolicyId: "active_core_profile_only";
    originActionId: "cruise_no_big_data";
  } | null;
  popularRecipeAction: {
    label: string;
    prompt: string;
    description: string | null;
    requestKind: "popular_recipe_query";
    sourcePolicy: "captured_popular_recipe_generation_only";
    evidencePolicyId: "popular_recipe_catalog_only";
    originActionId: "cruise_popular_recipe_query";
    placement: "cruise_actions_last";
  } | null;
  finalConfirmationAction: {
    label: string;
    prompt: string;
    requestKind: "host_question";
    backendMode: "lineup_card";
    lineupCardIntent: "final_target";
    lineupTargetSources: Array<"candidate" | "chat_discovery" | "user_custom">;
    requiresUserTextAfterToggle: boolean;
  } | null;
  primaryPresets: Array<{
    label: string;
    prompt: string;
    description: string | null;
    interaction: "prefill_only";
  }>;
  missingChoiceKinds: string[];
  candidateInputPolicy: string | null;
  userReportPrompt: string | null;
  refreshReportPrefix: string | null;
  choiceKind: string | null;
  cardType: string | null;
  decisionStages: string[];
  candidateCount: number | null;
  candidateCountsByKind: Record<string, number>;
  requiredCandidateFields: string[];
  adviceOptionalCandidateFields: string[];
  finalSelectionRequiredFields: string[];
  candidateLabel: string | null;
  candidateOptionGroupTerms: string[];
  candidateOptionSourceKey: string | null;
};

export type RuntimeDailyCoreTheoryAction = {
  label: string;
  prompt: string;
  description: string | null;
  requestKind: "daily_core_theory_query";
  sourcePolicy: "active_core_profile_only";
  evidencePolicyId: "active_core_profile_only";
  originActionId: "daily_no_big_data";
};

export type RuntimeDailyRankingRecommendationAction = {
  label: string;
  prompt: string;
  description: string | null;
  requestKind: "ranking_recommendation_query";
  sourcePolicy: "master_plus_ranking_and_compiled_recipe_evidence";
  evidencePolicyId: "normal_selected_context";
  originActionId: "daily_ranking_recommendation";
  defaultCount: number;
  minCount: number;
  maxCount: number;
};

type RendererModeAvailability = {
  kind?: "always" | "active_season_capability" | string;
  active_season_ids?: string[];
  required_option_groups?: string[];
};

type RendererModeMetadata = {
  ui_mode_key?: string;
  order?: number;
  short_label?: string;
  icon_key?: RuntimeModeIconKey;
  prompt?: string;
  visible_in_match_rail?: boolean;
  secondary?: boolean;
  variable_panel_role?: string;
  availability?: RendererModeAvailability;
  missing_choice_kinds?: string[];
  fact_capture_action?: {
    label?: string;
    prompt?: string;
    description?: string;
    interaction?: "prefill_fact_capture";
    request_kind?: "match_fact_capture";
  };
  hard_data_action?: {
    label?: string;
    prompt?: string;
    description?: string;
    interaction?: "prefill_hard_data_query";
    request_kind?: "hard_data_query";
    source_policy?: "active_core_profile_only";
    evidence_policy_id?: "active_core_profile_only";
    origin_action_id?: "cruise_no_big_data";
  };
  popular_recipe_action?: {
    label?: string;
    prompt?: string;
    description?: string;
    interaction?: "prefill_popular_recipe_query";
    request_kind?: "popular_recipe_query";
    source_policy?: "captured_popular_recipe_generation_only";
    evidence_policy_id?: "popular_recipe_catalog_only";
    origin_action_id?: "cruise_popular_recipe_query";
    placement?: "cruise_actions_last";
  };
  core_theory_action?: {
    label?: string;
    prompt?: string;
    description?: string;
    interaction?: "prefill_daily_core_theory_query";
    request_kind?: "daily_core_theory_query";
    source_policy?: "active_core_profile_only";
    evidence_policy_id?: "active_core_profile_only";
    origin_action_id?: "daily_no_big_data";
  };
  ranking_recommendation_action?: {
    label?: string;
    prompt?: string;
    description?: string;
    interaction?: "prefill_daily_ranking_recommendation";
    request_kind?: "ranking_recommendation_query";
    source_policy?: "master_plus_ranking_and_compiled_recipe_evidence";
    evidence_policy_id?: "normal_selected_context";
    origin_action_id?: "daily_ranking_recommendation";
    default_count?: number;
    min_count?: number;
    max_count?: number;
  };
  primary_presets?: Array<{
    label?: string;
    prompt?: string;
    description?: string;
    interaction?: "prefill_only";
  }>;
  variable_fields?: SeasonVariableField[];
};

type RuntimeUiModeDefinition = {
  renderer?: RendererModeMetadata;
  final_confirmation_action?: {
    label?: string;
    prompt?: string;
    interaction?: "prefill_confirmation_intent";
    request_kind?: "host_question";
    backend_mode?: "lineup_card";
    lineup_card_intent?: "final_target";
    lineup_target_sources?: Array<"candidate" | "chat_discovery" | "user_custom">;
    requires_user_text_after_toggle?: boolean;
  };
  season_variable_fields?: SeasonVariableField[];
  choice_kind?: string;
  confirmation_required?: boolean;
  card_report_policy?: {
    card_type?: string;
    stage_tabs?: string[];
    candidate_count?: number;
    candidate_counts_by_kind?: Record<string, number>;
    required_fields?: string[];
    advice_optional_fields?: string[];
    final_selection_required_fields?: string[];
    candidate_label?: string;
    candidate_option_group_terms?: string[];
    candidate_option_source_key?: string;
  };
  choice_poll_policy?: {
    candidate_input_policy?: string;
    user_report_contract?: {
      report_prompt?: string;
      refresh_report_prefix?: string;
    };
  };
};

export type RuntimeUiModeDefinitions = Record<string, RuntimeUiModeDefinition>;

type RuntimeUiModeContract = {
  modes?: Record<string, RuntimeUiModeDefinition>;
  cruise_mode_policy?: RuntimeUiModeDefinition & { mode_id?: string };
};

const runtimeUiModeContract = runtimeUiModeContractJson as unknown as RuntimeUiModeContract;

function rendererModeRows(seasonModeDefinitions: RuntimeUiModeDefinitions = {}) {
  const rows = Object.entries({
    ...(runtimeUiModeContract.modes || {}),
    ...seasonModeDefinitions,
  });
  const cruise = runtimeUiModeContract.cruise_mode_policy;
  if (cruise?.mode_id) rows.push([cruise.mode_id, cruise]);
  return rows;
}

function runtimeModeIsAvailable(
  renderer: RendererModeMetadata,
  activeSeasonId: string | null,
  optionGroups: ManualVariableOptions,
) {
  const availability = renderer.availability || { kind: "always" };
  if (availability.kind === "always") return true;
  if (availability.kind !== "active_season_capability") return false;
  if (!activeSeasonId) return false;
  if (availability.active_season_ids?.length && !availability.active_season_ids.includes(activeSeasonId)) return false;
  return (availability.required_option_groups || []).every((group) => {
    const options = optionGroups[group];
    return Array.isArray(options) && options.length > 0;
  });
}

export function resolveAvailableMatchModes({
  activeSeasonId,
  optionGroups,
  seasonModeDefinitions = {},
}: {
  activeSeasonId?: string | null;
  optionGroups: ManualVariableOptions;
  seasonModeDefinitions?: RuntimeUiModeDefinitions;
}): RuntimeMatchModeDescriptor[] {
  return rendererModeRows(seasonModeDefinitions)
    .filter(([, definition]) => definition.renderer?.visible_in_match_rail === true)
    .filter(([, definition]) => runtimeModeIsAvailable(definition.renderer || {}, activeSeasonId || null, optionGroups))
    .map(([backendMode, definition]) => {
      const renderer = definition.renderer || {};
      const choicePollPolicy = definition.choice_poll_policy || {};
      const userReportContract = choicePollPolicy.user_report_contract || {};
      const cardReportPolicy = definition.card_report_policy || {};
      return {
        id: String(renderer.ui_mode_key || backendMode) as RuntimeModeId,
        backendMode,
        label: String(renderer.short_label || backendMode),
        prompt: String(renderer.prompt || ""),
        iconKey: renderer.icon_key || "bot",
        secondary: renderer.secondary === true,
        manualChoice: Boolean(definition.choice_kind),
        variablePanelRole: renderer.variable_panel_role ? String(renderer.variable_panel_role) : null,
        factCaptureAction: renderer.fact_capture_action?.request_kind === "match_fact_capture"
          && renderer.fact_capture_action?.interaction === "prefill_fact_capture"
          && renderer.fact_capture_action?.label
          && renderer.fact_capture_action?.prompt
          ? {
              label: String(renderer.fact_capture_action.label),
              prompt: String(renderer.fact_capture_action.prompt),
              description: renderer.fact_capture_action.description
                ? String(renderer.fact_capture_action.description)
                : null,
              requestKind: "match_fact_capture" as const,
            }
          : null,
        hardDataAction: renderer.hard_data_action?.request_kind === "hard_data_query"
          && renderer.hard_data_action?.interaction === "prefill_hard_data_query"
          && renderer.hard_data_action?.source_policy === "active_core_profile_only"
          && renderer.hard_data_action?.evidence_policy_id === "active_core_profile_only"
          && renderer.hard_data_action?.origin_action_id === "cruise_no_big_data"
          && renderer.hard_data_action?.label
          && renderer.hard_data_action?.prompt
          ? {
              label: String(renderer.hard_data_action.label),
              prompt: String(renderer.hard_data_action.prompt),
              description: renderer.hard_data_action.description
                ? String(renderer.hard_data_action.description)
                : null,
              requestKind: "hard_data_query" as const,
              sourcePolicy: "active_core_profile_only" as const,
              evidencePolicyId: "active_core_profile_only" as const,
              originActionId: "cruise_no_big_data" as const,
            }
          : null,
        popularRecipeAction: renderer.popular_recipe_action?.request_kind === "popular_recipe_query"
          && renderer.popular_recipe_action?.interaction === "prefill_popular_recipe_query"
          && renderer.popular_recipe_action?.source_policy === "captured_popular_recipe_generation_only"
          && renderer.popular_recipe_action?.evidence_policy_id === "popular_recipe_catalog_only"
          && renderer.popular_recipe_action?.origin_action_id === "cruise_popular_recipe_query"
          && renderer.popular_recipe_action?.placement === "cruise_actions_last"
          && renderer.popular_recipe_action?.label
          && renderer.popular_recipe_action?.prompt
          ? {
              label: String(renderer.popular_recipe_action.label),
              prompt: String(renderer.popular_recipe_action.prompt),
              description: renderer.popular_recipe_action.description
                ? String(renderer.popular_recipe_action.description)
                : null,
              requestKind: "popular_recipe_query" as const,
              sourcePolicy: "captured_popular_recipe_generation_only" as const,
              evidencePolicyId: "popular_recipe_catalog_only" as const,
              originActionId: "cruise_popular_recipe_query" as const,
              placement: "cruise_actions_last" as const,
            }
          : null,
        finalConfirmationAction: definition.final_confirmation_action?.request_kind === "host_question"
          && definition.final_confirmation_action?.interaction === "prefill_confirmation_intent"
          && definition.final_confirmation_action?.backend_mode === "lineup_card"
          && definition.final_confirmation_action?.lineup_card_intent === "final_target"
          && definition.final_confirmation_action?.label
          && definition.final_confirmation_action?.prompt
          ? {
              label: String(definition.final_confirmation_action.label),
              prompt: String(definition.final_confirmation_action.prompt),
              requestKind: "host_question" as const,
              backendMode: "lineup_card" as const,
              lineupCardIntent: "final_target" as const,
              lineupTargetSources: (definition.final_confirmation_action.lineup_target_sources || ["candidate", "chat_discovery", "user_custom"]) as Array<"candidate" | "chat_discovery" | "user_custom">,
              requiresUserTextAfterToggle: definition.final_confirmation_action.requires_user_text_after_toggle !== false,
            }
          : null,
        primaryPresets: (renderer.primary_presets || [])
          .map((preset) => {
            return {
              label: String(preset.label || ""),
              prompt: String(preset.prompt || ""),
              description: preset.description ? String(preset.description) : null,
              interaction: "prefill_only" as const,
            };
          })
          .filter((preset) => preset.label && preset.prompt),
        missingChoiceKinds: (renderer.missing_choice_kinds || []).map(String).filter(Boolean),
        candidateInputPolicy: choicePollPolicy.candidate_input_policy
          ? String(choicePollPolicy.candidate_input_policy)
          : null,
        userReportPrompt: userReportContract.report_prompt
          ? String(userReportContract.report_prompt)
          : null,
        refreshReportPrefix: userReportContract.refresh_report_prefix
          ? String(userReportContract.refresh_report_prefix)
          : null,
        choiceKind: definition.choice_kind ? String(definition.choice_kind) : null,
        cardType: cardReportPolicy.card_type ? String(cardReportPolicy.card_type) : null,
        decisionStages: (cardReportPolicy.stage_tabs || []).map(String).filter(Boolean),
        candidateCount: Number.isFinite(Number(cardReportPolicy.candidate_count))
          ? Math.max(1, Number(cardReportPolicy.candidate_count))
          : null,
        candidateCountsByKind: Object.fromEntries(Object.entries(cardReportPolicy.candidate_counts_by_kind || {})
          .map(([key, value]) => [String(key), Math.max(1, Number(value) || 1)])),
        requiredCandidateFields: (cardReportPolicy.required_fields || []).map(String).filter(Boolean),
        adviceOptionalCandidateFields: (cardReportPolicy.advice_optional_fields || []).map(String).filter(Boolean),
        finalSelectionRequiredFields: (cardReportPolicy.final_selection_required_fields || cardReportPolicy.required_fields || []).map(String).filter(Boolean),
        candidateLabel: cardReportPolicy.candidate_label ? String(cardReportPolicy.candidate_label) : null,
        candidateOptionGroupTerms: (cardReportPolicy.candidate_option_group_terms || []).map(String).filter(Boolean),
        candidateOptionSourceKey: cardReportPolicy.candidate_option_source_key
          ? String(cardReportPolicy.candidate_option_source_key)
          : null,
        order: Number(renderer.order) || 1000,
      };
    })
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...mode }) => mode);
}

export function resolveDailyCoreTheoryAction(): RuntimeDailyCoreTheoryAction | null {
  const definition = runtimeUiModeContract.modes?.daily_chat;
  const action = definition?.renderer?.core_theory_action;
  if (
    action?.request_kind !== "daily_core_theory_query"
    || action?.interaction !== "prefill_daily_core_theory_query"
    || action?.source_policy !== "active_core_profile_only"
    || action?.evidence_policy_id !== "active_core_profile_only"
    || action?.origin_action_id !== "daily_no_big_data"
    || !action?.label
    || !action?.prompt
  ) return null;
  return {
    label: String(action.label),
    prompt: String(action.prompt),
    description: action.description ? String(action.description) : null,
    requestKind: "daily_core_theory_query",
    sourcePolicy: "active_core_profile_only",
    evidencePolicyId: "active_core_profile_only",
    originActionId: "daily_no_big_data",
  };
}

export function resolveDailyRankingRecommendationAction(): RuntimeDailyRankingRecommendationAction | null {
  const definition = runtimeUiModeContract.modes?.daily_chat;
  const action = definition?.renderer?.ranking_recommendation_action;
  if (
    action?.request_kind !== "ranking_recommendation_query"
    || action?.interaction !== "prefill_daily_ranking_recommendation"
    || action?.source_policy !== "master_plus_ranking_and_compiled_recipe_evidence"
    || action?.evidence_policy_id !== "normal_selected_context"
    || action?.origin_action_id !== "daily_ranking_recommendation"
    || !action?.label
    || !action?.prompt
  ) return null;
  const minCount = Math.max(1, Number(action.min_count) || 1);
  const maxCount = Math.max(minCount, Math.min(16, Number(action.max_count) || 16));
  const defaultCount = Math.max(minCount, Math.min(maxCount, Number(action.default_count) || 5));
  return {
    label: String(action.label),
    prompt: String(action.prompt),
    description: action.description ? String(action.description) : null,
    requestKind: "ranking_recommendation_query",
    sourcePolicy: "master_plus_ranking_and_compiled_recipe_evidence",
    evidencePolicyId: "normal_selected_context",
    originActionId: "daily_ranking_recommendation",
    defaultCount,
    minCount,
    maxCount,
  };
}

export function uiModeFromBackendMode(
  backendMode?: string | null,
  modes = resolveAvailableMatchModes({ activeSeasonId: null, optionGroups: {} }),
) {
  return modes.find((mode) => mode.backendMode === backendMode)?.id ?? null;
}

export function backendModeFromUiMode(
  uiMode: RuntimeModeId,
  modes: RuntimeMatchModeDescriptor[],
) {
  return modes.find((mode) => mode.id === uiMode)?.backendMode ?? null;
}

export function manualChoiceBackendMode(
  backendMode?: string | null,
  modes: RuntimeMatchModeDescriptor[] = [],
) {
  return modes.some((mode) => mode.backendMode === backendMode && mode.manualChoice);
}

export function missingChoicePromptIsAvailable(
  prompt: MissingChoicePrompt | null | undefined,
  modes: RuntimeMatchModeDescriptor[],
) {
  const kind = String(prompt?.kind || "").trim();
  if (!kind) return false;
  return modes.some((mode) => mode.missingChoiceKinds.includes(kind));
}

export type UserPreferencesPayload = {
  rank_tier: string;
  operation_speed: string;
  default_goal: string;
};

export type RuntimeSettingsPayload = {
  diagnostic_evidence_enabled: boolean;
  diagnostic_retention_days?: number;
};

export type SendMessagePayload = {
  text: string;
  mode: RuntimeModeId | DailyModeId;
  item_choice_kind?: ItemChoiceKind;
  request_kind?: "host_question" | "match_fact_capture";
  lineup_confirmation_requested?: boolean;
  ranking_recommendation?: boolean;
  ranking_requested_count?: number;
  ranking_query_route_key?: string;
};

export type RuntimeBridge = {
  bootstrap(): Promise<RuntimeResult>;
  discoverHostCliAgents(payload: { model?: string; reasoning_effort?: string; search_roots?: string[] }): Promise<RuntimeResult<{ agents?: HostCliAgentCandidate[]; discovery?: { agents?: HostCliAgentCandidate[] } }>>;
  detectHostCli(payload: { provider?: string; command?: string; model?: string; reasoning_effort?: string }): Promise<RuntimeResult<{ host_cli?: RuntimeState["host_cli"]; attempts?: unknown[] }>>;
  connectMumu(): Promise<RuntimeResult<{ discovery?: unknown }>>;
  startMatch(): Promise<RuntimeResult<StartMatchResult>>;
  stopMatch(): Promise<RuntimeResult<{ match_stopped?: boolean; watcher_termination?: unknown }>>;
  setMode(mode: RuntimeModeId | DailyModeId): Promise<RuntimeResult<{ fast_choice_hint?: FastChoiceHint; fast_choice_text?: unknown }>>;
  sendMessage(payload: SendMessagePayload): Promise<RuntimeResult<{ response?: CoachResponse; response_task?: RuntimeState["response_task"]; host_request?: unknown; fast_choice_hint?: FastChoiceHint; fast_choice_text?: unknown }>>;
  sendCruiseHardDataQuery(text: string): Promise<RuntimeResult<{ response?: CoachResponse; response_task?: RuntimeState["response_task"]; host_request?: unknown }>>;
  sendDailyCoreTheoryQuery(text: string): Promise<RuntimeResult<{ response?: CoachResponse; response_task?: RuntimeState["response_task"]; host_request?: unknown }>>;
  sendCruisePopularRecipeQuery(text: string): Promise<RuntimeResult<{ response?: CoachResponse; response_task?: RuntimeState["response_task"]; host_request?: unknown }>>;
  stopResponse(payload?: { response_task_id?: string | null; response_task_revision?: number | null }): Promise<RuntimeResult>;
  getDecisionInputOptions(payload: {
    mode: RuntimeModeId;
    backend_mode?: string | null;
    choice_kind?: string;
    stage_round?: string;
    tier?: string | null;
    category_ids?: string[];
    query?: string;
    limit?: number;
    item_choice_kind?: ItemChoiceKind;
    choice_window_instance_id?: string;
  }): Promise<RuntimeResult<{ options?: DecisionInputOptions; payload_binding?: DecisionPayloadBinding }>>;
  captureDecisionInputOcrDraft(payload: {
    mode: RuntimeModeId;
    backend_mode?: string | null;
    choice_kind?: string;
    stage_round?: string;
    tier?: string | null;
  }): Promise<RuntimeResult<{ draft_candidates?: DecisionCandidate[]; diagnostics?: Record<string, unknown> }>>;
  submitDecisionInput(payload: DecisionInputPayload): Promise<RuntimeResult<{
    response?: CoachResponse;
    response_task?: RuntimeState["response_task"];
    user_confirmed_equipment_update?: DecisionInputOptions["current_effective_equipment"];
  }>>;
  confirmDecisionSelection(payload: DecisionSelectionPayload): Promise<RuntimeResult<{ response?: CoachResponse; response_task?: RuntimeState["response_task"] }>>;
  getManualVariableOptions(): Promise<RuntimeResult<{
    options?: ManualVariableOptions;
    season_variable_fields?: SeasonVariableField[];
    prompt_at_match_start?: string[];
    active_season_id?: string | null;
    active_patch_id?: string | null;
    active_season_ui_modes?: RuntimeUiModeDefinitions;
  }>>;
  saveManualVariables(payload: ManualVariablesPayload): Promise<RuntimeResult<{ variables?: RuntimeState["manual_match_variables"]; response?: CoachResponse; response_task?: RuntimeState["response_task"] }>>;
  saveUserPreferences(payload: UserPreferencesPayload): Promise<RuntimeResult<{ user_preferences?: RuntimeState["user_preferences"] }>>;
  saveRuntimeSettings(payload: RuntimeSettingsPayload): Promise<RuntimeResult<{ runtime_settings?: RuntimeState["runtime_settings"] }>>;
  saveStrategyMemory(payload: { text: string }): Promise<RuntimeResult<{ result?: { conflict_count?: number; agent_notice_events?: { user_visible_text?: string }[] }; user_strategy_memory?: unknown }>>;
  buildWikiCurationRequest(payload?: { season_id?: string; patch_id?: string; trigger?: string; limit?: number }): Promise<RuntimeResult<{ wiki_curation_request?: unknown; apply_result?: { written_pages?: unknown[]; stale_updates?: unknown[]; user_questions?: string[] }; result?: { source_event_ids?: number[] } }>>;
  getStrategyWikiStatus(): Promise<RuntimeResult<{ wiki_status?: StrategyWikiStatus }>>;
  updateRankings(): Promise<RankingUpdateResult>;
  observeRuntimeTick(): Promise<RuntimeResult<{
    runtime_events?: RuntimeEvent[];
    advice_eligible_events?: RuntimeEvent[];
    prompt?: MissingChoicePrompt;
    phase_trigger?: RuntimePhaseTrigger | null;
    advice_gate?: unknown;
    runtime_event?: RuntimeEvent;
    response_task?: RuntimeState["response_task"];
    fallback_response?: CoachResponse | null;
  }>>;
  deliverReadyResponse(): Promise<RuntimeResult<{ response?: CoachResponse; fallback_response?: CoachResponse; response_task?: RuntimeState["response_task"] }>>;
  ackDeliveredResponse(payload?: { response_task_id?: string | null; response_task_revision?: number | null; reason?: string }): Promise<RuntimeResult<{ response_task?: RuntimeState["response_task"] }>>;
  pollCruiseAdvice(): Promise<RuntimeResult<{ response?: CoachResponse; fallback_response?: CoachResponse; response_task?: RuntimeState["response_task"]; host_request?: unknown; phase_trigger?: RuntimePhaseTrigger; fast_choice_hint?: FastChoiceHint; prompt?: MissingChoicePrompt }>>;
  resetDailySession(): Promise<RuntimeResult>;
  restartRuntimeDaemon(): Promise<RuntimeResult<{ daemon?: unknown }>>;
  getState(): Promise<RuntimeResult>;
  minimizeWindow(): Promise<RuntimeResult>;
  closeWindow(): Promise<RuntimeResult>;
  onRuntimeEvent?(callback: (event: RuntimeEvent) => void): () => void;
};

export type RuntimeDeliveryStream = "daily" | "match";

export type RuntimeReconcileRequest = {
  sequence?: number | null;
  observe?: boolean;
  reason: string;
};

type RuntimeDeliveryDecision = {
  action: "deliver" | "suppress_and_ack" | "defer_without_ack";
  stream: RuntimeDeliveryStream;
  reason: string;
};

export type LineupDeliveryGuardDecision = "deliver" | "defer_without_ack" | "suppress_and_ack";

const dailyResponseTaskModes = new Set([
  "daily_chat",
  "postgame_review",
  "user_preferences",
  "strategy_wiki",
]);

export function responseTaskDeliveryDecision({
  task,
  state,
}: {
  task?: RuntimeState["response_task"] | null;
  state?: RuntimeState | null;
}): RuntimeDeliveryDecision {
  const taskMode = String(task?.mode || "");
  const taskMatchSessionId = typeof task?.match_session_id === "string" && task.match_session_id
    ? task.match_session_id
    : null;
  const activeMatchSessionId = state?.match_session?.status === "active"
    ? state.match_session.match_session_id || null
    : null;
  const matchScoped = Boolean(taskMatchSessionId)
    || Boolean(activeMatchSessionId && taskMode && !dailyResponseTaskModes.has(taskMode));
  const stream: RuntimeDeliveryStream = matchScoped && !dailyResponseTaskModes.has(taskMode) ? "match" : "daily";

  if (stream === "match") {
    if (!activeMatchSessionId) {
      return { action: "suppress_and_ack", stream, reason: "match_response_without_active_match" };
    }
    if (taskMatchSessionId && taskMatchSessionId !== activeMatchSessionId) {
      return { action: "suppress_and_ack", stream, reason: "response_task_match_session_mismatch" };
    }
    // The selected card is navigation, not an answer owner. The canonical
    // task and backend freshness checks own delivery even while a card is open.
  }

  return { action: "deliver", stream, reason: "response_task_session_route" };
}

export function runtimeResultGenerationIsCurrent(requestGeneration: number, currentGeneration: number) {
  return requestGeneration === currentGeneration;
}

export function dailyDeliveryNeedsActiveMatchNotice({
  stream,
  state,
}: {
  stream: RuntimeDeliveryStream;
  state?: RuntimeState | null;
}) {
  return stream === "daily" && state?.match_session?.status === "active";
}

export function lineupDeliveryGuardDecision({
  response,
  task,
  expectedTaskId,
  lineupRequestInFlight,
  source = "canonical",
}: {
  response?: CoachResponse | null;
  task?: RuntimeState["response_task"] | null;
  expectedTaskId?: string | null;
  lineupRequestInFlight?: boolean;
  source?: "direct" | "canonical";
}): LineupDeliveryGuardDecision {
  const responseMode = String(response?.mode || "");
  const taskMode = String(task?.mode || "");
  if (responseMode !== "lineup_card" && taskMode !== "lineup_card") return "deliver";
  const actualTaskId = task?.response_task_id ?? null;
  if (expectedTaskId && actualTaskId && actualTaskId !== expectedTaskId) return "suppress_and_ack";
  if (source === "canonical" && lineupRequestInFlight && !expectedTaskId) return "defer_without_ack";
  return "deliver";
}

export function lineupDeliveryIsBlockedByGuard(args: Parameters<typeof lineupDeliveryGuardDecision>[0]) {
  return lineupDeliveryGuardDecision(args) !== "deliver";
}

export function pinnedResultIsPublishable(payload?: PinnedResultPayload | null) {
  if (!payload || typeof payload !== "object" || payload.degraded) return false;
  if (payload.schema && payload.schema !== "jcc-internal-lineup-plan-v1") return false;
  const units = Array.isArray(payload.units) ? payload.units : [];
  if (units.length < 4) return false;
  const occupied = new Set<string>();
  for (const unit of units) {
    const row = Number(unit?.row);
    const col = Number(unit?.col);
    const name = String(unit?.name || "").trim();
    const key = `${row}:${col}`;
    if (!name || row < 1 || row > 4 || col < 1 || col > 7 || occupied.has(key)) return false;
    occupied.add(key);
  }
  const loadouts = Array.isArray(payload.loadouts) ? payload.loadouts : [];
  const hasKnownEquipment = loadouts.some((loadout) => (
    String(loadout?.unit || "").trim()
    && Array.isArray(loadout?.items)
    && loadout.items.some((item) => String(item || "").trim())
  ));
  const equipmentExplicitlyUnknown = ["not_provided_in_evidence", "unknown", "pending"].includes(
    String(payload.equipment_status || "").trim(),
  );
  if (!hasKnownEquipment && !equipmentExplicitlyUnknown) {
    return false;
  }
  return Array.isArray(payload.moves) && payload.moves.some((move) => String(move || "").trim());
}

export function createRuntimeReconcileDrain(
  run: (request: Required<Pick<RuntimeReconcileRequest, "reason">> & { sequence: number; observe: boolean }) => Promise<void>,
) {
  let running = false;
  let requestedVersion = 0;
  let processedVersion = 0;
  let highestRequestedSequence = 0;
  let processedSequence = 0;
  let pendingObserve = false;
  let latestReason = "runtime reconcile";
  let lastError: unknown = null;
  const idleWaiters = new Set<() => void>();

  const settleIdleWaiters = () => {
    if (running || processedVersion < requestedVersion) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (processedVersion < requestedVersion) {
        const targetVersion = requestedVersion;
        const targetSequence = highestRequestedSequence;
        const observe = pendingObserve;
        const reason = latestReason;
        pendingObserve = false;
        try {
          await run({ sequence: targetSequence, observe, reason });
          lastError = null;
        } catch (error) {
          lastError = error;
        }
        processedVersion = targetVersion;
        processedSequence = Math.max(processedSequence, targetSequence);
      }
    } finally {
      running = false;
      if (processedVersion < requestedVersion) void drain();
      else settleIdleWaiters();
    }
  };

  return {
    request(request: RuntimeReconcileRequest) {
      const sequence = Number(request.sequence);
      const hasSequence = Number.isInteger(sequence) && sequence > 0;
      if (hasSequence && sequence <= Math.max(highestRequestedSequence, processedSequence)) {
        if (!request.observe) return false;
        requestedVersion += 1;
        pendingObserve = true;
        latestReason = request.reason || latestReason;
        void drain();
        return true;
      }
      requestedVersion += 1;
      if (hasSequence) highestRequestedSequence = Math.max(highestRequestedSequence, sequence);
      pendingObserve ||= Boolean(request.observe);
      latestReason = request.reason || latestReason;
      void drain();
      return true;
    },
    whenIdle() {
      if (!running && processedVersion >= requestedVersion) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
    snapshot() {
      return {
        running,
        requestedVersion,
        processedVersion,
        highestRequestedSequence,
        processedSequence,
        lastError,
      };
    },
  };
}

export async function reconcileCanonicalRuntimeDelivery({
  runtime,
  reason,
  observe = false,
  onState,
  onObserved,
  onDelivery,
}: {
  runtime: Pick<RuntimeBridge, "getState" | "observeRuntimeTick" | "deliverReadyResponse" | "ackDeliveredResponse">;
  reason: string;
  observe?: boolean;
  onState?: (state?: RuntimeState) => void;
  onObserved?: (result: Awaited<ReturnType<RuntimeBridge["observeRuntimeTick"]>>) => void | Promise<void>;
  onDelivery: (payload: {
    stream: RuntimeDeliveryStream;
    response?: CoachResponse | null;
    fallbackResponse?: CoachResponse | null;
    task: RuntimeState["response_task"];
    result: Awaited<ReturnType<RuntimeBridge["deliverReadyResponse"]>>;
  }) => boolean | Promise<boolean>;
}) {
  if (observe) {
    const observed = await runtime.observeRuntimeTick();
    onState?.(observed.state);
    await onObserved?.(observed);
  }

  const current = await runtime.getState();
  onState?.(current.state);
  let canonicalTask = current.state?.response_task;
  if (!canonicalTask || canonicalTask.delivered_at) {
    return { status: "no_terminal_response", state: current.state, response_task: canonicalTask || null };
  }

  let delivered: Awaited<ReturnType<RuntimeBridge["deliverReadyResponse"]>> | null = null;
  if (!["completed", "failed"].includes(String(canonicalTask.status || ""))) {
    delivered = await runtime.deliverReadyResponse();
    onState?.(delivered.state);
    canonicalTask = delivered.response_task || delivered.state?.response_task || canonicalTask;
    if (
      !canonicalTask
      || canonicalTask.delivered_at
      || !["completed", "failed"].includes(String(canonicalTask.status || ""))
    ) {
      return {
        status: delivered.status || "no_terminal_response",
        state: delivered.state || current.state,
        response_task: canonicalTask || null,
        result: delivered,
      };
    }
  }

  const canonicalDecision = responseTaskDeliveryDecision({ task: canonicalTask, state: current.state });
  if (canonicalDecision.action === "defer_without_ack") {
    return { status: "deferred_without_ack", decision: canonicalDecision, response_task: canonicalTask };
  }
  if (canonicalDecision.action === "suppress_and_ack") {
    if (!canonicalTask.response_task_id || !Number.isInteger(canonicalTask.revision)) {
      return { status: "suppressed_without_ack_identity", decision: canonicalDecision, response_task: canonicalTask };
    }
    const ack = await runtime.ackDeliveredResponse({
      response_task_id: canonicalTask.response_task_id,
      response_task_revision: canonicalTask.revision,
      reason: canonicalDecision.reason,
    });
    onState?.(ack.state);
    return { status: "suppressed_and_acked", decision: canonicalDecision, response_task: canonicalTask, ack };
  }

  delivered ||= await runtime.deliverReadyResponse();
  onState?.(delivered.state);
  const deliveryTask = delivered.response_task || delivered.state?.response_task || canonicalTask;
  const deliveryDecision = responseTaskDeliveryDecision({ task: deliveryTask, state: delivered.state || current.state });
  if (deliveryDecision.action === "defer_without_ack") {
    return { status: "deferred_without_ack", decision: deliveryDecision, response_task: deliveryTask };
  }
  if (deliveryDecision.action === "suppress_and_ack") {
    if (!deliveryTask?.response_task_id || !Number.isInteger(deliveryTask.revision)) {
      return { status: "suppressed_without_ack_identity", decision: deliveryDecision, response_task: deliveryTask };
    }
    const ack = await runtime.ackDeliveredResponse({
      response_task_id: deliveryTask.response_task_id,
      response_task_revision: deliveryTask.revision,
      reason: deliveryDecision.reason,
    });
    onState?.(ack.state);
    return { status: "suppressed_and_acked", decision: deliveryDecision, response_task: deliveryTask, ack };
  }

  const terminal = delivered.status === "completed" || delivered.status === "response_failed";
  if (!terminal || !deliveryTask) return { status: delivered.status || "no_response_ready", result: delivered };
  const rendered = await onDelivery({
    stream: deliveryDecision.stream,
    response: delivered.response || deliveryTask.response || null,
    fallbackResponse: delivered.fallback_response || deliveryTask.fallback_response || null,
    task: deliveryTask,
    result: delivered,
  });
  if (!rendered) return { status: "terminal_response_not_rendered", result: delivered, response_task: deliveryTask };
  if (!deliveryTask.response_task_id || !Number.isInteger(deliveryTask.revision)) {
    return { status: "rendered_without_ack_identity", result: delivered, response_task: deliveryTask };
  }
  const ack = await runtime.ackDeliveredResponse({
    response_task_id: deliveryTask.response_task_id,
    response_task_revision: deliveryTask.revision,
    reason,
  });
  onState?.(ack.state);
  return { status: ack.ok ? "rendered_and_acked" : "rendered_ack_failed", result: delivered, response_task: deliveryTask, ack };
}

declare global {
  interface Window {
    jccRuntime?: RuntimeBridge;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mockCodexModelOptions: ModelOption[] = [
  { value: "default", label: "Default (CLI config)", native: true },
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6-Sol (gpt-5.6-sol)",
    native: true,
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    default_reasoning_level: "low",
  },
];

const mockKimiModelOptions: ModelOption[] = [
  { value: "default", label: "Default (CLI config)", native: true },
  {
    value: "kimi-code/k3",
    label: "K3 (kimi-code/k3)",
    native: true,
    supported_reasoning_levels: ["low", "high", "max"],
    default_reasoning_level: "high",
  },
];

const mockReasoningEffortLabels: Record<string, string> = {
  low: "低：更快",
  medium: "中：均衡",
  high: "高：复杂局面",
  xhigh: "超高：深度局面/复盘",
  max: "最高：重要策略决策",
  ultra: "Ultra：最强思考（慢）",
};

const mockState: RuntimeState = {
  device_connection: {
    status: "mock",
    adb_target: { serial: "127.0.0.1:7555", score: 80 },
    ui_hint: "Vite preview mock; Electron will call real MuMu discovery.",
  },
  match_session: {
    status: "idle",
    match_session_id: null,
  },
  response_task: {
    status: "idle",
    response_task_id: null,
  },
  active_mode: "daily_chat",
  host_cli: {
    provider: "codex",
    display_name: "Codex CLI",
    available: true,
    version: "codex-cli mock",
    codex_available: true,
    codex_version: "codex-cli mock",
    capabilities: {
      schema: "jcc-host-cli-capabilities-v1",
      selected_model: null,
      reasoning_effort_source: "cli_default_unknown_model",
      reasoning_effort_options: [{ value: "default", label: "跟随 CLI 默认", native: true }],
    },
  },
  user_preferences: {
    schema: "jcc-runtime-user-settings-v1",
    rank_tier: "master",
    operation_speed: "normal_can_pivot_next_round",
    default_goal: "balanced",
    source: "runtime_default",
  },
  runtime_settings: {
    schema: "jcc-runtime-settings-v1",
    diagnostic_evidence_enabled: false,
    diagnostic_retention_days: 7,
    source: "runtime_default",
  },
  rankings_status: {
    status: "ready",
    ok: true,
    stat_date: "mock",
    updated_at: new Date().toISOString(),
    snapshot_in_use: "mock",
  },
  ranking_update_task: null,
  self_state_refresh: {
    status: "idle",
  },
};

function mockBridge(): RuntimeBridge {
  const previewCapabilities = () => window.__JCC_RUNTIME_PREVIEW_CAPABILITIES__ || {};
  let previewEquippedItems: DecisionEquipmentEntry[] = [];
  let previewEquippedInitialized = false;
  const reportedDecisionSets = new Map<string, {
    choice_kind: string;
    stage_round: string;
    revision: number;
    report_id: string;
    choice_window_instance_id: string;
    candidates: DecisionCandidate[];
  }>();
  const previewOpenWindowIds = new Map<string, string>();
  const previewStage = (payload: { stage_round?: string }) => String(
    payload.stage_round || mockState.resolved_decision_snapshot?.live_state_summary?.phase?.stage_round || "",
  );
  const decisionScopeKey = (payload: { mode?: string; backend_mode?: string | null; choice_kind?: string; stage_round?: string }) => [
    String(payload.backend_mode || payload.mode || ""),
    String(payload.choice_kind || ""),
    previewStage(payload),
  ].join(":");
  const currentPreviewSet = (payload: { mode?: string; backend_mode?: string | null; choice_kind?: string; stage_round?: string; choice_window_instance_id?: string }) => {
    const scope = decisionScopeKey(payload);
    if (payload.choice_window_instance_id) return reportedDecisionSets.get(`${scope}:${payload.choice_window_instance_id}`);
    return [...reportedDecisionSets.entries()].reverse().find(([key]) => key.startsWith(`${scope}:`))?.[1];
  };
  const previewWindowId = (payload: { mode?: string; backend_mode?: string | null; choice_kind?: string; stage_round?: string; choice_window_instance_id?: string }, set?: ReturnType<typeof reportedDecisionSets.get>) => {
    const normalizedKind = String(payload.choice_kind || "").toLowerCase();
    if (normalizedKind.includes("augment")) return `augment:${previewStage(payload) || "unknown"}`;
    const scope = decisionScopeKey(payload);
    const windowId = payload.choice_window_instance_id
      || set?.choice_window_instance_id
      || previewOpenWindowIds.get(scope)
      || `item:${crypto.randomUUID()}`;
    previewOpenWindowIds.set(scope, windowId);
    return windowId;
  };
  const decisionSetKey = (payload: { mode?: string; backend_mode?: string | null; choice_kind?: string; stage_round?: string; choice_window_instance_id?: string }, set?: ReturnType<typeof reportedDecisionSets.get>) => (
    `${decisionScopeKey(payload)}:${previewWindowId(payload, set)}`
  );
  const previewBinding = (payload: { mode?: string; backend_mode?: string | null; choice_kind?: string; stage_round?: string; choice_window_instance_id?: string }, set?: ReturnType<typeof reportedDecisionSets.get>) => {
    const windowId = previewWindowId(payload, set);
    return {
      schema: "jcc-runtime-decision-input-payload-binding-v1",
      match_session_id: mockState.match_session?.match_session_id || null,
      stage_round: set?.stage_round || previewStage(payload) || null,
      choice_kind: set?.choice_kind || String(payload.choice_kind || "") || null,
      choice_window_instance_id: windowId,
      choice_set_revision: set?.revision || 0,
      report_id: set?.report_id || `${mockState.match_session?.match_session_id || "no-match"}:${String(payload.choice_kind || "choice")}:${String(payload.stage_round || "unknown")}:${windowId}:r0`,
    };
  };
  return {
    async bootstrap() {
      const injectedState = previewCapabilities().runtime_state;
      if (injectedState) Object.assign(mockState, structuredClone(injectedState));
      return { ok: true, state: mockState };
    },
    async discoverHostCliAgents() {
      return {
        ok: true,
        state: mockState,
        agents: [
          {
            provider: "codex",
            display_name: "Codex CLI",
            available: true,
            command: "codex",
            version: "codex-cli mock",
            protocol: "codex-json-event-stream",
            model_options: mockCodexModelOptions,
          },
          {
            provider: "kimi",
            display_name: "Kimi CLI",
            available: false,
            discovery_status: "runtime_required",
            command: null,
            version: null,
            protocol: "acp-json-rpc",
            error: "Browser preview cannot inspect local CLI installations. Open the Electron Runtime and scan again.",
            model_options: mockKimiModelOptions,
          },
        ],
      };
    },
    async detectHostCli(payload) {
      const requestedProvider = String(payload.provider || "codex").toLowerCase();
      if (requestedProvider !== "codex" && requestedProvider !== "kimi") {
        return {
          ok: false,
          error: `Unsupported host provider: ${requestedProvider}`,
          state: mockState,
          attempts: [],
        };
      }
      const provider = requestedProvider;
      const requestedModel = payload.model === "default" ? null : payload.model;
      const selectedCodexOption = provider === "codex"
        ? mockCodexModelOptions.find((option) => option.value === requestedModel)
        : null;
      const selectedKimiOption = provider === "kimi"
        ? mockKimiModelOptions.find((option) => option.value === requestedModel)
        : null;
      const selectedModel = provider === "codex" ? selectedCodexOption?.value ?? null : selectedKimiOption?.value ?? null;
      const supportedLevels = (selectedCodexOption || selectedKimiOption)?.supported_reasoning_levels ?? [];
      const effortOptions = [
        { value: "default", label: "跟随 CLI 默认", native: true },
        ...supportedLevels.map((value) => ({ value, label: mockReasoningEffortLabels[value] || value, native: true })),
      ];
      const requestedEffort = payload.reasoning_effort === "default" ? null : payload.reasoning_effort;
      const reasoningEffort = requestedEffort && supportedLevels.includes(requestedEffort) ? requestedEffort : null;
      mockState.host_cli = {
        provider,
        display_name: provider === "kimi" ? "Kimi CLI" : "Codex CLI",
        available: true,
        version: provider === "kimi" ? "kimi-cli mock" : "codex-cli mock",
        codex_available: provider === "codex",
        codex_version: provider === "codex" ? "codex-cli mock" : mockState.host_cli?.codex_version,
        command: payload.command ?? (provider === "kimi" ? "kimi" : "codex"),
        selected_model: selectedModel,
        reasoning_effort: reasoningEffort,
        model_options: provider === "codex" ? mockCodexModelOptions : mockKimiModelOptions,
        model_options_error: provider === "codex" && requestedModel && !selectedCodexOption
          ? `Requested model ${requestedModel} is not advertised by the selected Codex CLI; using CLI default.`
          : null,
        capabilities: {
          schema: "jcc-host-cli-capabilities-v1",
          selected_model: selectedModel,
          reasoning_effort_source: supportedLevels.length
            ? (provider === "kimi" ? "kimi_provider_list_support_efforts" : "codex_debug_models_supported_reasoning_levels")
            : "cli_default_unknown_model",
          reasoning_effort_options: effortOptions,
        },
      };
      return { ok: true, state: mockState, host_cli: mockState.host_cli, attempts: [] };
    },
    async connectMumu() {
      mockState.device_connection = {
        status: "connected",
        adb_target: { serial: "127.0.0.1:7555", score: 90 },
        ui_hint: "已连接模拟 MuMu 目标。Electron 版会真实扫描端口。",
      };
      return { ok: true, state: mockState };
    },
    async startMatch() {
      mockState.match_session = { status: "active", match_session_id: `mock-match-${Date.now()}` };
      mockState.active_mode = "cruise";
      reportedDecisionSets.clear();
      return {
        ok: true,
        match_created: true,
        ready: true,
        watcher_ready: true,
        host_ready: true,
        status: "ready",
        watcher: { ok: true, status: "mock_watcher_ready" },
        host_warmup: { ok: true, status: "mock_host_ready" },
        state: mockState,
      };
    },
    async stopMatch() {
      mockState.match_session = { status: "idle", match_session_id: null };
      mockState.active_mode = "daily_chat";
      return { ok: true, state: mockState };
    },
    async setMode(mode) {
      mockState.active_mode = mode;
      return { ok: true, state: mockState };
    },
    async sendMessage(payload) {
      mockState.response_task = { status: "running", response_task_id: `mock-response-${Date.now()}`, mode: payload.mode };
      await delay(450);
      mockState.response_task = { status: "completed", response_task_id: null, mode: payload.mode };
      return {
        ok: true,
        status: "completed",
        state: mockState,
        response_task: mockState.response_task,
        response: {
          final_text: payload.mode === "augment"
            ? "按当前巡航上下文，先留一张最稳的保底，优先刷新弱项；刷新后继续看最新三张再定。"
            : "已收到。真实 Electron 运行时会把这条消息交给 Codex CLI 主模型生成最终建议。",
          confidence: "medium",
          recommended_action: null,
        },
      };
    },
    async sendCruiseHardDataQuery(text) {
      mockState.response_task = { status: "running", response_task_id: `mock-hard-data-${Date.now()}`, mode: "cruise" };
      await delay(450);
      mockState.response_task = { status: "completed", response_task_id: null, mode: "cruise" };
      return {
        ok: true,
        status: "completed",
        state: mockState,
        response_task: mockState.response_task,
        response: {
          final_text: `已按当前 Core Profile 处理：${text}`,
          confidence: "medium",
          recommended_action: null,
        },
      };
    },
    async sendDailyCoreTheoryQuery(text) {
      mockState.response_task = { status: "running", response_task_id: `mock-daily-core-${Date.now()}`, mode: "daily_chat" };
      await delay(450);
      mockState.response_task = { status: "completed", response_task_id: null, mode: "daily_chat" };
      return {
        ok: true,
        status: "completed",
        state: mockState,
        response_task: mockState.response_task,
        response: {
          final_text: `已按当前版本硬数据和通用玩法处理：${text}`,
          confidence: "medium",
          recommended_action: null,
        },
      };
    },
    async sendCruisePopularRecipeQuery(text) {
      mockState.response_task = { status: "running", response_task_id: `mock-popular-recipe-${Date.now()}`, mode: "cruise" };
      await delay(450);
      mockState.response_task = { status: "completed", response_task_id: null, mode: "cruise" };
      return {
        ok: true,
        status: "completed",
        state: mockState,
        response_task: mockState.response_task,
        response: {
          final_text: `已按热门阵容模板处理：${text}`,
          confidence: "medium",
          recommended_action: null,
        },
      };
    },
    async ackDeliveredResponse() {
      mockState.response_task = { ...(mockState.response_task || {}), status: "idle", response_task_id: null };
      return { ok: true, status: "delivered", state: mockState };
    },
    async stopResponse(_payload) {
      mockState.response_task = { status: "cancelled", response_task_id: null };
      return { ok: true, state: mockState, message: "已停止当前回答，回到巡航。" };
    },
    async getDecisionInputOptions(payload) {
      const preview = previewCapabilities();
      const modeKey = String(payload.mode || payload.backend_mode || "");
      const itemKindKey = payload.item_choice_kind ? `${modeKey}:${payload.item_choice_kind}` : "";
      const decisionKey = [
        modeKey,
        String(payload.stage_round || ""),
        String(payload.tier || ""),
      ].join(":");
      const stageKey = [
        modeKey,
        String(payload.stage_round || ""),
      ].join(":");
      const injected = (itemKindKey ? preview.decision_options?.[itemKindKey] : undefined)
        || preview.decision_options?.[decisionKey]
        || preview.decision_options?.[stageKey]
        || preview.decision_options?.[modeKey];
      const searchTemplate = (itemKindKey ? preview.decision_options?.[`${itemKindKey}:search`] : undefined)
        || preview.decision_options?.[`${modeKey}:search`];
      if (payload.query?.trim() && searchTemplate) {
        const query = payload.query.trim().toLowerCase();
        const stageRound = String(payload.stage_round || "");
        const candidates = (searchTemplate.candidates || [])
          .filter((candidate) => [candidate.name, candidate.label, candidate.display_text, candidate.id, candidate.option_id, ...(candidate.search_terms || [])]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query)))
          .map((candidate) => {
            const rounds = Array.isArray(candidate.stage_rounds)
              ? candidate.stage_rounds.map(String)
              : Array.isArray((candidate as DecisionCandidate & { rounds?: string[] }).rounds)
                ? ((candidate as DecisionCandidate & { rounds?: string[] }).rounds || []).map(String)
                : [];
            const stageUnknown = candidate.stage_unknown === true || candidate.round_bucket === "unknown_round" || rounds.length === 0;
            return {
              ...candidate,
              availability_match: stageUnknown ? "stage_unknown" : rounds.includes(stageRound) ? "current_stage" : "stage_mismatch",
              current_stage_eligible: !stageUnknown && rounds.includes(stageRound),
              stage_unknown: stageUnknown,
              stage_rounds: rounds,
            };
          });
        const current = currentPreviewSet(payload);
        const payloadBinding = previewBinding(payload, current);
        return {
          ok: true,
          state: mockState,
          options: {
            ...(injected || searchTemplate),
            candidates,
            payload_binding: payloadBinding,
            current_reported_set: current || null,
          },
          payload_binding: payloadBinding,
        };
      }
      const current = currentPreviewSet(payload);
      const payloadBinding = previewBinding(payload, current);
      return {
        ok: true,
        state: mockState,
        options: {
          ...(injected || {
            schema: "jcc-decision-input-options-v1",
            candidates: [],
            options_by_group: {},
          }),
          payload_binding: payloadBinding,
          current_reported_set: current || null,
          current_effective_equipment: {
            ...(injected?.current_effective_equipment || {}),
            equipped: previewEquippedInitialized
              ? previewEquippedItems
              : injected?.current_effective_equipment?.equipped || [],
          },
        },
        payload_binding: payloadBinding,
      };
    },
    async captureDecisionInputOcrDraft(payload) {
      const optionsResult = await this.getDecisionInputOptions(payload);
      const candidates = (optionsResult.options?.candidates || []).slice(0, 3);
      return {
        ok: candidates.length === 3,
        status: candidates.length === 3 ? "explicit_augment_ocr_draft_ready" : "explicit_augment_ocr_draft_incomplete",
        state: mockState,
        draft_candidates: candidates,
        message: candidates.length === 3 ? "已识别三个强化并填入当前卡片草稿，请核对后再提交。" : "未识别到完整候选。",
      };
    },
    async submitDecisionInput(payload) {
      previewCapabilities().submission_log?.push({
        action: "submitDecisionInput",
        payload: structuredClone(payload),
      });
      if (payload.action === "equipment_equipped_update") {
        previewEquippedItems = structuredClone(payload.equipment?.equipped || []);
        previewEquippedInitialized = true;
        return {
          ok: true,
          status: "structured_facts_recorded",
          state: mockState,
          user_confirmed_equipment_update: {
            equipped: previewEquippedItems,
            revision: 1,
          },
          message: "已保存本局已穿装备持有关系。",
        };
      }
      if (!payload.payload_binding) {
        return { ok: false, status: "decision_input_payload_binding_required", state: mockState };
      }
      const current = currentPreviewSet(payload);
      const key = decisionSetKey(payload, current);
      const expected = previewBinding(payload, current);
      const received = payload.payload_binding;
      if (
        String(received.match_session_id || "") !== String(expected.match_session_id || "")
        || String(received.stage_round || "") !== String(expected.stage_round || "")
        || String(received.choice_kind || "") !== String(expected.choice_kind || "")
        || String(received.choice_window_instance_id || "") !== String(expected.choice_window_instance_id || "")
        || Number(received.choice_set_revision || 0) !== Number(expected.choice_set_revision || 0)
      ) {
        return { ok: false, status: "stale_decision_input_payload", state: mockState };
      }
      const candidates = payload.candidates || [];
      const nextSet = candidates.length ? {
        choice_kind: String(payload.choice_kind || ""),
        stage_round: previewStage(payload),
        choice_window_instance_id: previewWindowId(payload, current),
        revision: (current?.revision || 0) + 1,
        report_id: `${mockState.match_session?.match_session_id || "no-match"}:${String(payload.choice_kind || "choice")}:${String(payload.stage_round || "unknown")}:${previewWindowId(payload, current)}:r${(current?.revision || 0) + 1}`,
        candidates,
      } : current;
      if (nextSet) reportedDecisionSets.set(key, nextSet);
      const nextPayloadBinding = previewBinding(payload, nextSet);
      mockState.response_task = {
        status: payload.action === "global_advice" || payload.action === "local_advice" ? "awaiting_host_cli_agent_response" : "completed",
        response_task_id: `mock-decision-${Date.now()}`,
        mode: payload.backend_mode || payload.mode,
      };
      return {
        ok: true,
        status: payload.action,
        state: mockState,
        response_task: mockState.response_task,
        payload_binding: nextPayloadBinding,
        reported_choice_set: nextSet || null,
        message: "结构化决策输入已提交。",
      };
    },
    async confirmDecisionSelection(payload) {
      previewCapabilities().submission_log?.push({
        action: "confirmDecisionSelection",
        payload: structuredClone(payload),
      });
      if (!payload.payload_binding) {
        return { ok: false, status: "decision_input_payload_binding_required", state: mockState };
      }
      const current = currentPreviewSet(payload);
      if (!current) return { ok: false, status: "selected_choice_not_in_current_choice_set", state: mockState };
      const expected = previewBinding(payload, current);
      if (Number(payload.payload_binding.choice_set_revision || 0) !== expected.choice_set_revision) {
        const sameScope = String(payload.payload_binding.match_session_id || "") === String(expected.match_session_id || "")
          && String(payload.payload_binding.stage_round || "") === String(expected.stage_round || "")
          && String(payload.payload_binding.choice_kind || "") === String(expected.choice_kind || "")
          && String(payload.payload_binding.choice_window_instance_id || "") === String(expected.choice_window_instance_id || "");
        if (!sameScope) return { ok: false, status: "stale_decision_input_payload", state: mockState };
      }
      const selectedName = String(payload.selected_choice || "").trim();
      const selectedRefAddress = payload.ref?.address || null;
      if (!Number.isFinite(Number(payload.slot)) || (!selectedName && !selectedRefAddress)) {
        return { ok: false, status: "selected_choice_identity_required", state: mockState };
      }
      const selected = current.candidates.find((candidate) => (
        Number(candidate.slot) === Number(payload.slot)
        && (!selectedRefAddress || candidate.ref?.address === selectedRefAddress)
        && (!selectedName || candidate.name === selectedName || candidate.display_text === selectedName)
      ));
      if (!selected) {
        return { ok: false, status: "selected_choice_not_in_current_choice_set", state: mockState };
      }
      mockState.response_task = {
        status: "completed",
        response_task_id: `mock-confirm-${Date.now()}`,
        mode: payload.backend_mode || payload.mode,
      };
      return {
        ok: true,
        status: "choice_confirmation_recorded",
        state: mockState,
        response_task: null,
        message: "最终选择已确认。",
      };
    },
    async getManualVariableOptions() {
      const preview = previewCapabilities();
      return {
        ok: true,
        state: mockState,
        active_season_id: preview.active_season_id || null,
        active_patch_id: preview.active_patch_id || null,
        options: preview.options || {},
        season_variable_fields: preview.season_variable_fields || [],
        prompt_at_match_start: preview.prompt_at_match_start || [],
        active_season_ui_modes: preview.active_season_ui_modes || {},
        message: "浏览器预览不读取本地活动赛季数据；Electron 版会从后端加载真实选项。",
      };
    },
    async saveManualVariables(payload) {
      const target = String(payload.target || "").trim();
      mockState.manual_match_variables = {
        schema: "jcc-runtime-manual-match-variables-ui-event-v1",
        values: {
          target_plan_text: target || null,
          season_variables: payload.seasonVariables,
        },
      };
      const summary = Object.values(payload.seasonVariables || {})
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .filter(Boolean)
        .join(" / ");
      return {
        ok: true,
        state: mockState,
        variables: mockState.manual_match_variables,
        message: summary
          ? `已确认本局变量：${[summary, target].filter(Boolean).join(" / ")}。后续建议会结合当前局势、规则和大师以上数据。`
          : target
            ? `已确认本局目标：${target}。后续建议会以此为明确目标，并继续校验成立和退出条件。`
            : "本局目标已留空；后续继续根据当前局势和大师以上数据收束方向。",
      };
    },
    async saveUserPreferences(payload) {
      mockState.user_preferences = {
        schema: "jcc-runtime-user-settings-v1",
        ...payload,
        source: "user_confirmed_menu_setting",
        updated_at: new Date().toISOString(),
      };
      return { ok: true, state: mockState, user_preferences: mockState.user_preferences };
    },
    async saveRuntimeSettings(payload) {
      mockState.runtime_settings = {
        schema: "jcc-runtime-settings-v1",
        diagnostic_evidence_enabled: payload.diagnostic_evidence_enabled === true,
        diagnostic_retention_days: payload.diagnostic_retention_days || 7,
        source: "user_confirmed_menu_setting",
        updated_at: new Date().toISOString(),
      };
      return { ok: true, state: mockState, runtime_settings: mockState.runtime_settings };
    },
    async saveStrategyMemory() {
      return {
        ok: false,
        state: mockState,
        status: "preview_only",
        message: "浏览器预览不写入策略记忆；Electron 版会调用后端策略冲突检查。",
      };
    },
    async buildWikiCurationRequest() {
      return {
        ok: true,
        state: mockState,
        status: "awaiting_host_cli_agent_response",
        result: { source_event_ids: [1, 2, 3] },
        wiki_curation_request: {
          schema: "jcc-wiki-curation-host-request-v1",
          target_wiki_namespaces: [{ namespace: "personal_strategy", categories: ["patch_meta_strategy", "season_mechanic_strategy", "universal_gameplay_strategy"] }],
        },
      };
    },
    async getStrategyWikiStatus() {
      return {
        ok: true,
        state: mockState,
        status: "completed",
        wiki_status: {
          schema: "jcc-strategy-wiki-status-v1",
          draft_pages: [],
          published_pages: [],
          stale_pages: [],
          pending_questions: [],
        },
      };
    },
    async updateRankings() {
      const now = new Date().toISOString();
      const taskId = `mock-ranking-update-${Date.now()}`;
      mockState.ranking_update_task = {
        schema: "jcc-ranking-update-task-v1",
        task_id: taskId,
        status: "succeeded",
        terminal: true,
        progress: { phase: "completed", completed_steps: 5, total_steps: 5 },
        created_at: now,
        queued_at: now,
        started_at: now,
        completed_at: now,
        failed_at: null,
        error: null,
        result_status: "rankings_update_completed",
      };
      return { ok: true, status: "ranking_update_started", task_id: taskId, ranking_update_task: mockState.ranking_update_task, state: mockState };
    },
    async observeRuntimeTick() {
      return { ok: true, state: mockState, status: "runtime_observed", runtime_events: [] };
    },
    async deliverReadyResponse() {
      return { ok: true, state: mockState, status: "no_response_ready" };
    },
    async pollCruiseAdvice() {
      return { ok: true, state: mockState, status: "no_advice" };
    },
    async resetDailySession() {
      mockState.active_mode = "daily_chat";
      return { ok: true, state: mockState, status: "daily_session_reset" };
    },
    async restartRuntimeDaemon() {
      return { ok: true, state: mockState, status: "preview_noop", message: "Electron 版会重启 Runtime Daemon；浏览器预览不启动 daemon。" };
    },
    async getState() {
      return { ok: true, state: mockState };
    },
    async minimizeWindow() {
      return {
        ok: true,
        status: "preview_noop",
        state: mockState,
        message: "浏览器预览页不能最小化窗口；这里会隐藏 Runtime UI 预览。",
      };
    },
    async closeWindow() {
      return {
        ok: true,
        status: "preview_noop",
        state: mockState,
        message: "浏览器预览页不能关闭窗口；Electron 版会直接关闭 Runtime UI。",
      };
    },
    onRuntimeEvent() {
      return () => {};
    },
  };
}

export function getRuntimeBridge(): RuntimeBridge {
  return window.jccRuntime ?? mockBridge();
}

export const runtimeModeMap = Object.freeze({
  ...Object.fromEntries(
    rendererModeRows()
      .filter(([, definition]) => definition.renderer?.ui_mode_key)
      .map(([backendMode, definition]) => [definition.renderer?.ui_mode_key, backendMode]),
  ),
  chat: "daily_chat",
  prefs: "user_preferences",
  wiki: "strategy_wiki",
  review: "postgame_review",
}) as Readonly<Record<RuntimeModeId | DailyModeId, string>>;
