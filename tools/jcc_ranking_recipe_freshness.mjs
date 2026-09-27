const STAT_DATE = /^\d{8}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_SOURCE_STATUSES = [
  "incompatible",
  "expired",
  "forbidden",
  "quarantined",
  "failed",
  "unavailable",
];

function utcDay(statDate) {
  const value = String(statDate || "").trim();
  if (!STAT_DATE.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const epoch = Date.UTC(year, month - 1, day);
  const date = new Date(epoch);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return epoch;
}

export function statDateFromIsoTimestamp(value, timeZone = "Asia/Shanghai") {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const statDate = `${byType.year || ""}${byType.month || ""}${byType.day || ""}`;
  return STAT_DATE.test(statDate) ? statDate : null;
}

export function recipeSourceStatDate(capability = {}) {
  const explicit = String(capability?.source_stat_date || "").trim();
  if (STAT_DATE.test(explicit)) return explicit;
  return statDateFromIsoTimestamp(capability?.source_receipt?.last_modified);
}

function terminalSourceStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return TERMINAL_SOURCE_STATUSES.find((status) => new RegExp(`(^|[_-])${status}($|[_-])`, "u").test(normalized)) || null;
}

function unavailableSourceResult({ sourceRole, rankingStatDate, sourceStatDate, status }) {
  const matchingPolicy = status === "expired"
    ? "historical_and_diagnostic_only"
    : ["incompatible", "forbidden"].includes(status)
      ? "forbidden"
      : status === "quarantined"
        ? "quarantined"
        : "unavailable";
  return {
    source_role: sourceRole,
    ranking_stat_date: rankingStatDate || null,
    source_stat_date: sourceStatDate || null,
    lag_days: null,
    status,
    automatic_pairing: false,
    structural_evidence: false,
    statistics_authority: false,
    matching_policy: matchingPolicy,
  };
}

export function evaluateRecipeSourceFreshness({
  rankingStatDate,
  sourceStatDate,
  identityCompatible = true,
  sourceStatus = "available",
  sourceRole = null,
} = {}) {
  const rankingEpoch = utcDay(rankingStatDate);
  const sourceEpoch = utcDay(sourceStatDate);
  if (!identityCompatible) {
    return unavailableSourceResult({ sourceRole, rankingStatDate, sourceStatDate, status: "incompatible" });
  }
  const terminalStatus = terminalSourceStatus(sourceStatus);
  if (terminalStatus || sourceStatus === "missing") {
    return unavailableSourceResult({
      sourceRole,
      rankingStatDate,
      sourceStatDate,
      status: terminalStatus || "unavailable",
    });
  }
  if (rankingEpoch === null || sourceEpoch === null) {
    return {
      source_role: sourceRole,
      ranking_stat_date: rankingStatDate || null,
      source_stat_date: sourceStatDate || null,
      lag_days: null,
      status: "date_unknown",
      automatic_pairing: false,
      structural_evidence: false,
      statistics_authority: false,
      matching_policy: "quarantine_until_dated",
    };
  }
  const lagDays = Math.round((rankingEpoch - sourceEpoch) / DAY_MS);
  let status;
  let matchingPolicy;
  let automaticPairing = true;
  if (lagDays === 0) {
    status = "fresh";
    matchingPolicy = "normal_structural_pairing";
  } else if (lagDays >= 1 && lagDays <= 2) {
    status = "recent_lag";
    matchingPolicy = "normal_structural_pairing_with_true_source_date";
  } else if (lagDays >= 3 && lagDays <= 7) {
    status = "stale_reference";
    matchingPolicy = "exact_or_high_confidence_compatible_only";
  } else if (lagDays > 7) {
    status = "expired";
    matchingPolicy = "historical_and_diagnostic_only";
    automaticPairing = false;
  } else {
    status = "incompatible_date_order";
    matchingPolicy = "forbidden";
    automaticPairing = false;
  }
  return {
    source_role: sourceRole,
    ranking_stat_date: String(rankingStatDate),
    source_stat_date: String(sourceStatDate),
    lag_days: lagDays,
    status,
    automatic_pairing: automaticPairing,
    structural_evidence: automaticPairing,
    statistics_authority: false,
    matching_policy: matchingPolicy,
  };
}

export function buildRankingRecipeFreshnessProfile({
  rankingStatDate,
  sourceCapabilities = {},
  identityCompatible = true,
} = {}) {
  const sources = {};
  for (const sourceRole of ["winning", "popular"]) {
    const capability = sourceCapabilities?.[sourceRole] || {};
    const capabilityStatus = String(capability?.status || "unavailable").trim().toLowerCase();
    const explicitlyTerminal = terminalSourceStatus(capabilityStatus);
    const available = !explicitlyTerminal
      && (capabilityStatus.startsWith("available") || Number(capability?.accepted_recipe_count || 0) > 0);
    sources[sourceRole] = evaluateRecipeSourceFreshness({
      rankingStatDate,
      sourceStatDate: recipeSourceStatDate(capability),
      identityCompatible,
      sourceStatus: explicitlyTerminal || (available ? "available" : "unavailable"),
      sourceRole: `${sourceRole}_recipe`,
    });
  }
  const usable = Object.values(sources).filter((source) => source.automatic_pairing);
  const lagged = usable.filter((source) => source.status !== "fresh");
  return {
    schema: "jcc-ranking-recipe-freshness-profile-v1",
    ranking_stat_date: String(rankingStatDate || "") || null,
    status: usable.length === 0 ? "unavailable" : lagged.length ? "ready_with_source_lag" : "ready",
    sources,
    strength_authority: "ranking_stat_date_only",
    recipe_authority: "structure_equipment_positioning_and_playbook_only",
    recipe_metrics_may_override_ranking: false,
  };
}

export function recipeFreshnessAllowsAutomaticPairing(value) {
  return value?.automatic_pairing === true;
}

export function recipeFreshnessRequiresHighConfidence(value) {
  return value?.status === "stale_reference";
}
