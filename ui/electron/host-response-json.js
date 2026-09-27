import { isHostCoachTransportCandidate } from "./host-coach-response-contract.js";

const DEFAULT_MAX_HOST_JSON_CHARS = 4 * 1024 * 1024;

function hostJsonError(reason) {
  const error = new Error("host_cli_json_parse_failed");
  error.code = "JCC_HOST_JSON_PARSE_FAILED";
  error.reason = reason;
  return error;
}

function balancedObjectEnd(text, start, budget) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    budget.scanned += 1;
    if (budget.scanned > budget.maxScanned) throw hostJsonError("response_too_complex");
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      depth += 1;
      if (depth > budget.maxDepth) throw hostJsonError("response_too_complex");
    }
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function parsedObjectCandidates(raw, options = {}) {
  const candidates = [];
  let cursor = 0;
  let starts = 0;
  const budget = {
    scanned: 0,
    maxScanned: Math.max(raw.length, Number(options.maxScannedChars || raw.length * 2)),
    maxDepth: Math.max(1, Number(options.maxDepth || 256)),
  };
  const maxCandidateStarts = Math.max(1, Number(options.maxCandidateStarts || 128));
  while (cursor < raw.length) {
    const start = raw.indexOf("{", cursor);
    if (start < 0) break;
    starts += 1;
    if (starts > maxCandidateStarts) throw hostJsonError("response_too_complex");
    const end = balancedObjectEnd(raw, start, budget);
    if (end < 0) {
      cursor = start + 1;
      continue;
    }
    const jsonText = raw.slice(start, end);
    try {
      const value = JSON.parse(jsonText);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        candidates.push({ value, start, end, json_text: jsonText });
        cursor = end;
        continue;
      }
    } catch {}
    cursor = start + 1;
  }
  return candidates;
}

function defaultCoachResponseCandidate(value) {
  return isHostCoachTransportCandidate(value);
}

export function decodeHostJsonObject(text, options = {}) {
  const maxChars = Number(options.maxChars || DEFAULT_MAX_HOST_JSON_CHARS);
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) throw hostJsonError("empty_response");
  if (Number.isFinite(maxChars) && maxChars > 0 && raw.length > maxChars) {
    throw hostJsonError("response_too_large");
  }

  const parsed = parsedObjectCandidates(raw, options);
  if (!parsed.length) throw hostJsonError("valid_json_object_missing");
  const isCandidate = typeof options.isCandidate === "function" ? options.isCandidate : defaultCoachResponseCandidate;
  const coachCandidates = parsed.filter((entry) => isCandidate(entry.value));
  if (!coachCandidates.length) throw hostJsonError("coach_response_object_missing");
  if (coachCandidates.length > 1) throw hostJsonError("ambiguous_multiple_coach_response_objects");

  const selected = coachCandidates[0];
  return {
    value: selected.value,
    json_text: selected.json_text,
    prefix: raw.slice(0, selected.start).trim() || null,
    trailing: raw.slice(selected.end).trim() || null,
    parsed_object_count: parsed.length,
  };
}

export function parseHostJsonObject(text, options = {}) {
  return decodeHostJsonObject(text, options).value;
}

export const decodeFirstHostJsonObject = decodeHostJsonObject;
export const parseFirstHostJsonObject = parseHostJsonObject;
