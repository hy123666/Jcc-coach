import { createHash } from "node:crypto";

function json(value) { return JSON.stringify(value ?? null); }

function digest(value) {
  return createHash("sha256").update(json(value)).digest("hex");
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`knowledge aggregation requires ${name}`);
  return text;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * The aggregation boundary is deliberately data-only. It does not own Core,
 * Ranking, Wiki, or Match storage; callers provide the already-authorized
 * result and this function gives every query the same provenance envelope.
 */
export function aggregateKnowledgeResult({
  result = null,
  relations = [],
  missingFields = [],
  source = {},
  freshness = {},
  snapshotId,
  sessionId = null,
  query = {},
  reusableInSession = true,
  schema = "jcc-knowledge-aggregation-result-v1",
  operation = null,
} = {}) {
  const snapshot = required(snapshotId || source.knowledge_snapshot_id, "snapshot_id");
  const receiptId = `receipt:${digest({ snapshot, sessionId, query, result })}`;
  return deepFreeze({
    schema,
    operation,
    result,
    relations: Array.isArray(relations) ? relations : [],
    missing_fields: Array.isArray(missingFields) ? missingFields : [],
    source: Object.freeze({ ...source, knowledge_snapshot_id: snapshot }),
    freshness: Object.freeze({ ...freshness }),
    query_receipt: Object.freeze({
      receipt_id: receiptId,
      snapshot_id: snapshot,
      match_session_id: sessionId,
      query_fingerprint: `sha256:${digest(query)}`,
      reusable_in_session: reusableInSession === true,
    }),
  });
}

export function isReusableKnowledgeReceipt(receipt, { snapshotId, sessionId, query } = {}) {
  return receipt?.query_receipt?.snapshot_id === snapshotId
    && (receipt.query_receipt.match_session_id || null) === (sessionId || null)
    && receipt.query_receipt.query_fingerprint === `sha256:${digest(query)}`
    && receipt.query_receipt.reusable_in_session === true;
}
