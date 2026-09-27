const CORE_PROFILE_ID_PATTERN = /^[a-f0-9]{64}$/;
const RANKING_GENERATION_ID_PATTERN = /^\d{8}-[a-f0-9]{24}$/;

function strings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

export function normalizeGameKnowledgeGenerationLease(lease = {}, now = new Date().toISOString()) {
  const coreProfileId = String(lease?.core_profile_id || "").trim();
  if (!CORE_PROFILE_ID_PATTERN.test(coreProfileId)) return null;
  const rankingOverlayId = String(lease?.ranking_overlay_id || "").trim();
  const recipeGenerationId = String(lease?.recipe_generation_id || "").trim();
  return {
    core_profile_id: coreProfileId,
    ranking_overlay_id: RANKING_GENERATION_ID_PATTERN.test(rankingOverlayId)
      ? rankingOverlayId
      : null,
    recipe_generation_id: CORE_PROFILE_ID_PATTERN.test(recipeGenerationId)
      ? recipeGenerationId
      : null,
    match_session_id: lease?.match_session_id || null,
    status: String(lease?.status || "active"),
    owner: lease?.owner || null,
    route_keys: strings(lease?.route_keys || lease?.host_session_keys || []),
    reason: lease?.reason || null,
    leased_at: lease?.leased_at || now,
  };
}

export function generationLeaseSnapshotKey(lease = {}) {
  return [
    String(lease?.core_profile_id || ""),
    String(lease?.ranking_overlay_id || ""),
    String(lease?.recipe_generation_id || lease?.recipe_catalog_generation_id || ""),
  ].join(":");
}

function generationLeaseIdentity(lease = {}) {
  if (lease?.match_session_id) return `match:${lease.match_session_id}`;
  if (lease?.status === "starting") return `starting:${generationLeaseSnapshotKey(lease)}`;
  return [
    "unowned",
    generationLeaseSnapshotKey(lease),
    String(lease?.status || "active"),
    String(lease?.owner || ""),
  ].join(":");
}

export function reconcileGameKnowledgeGenerationLeases(existingLeases = [], incomingLeases = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const releaseMatchSessionIds = new Set(strings(options.release_match_session_ids));
  const releaseStartingSnapshotKeys = new Set(strings(options.release_starting_snapshot_keys));
  const incoming = (Array.isArray(incomingLeases) ? incomingLeases : [])
    .map((lease) => normalizeGameKnowledgeGenerationLease(lease, now))
    .filter(Boolean);
  const incomingIdentities = new Set(incoming.map(generationLeaseIdentity));
  const reconciled = new Map();

  if (options.replace_all !== true) {
    for (const rawLease of Array.isArray(existingLeases) ? existingLeases : []) {
      const lease = normalizeGameKnowledgeGenerationLease(rawLease, now);
      if (!lease) continue;
      if (lease.match_session_id && releaseMatchSessionIds.has(String(lease.match_session_id))) continue;
      if (
        lease.status === "starting"
        && releaseStartingSnapshotKeys.has(generationLeaseSnapshotKey(lease))
      ) continue;
      const identity = generationLeaseIdentity(lease);
      if (incomingIdentities.has(identity)) continue;
      reconciled.set(identity, lease);
    }
  }

  for (const lease of incoming) reconciled.set(generationLeaseIdentity(lease), lease);
  return [...reconciled.values()].sort((left, right) => (
    String(left.match_session_id || "").localeCompare(String(right.match_session_id || ""))
      || String(left.status || "").localeCompare(String(right.status || ""))
      || generationLeaseSnapshotKey(left).localeCompare(generationLeaseSnapshotKey(right))
  ));
}
