import { createHash } from "node:crypto";
import { HOST_SUPPORTING_EVENT_FIELDS, HOST_TASK_CONTEXT_FIELDS, taskContractFor } from "./host-task-contract-registry.js";

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function pick(value, fields) {
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(value || {}, key)).map((key) => [key, clone(value[key])]));
}
function uniqueLabels(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(Boolean).map((entry) => String(entry).trim()).filter(Boolean))].slice(0, 12);
}
function clamp(value, max) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}...<truncated>` : text;
}

export function compactHostSupportingEvent(value) {
  if (!isRecord(value)) return null;
  const compact = pick(value, HOST_SUPPORTING_EVENT_FIELDS.filter((key) => value[key] !== null && value[key] !== undefined && value[key] !== ""));
  const labels = uniqueLabels(value.semantic_labels);
  if (labels.length) compact.semantic_labels = labels;
  const reason = value.reason === undefined || value.reason === null ? null : clamp(value.reason, 240);
  if (reason) compact.reason = reason;
  return Object.keys(compact).length ? compact : null;
}

export function compactHostSupportingContext(value) {
  if (!isRecord(value)) return null;
  const compact = {};
  const absorbed = compactHostSupportingEvent(value.absorbed_runtime_event_context);
  if (absorbed) compact.absorbed_runtime_event_context = absorbed;
  if (value.authority) compact.authority = String(value.authority).slice(0, 80);
  return Object.keys(compact).length ? compact : null;
}

export function projectHostTaskContext(request = {}, { mode = null, requestKind = null } = {}) {
  const contract = taskContractFor(request.mode || mode, request.request_kind || requestKind);
  const source = isRecord(request.context) ? request.context : {};
  const next = pick(source, contract.allowed_context_fields.filter((key) => source[key] !== undefined && source[key] !== null));
  if (isRecord(source.task)) {
    const task = {};
    for (const key of HOST_TASK_CONTEXT_FIELDS) {
      const entry = source.task[key];
      if (entry !== undefined && entry !== null) {
        task[key] = key === "user_message" ? clone(entry)
          : key === "semantic_labels" ? uniqueLabels(entry)
          : typeof entry === "string" ? clamp(entry, key === "short_advice" ? 320 : 180) : clone(entry);
      }
    }
    const event = compactHostSupportingEvent(source.task.runtime_event_context);
    if (event) task.runtime_event_context = event;
    if (Object.keys(task).length) next.task = task;
  }
  const supporting = compactHostSupportingContext(source.supporting_context);
  if (supporting) next.supporting_context = supporting;
  return next;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function withHostRequestProjectionMetadata(request, { mode = null, requestKind = null } = {}) {
  const {
    projection: _oldProjection,
    projection_hash: _oldHash,
    request_stage: _oldRequestStage,
    ...content
  } = request;
  const contract = taskContractFor(content.mode || mode, content.request_kind || requestKind);
  // Hash the JSON wire content, including rebuilt evidence, not a previous receipt.
  const projectionHash = createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(content)))).digest("hex").slice(0, 16);
  return {
    ...content,
    projection: {
      schema: "jcc-host-request-projection-v1",
      task_mode: content.mode || mode || null,
      contract_id: contract.id,
      output_contract: contract.output_contract,
      recovery_policy: contract.recovery_policy,
      request_stage: "canonical_enriched_request",
    },
    request_stage: "canonical_enriched_request",
    projection_hash: projectionHash,
  };
}

export function projectHostRequestForTask(request = {}, { mode = null, requestKind = null } = {}) {
  if (!isRecord(request)) return request;
  const contract = taskContractFor(request.mode || mode, request.request_kind || requestKind);
  const output = pick(request, contract.allowed_control_fields);
  const context = projectHostTaskContext(request, { mode, requestKind });
  if (Object.keys(context).length) output.context = context;
  if (contract.allowed_runtime_input_fields.length) {
    output.runtime_context = pick(isRecord(request.runtime_context) ? request.runtime_context : {}, contract.allowed_runtime_input_fields);
  }
  // Contract selection is not authorization: never synthesize kind, source
  // policy, card intent, or fact-write permission from mode or visible text.
  return withHostRequestProjectionMetadata(output, { mode, requestKind });
}

export function assertProjectedHostRequest(request) {
  if (!isRecord(request) || request.projection?.schema !== "jcc-host-request-projection-v1"
    || request.projection_hash !== withHostRequestProjectionMetadata(request).projection_hash) {
    throw new Error("host_request_projection_missing_or_stale");
  }
  return true;
}

export function isCanonicalHostRequest(request) {
  return isRecord(request)
    && request.request_stage === "canonical_enriched_request"
    && request.projection?.request_stage === "canonical_enriched_request"
    && request.projection_hash === withHostRequestProjectionMetadata(request).projection_hash;
}
