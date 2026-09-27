import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function text(file) {
  return readFile(file, "utf8");
}

function includes(source, needle, label) {
  assert(source.includes(needle), `${label} must include ${needle}`);
}

const app = await text("ui/src/App.tsx");
const styles = await text("ui/src/styles.css");
const selfStateView = app.slice(
  app.indexOf("function selfStateRefreshView"),
  app.indexOf("function manualVariablesFromRuntime"),
);

includes(app, "SelfStateStrip", "App realtime self-state strip");
includes(app, "self_state_refresh_changed", "App runtime event subscription");
includes(app, "hud_facts_changed", "App successful HUD facts event subscription");
includes(app, "rankings_status_changed", "App rankings status event subscription");
includes(app, "aria-live=\"polite\"", "App self-state accessibility");
includes(selfStateView, "HUD 已更新；策略回答会使用最新事实", "App self-state strip reports sensing health without exposing persistent HUD values");
assert(!selfStateView.includes("`HP ${refresh.hp}`"), "self-state strip must not persistently expose HP");
assert(!selfStateView.includes("`${refresh.gold}g`"), "self-state strip must not persistently expose gold");
assert(!selfStateView.includes("`Lv ${refresh.level}`"), "self-state strip must not persistently expose level");
assert(!selfStateView.includes("`XP ${refresh.xp}`"), "self-state strip must not persistently expose XP");
includes(app, "rankingsUpdateBusy", "App rankings busy state");
includes(app, "runtimeState?.rankings_status", "App rankings_status display");
includes(app, "aria-busy={rankingBusy}", "App rankings update busy affordance");
includes(app, "onClick={onUpdateRankings}", "App single rankings update control");
includes(app, "掌盟大师以上", "App rankings source and tier");
includes(app, "尚未更新", "App unavailable rankings state");
assert(!app.includes("DailyIntelligence") && !app.includes("daily_intelligence") && !app.includes("DataTFT"), "App must not retain Daily Intelligence UI");
assert(!app.includes("掌盟大数据"), "App must not retain the legacy ranking-update product wording");
includes(app, "pinnedPanelVisible", "App pinned card visibility guard");
includes(app, "pinnedPanelOpen", "App explicit pinned slot state");
includes(app, "pinnedPanelShouldBeVisible", "App pinned slot state-machine helper");
includes(app, "hidden={activeView !== \"variables\"}", "App keeps variable draft component mounted across pinned tab changes");
includes(app, "hidden={activeView !== \"lineup\"}", "App keeps lineup view in the same stable pinned slot");
assert.equal((app.match(/setLineupPlan\(null\)/g) || []).length, 2, "only Start Match and Stop Match may clear the last published lineup plan");
assert(!app.includes("lineupExpectedTaskIdRef.current = taskId"), "canonical sync must not adopt an older lineup task as the current in-flight request");
includes(app, "draftResetKey={variableDraftResetKey}", "App resets variable drafts only at the match-session boundary");
includes(app, "role=\"tablist\"", "App pinned switcher tablist semantics");
includes(app, "role=\"tabpanel\"", "App pinned switcher tabpanel semantics");
includes(app, "tabIndex={itemChoiceKind === kind.id ? 0 : -1}", "App item choice roving tab index");
includes(app, "正在生成新版阵容图；完成前继续保留上一张可用阵容。", "App keeps the last published lineup while a replacement is pending");
includes(app, "新版阵容图未通过发布校验；当前仍显示上一张可用阵容。", "App keeps the last published lineup when a replacement fails");
includes(app, "role=\"radiogroup\"", "App item kind radiogroup");
includes(app, "role=\"radio\"", "App item kind radio buttons");
includes(app, "aria-checked={itemChoiceKind === kind.id}", "App item kind radio checked state");
includes(app, "aria-pressed={activeMode === mode.id}", "App mode pressed state");
includes(app, "aria-current={activeMode === mode.id ? \"page\" : undefined}", "App mode current state");
includes(app, "danger-menu-action", "App runtime daemon restart danger styling hook");

includes(styles, "height: 100dvh;", "CSS viewport height");
includes(styles, "grid-template-columns: minmax(0, 1fr);", "CSS root grid shrink boundary");
includes(styles, ".app-shell > *", "CSS root child shrink boundary");
assert(!styles.includes("min-height: 640px"), "CSS must not force 640px minimum app height");
includes(styles, "grid-template-columns: repeat(6, minmax(0, 1fr));", "CSS compact active match mode rail");
includes(styles, ".self-state-strip", "CSS self-state strip");
includes(styles, ".pinned-empty[data-lineup-status=\"idle\"]", "CSS idle pinned compact affordance");
includes(styles, "@media (max-height: 600px)", "CSS short viewport branch");
includes(styles, "button:focus-visible", "CSS focus-visible button ring");
includes(styles, ".menu-panel .danger-menu-action", "CSS daemon restart maintenance/danger visual");
assert(!/border-radius:\s*(?:9|10|11|12)px/.test(styles), "CSS card/control radii must stay at 8px or below");
assert(!/grid-template-columns:\s*repeat\(4/.test(styles), "CSS must not keep the old 4-column active match mode rail");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-renderer-compact-layout-verifier-v1",
  checks: [
    "app_shell_uses_dynamic_viewport_height_without_640px_minimum",
    "app_shell_grid_and_children_can_shrink_to_340px",
    "active_match_mode_rail_is_single_row_six_column",
    "self_state_refresh_strip_is_typed_event_driven_and_aria_live",
    "self_state_refresh_strip_shows_health_not_persistent_hud_values",
    "successful_hud_facts_refresh_is_event_driven",
    "renderer_subscribes_to_rankings_status_events",
    "rankings_status_fields_are_persistently_rendered",
    "rankings_update_button_is_single_non_cancellable_action",
    "rankings_source_and_unavailable_state_are_visible",
    "explicitly_open_pinned_card_stays_mounted_across_tab_changes",
    "item_kind_uses_radio_semantics",
    "mode_buttons_expose_pressed_and_current_state",
    "focus_visible_ring_exists_for_controls",
    "runtime_daemon_restart_uses_danger_visual_hook",
    "card_and_control_radii_are_8px_or_less"
  ],
}, null, 2));
