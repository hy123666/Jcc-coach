import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { terminateProcessTree } from "./jcc_process_runner.mjs";
import { classifyProductGateFailure, gateLayerForCheck } from "../ui/electron/product-gate-classification.js";

// This is the maximum runtime for one test process. It is deliberately
// separate from production Host/Provider timeouts and covers serial suites
// that exercise several lifecycle operations in one process.
export const DEFAULT_CHECK_TIMEOUT_MS = 300000;
const DEFAULT_PROFILE = "core";
const HYGIENE_CHECK_IDS = new Set(["repo_hygiene_audit"]);
const SLOW_CHECK_IDS = new Set([
  "start_match_symptom_regression",
  "runtime_event_pipeline_preemption",
  "full_player_journey_matrix",
]);
const LEGACY_MANUAL_CHECK_IDS = new Set(["pinned_card_browser"]);

export const CHECKS = [
  {
    id: "adb_connection_health",
    layer: "deterministic",
    command: ["tools/verify-jcc-adb-connection-health.mjs"],
    covers: ["selected_adb_probe", "stale_connection_not_online"],
  },
  {
    id: "renderer_start_match",
    layer: "deterministic",
    command: ["tools/verify-jcc-renderer-start-match.mjs"],
    covers: ["start_failure_visible_in_lobby", "start_rejection_releases_owner"],
  },
  {
    id: "watcher_bootstrap_lightweight",
    layer: "deterministic",
    command: ["tools/verify-jcc-watcher-bootstrap-lightweight.mjs"],
    covers: ["watcher_start_without_ranking_load", "isolated_storage_paths"],
  },
  {
    id: "kimi_mcp_bridge",
    layer: "deterministic",
    command: ["tools/verify-jcc-kimi-mcp-bridge.mjs"],
    covers: ["turn_bound_mcp_calls", "revocable_tool_delivery", "bounded_complete_results"],
  },
  {
    id: "kimi_mcp_session",
    layer: "provider_contract",
    command: ["tools/verify-jcc-kimi-mcp-session.mjs"],
    covers: ["verified_session_capability", "isolated_kimi_permissions", "async_mcp_readiness"],
  },
  {
    id: "kimi_mcp_installed",
    layer: "provider_contract",
    execution: "live",
    command: ["tools/verify-jcc-kimi-mcp-installed.mjs"],
    covers: ["installed_acp_native_tool_execution", "builtin_execution_denied", "model_bound_result_visibility"],
  },
  {
    id: "knowledge_delivery_semantics",
    layer: "deterministic",
    command: ["tools/verify-jcc-knowledge-delivery-semantics.mjs"],
    covers: ["honest_delivery_state", "recoverable_bound_pages", "shared_operation_instructions"],
  },
  {
    id: "provider_wire_visibility",
    layer: "provider_contract",
    execution: "live",
    command: ["tools/verify-jcc-provider-wire-visibility.mjs"],
    covers: ["real_cli_model_bound_tool_content", "no_middle_truncation"],
  },
  {
    id: "provider_evidence_visibility",
    layer: "provider_contract",
    execution: "live",
    command: ["tools/verify-jcc-provider-evidence-visibility.mjs"],
    covers: ["real_model_middle_evidence_visibility"],
  },
  {
    id: "wiki_match_recovery",
    layer: "deterministic",
    command: ["tools/verify-jcc-wiki-match-recovery.mjs"],
    timeout_ms: 300000,
    covers: ["match_wiki_revision_pin", "recovery_no_mutable_wiki_replay"],
  },
  {
    id: "wiki_scope",
    layer: "deterministic",
    command: ["tools/verify-jcc-wiki-scope.mjs"],
    covers: ["explicit_wiki_scope", "unclassified_default_exclusion"],
  },
  {
    id: "readonly_evidence_sharing",
    layer: "deterministic",
    command: ["tools/verify-jcc-readonly-evidence-sharing.mjs"],
    covers: ["same_result_lossless_sharing", "snapshot_bound_explicit_refetch"],
  },
  {
    id: "native_ranking_pull",
    layer: "deterministic",
    command: ["tools/verify-jcc-native-ranking-pull.mjs"],
    // Search, candidate hydration, exact variant lookup and recovery are
    // intentionally covered in one serial test process.
    timeout_ms: 300000,
    covers: ["complete_candidate_pull", "exact_variant_retrieval", "native_trend_without_prefetch"],
  },
  {
    id: "knowledge_relation_index",
    layer: "deterministic",
    command: ["tools/verify-jcc-knowledge-relation-index.mjs"],
    covers: ["canonical_core_details", "typed_relation_snapshot_binding"],
  },
  {
    id: "knowledge_broker_integration",
    layer: "deterministic",
    command: ["tools/verify-jcc-knowledge-broker-integration.mjs"],
    covers: ["broker_typed_relation_delivery"],
  },
  {
    id: "self_state_refresh_isolation",
    layer: "deterministic",
    command: ["tools/verify-jcc-self-state-refresh-isolation.mjs"],
    covers: ["disabled_capture_has_no_cold_bypass", "background_refresh_isolation", "failed_attempt_cooldown"],
  },
  {
    id: "augment_response_semantic_boundary",
    layer: "deterministic",
    command: ["tools/verify-jcc-augment-response-semantic-boundary.mjs"],
    covers: ["native_actions_match_semantics", "sealed_expected_set", "tier_and_plus_identity_preserved"],
  },
  {
    id: "augment_profile_resolution",
    layer: "deterministic",
    command: ["tools/verify-jcc-augment-profile-resolution.mjs"],
    covers: ["current_core_augment_profile_resolution", "catalog_identity_without_core_rewrite"],
  },
  {
    id: "player_journey_acceptance",
    layer: "deterministic",
    command: ["tools/verify-jcc-player-journey-acceptance.mjs"],
    covers: ["required_journey_turns", "real_dispatch_and_ack_evidence", "target_and_tolerance_separation"],
  },
  {
    id: "product_gate_outcome_protocol",
    layer: "deterministic",
    command: ["tools/verify-jcc-product-gate-outcome-protocol.mjs"],
    covers: ["explicit_success_envelope", "zero_exit_is_not_success", "skipped_and_failed_outcomes_rejected"],
  },
  {
    id: "host_native_schema_live",
    layer: "provider_contract",
    execution: "live",
    command: ["tools/verify-jcc-host-native-schema-live.mjs"],
    covers: ["real_provider_native_schema_acceptance"],
  },
  {
    id: "host_evidence_materialization",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-evidence-materialization.mjs"],
    covers: ["same_turn_evidence_references", "lossless_evidence_restoration", "atomic_candidate_materialization"],
  },
  {
    id: "host_schema_transport_matrix",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-schema-transport-matrix.mjs"],
    covers: ["strict_native_schema_matrix", "transport_normalization", "alias_conflict_fail_closed"],
  },
  {
    id: "host_adapter_first_token",
    layer: "provider_contract",
    command: ["tools/verify-jcc-host-adapter-first-token.mjs"],
    covers: ["first_token_receipt_time", "foreign_turn_and_reasoning_exclusion", "observer_failure_isolation"],
  },
  {
    id: "confirmed_equipment_roster_handoff",
    layer: "deterministic",
    command: ["tools/verify-jcc-confirmed-equipment-roster-handoff.mjs"],
    covers: ["confirmed_equipment_final_wire", "core_roster_tool_handoff"],
  },
  {
    id: "host_task_projection_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-task-projection-contract.mjs"],
    covers: ["task_owned_host_projection", "no_cross_task_context"],
  },
  {
    id: "ranking_status_view_model",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-status-view-model.mjs"],
    covers: ["ranking_status_view_model"],
  },
  {
    id: "host_turn_trace",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-turn-trace.mjs"],
    covers: ["host_turn_trace"],
  },
  {
    id: "product_gate_classification",
    layer: "deterministic",
    command: ["tools/verify-jcc-product-gate-classification.mjs"],
    covers: ["deterministic_provider_contract_live_acceptance_layers", "blocking_failure_classification"],
  },
  {
    id: "runtime_text_and_json_contracts",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-text-encoding.mjs"],
    covers: ["utf8_runtime_text", "all_runtime_json_parseable"],
  },
  {
    id: "product_gate_runtime_isolation",
    layer: "deterministic",
    command: ["tools/verify-jcc-product-gate-runtime-isolation.mjs"],
    covers: ["isolated_runtime_data_dir", "production_canonical_state_not_used_by_verifiers"],
  },
  {
    id: "runtime_state_store",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-state-store.mjs"],
    covers: ["sqlite_canonical_state", "legacy_json_mirror", "queue_lifecycle"],
  },
  {
    id: "single_writer_canonical_transition",
    layer: "deterministic",
    command: ["tools/verify-jcc-single-writer-canonical-state-contract.mjs"],
    covers: ["atomic_state_task_revision_outbox", "single_canonical_writer", "cas_conflict_rejection"],
  },
  {
    id: "response_task_delivery",
    layer: "deterministic",
    command: ["tools/verify-jcc-response-task-delivery-contract.mjs"],
    // Serial durability fixtures intentionally exercise expiry, restart and
    // cross-Match guards. This is a suite budget, not a Host response limit.
    timeout_ms: 360000,
    covers: ["durable_host_result", "exact_revision_ack", "stop_and_cross_match_guards"],
  },
  {
    id: "host_request_task_identity",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-request-task-identity.mjs"],
    covers: ["immutable_request_event_identity", "task_specific_request_artifacts", "no_shared_latest_request_fallback"],
  },
  {
    id: "host_response_integrity",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-response-integrity.mjs"],
    covers: ["mojibake_correction", "sanitized_host_diagnostics", "provider_error_visibility"],
  },
  {
    id: "host_response_json_decoder",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-response-json-decoder.mjs"],
    covers: ["first_complete_json_object", "adjacent_json_diagnostics", "internal_parse_error_code"],
  },
  {
    id: "app_session_boundary",
    layer: "deterministic",
    command: ["tools/verify-jcc-app-session-boundary.mjs"],
    timeout_ms: 300000,
    covers: ["fresh_app_lobby", "retired_match_queues", "late_match_completion_fence", "renderer_reload_reuse"],
  },
  {
    id: "host_session_lifecycle",
    layer: "provider_contract",
    command: ["tools/verify-jcc-host-session-lifecycle-contract.mjs"],
    // The contract intentionally covers every provider/session transition;
    // its serial fixture suite is longer than any single production turn.
    timeout_ms: 360000,
    covers: ["persistent_lobby_and_match_transport", "normal_turn_no_resume", "turn_only_cancellation", "static_bootstrap_dynamic_delta", "crash_only_resume"],
  },
  {
    id: "common_host_knowledge",
    layer: "deterministic",
    command: ["tools/verify-jcc-common-host-knowledge.mjs"],
    covers: ["complete_decision_knowledge", "deduplicated_agent_view", "natural_language_section_recovery"],
  },
  {
    id: "host_provider_timeout_boundary",
    layer: "provider_contract",
    command: ["tools/verify-jcc-host-provider-timeout-boundary.mjs"],
    covers: ["native_provider_dispatch_clock", "separate_queue_start_budget", "codex_and_kimi_dispatch_signal"],
  },
  {
    id: "host_context_storage_budget",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-context-storage-budget.mjs"],
    covers: ["in_process_request_selection", "metadata_only_request_persistence", "bounded_turn_delta", "default_off_async_diagnostics"],
  },
  {
    id: "canonical_host_request_persistence",
    layer: "deterministic",
    command: ["tools/verify-jcc-canonical-host-request-persistence.mjs"],
    covers: ["recursive_host_request_sanitization", "nested_request_reference_only", "sqlite_payload_scan"],
  },
  {
    id: "public_action_message_persistence",
    layer: "deterministic",
    command: ["tools/verify-jcc-public-action-message-persistence.mjs"],
    covers: ["public_action_metadata_only", "active_turn_text_memory_only", "sqlite_wal_shm_message_scan"],
  },
  {
    id: "host_session_live_smoke",
    layer: "live_acceptance",
    command: ["tools/verify-jcc-host-session-live-smoke.mjs"],
    timeout_ms: 300000,
    covers: ["real_provider_same_process", "real_provider_same_session", "cross_turn_context_retention", "normal_turn_no_resume"],
  },
  {
    id: "ui_host_failure_diagnostics",
    layer: "deterministic",
    command: ["tools/verify-jcc-ui-host-failure-diagnostics.mjs"],
    covers: ["typed_host_diagnostics", "generic_exit_provider_reason", "secret_and_path_redaction"],
  },
  {
    id: "runtime_mainline_paths",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-mainline-paths.mjs"],
    covers: ["runtime_data_dir_defaults", "legacy_omx_mirror_only", "product_path_hygiene"],
  },
  {
    id: "runtime_data_dir_migration",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-data-dir-migration.mjs"],
    covers: ["legacy_state_migration", "migration_marker", "sqlite_runtime_data_root"],
  },
  {
    id: "runtime_queue_concurrency",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-queue-concurrency.mjs"],
    covers: ["transactional_claim", "no_double_claim", "retry_claim"],
  },
  {
    id: "runtime_daemon_static",
    layer: "provider_contract",
    command: ["tools/verify-jcc-runtime-daemon.mjs"],
    timeout_ms: 180000,
    covers: ["os_daemon_contract", "runtime_data_dir", "sqlite_binding"],
  },
  {
    id: "runtime_daemon_server",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-daemon-server.mjs"],
    // HTTP, SSE, WebSocket, queue and shutdown checks share one daemon.
    timeout_ms: 300000,
    covers: ["http_control", "token_auth", "sse", "websocket", "queue_endpoints"],
  },
  {
    id: "runtime_event_stream",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-event-stream-contract.mjs"],
    covers: ["post_commit_events", "durable_sse_ws_replay", "reconnect_cursor", "writer_lease"],
  },
  {
    id: "runtime_writer_lease_identity",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-writer-lease-identity.mjs"],
    covers: ["process_instance_identity", "windows_pid_reuse_recovery", "missing_owner_recovery"],
  },
  {
    id: "daemon_control_lane",
    layer: "deterministic",
    command: ["tools/verify-jcc-daemon-control-lane-contract.mjs"],
    covers: ["immediate_host_cancellation_signal", "serialized_state_reducer", "late_result_ownership"],
  },
  {
    id: "runtime_event_pipeline_preemption",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-event-pipeline-preemption.mjs"],
    // This suite intentionally exercises delayed preparation and late-result
    // fencing across several independent lanes; the test budget must cover
    // those delays without changing any production response timeout.
    timeout_ms: 300000,
    covers: ["observe_lane_nonblocking", "manual_preempts_automatic", "stop_cancels_preparing", "late_result_fencing"],
  },
  {
    id: "runtime_daemon_client",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-daemon-client.mjs"],
    // The verifier performs a cold start and a full replacement restart. Both
    // use the same five-minute final guard as the production client.
    timeout_ms: 300000,
    covers: ["electron_client_supervisor", "owned_process_policy", "event_forwarding"],
  },
  {
    id: "stage_context_authority",
    layer: "deterministic",
    command: ["tools/verify-jcc-stage-context-authority.mjs"],
    timeout_ms: 180000,
    covers: ["hud_ocr_stage_authority", "consecutive_current_turn_contract_rebuild", "full_match_version_snapshot_guard", "stale_live_state_economy_scrub", "cached_authoritative_facts_guard"],
  },
  {
    id: "ui_runtime_bridge",
    layer: "deterministic",
    command: ["tools/verify-jcc-ui-runtime-bridge.mjs"],
    covers: ["renderer_to_daemon_actions", "session_boundary_actions", "host_settings_actions"],
  },
  {
    id: "renderer_event_delivery",
    layer: "deterministic",
    command: ["tools/verify-jcc-renderer-event-delivery.mjs"],
    covers: ["canonical_response_delivery", "exact_ack", "lineup_delivery_fencing", "trailing_event_drain"],
  },
  {
    id: "coach_response_delivery_dedup",
    layer: "deterministic",
    command: ["tools/verify-jcc-coach-response-delivery-dedup.mjs"],
    covers: ["direct_canonical_exactly_once", "interleaved_hint_dedup", "bounded_delivery_identity_cache"],
  },
  {
    id: "renderer_compact_layout",
    layer: "deterministic",
    command: ["tools/verify-jcc-renderer-compact-layout.mjs"],
    covers: ["short_viewport_layout", "runtime_status_visibility", "accessible_mode_controls", "idle_lineup_card_collapse"],
  },
  {
    id: "pinned_card_browser",
    layer: "live_acceptance",
    command: ["tools/verify-jcc-pinned-card-browser.mjs"],
    timeout_ms: 120000,
    covers: ["real_browser_pinned_card_stability", "composer_position_stability", "manual_viewport_acceptance"],
  },
  {
    id: "choice_composer_prefill_ui",
    layer: "deterministic",
    command: ["tools/verify-jcc-choice-composer-prefill-ui.mjs"],
    covers: ["choice_report_copy_from_descriptor", "prefill_without_auto_send", "explicit_send_ownership"],
  },
  {
    id: "final_lineup_confirmation_ui",
    layer: "deterministic",
    command: ["tools/verify-jcc-final-lineup-confirmation-ui.mjs"],
    covers: ["explicit_final_lineup_intent", "candidate_chat_or_custom_target", "mode_contract_consumption"],
  },
  {
    id: "cruise_hard_data_query",
    layer: "deterministic",
    command: ["tools/verify-jcc-cruise-hard-data-query.mjs"],
    covers: ["typed_ui_evidence_capability", "ranking_wiki_exclusion", "hard_data_budget_identity", "persistent_capsule_override"],
  },
  {
    id: "cruise_popular_recipe_query",
    layer: "deterministic",
    command: ["tools/verify-jcc-cruise-popular-recipe-query.mjs"],
    covers: ["typed_ui_recipe_capability", "popular_only_generation", "live_state_and_strength_exclusion", "auxiliary_unit_delivery"],
  },
  {
    id: "explicit_augment_ocr_draft",
    layer: "deterministic",
    command: ["tools/verify-jcc-explicit-augment-ocr-draft.mjs"],
    covers: ["augment_quick_ocr_renderer_draft", "exact_stage_tier_catalog_validation", "cross_match_ocr_result_fencing", "no_canonical_choice_write"],
  },
  {
    id: "augment_choice_live_regression",
    layer: "live_acceptance",
    command: ["tools/verify-jcc-augment-choice-live-regression.mjs"],
    timeout_ms: 120000,
    covers: ["real_redacted_augment_frame", "production_in_memory_roi_geometry", "one_based_card_slots", "prewarmed_choice_window_latency", "resident_ocr_three_choice_resolution"],
  },
  {
    id: "new_match_session_isolation",
    layer: "deterministic",
    command: ["tools/verify-jcc-new-match-session-isolation.mjs"],
    covers: ["fresh_match_session_id", "match_scoped_state_reset", "old_match_pollution_guard"],
  },
  {
    id: "mumu_s1_self_anchor",
    layer: "deterministic",
    command: ["tools/verify-jcc-mumu-s1-self-anchor.mjs"],
    covers: ["self_view_anchor", "own_board_promotion", "s2_observing_no_opponent_facts"],
  },
  {
    id: "mumu_hero_id_normalization",
    layer: "deterministic",
    command: ["tools/verify-jcc-mumu-hero-id.mjs"],
    covers: ["shared_star_prefix_normalization", "invalid_zero_suffix_rejection", "all_production_parsers_share_one_normalizer"],
  },
  {
    id: "mumu_runtime_id_mapping_receipt",
    layer: "deterministic",
    command: ["tools/verify-jcc-mumu-runtime-id-mapping.mjs"],
    covers: ["bounded_live_mapping_receipt", "immutable_core_profile_binding", "shop_only_exception_is_explicit"],
  },
  {
    id: "mumu_runtime_id_mapping_adversarial",
    layer: "deterministic",
    command: ["tools/verify-jcc-mumu-runtime-id-mapping-adversarial.mjs"],
    covers: ["unknown_own_state_fails_closed", "receipt_mutation_fails_profile_binding", "aggregate_only_forgery_rejected"],
  },
  {
    id: "mumu_source_degraded_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-mumu-source-degraded-contract.mjs"],
    covers: ["adb_connected_gameassist_missing", "waiting_live_state_source_health", "later_live_payload_promotion"],
  },
  {
    id: "mumu_watch_item_source_diagnostics",
    layer: "deterministic",
    command: ["tools/verify-jcc-mumu-watch-item-source-diagnostics.mjs"],
    covers: ["4357_source_absence", "equipment_command_drift", "equipment_parse_rejection", "bounded_source_diagnostics"],
  },
  {
    id: "mumu_item_source_health_context",
    layer: "deterministic",
    command: ["tools/verify-jcc-mumu-item-source-health-context.mjs"],
    covers: ["structured_item_source_degradation", "no_prior_nonempty_reuse", "source_health_reaches_host_context"],
  },
  {
    id: "user_confirmed_equipment_context",
    layer: "deterministic",
    command: ["tools/verify-jcc-user-confirmed-equipment-context.mjs"],
    covers: ["equipment_source_precedence", "user_confirmation_match_scope", "contextual_equipment_prompt", "no_permanent_equipment_mode"],
  },
  {
    id: "effective_equipment_runtime_flow",
    layer: "deterministic",
    command: ["tools/verify-jcc-effective-equipment-runtime-flow.mjs"],
    covers: ["effective_equipment_pipeline", "user_confirmation_no_visual_wait", "proactive_item_decision_context"],
  },
  {
    id: "self_state_roi_capture_source",
    layer: "deterministic",
    command: ["tools/verify-jcc-self-state-roi-capture-source-contract.mjs"],
    covers: ["adb_first_auto_capture", "empty_frame_mumushell_fallback", "android_version_neutral_capture"],
  },
  {
    id: "self_state_roi_authority",
    layer: "deterministic",
    command: ["tools/verify-jcc-self-state-roi-ocr.mjs"],
    covers: ["missing_before_numeric_coercion", "field_level_authority", "active_hp_zero_rejected", "persisted_false_zero_cleanup"],
  },
  {
    id: "mumu_runtime_autodiscovery",
    layer: "deterministic",
    command: ["tools/verify-jcc-mumu-runtime-autodiscovery.mjs"],
    covers: ["explicit_rescan_only", "dynamic_port_discovery", "hidden_bounded_adb_processes"],
  },
  {
    id: "runtime_sensing_artifact_retention",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-sensing-artifact-retention.mjs"],
    covers: ["bounded_hud_artifacts", "bounded_icon_fallback", "structured_4357_suppresses_icon_fallback"],
  },
  {
    id: "runtime_ui_mode_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-ui-mode-contract.mjs"],
    covers: ["mode_mapping", "daily_modes", "match_modes"],
  },
  {
    id: "decision_input_catalog",
    layer: "deterministic",
    command: ["tools/verify-jcc-decision-input-catalog.mjs"],
    covers: ["stage_tier_availability_index", "catalog_source_fingerprint", "global_search_without_cross_stage_confirmation", "shared_equipment_and_season_choice_catalogs"],
  },
  {
    id: "decision_input_ui",
    layer: "deterministic",
    command: ["tools/verify-jcc-decision-input-ui.mjs"],
    covers: ["structured_choice_cards", "shared_equipment_token_editor", "dirty_final_confirmation_without_implicit_equipment_write"],
  },
  {
    id: "structured_card_backend_actions",
    layer: "deterministic",
    command: ["tools/verify-jcc-structured-card-backend-actions.mjs"],
    covers: ["payload_binding", "candidate_and_final_choice_boundary", "explicit_advice_single_owner", "final_confirmation_state_only"],
  },
  {
    id: "structured_card_backend_blackbox",
    layer: "deterministic",
    command: ["tools/verify-jcc-structured-card-backend-actions-blackbox.mjs"],
    covers: ["cross_stage_rejection", "descriptor_final_state_materialization", "catalog_choice_ref", "item_choice_final_state", "confirmation_observer_suppression"],
  },
  {
    id: "season_aware_renderer_modes",
    layer: "deterministic",
    command: ["tools/verify-jcc-season-aware-renderer-modes.mjs"],
    covers: ["season_aware_mode_availability", "future_season_special_mode_suppression", "stale_option_data_guard"],
  },
  {
    id: "season_variable_panel_runtime",
    layer: "deterministic",
    command: ["tools/verify-jcc-season-variable-panel-runtime.mjs"],
    covers: ["descriptor_driven_setup_fields", "frontend_backend_descriptor_shape", "generic_season_variable_persistence"],
  },
  {
    id: "season_variable_canonical_roundtrip",
    layer: "deterministic",
    command: ["tools/verify-jcc-season-variable-canonical-roundtrip.mjs"],
    covers: ["generic_variable_save", "sqlite_hydrate_roundtrip", "host_selected_context_roundtrip"],
  },
  {
    id: "common_season_neutrality",
    layer: "deterministic",
    command: ["tools/verify-jcc-common-season-neutrality.mjs"],
    covers: ["common_runtime_has_no_s17_mechanic_literals", "manual_variables_owned_by_active_major_season", "future_season_descriptor_boundary"],
  },
  {
    id: "requirements_authority",
    layer: "deterministic",
    command: ["tools/verify-jcc-requirements-authority.mjs"],
    covers: ["requirements_registry", "stale_doc_pollution_guard", "current_sensing_authority", "mode_json_authority"],
  },
  {
    id: "game_knowledge_compiler",
    layer: "deterministic",
    command: ["tools/verify-jcc-game-knowledge-compiler.mjs"],
    covers: ["deterministic_core_profile_compile", "common_season_isolation", "immutable_candidate_bundle", "source_fingerprint_integrity"],
  },
  {
    id: "player_entity_aliases",
    layer: "deterministic",
    command: ["tools/verify-jcc-player-entity-aliases.mjs"],
    covers: ["common_equipment_alias_binding", "version_owned_champion_alias_binding", "typed_alias_search", "canonical_fact_persistence"],
  },
  {
    id: "season_archive",
    layer: "deterministic",
    command: ["tools/verify-jcc-season-archive.mjs"],
    covers: ["s17_frozen_in_place", "rollback_assets_retained", "archive_manifest_determinism"],
  },
  {
    id: "s18_source_import",
    layer: "deterministic",
    command: [
      "tools/verify-jcc-s18-source-import.mjs",
      "--champions-doc", "data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/champions-and-traits.md",
      "--augments-doc", "data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/augments.md",
      "--sprites-doc", "data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/nature-sprites.md",
      "--equipment-doc", "data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/equipment.md",
      "--patch-source-manifest", "data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-manifest.json",
    ],
    covers: ["s18_source_counts", "effect_structure", "dynamic_placeholder_isolation", "duplicate_name_identity"],
  },
  {
    id: "official_augment_source",
    layer: "deterministic",
    command: [
      "tools/verify-jcc-official-augment-source.mjs",
      "--patch-source-manifest", "data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-manifest.json",
    ],
    covers: ["official_augment_membership_authority", "official_augment_tiers", "official_light_magic_roll_identity"],
  },
  {
    id: "s18_hard_data_staging",
    layer: "deterministic",
    command: ["tools/verify-jcc-s18-hard-data-staging.mjs"],
    covers: ["s18_staging_determinism", "runtime_overlay_shape", "sprite_shop_extension", "no_s17_fallback"],
  },
  {
    id: "s18_18_2a_balance_delta",
    layer: "deterministic",
    command: ["tools/verify-jcc-s18-18.2a-hard-data.mjs", "--manifest", "data/core-patches/jcc/generations/9ea24a3a5606e2aa3850bb7f7e8c08bcf0c5faaa88f1188fe0e66cc7aa9c24b7/manifest.json"],
    covers: ["18_2a_balance_delta", "xp_rollback", "preserved_population_and_trait_rules"],
  },
  {
    id: "hard_data_package_store",
    layer: "deterministic",
    command: ["tools/verify-jcc-hard-data-package-store.mjs"],
    covers: ["immutable_hard_data_generation", "same_patch_refresh_isolation", "collision_rejection", "reference_aware_prune"],
  },
  {
    id: "game_knowledge_profile_store",
    layer: "deterministic",
    command: ["tools/verify-jcc-game-knowledge-profile-store.mjs"],
    covers: ["atomic_core_profile_promotion", "active_bundle_identity_validation", "last_known_good_core_profile", "candidate_path_containment"],
  },
  {
    id: "core_profile_runtime_identity",
    layer: "deterministic",
    command: ["tools/verify-jcc-core-profile-runtime-identity.mjs"],
    covers: ["core_profile_primary_runtime_selector", "runtime_source_identity_validation", "future_season_hot_swap", "legacy_selector_fallback"],
  },
  {
    id: "version_pipeline_architecture",
    layer: "deterministic",
    command: ["tools/verify-jcc-version-pipeline-architecture.mjs"],
    covers: ["modular_version_pipeline", "machine_readable_harness_entrypoint", "retired_architecture_absence"],
  },
  {
    id: "tencent_primary_ranking_source",
    layer: "deterministic",
    command: ["tools/verify-jcc-tencent-primary-ranking-source.mjs"],
    covers: ["tencent_jcc_master_plus_primary", "daily_datatft_production_retired", "offline_s18_datatft_core_supplement"],
  },
  {
    id: "match_core_profile_binding",
    layer: "deterministic",
    command: ["tools/verify-jcc-match-core-profile-binding.mjs"],
    covers: ["match_snapshot_recovery_binding", "match_child_profile_pinning", "promotion_race_fencing"],
  },
  {
    id: "knowledge_snapshot",
    layer: "deterministic",
    command: ["tools/verify-jcc-knowledge-snapshot.mjs"],
    covers: ["request_captured_knowledge_identity", "core_ranking_overlay_compatibility", "immutable_turn_snapshot", "deterministic_snapshot_generation"],
  },
  {
    id: "rankings_status_runtime_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-rankings-status-runtime-contract.mjs"],
    covers: ["durable_rankings_status", "update_failure_visibility", "last_good_snapshot_preserved"],
  },
  {
    id: "live_ranking_generation_store",
    layer: "deterministic",
    command: ["tools/verify-jcc-live-ranking-generation-store.mjs"],
    covers: ["atomic_ranking_overlay_publication", "exclusive_refresh_lease", "immutable_generation_validation", "last_known_good_overlay"],
  },
  {
    id: "live_rankings_atomic_promotion",
    layer: "deterministic",
    command: ["tools/verify-jcc-live-rankings-promotion.mjs"],
    covers: ["rankings_last_known_good", "rankings_candidate_validation", "rankings_atomic_promotion"],
  },
  {
    id: "live_rankings_sync_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-live-rankings-sync-contract.mjs"],
    covers: ["trait_and_hero_freshness", "candidate_audit_before_publish", "last_known_good_current"],
  },
  {
    id: "live_ranking_recipe_sources",
    layer: "deterministic",
    command: ["tools/verify-jcc-live-ranking-recipe-sources.mjs"],
    covers: ["popular_recipe_source", "player_lineup_exclusion", "recipe_metric_isolation", "typed_auxiliary_units", "active_recipe_generation", "atomic_recipe_publication"],
  },
  {
    id: "live_ranking_active_closure",
    layer: "deterministic",
    command: ["tools/verify-jcc-live-ranking-active-closure.mjs"],
    covers: ["active_ranking_recipe_generation_closure", "latest_source_count_alignment"],
  },
  {
    id: "canonical_lineup_identity",
    layer: "deterministic",
    command: ["tools/verify-jcc-canonical-lineup-identity.mjs"],
    covers: ["raw_family_id_audit_only", "canonical_trait_semantics", "atomic_variant_comparison"],
  },
  {
    id: "official_source_dictionary",
    layer: "deterministic",
    command: ["tools/verify-jcc-official-source-dictionary.mjs"],
    covers: ["source_trait_text_capture", "raw_source_identity_is_non_semantic", "core_trait_dictionary_resolution"],
  },
  {
    id: "mature_recipe_variant_packet",
    layer: "deterministic",
    command: ["tools/verify-jcc-mature-recipe-variant-packet.mjs"],
    covers: ["standard_roster_authority", "explicit_recipe_variant_difference", "recipe_unit_leak_rejection"],
  },
  {
    id: "ranking_recipe_freshness",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-recipe-freshness.mjs"],
    covers: ["independent_source_dates", "recent_lag_structural_use", "expired_and_incompatible_rejection"],
  },
  {
    id: "strategic_ranking_candidate_integrity",
    layer: "deterministic",
    command: ["tools/verify-jcc-strategic-ranking-candidate-integrity.mjs"],
    covers: ["complete_candidate_identity", "complete_roster_survives_compaction", "no_cross_candidate_lineup_merge"],
  },
  {
    id: "live_rankings_history",
    layer: "deterministic",
    command: ["tools/verify-jcc-live-rankings-history.mjs"],
    covers: ["complete_binding_partition", "compact_daily_history", "latest_14_date_retention", "same_date_idempotency", "zero_weight_compiled_trend", "safe_pruning"],
  },
  {
    id: "ranking_strength_evaluator",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-strength-evaluator.mjs"],
    covers: ["current_day_only_gradient", "floor_ceiling_reliability", "popularity_isolation", "recipe_sample_isolation", "deterministic_tie_break"],
  },
  {
    id: "ranking_semantic_maintenance",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-maintenance.mjs"],
    covers: ["semantic_diff_only", "closed_annotation_schema", "numeric_authority_isolation", "degraded_deterministic_publish"],
  },
  {
    id: "ranking_semantic_maintenance_session",
    layer: "provider_contract",
    command: ["tools/verify-jcc-ranking-maintenance-runtime-session.mjs"],
    covers: ["one_shot_ephemeral_host", "no_lobby_or_match_reuse", "zero_host_call_when_unchanged", "bounded_degraded_failure"],
  },
  {
    id: "ranking_semantic_maintenance_publication",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-maintenance-publication.mjs"],
    covers: ["prepared_generation_validation", "active_pointer_compare_and_swap", "verify_before_publish", "activate_before_history", "staging_cleanup"],
  },
  {
    id: "ranking_semantic_maintenance_preparation",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-maintenance-preparation.mjs"],
    covers: ["full_active_closure_compare_and_swap", "recipe_pointer_fencing", "history_repairable_commit"],
  },
  {
    id: "typed_effect_parser",
    layer: "deterministic",
    command: ["tools/verify-jcc-typed-effect-parser.mjs"],
    covers: ["typed_trigger_target_metric", "conditional_reward_semantics", "unmapped_numeric_audit"],
  },
  {
    id: "typed_effect_import_integration",
    layer: "deterministic",
    command: ["tools/verify-jcc-typed-effect-import-integration.mjs"],
    covers: ["all_official_augments_parsed", "source_and_extension_shared_parser", "unknown_trigger_fail_closed"],
  },
  {
    id: "live_ranking_strategy_index",
    layer: "deterministic",
    command: ["tools/verify-jcc-live-ranking-strategy-index.mjs"],
    covers: ["offline_lineup_compilation", "main_carry_items", "augment_associations", "transitions", "season_neutrality"],
  },
  {
    id: "ranking_recipe_storage_normalization",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-recipe-storage-normalization.mjs"],
    covers: ["single_recipe_fact_storage", "content_addressed_relations", "lossless_materialization", "dangling_reference_rejection"],
  },
  {
    id: "live_ranking_strategy_runtime",
    layer: "deterministic",
    command: ["tools/verify-jcc-live-ranking-strategy-runtime.mjs"],
    covers: ["all_lineups_searchable", "main_carry_search", "compact_runtime_evidence"],
  },
  {
    id: "ranking_query_intent",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-query-intent.mjs"],
    covers: ["multi_group_query_compilation", "and_or_not_breakpoints", "role_semantics", "continuation_and_correction"],
  },
  {
    id: "ranking_query_retrieval",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-query-retrieval.mjs"],
    covers: ["atomic_variant_matching", "two_to_six_trait_queries", "partial_downgrade", "role_aware_retrieval"],
  },
  {
    id: "ranking_query_pagination",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-query-pagination.mjs"],
    covers: ["bounded_route_cursor", "non_repeating_next_page", "query_and_data_invalidation", "display_size_not_search_limit"],
  },
  {
    id: "ranking_query_runtime_integration",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-query-runtime-integration.mjs"],
    covers: ["daily_multi_group_retrieval", "daily_next_page", "match_complete_pool", "meta_map_not_whitelist", "main_carry_exactness"],
  },
  {
    id: "ranking_direction_family",
    layer: "deterministic",
    command: ["tools/verify-jcc-ranking-direction-family.mjs"],
    covers: ["independent_atomic_strength", "five_band_directory", "distinct_lobby_directions", "match_candidate_coverage"],
  },
  {
    id: "target_aware_ranking_retrieval",
    layer: "deterministic",
    command: ["tools/verify-jcc-target-aware-ranking-retrieval.mjs"],
    covers: [
      "current_explicit_target_authority",
      "target_trait_relevance_first",
      "variant_identity_preserved",
      "ranking_statistics_preserved",
      "explicit_fallback_label",
    ],
  },
  {
    id: "lineup_decision_quality",
    layer: "deterministic",
    command: ["tools/verify-jcc-lineup-decision-quality.mjs"],
    covers: [
      "stage_adaptive_lineup_fit",
      "target_role_semantics",
      "choice_dependency_classification",
      "augment_refresh_decision_delivery",
      "compact_source_provenance",
    ],
  },
  {
    id: "cruise_profile_binding",
    layer: "deterministic",
    command: ["tools/verify-jcc-cruise-profile-binding.mjs"],
    covers: ["cruise_profile_generation_binding", "cruise_cache_generation_keying", "cruise_promotion_race_fencing"],
  },
  {
    id: "active_hard_data",
    layer: "deterministic",
    command: ["tools/verify-jcc-hard-data.mjs"],
    covers: ["active_manifest_identity", "normalized_entities", "formula_and_typed_index_integrity", "patch_fact_integrity"],
  },
  {
    id: "semantic_feature_layer",
    layer: "deterministic",
    command: ["tools/verify-jcc-semantic-feature-layer.mjs"],
    covers: ["common_controlled_vocabulary", "core_feature_identity", "ranking_feature_binding", "runtime_transient_mapping", "bounded_transition_adaptation"],
  },
  {
    id: "cruise_decision_orchestrator",
    layer: "deterministic",
    command: ["tools/verify-jcc-cruise-decision-orchestrator.mjs"],
    covers: ["single_match_snapshot", "typed_effect_lifecycle", "canonical_action_deduplication", "cross_route_score_isolation", "bounded_single_owner_evidence"],
  },
  {
    id: "semantic_evidence_router",
    layer: "deterministic",
    command: ["tools/verify-jcc-semantic-evidence-router.mjs"],
    covers: ["typed_intent_authority", "bounded_semantic_evidence", "supplemental_wiki_policy"],
  },
  {
    id: "strategy_evidence_runtime_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-strategy-evidence-runtime-contract.mjs"],
    covers: ["season_neutral_routes", "immutable_evidence_snapshot", "multi_route_coverage", "provider_capability_fallback"],
  },
  {
    id: "strategy_evidence_kernel",
    layer: "deterministic",
    command: ["tools/verify-jcc-strategy-evidence-kernel.mjs"],
    covers: ["multi_domain_route_planning", "facet_coverage_receipt", "source_policy_isolation", "snapshot_bound_tool_results"],
  },
  {
    id: "entity_first_evidence",
    layer: "deterministic",
    command: ["tools/verify-jcc-entity-first-evidence.mjs"],
    covers: ["entity_facts_without_intent_keywords", "current_core_reward_timing", "lobby_match_entity_routes"],
  },
  {
    id: "host_readonly_tools",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-readonly-tools.mjs"],
    covers: ["codex_dynamic_tool_registration", "same_turn_readonly_broker", "kimi_prefetch_fallback", "tool_contract_identity"],
  },
  {
    id: "strategy_evidence_old_authority_absence",
    layer: "deterministic",
    command: ["tools/verify-jcc-strategy-evidence-old-authority-absence.mjs"],
    covers: ["no_retired_season_authority", "no_graph_or_vector_runtime", "no_separate_planning_model", "no_single_route_truncation"],
  },
  {
    id: "decision_math_service",
    layer: "deterministic",
    command: ["tools/verify-jcc-decision-math-service.mjs"],
    covers: ["common_formula_kernel", "version_parameter_composition", "season_mechanic_modifiers", "bounded_numeric_evidence"],
  },
  {
    id: "formula_evaluator",
    layer: "deterministic",
    command: ["tools/verify-jcc-formula-evaluator.mjs"],
    covers: ["common_formula_registry", "explicit_version_parameters", "missing_input_fail_closed"],
  },
  {
    id: "common_game_baseline",
    layer: "deterministic",
    command: ["tools/verify-jcc-common-game-baseline.mjs"],
    covers: ["common_standard_authority", "round_and_economy_rules", "shop_pool_and_progression", "gameplay_glossary"],
  },
  {
    id: "profile_only_rule_authority",
    layer: "deterministic",
    command: ["tools/verify-jcc-profile-only-rule-authority.mjs"],
    covers: ["profile_backed_rule_authority", "no_legacy_rule_fallback", "no_runtime_direct_legacy_reads"],
  },
  {
    id: "no_opponent_product_modes",
    layer: "deterministic",
    command: ["tools/verify-jcc-no-opponent-product-modes.mjs"],
    covers: ["removed_opponent_board_modes", "removed_scan_position_ui", "no_opponent_snapshot_runtime_actions"],
  },
  {
    id: "mumu_equipment_source_priority",
    layer: "deterministic",
    command: ["tools/verify-jcc-mumu-equipment-source-priority.mjs"],
    covers: ["4357_item_bench_primary", "4356_equipped_item_assignment_gate", "icon_matcher_fallback_only"],
  },
  {
    id: "left_item_rail_product_source",
    layer: "deterministic",
    command: ["tools/verify-jcc-left-item-rail-product-source.mjs"],
    covers: ["left_item_rail_icon_candidates_only", "4357_structured_primary"],
  },
  {
    id: "host_summary_current_view_scope",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-summary-current-view-scope.mjs"],
    covers: ["current_view_diagnostics_hidden_from_host", "no_opponent_board_facts"],
  },
  {
    id: "choice_confirmation_hooks",
    layer: "deterministic",
    command: ["tools/verify-jcc-choice-confirmation-hooks.mjs"],
    covers: ["augment_confirmation", "descriptor_owned_season_choice_confirmation", "cross_match_rejection"],
  },
  {
    id: "choice_confirmation_behavior",
    layer: "deterministic",
    command: ["tools/verify-jcc-choice-confirmation-behavior.mjs"],
    covers: ["pending_choice_colon_confirmation", "mixed_choice_strategy_message", "choice_task_supersede"],
  },
  {
    id: "match_fact_capture",
    layer: "deterministic",
    command: ["tools/verify-jcc-match-fact-capture.mjs"],
    covers: ["explicit_quick_record_authority", "ordinary_chat_no_fact_writes", "catalog_validated_sparse_match_updates", "no_target_plan_inference"],
  },
  {
    id: "choice_fast_coach_gates",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-choice-fast-coach-gates.mjs"],
    covers: ["current_match_choice_report", "choice_report_composer_prefill", "active_choice_no_ocr_or_vision_fallback"],
  },
  {
    id: "user_reported_choice_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-user-reported-choice-contract.mjs"],
    timeout_ms: 180000,
    covers: ["current_match_user_report_choice_candidates", "manual_report_modes_no_ocr_vision_fallback", "refresh_result_prefill_only", "lineup_schema_and_coordinate_guard", "frozen_decision_snapshot", "proactive_agenda_freshness_retry"],
  },
  {
    id: "runtime_goal_regression",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-goal-regression.mjs"],
    covers: ["host_provenance_normalization", "active_pipeline_completion", "mode_visual_refresh", "pinned_result"],
  },
  {
    id: "runtime_goal_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-goal-contract.mjs"],
    covers: ["manual_choice_ai_native", "hidden_fast_hint_evidence", "cruise_manual_choice_gate", "active_rules_selected_context"],
  },
  {
    id: "host_selected_context_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-selected-context-contract.mjs"],
    covers: ["hud_board_shop_items_match_facts", "rules_big_data_catalog_wiki", "strategy_fit_packet", "missing_fact_contract"],
  },
  {
    id: "user_settings_review_runtime",
    layer: "deterministic",
    command: ["tools/verify-jcc-user-settings-review-runtime.mjs"],
    covers: ["canonical_user_preferences", "supported_rank_preferences", "strategy_memory_and_review_settings", "twenty_compact_postgame_summaries"],
  },
  {
    id: "start_match_symptom_regression",
    layer: "deterministic",
    command: ["tools/verify-jcc-start-match-symptom-regression.mjs"],
    // Serial multi-scenario suite; each scenario retains its own timeout.
    timeout_ms: 300000,
    covers: ["live_match_attach_gate", "choice_window_lane_reservation", "host_summary_provenance", "selected_ranking_candidates", "pinned_result"],
  },
  {
    id: "full_player_journey_sim",
    layer: "deterministic",
    command: ["tools/verify-jcc-full-player-journey-sim.mjs"],
    timeout_ms: 300000,
    covers: [
      "daily_strategy_wiki_postgame",
      "active_match_cruise_user_and_automatic_event_resume",
      "response_task_revision_exact_ack",
      "augment_god_item_choice",
      "manual_refresh_local_response_without_cold_ocr",
      "lineup_card_publishable_structured_pinned_result",
      "explicit_runtime_shutdown",
    ],
  },
  {
    id: "full_player_journey_matrix",
    layer: "deterministic",
    command: ["tools/verify-jcc-full-player-journey-matrix.mjs"],
    timeout_ms: 900000,
    covers: [
      "independent_match_session_isolation",
      "completed_artifact_and_radiant_choice_paths",
      "fixed_checkpoint_progression_through_5_3",
      "explicit_runtime_shutdown_per_scenario",
    ],
  },
  {
    id: "cruise_state_materialization",
    layer: "deterministic",
    command: ["tools/verify-jcc-cruise-state-materialization.mjs"],
    covers: ["hud_state_materialization", "unchanged_fact_snapshot_gate", "cruise_semantic_dedupe", "user_question_priority"],
  },
  {
    id: "rapidocr_resident_worker_lifecycle",
    layer: "deterministic",
    command: ["tools/verify-jcc-rapidocr-resident-worker-lifecycle.mjs"],
    covers: ["single_shared_ocr_process", "ready_timeout_process_reaping", "daemon_scoped_worker_cleanup"],
  },
  {
    id: "roi_subprocess_lifecycle",
    layer: "deterministic",
    command: ["tools/verify-jcc-roi-subprocess-lifecycle.mjs"],
    covers: ["bounded_roi_subprocesses", "windows_process_tree_timeout_cleanup", "no_private_unbounded_runner"],
  },
  {
    id: "runtime_event_driven_observe",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-event-driven-observe.mjs"],
    covers: ["continuous_fact_observation", "semantic_advice_gate", "derived_equipment_fit_event", "derived_proactive_decision_delta"],
  },
  {
    id: "proactive_coach_decision_delta",
    layer: "deterministic",
    command: ["tools/verify-jcc-proactive-coach-decision-delta.mjs"],
    covers: [
      "target_shop_decision",
      "raw_shop_churn_fact_only",
      "target_non_hit_shop_churn_fact_only",
      "key_unit_acquisition_pair_upgrade_dedupe",
      "direct_intent_single_answer_no_retry",
      "choice_window_lane_reservation",
      "category_cooldown",
    ],
  },
  {
    id: "proactive_coach_multiround",
    layer: "deterministic",
    command: ["tools/verify-jcc-proactive-coach-multiround.mjs"],
    covers: [
      "multi_round_proactive_cadence",
      "raw_facts_do_not_open_host_lane",
      "trigger_cooldown_precedence",
      "choice_and_danger_exceptions",
      "stale_cross_stage_advice_expiry",
    ],
  },
  {
    id: "proactive_lineup_convergence",
    layer: "deterministic",
    command: ["tools/verify-jcc-proactive-lineup-convergence.mjs"],
    timeout_ms: 180000,
    covers: [
      "automatic_cruise_lineup_agenda",
      "stage_specific_convergence",
      "pre_4_2_durable_target_discovery_suppression",
      "post_4_2_durable_target_execution",
    ],
  },
  {
    id: "common_lineup_lifecycle_harness",
    layer: "deterministic",
    command: ["tools/verify-jcc-lineup-lifecycle-harness.mjs"],
    covers: [
      "season_neutral_lineup_lifecycle",
      "cost_curve_roll_level_guardrails",
      "board_readiness_estimate",
      "xp_overbuy_alignment",
    ],
  },
  {
    id: "combat_cap_lifecycle_context",
    layer: "deterministic",
    command: ["tools/verify-jcc-combat-cap-estimator-context.mjs"],
    covers: [
      "combat_cap_board_readiness",
      "lifecycle_context_reaches_scorer",
      "no_opponent_board_dependency",
    ],
  },
  {
    id: "economy_management_context",
    layer: "deterministic",
    command: ["tools/verify-jcc-economy-management-context.mjs"],
    covers: [
      "season_neutral_economy_doctrine",
      "computed_economic_decision_context",
      "economy_event_cooldown",
      "patch_strategy_separation",
    ],
  },
  {
    id: "runtime_event_request_ownership",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-event-request-ownership.mjs"],
    covers: ["single_runtime_event_answer_owner", "exact_event_focus", "scorer_tasks_evidence_only"],
  },
  {
    id: "cruise_trigger_coverage",
    layer: "deterministic",
    command: ["tools/verify-jcc-cruise-trigger-coverage.mjs"],
    covers: ["cruise_strategy_triggers", "early_direction", "economy_tempo_actions"],
  },
  {
    id: "lineup_display_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-lineup-display-contract.mjs"],
    covers: ["lineup_card_slots", "external_code_disabled", "mechanical_board_renderer"],
  },
  {
    id: "lineup_display_agent_bridge",
    layer: "deterministic",
    command: ["tools/verify-jcc-lineup-display-agent-bridge.mjs"],
    covers: ["host_lineup_output_bridge", "pinned_result_board_text", "mechanical_renderer_only"],
  },
  {
    id: "host_adapter_registry",
    layer: "provider_contract",
    command: ["tools/verify-jcc-host-adapter-registry.mjs"],
    covers: ["codex_adapter", "kimi_adapter_contract", "streaming_policy"],
  },
  {
    id: "kimi_http_vision_provider_removed",
    layer: "provider_contract",
    command: ["tools/verify-jcc-kimi-http-vision-provider-removal.mjs"],
    covers: ["codex_kimi_cli_only", "no_moonshot_http_provider", "kimi_acp_multimodal_preserved"],
  },
  {
    id: "host_cli_discovery_ui",
    layer: "provider_contract",
    command: ["tools/verify-jcc-host-cli-discovery-ui.mjs"],
    covers: ["scan_all_host_cli_agents", "kimi_cli_selection", "electron_bridge_action"],
  },
  {
    id: "host_adapter_stream_stub",
    layer: "provider_contract",
    command: ["tools/verify-jcc-host-adapter-stream-stub.mjs"],
    covers: ["codex_json_event_stream", "stdin_prompt_transport", "json_response_parse"],
  },
  {
    id: "host_adapter_final_before_exit",
    layer: "provider_contract",
    command: ["tools/verify-jcc-host-adapter-final-text-before-exit.mjs"],
    covers: ["early_final_response_delivery", "kind_specific_stream_completion", "host_process_tree_reaped_before_settlement"],
  },
  {
    id: "host_adapter_task_cancellation",
    layer: "provider_contract",
    command: ["tools/verify-jcc-host-adapter-task-cancellation.mjs"],
    covers: ["task_id_scoped_host_cancellation", "timeout_does_not_cancel_unrelated_host_task", "manual_cancel_does_not_cancel_unrelated_host_task"],
  },
  {
    id: "codex_cli_live_selected_context",
    layer: "live_acceptance",
    command: ["tools/verify-jcc-codex-cli-live-selected-context.mjs", "--require-live"],
    covers: ["codex_live_dependency_boundary", "codex_json_event_stream_live", "selected_context_live_path"],
  },
  {
    id: "codex_cli_live_coach_simulation",
    layer: "live_acceptance",
    command: ["tools/verify-jcc-codex-cli-live-coach-simulation.mjs", "--require-live"],
    covers: ["codex_live_coach_response", "fresh_context_precedence", "stale_context_rejection", "latency_budget"],
  },
  {
    id: "codex_cli_live_production_scenarios",
    layer: "live_acceptance",
    command: ["tools/verify-jcc-codex-cli-production-scenarios.mjs", "--require-live"],
    timeout_ms: 1800000,
    covers: [
      "one_start_match_one_persistent_host_session",
      "augment_advice_and_confirmation",
      "2_1_2_2_3_2_3_3_4_2_4_3_merge_contracts",
      "artifact_question_and_fixed_checkpoint_continuity",
      "all_scenario_turns_under_60_seconds",
      "native_output_schema_without_correction",
    ],
  },
  {
    id: "kimi_acp_adapter_stub",
    layer: "provider_contract",
    command: ["tools/verify-jcc-kimi-acp-adapter-stub.mjs"],
    covers: ["kimi_acp_json_rpc", "selected_context_transport", "json_response_parse"],
  },
  {
    id: "kimi_cli_live_availability",
    layer: "live_acceptance",
    command: ["tools/verify-jcc-kimi-cli-live-availability.mjs", "--require-live"],
    covers: ["kimi_live_dependency_boundary", "strict_live_gate", "selected_context_live_path"],
  },
  {
    id: "host_request_runtime_context",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-request-runtime-context.mjs"],
    covers: ["selected_context_policy", "season_catalog_trigger", "big_data_trigger", "no_raw_trait_ids"],
  },
  {
    id: "itemization_decision_context",
    layer: "deterministic",
    command: ["tools/verify-jcc-itemization-decision-context.mjs"],
    covers: ["live_state_first_item_policy", "wait_vs_slam_guardrail", "artifact_radiant_special_fit_context"],
  },
  {
    id: "ocr_field_aggregator",
    layer: "deterministic",
    command: ["tools/verify-jcc-ocr-field-aggregator.mjs"],
    covers: ["hp_block_geometry", "hp_zero_missing", "requested_field_without_crop_diagnostics", "hud_field_aggregation"],
  },
  {
    id: "live_test_symptom_regression",
    layer: "deterministic",
    command: ["tools/verify-jcc-live-test-symptom-regression.mjs"],
    covers: ["manual_question_delivery", "false_hp_zero_source_guard", "real_test_stale_state_symptoms"],
  },
  {
    id: "electron_host_request_smoke",
    layer: "deterministic",
    command: ["tools/verify-jcc-electron-host-request-smoke.mjs"],
    timeout_ms: 180000,
    covers: ["daily_and_match_host_request", "user_preferences", "season_catalog", "manual_variables"],
  },
  {
    id: "runtime_mode_host_request_benchmark",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-mode-host-request-benchmark.mjs"],
    // Whole serial local suite: daily cases, six mode cases, routing and cleanup.
    // Not the production per-Host-turn 180-second answer contract.
    timeout_ms: 300000,
    covers: [
      "all_modes_selected_context",
      "daily_minimal_context",
      "match_live_state_context",
      "bounded_prompt_size",
      "current_match_user_report_choice_turns",
      "choice_visual_provenance_excluded",
    ],
  },
  {
    id: "worker_orchestrator",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-worker-orchestrator.mjs"],
    covers: ["deterministic_workers", "optional_specialists", "single_visible_coach"],
  },
  {
    id: "season_module_boundaries",
    layer: "deterministic",
    command: ["tools/verify-jcc-season-module-boundaries.mjs"],
    covers: ["season_swappable_data", "runtime_invariant_boundaries"],
  },
  {
    id: "active_rules_context",
    layer: "deterministic",
    command: ["tools/verify-jcc-active-rules-context.mjs"],
    covers: ["base_season_patch_layering", "canonical_rules_compiler", "data_driven_choice_mechanics", "current_turn_contract"],
  },
  {
    id: "host_coach_instruction_contract",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-coach-instruction-contract.mjs"],
    covers: ["provider_neutral_instructions", "no_season_or_patch_literals", "mode_instruction_contract"],
  },
  {
    id: "season_version_isolation",
    layer: "deterministic",
    command: ["tools/verify-jcc-season-version-isolation.mjs"],
    covers: ["minor_patch_major_season_reuse", "future_season_isolation", "fail_closed_season_authority", "full_match_promotion_tuple", "patch_rule_override_audit_rollback"],
  },
  {
    id: "host_request_stage_snapshots",
    layer: "deterministic",
    command: ["tools/verify-jcc-host-request-stage-snapshots.mjs"],
    covers: ["stage_2_1_2_2_2_4_3_2_4_2", "current_turn_fingerprint", "choice_checkpoint_semantics"],
  },
  {
    id: "retention_budget",
    layer: "deterministic",
    command: ["tools/verify-jcc-match-session-retention-budget.mjs"],
    covers: ["bounded_match_state", "match_retirement", "no_raw_frame_retention", "twenty_compact_postgame_summaries"],
  },
  {
    id: "transient_visual_cleanup",
    layer: "deterministic",
    command: ["tools/verify-jcc-transient-visual-cleanup.mjs"],
    covers: ["abandoned_visual_frame_cleanup", "structured_visual_evidence_retained"],
  },
  {
    id: "runtime_db_budget",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-db-budget.mjs"],
    covers: ["sqlite_log_retention", "sqlite_event_retention", "completed_queue_retention"],
  },
  {
    id: "runtime_local_artifact_prune",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-local-artifact-prune.mjs"],
    covers: ["dry_run_first", "retired_version_artifact_cleanup", "durable_state_preservation"],
  },
  {
    id: "runtime_retired_version_cleanup",
    layer: "deterministic",
    command: ["tools/verify-jcc-runtime-retired-version-cleanup.mjs"],
    covers: ["retired_match_cleanup", "transient_wiki_cleanup", "durable_user_state_preservation"],
  },
  {
    id: "strategy_wiki_curation",
    layer: "deterministic",
    command: ["tools/verify-jcc-strategy-wiki-curation.mjs"],
    covers: ["wiki_source_events", "wiki_pages", "wiki_curation_runs", "patch_stale_guard", "host_model_json_validation"],
  },
  {
    id: "open_design_runtime_maturity",
    layer: "deterministic",
    command: ["tools/verify-jcc-open-design-runtime-maturity.mjs"],
    covers: ["open_design_style_daemon", "sqlite", "http_sse_websocket", "thin_host_adapter"],
  },
  {
    id: "runtime_live_acceptance_soak",
    layer: "live_acceptance",
    command: ["tools/verify-jcc-live-acceptance-soak.mjs", "--duration-ms", "2500", "--require-live-mumu"],
    covers: ["daemon_soak", "queue_health", "push_events", "mumu_live_gate_boundary"],
  },
  {
    id: "product_readiness_surface",
    layer: "deterministic",
    command: ["tools/verify-jcc-product-readiness.mjs"],
    covers: ["startup_scripts", "strict_live_scripts", "operator_readiness_doc"],
  },
  {
    id: "windows_desktop_shortcut",
    layer: "deterministic",
    command: ["tools/verify-jcc-windows-desktop-shortcut.mjs"],
    covers: ["developer_desktop_shortcut", "single_instance_focus", "release_installer_shortcut_policy"],
  },
  {
    id: "repo_hygiene_budget",
    layer: "deterministic",
    command: ["tools/verify-jcc-repo-hygiene-budget.mjs"],
    covers: ["bounded_repo_scan", "symlink_junction_guard", "time_and_entry_budget"],
  },
  {
    id: "repo_hygiene_audit",
    layer: "deterministic",
    command: ["tools/audit-jcc-repo-hygiene.mjs"],
    covers: ["git_clean", "ignored_inventory", "cleanup_policy"],
  },
];

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-runtime-product-gate.mjs [--profile <profile>] [--only <id,id>] [--report <path.json>] [--timeout-ms <ms>] [--list]",
    "  --only selects exact IDs across profiles; repeatable, unknown IDs fail before execution.",
    "  --report atomically saves each completed result and the final report; stdout stays compact.",
    "",
    "Profiles:",
    "  core     offline deterministic + provider contracts; excludes live, hygiene, and slow checks (default)",
    "  deterministic  all deterministic checks",
    "  provider_contract  offline provider transport/session contracts; live contracts require --profile live",
    "  live_acceptance  live provider/MuMu acceptance checks",
    "  extended core + long offline regressions",
    "  live     live/host-environment checks such as Codex/Kimi/live soak",
    "  hygiene  repository cleanliness audit",
    "  manual   legacy/manual diagnostics that are not part of release gates",
    "  full     every check, including live and hygiene",
    "  smoke    smallest daemon/UI/choice-context sanity layer",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    profile: DEFAULT_PROFILE,
    timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    list: false,
    only: [],
    report: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--profile") options.profile = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--report") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--report requires a path");
      options.report = path.resolve(value);
    } else if (arg === "--only") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--only requires comma-separated check IDs");
      const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
      if (!ids.length) throw new Error("--only requires at least one check ID");
      options.only.push(...ids);
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["core", "extended", "live", "hygiene", "manual", "full", "smoke", "deterministic", "provider_contract", "live_acceptance"].includes(options.profile)) {
    throw new Error(`Unknown --profile ${options.profile}\n${usage()}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Invalid --timeout-ms");
  return options;
}

export function checkProfile(check) {
  if (HYGIENE_CHECK_IDS.has(check.id)) return "hygiene";
  if (LEGACY_MANUAL_CHECK_IDS.has(check.id)) return "manual";
  if (check.execution === "live" || checkLayer(check) === "live_acceptance") return "live";
  if (SLOW_CHECK_IDS.has(check.id)) return "extended";
  return "core";
}

function checkLayer(check) {
  return gateLayerForCheck(check);
}

export function selectChecks(profile, only = []) {
  if (only.length) {
    const unknown = only.filter((id) => !CHECKS.some((check) => check.id === id));
    if (unknown.length) throw new Error(`Unknown --only check IDs: ${unknown.join(", ")}`);
    return CHECKS.filter((check) => only.includes(check.id));
  }
  if (profile === "full") return CHECKS;
  if (profile === "live") return CHECKS.filter((check) => checkProfile(check) === "live");
  if (["deterministic", "provider_contract", "live_acceptance"].includes(profile)) return CHECKS.filter((check) => checkLayer(check) === profile
    && !["hygiene", "manual"].includes(checkProfile(check))
    && (profile === "live_acceptance" || checkProfile(check) !== "live"));
  if (profile === "hygiene") return CHECKS.filter((check) => checkProfile(check) === "hygiene");
  if (profile === "manual") return CHECKS.filter((check) => checkProfile(check) === "manual");
  if (profile === "extended") return CHECKS.filter((check) => ["core", "extended"].includes(checkProfile(check)));
  if (profile === "smoke") {
    const smokeIds = new Set([
      "runtime_state_store",
      "runtime_daemon_static",
      "runtime_daemon_server",
      "runtime_event_stream",
      "daemon_control_lane",
      "single_writer_canonical_transition",
      "response_task_delivery",
      "proactive_coach_decision_delta",
      "runtime_event_request_ownership",
      "stage_context_authority",
      "ui_runtime_bridge",
      "no_opponent_product_modes",
      "mumu_s1_self_anchor",
      "mumu_equipment_source_priority",
      "left_item_rail_product_source",
      "host_summary_current_view_scope",
      "choice_fast_coach_gates",
      "cruise_state_materialization",
      "runtime_goal_contract",
      "host_selected_context_contract",
      "host_adapter_stream_stub",
      "runtime_goal_regression",
    ]);
    return CHECKS.filter((check) => smokeIds.has(check.id));
  }
  return CHECKS.filter((check) => checkProfile(check) === "core");
}

export async function runNode(scriptArgs, timeoutMs, layer = "deterministic") {
  const isolatedDataRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-product-gate-check-"));
  const run = await new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, scriptArgs, {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        JCC_RUNTIME_DATA_DIR: isolatedDataRoot,
        JCC_PRODUCT_GATE_ISOLATED_RUNTIME_DATA_DIR: isolatedDataRoot,
        ...(layer === "deterministic" ? {
          JCC_UI_DISABLE_CODEX_EXEC: "1",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(path.resolve(import.meta.dirname, "jcc-product-gate-no-provider.mjs")).href}`.trim(),
        } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      timedOut = true;
      await terminateProcessTree(child);
      finish({
        code: 124,
        timed_out: true,
        stdout,
        stderr,
        elapsed_ms: Date.now() - startedAt,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (timedOut) return;
      finish({
        code: 1,
        spawn_error: error.code || error.message,
        timed_out: false,
        stdout,
        stderr: error.message || String(error),
        elapsed_ms: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      if (timedOut) return;
      finish({
        code,
        timed_out: false,
        stdout,
        stderr,
        elapsed_ms: Date.now() - startedAt,
      });
    });
  });
  await rm(isolatedDataRoot, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 75,
  }).catch((error) => {
    run.stderr = `${run.stderr}${run.stderr ? "\n" : ""}warning: isolated gate data cleanup deferred: ${error?.code || error?.message || String(error)}`;
  });
  return run;
}

export function parseJsonTail(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function writeReport(file, report) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function checkRunPassed(run, parsed) {
  const unaccepted = ["external_dependency_pending", "simulated_pass_external_mumu_pending", "skipped"];
  return !run.timed_out && run.code === 0 && parsed?.skipped !== true
    && !unaccepted.includes(parsed?.status)
    && parsed?.ok !== false
    && (parsed?.ok === true || parsed?.status === "pass");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const checks = selectChecks(options.profile, options.only);
  for (const check of CHECKS) checkLayer(check);
  if (options.list) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-runtime-product-gate-profile-list-v1",
      default_profile: DEFAULT_PROFILE,
      selected_count: checks.length,
      selected_ids: checks.map((check) => check.id),
      profiles: ["smoke", "core", "extended", "deterministic", "provider_contract", "live_acceptance", "live", "hygiene", "manual", "full"],
      checks: CHECKS.map((check) => ({
        id: check.id,
        profile: checkProfile(check),
        layer: checkLayer(check),
        timeout_ms: Number(check.timeout_ms || options.timeoutMs),
        command: check.command,
        covers: check.covers,
      })),
    }, null, 2)}\n`);
    return;
  }
  const results = [];
  const startedAt = new Date().toISOString();
  const snapshot = (status, runningCheckId = null) => ({
    ok: status === "completed" && results.every((result) => result.ok),
    schema: "jcc-runtime-product-gate-v1",
    status,
    profile: options.profile,
    only: options.only,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
    running_check_id: runningCheckId,
    selected_ids: checks.map((check) => check.id),
    selected_count: checks.length,
    checked_count: results.length,
    skipped_count: CHECKS.length - checks.length,
    failed_count: results.filter((result) => !result.ok).length,
    failure_counts: Object.fromEntries([...new Set(results.filter((result) => !result.ok).map((result) => result.failure.failure_type))]
      .map((type) => [type, results.filter((result) => result.failure?.failure_type === type).length])),
    results,
  });
  for (const check of checks) {
    if (options.report) await writeReport(options.report, snapshot("running", check.id));
    const checkTimeoutMs = Number(check.timeout_ms || options.timeoutMs);
    process.stderr.write(`[product-gate] start ${check.id} (${checkProfile(check)}, timeout=${checkTimeoutMs}ms)\n`);
    const run = await runNode(check.command, checkTimeoutMs, checkLayer(check));
    const parsed = parseJsonTail(run.stdout) || parseJsonTail(run.stderr);
    const ok = checkRunPassed(run, parsed);
    const failure = ok ? null : classifyProductGateFailure({ layer: checkLayer(check), checkId: check.id, timedOut: run.timed_out, exitCode: run.code, parsed, spawnError: run.spawn_error });
    results.push({
      id: check.id,
      ok,
      exit_code: run.code,
      timed_out: Boolean(run.timed_out),
      elapsed_ms: run.elapsed_ms,
      timeout_ms: checkTimeoutMs,
      profile: checkProfile(check),
      layer: checkLayer(check),
      failure,
      command: check.command,
      diagnostics: ok ? null : { parsed, stdout: run.stdout, stderr: run.stderr },
      covers: check.covers,
      summary: parsed?.checked || parsed?.coverage || parsed?.policy || parsed?.known_boundaries || null,
      stdout_tail: run.stdout.trim().slice(-1000),
      stderr_tail: run.stderr.trim().slice(-1000),
    });
    if (options.report) await writeReport(options.report, snapshot("running"));
    process.stderr.write(`[product-gate] ${ok ? "pass" : "fail"} ${check.id} (${run.elapsed_ms}ms)\n`);
  }

  const failed = results.filter((result) => !result.ok);
  const report = {
    ...snapshot("completed"),
    ok: failed.length === 0,
    schema: "jcc-runtime-product-gate-v1",
    profile: options.profile,
    check_timeout_ms: options.timeoutMs,
    checked_count: results.length,
    skipped_count: CHECKS.length - results.length,
    failed_count: failed.length,
    product_claim: "JCC Runtime owns state in an independent daemon/SQLite layer; Electron is UI bridge; host CLI adapters are thin, streaming, selected-context model callers.",
    not_claimed: [
      checks.some((check) => checkProfile(check) === "live")
        ? null
        : "Live host CLI and MuMu acceptance are in --profile live or --profile full, not the default deterministic core gate.",
      options.profile === "hygiene" || options.profile === "full"
        ? null
        : "Repository cleanliness is in --profile hygiene or --profile full, because dirty worktrees are common during active runtime debugging.",
      "Active augment, descriptor-owned season choice, and item/anvil candidate truth is current-match user report only. The augment card has one explicit user-triggered OCR convenience that may fill uniquely resolved exact-stage/tier physical renderer slots, including partial results, but it never writes canonical choice facts or opens a Host answer; other retained choice OCR/vision tools are compatibility and calibration surfaces.",
    ].filter(Boolean),
    results,
  };
  if (options.report) await writeReport(options.report, report);
  const output = options.report ? {
    ok: report.ok,
    status: report.status,
    report: options.report,
    checked_count: report.checked_count,
    failed_count: report.failed_count,
    failed_checks: failed.map((result) => ({ id: result.id, failure: result.failure })),
  } : report;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
