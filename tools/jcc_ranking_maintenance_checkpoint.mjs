import { createHash } from "node:crypto";

export const RANKING_MAINTENANCE_CHECKPOINT_SCHEMA = "jcc-ranking-maintenance-checkpoint-v1";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function recordIds(batch) {
  return (Array.isArray(batch?.records) ? batch.records : [])
    .map((record) => String(record?.lineup_id || "").trim())
    .filter(Boolean)
    .sort();
}

function batchDescriptor(batch, batchPath) {
  return {
    batch_path: String(batchPath),
    input_hash: String(batch?.input_hash || ""),
    record_ids: recordIds(batch),
    status: "pending",
    attempt_count: 0,
    response: null,
    updated_at: null,
  };
}

export function createRankingMaintenanceCheckpoint(packet, batches, now = new Date().toISOString()) {
  if (!packet || packet.schema !== "jcc-ranking-maintenance-packet-v1") {
    throw new TypeError("valid maintenance packet is required");
  }
  return {
    schema: RANKING_MAINTENANCE_CHECKPOINT_SCHEMA,
    version: 1,
    input_hash: String(packet.input_hash || ""),
    target_identity: structuredClone(packet.target_identity || null),
    stat_date: packet.stat_date || null,
    created_at: now,
    updated_at: now,
    batches: (Array.isArray(batches) ? batches : []).map((batch, index) => batchDescriptor(batch, String(index + 1))),
  };
}

export function normalizeRankingMaintenanceCheckpoint(value) {
  if (!value || value.schema !== RANKING_MAINTENANCE_CHECKPOINT_SCHEMA || value.version !== 1) return null;
  if (!Array.isArray(value.batches)) return null;
  const batches = value.batches.map((batch) => ({
    batch_path: String(batch?.batch_path || ""),
    input_hash: String(batch?.input_hash || ""),
    record_ids: [...new Set((Array.isArray(batch?.record_ids) ? batch.record_ids : []).map(String))].sort(),
    status: batch?.status === "ready" ? "ready" : "pending",
    attempt_count: Number.isInteger(batch?.attempt_count) && batch.attempt_count >= 0 ? batch.attempt_count : 0,
    response: batch?.response && typeof batch.response === "object" ? structuredClone(batch.response) : null,
    updated_at: batch?.updated_at || null,
  }));
  if (batches.some((batch) => !batch.batch_path || !batch.input_hash || !batch.record_ids.length)) return null;
  return {
    schema: value.schema,
    version: value.version,
    input_hash: String(value.input_hash || ""),
    target_identity: structuredClone(value.target_identity || null),
    stat_date: value.stat_date || null,
    created_at: value.created_at || null,
    updated_at: value.updated_at || null,
    batches,
  };
}

export function checkpointMatchesPacket(checkpoint, packet) {
  const normalized = normalizeRankingMaintenanceCheckpoint(checkpoint);
  return Boolean(normalized
    && packet?.schema === "jcc-ranking-maintenance-packet-v1"
    && normalized.input_hash === String(packet.input_hash || "")
    && normalized.stat_date === (packet.stat_date || null)
    && JSON.stringify(stableValue(normalized.target_identity)) === JSON.stringify(stableValue(packet.target_identity || null)));
}

export function checkpointBatch(checkpoint, batch, batchPath) {
  const normalized = normalizeRankingMaintenanceCheckpoint(checkpoint);
  if (!normalized || !batch) return null;
  const expectedPath = String(batchPath);
  const expectedHash = String(batch.input_hash || "");
  const expectedIds = recordIds(batch);
  return normalized.batches.find((entry) => entry.batch_path === expectedPath
    && entry.input_hash === expectedHash
    && JSON.stringify(entry.record_ids) === JSON.stringify(expectedIds)) || null;
}

export function markRankingMaintenanceBatchReady(checkpoint, batch, batchPath, response, attemptCount = 1, now = new Date().toISOString()) {
  const normalized = normalizeRankingMaintenanceCheckpoint(checkpoint);
  if (!normalized || !batch) throw new TypeError("valid checkpoint and batch are required");
  const path = String(batchPath);
  const descriptor = batchDescriptor(batch, path);
  const index = normalized.batches.findIndex((entry) => entry.batch_path === path);
  const next = {
    ...descriptor,
    status: "ready",
    attempt_count: Math.max(0, Number(attemptCount) || 0),
    response: structuredClone(response),
    updated_at: now,
  };
  const batches = [...normalized.batches];
  if (index >= 0) batches[index] = next;
  else batches.push(next);
  return {
    ...normalized,
    updated_at: now,
    batches: batches.sort((left, right) => left.batch_path.localeCompare(right.batch_path, undefined, { numeric: true })),
  };
}

export function markRankingMaintenanceBatchAttempt(checkpoint, batch, batchPath, attemptCount, now = new Date().toISOString()) {
  const normalized = normalizeRankingMaintenanceCheckpoint(checkpoint);
  if (!normalized || !batch) throw new TypeError("valid checkpoint and batch are required");
  const path = String(batchPath);
  const descriptor = batchDescriptor(batch, path);
  const index = normalized.batches.findIndex((entry) => entry.batch_path === path);
  const previous = index >= 0 ? normalized.batches[index] : descriptor;
  const next = {
    ...previous,
    ...descriptor,
    attempt_count: Math.max(previous.attempt_count, Number(attemptCount) || 0),
    status: previous.status === "ready" ? "ready" : "pending",
    response: previous.status === "ready" ? previous.response : null,
    updated_at: now,
  };
  const batches = [...normalized.batches];
  if (index >= 0) batches[index] = next;
  else batches.push(next);
  return {
    ...normalized,
    updated_at: now,
    batches: batches.sort((left, right) => left.batch_path.localeCompare(right.batch_path, undefined, { numeric: true })),
  };
}

export function checkpointReadyResponses(checkpoint) {
  const normalized = normalizeRankingMaintenanceCheckpoint(checkpoint);
  return normalized ? normalized.batches.filter((entry) => entry.status === "ready" && entry.response) : [];
}

export function rankingMaintenanceCheckpointHash(checkpoint) {
  const normalized = normalizeRankingMaintenanceCheckpoint(checkpoint);
  return normalized ? stableHash(normalized) : null;
}
