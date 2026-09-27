function isMumu4357ItemBenchSource(entry) {
  if (!entry || typeof entry !== "object") return false;
  const source = entry.source || entry.provenance?.source || "";
  const policy = entry.promotion_policy || entry.provenance?.promotion_policy || "";
  return source === "mumu_4357_item_bench"
    || policy === "structured_4357_left_item_rail_primary";
}

export function hasStructuredMumu4357ItemBench(liveState) {
  const rows = Array.isArray(liveState?.items?.item_bench) ? liveState.items.item_bench : [];
  const status = liveState?.field_status?.["items.item_bench"];
  return rows.some(isMumu4357ItemBenchSource)
    || isMumu4357ItemBenchSource(status);
}

export function leftItemRailFallbackDecision({
  liveState,
  force = false,
  userConfirmedEquipmentReady = false,
}) {
  const structured4357Ready = hasStructuredMumu4357ItemBench(liveState);
  const reason = structured4357Ready
    ? "structured_4357_primary_available"
    : userConfirmedEquipmentReady
      ? "user_confirmed_equipment_available"
      : force === true
        ? "explicit_visual_fallback_requested"
        : "visual_fallback_not_requested";
  return {
    structured_4357_ready: structured4357Ready,
    user_confirmed_equipment_ready: userConfirmedEquipmentReady === true,
    explicit_request: force === true,
    should_run: !structured4357Ready && userConfirmedEquipmentReady !== true && force === true,
    reason,
  };
}

const itemTopicPattern = /(?:\u88c5\u5907|\u6563\u4ef6|\u6210\u88c5|\u795e\u5668|\u5149\u660e|\u9526\u56ca|item|items|equip|equipment|artifact|radiant)/i;
const currentItemStatePattern = /(?:\u5f53\u524d|\u73b0\u5728|\u5df2\u6709|\u6211\u6709|\u6211\u7684|\u88c5\u5907\u680f|\u5de6\u4fa7|\u80fd\u4e0d\u80fd\u5408|\u8be5\u4e0d\u8be5\u5408|\u8981\u4e0d\u8981\u5408|\u7b2c\u4e8c\u5957|current|owned|inventory|item rail|my items)/i;

export function messageRequestsCurrentItemEvidence(text) {
  const raw = String(text || "").trim();
  return Boolean(raw && itemTopicPattern.test(raw) && currentItemStatePattern.test(raw));
}
