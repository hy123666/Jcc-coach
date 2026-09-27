import { createHash } from "node:crypto";

function requiredIdentity(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Knowledge Snapshot is missing ${label}`);
  return normalized;
}

export function createKnowledgeSnapshot({
  coreProfileId,
  rankingOverlayId,
  seasonId,
  patchId,
  coreSourceIdentity,
  rankingSourceIdentity,
  capturedAt = new Date().toISOString(),
} = {}) {
  const core = requiredIdentity(coreProfileId, "core_profile_id");
  const rankingId = requiredIdentity(rankingOverlayId || `unavailable:${core}`, "ranking_overlay_id");
  const season = requiredIdentity(seasonId, "season_id");
  const patch = requiredIdentity(patchId, "patch_id");
  const rankingIdentity = rankingSourceIdentity || null;
  const rankingSeason = String(rankingIdentity?.season_id || rankingIdentity?.runtime_season_id || "").trim();
  const rankingPatch = String(rankingIdentity?.patch_id || rankingIdentity?.active_patch_id || "").trim();
  const rankingCore = String(rankingIdentity?.core_profile_id || "").trim();
  const coreCatalog = String(coreSourceIdentity?.catalog_source_fingerprint || "").trim();
  const rankingCatalog = String(rankingIdentity?.catalog_fingerprint || rankingIdentity?.catalog_source_fingerprint || "").trim();
  const rankingGeneration = String(rankingIdentity?.ranking_overlay_id || rankingId).trim();
  const closureStatus = String(rankingIdentity?.dependency_closure_status || "").trim();
  const unavailableRanking = rankingId.startsWith("unavailable:");
  if (rankingCore && rankingCore !== core) {
    throw new Error("Ranking overlay is incompatible with the Core Profile generation");
  }
  if (rankingCatalog && coreCatalog && rankingCatalog !== coreCatalog) {
    throw new Error("Ranking overlay is incompatible with the Core Profile catalog");
  }
  if (rankingSeason && rankingSeason !== season) {
    throw new Error("Ranking overlay is incompatible with the Core Profile season");
  }
  if (rankingPatch && rankingPatch !== patch) {
    throw new Error("Ranking overlay is incompatible with the Core Profile patch");
  }
  const identity = {
    core_profile_id: core,
    ranking_overlay_id: rankingId,
    season_id: season,
    patch_id: patch,
    catalog_fingerprint: rankingCatalog || coreCatalog || null,
    ranking_generation: rankingGeneration,
    dependency_closure_status: unavailableRanking ? "unavailable" : (closureStatus || "closed"),
  };
  const generationId = createHash("sha256").update(JSON.stringify({
    core_profile_id: core,
    ranking_overlay_id: rankingId,
    season_id: season,
    patch_id: patch,
    catalog_fingerprint: rankingCatalog || coreCatalog || null,
    ranking_generation: rankingGeneration,
  })).digest("hex");
  return Object.freeze({
    schema: "jcc-knowledge-snapshot-v3",
    core_profile_id: core,
    ranking_overlay_id: rankingId,
    catalog_fingerprint: rankingCatalog || coreCatalog || null,
    ranking_generation: rankingGeneration,
    generation_id: generationId,
    captured_at: capturedAt,
    compatibility: Object.freeze({
      season_id: season,
      patch_id: patch,
      dependency_closure_status: unavailableRanking ? "unavailable" : (closureStatus || "closed"),
      status: unavailableRanking ? "ranking_overlay_unavailable" : "compatible",
    }),
  });
}

export function knowledgeSnapshotMatches(left, right) {
  return Boolean(left?.generation_id)
    && left.generation_id === right?.generation_id
    && left.core_profile_id === right?.core_profile_id
    && left.ranking_overlay_id === right?.ranking_overlay_id
    && left.catalog_fingerprint === right?.catalog_fingerprint
    && left.ranking_generation === right?.ranking_generation;
}
