const RECIPE_WARNING_REASONS = new Set([
  "winning_recipe_count_below_minimum",
  "winning_recipe_stat_date_missing",
]);

const RECIPE_SOURCE_LAG_REASONS = new Set(["lineup_date_differs_from_snapshot"]);

const ROSTER_WARNING_REASONS = new Set([
  "master_plus_canonical_roster_partial",
]);

const HERO_WARNING_REASONS = new Set([
  "hero_equip_ranking_partial_failure",
  "hero_equip_ranking_stat_date_mismatch",
]);

const ITEM_WARNING_REASONS = new Set([
  "equip_stat_date_missing",
  "equip_date_differs_from_snapshot",
]);

function warningReasons(audit) {
  return new Set((Array.isArray(audit?.warnings) ? audit.warnings : [])
    .map((warning) => String(warning?.reason || "").trim())
    .filter(Boolean));
}

function hasAny(reasons, values) {
  for (const value of values) {
    if (reasons.has(value)) return true;
  }
  return false;
}

function domainStatus({ unavailable = false, partial = false } = {}) {
  if (unavailable) return "unavailable";
  if (partial) return "partial";
  return "available";
}

function semanticMaintenanceStatus(strategyIndex, audit) {
  const receipt = strategyIndex?.semantic_maintenance || audit?.semantic_maintenance || null;
  const status = String(receipt?.status || "").trim();
  if (["ready", "not_required"].includes(status)) return "available";
  if (status === "degraded") return "degraded";
  return "unknown";
}

export function classifyRankingCapabilityStatus(audit, strategyIndex = null) {
  const auditPresent = Boolean(audit && typeof audit === "object");
  const failures = Array.isArray(audit?.failures) ? audit.failures : [];
  const reasons = warningReasons(audit);
  const blocking = !auditPresent
    || failures.length > 0
    || audit?.status === "fail"
    || audit?.strength_status === "unavailable";
  const strengthStatus = domainStatus({
    unavailable: !auditPresent || blocking || audit?.strength_status === "unavailable",
  });
  const recipeStatus = domainStatus({
    unavailable: !auditPresent || (blocking && audit?.recipe_status === "unavailable"),
    partial: audit?.recipe_status === "partial" || hasAny(reasons, RECIPE_WARNING_REASONS),
  });
  const heroStatus = domainStatus({
    unavailable: !auditPresent || (blocking && audit?.strength_status === "unavailable"),
    partial: hasAny(reasons, HERO_WARNING_REASONS),
  });
  const itemStatus = domainStatus({
    unavailable: !auditPresent || (blocking && audit?.strength_status === "unavailable"),
    partial: hasAny(reasons, ITEM_WARNING_REASONS),
  });
  const rosterStatus = domainStatus({
    unavailable: !auditPresent || (blocking && audit?.strength_status === "unavailable"),
    partial: hasAny(reasons, ROSTER_WARNING_REASONS),
  });
  const semanticStatus = semanticMaintenanceStatus(strategyIndex, audit);
  const recipeSourceLag = hasAny(reasons, RECIPE_SOURCE_LAG_REASONS);
  const fullRankingOverlayAvailable = !blocking
    && [recipeStatus, heroStatus, itemStatus, rosterStatus].every((status) => status === "available");

  return {
    overall_status: blocking ? "unavailable" : recipeSourceLag ? "ready_with_source_lag" : "ready",
    strength_status: strengthStatus,
    recipe_status: recipeStatus,
    hero_status: heroStatus,
    item_status: itemStatus,
    roster_status: rosterStatus,
    semantic_maintenance_status: semanticStatus,
    full_ranking_overlay_available: fullRankingOverlayAvailable,
    blocking,
    recipe_source_lag: recipeSourceLag,
  };
}

export function rankingCapabilityWarnings(audit, strategyIndex = null) {
  const capabilities = classifyRankingCapabilityStatus(audit, strategyIndex);
  const partialDomains = Object.entries(capabilities)
    .filter(([key, value]) => key.endsWith("_status") && value === "partial")
    .map(([key]) => key);
  return {
    ...capabilities,
    partial_domains: partialDomains,
  };
}
