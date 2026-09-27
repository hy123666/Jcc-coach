import { createEvidenceMaterializationRegistry } from "./strategy-evidence-kernel.js";
import { taskContractFor } from "./host-task-contract-registry.js";
import { createHash } from "node:crypto";

export const MAX_RANKING_AGENT_CANDIDATES = 10;
const REF_SCHEMA = "jcc-host-evidence-address-reference-v1";
const array = (value) => Array.isArray(value) ? value : [];
const pointerToken = (value) => String(value).replaceAll("~", "~0").replaceAll("/", "~1");
const evidenceIdentityFor = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

function candidateIdentity(value) {
  const id = value?.candidate_id || value?.line_id || value?.id;
  const evidenceId = value?.candidate_evidence_id || value?.canonical_variant?.candidate_evidence_id;
  const variant = value?.selected_variant_id || value?.query_variant_id
    || value?.canonical_variant?.variant_id || value?.strategy_profile?.canonical_variant?.variant_id;
  return id || evidenceId ? {
    id: String(id || evidenceId),
    evidenceId: evidenceId ? String(evidenceId) : "",
    variant: String(variant || ""),
  } : null;
}

export const RANKING_ATOMIC_FIELDS = Object.freeze([
  "candidate_id", "candidate_evidence_id", "selected_variant_id", "atomic_roster_id", "roster_is_atomic",
  "canonical_variant", "main_carry", "primary_tank", "equipment_requirements", "lifecycle_prior",
  "formation_profile", "condition_priors", "semantic_signature", "atomic_variant_comparison",
  "atomic_variant_difference", "mature_recipe_variant_receipt",
  "top4_rate", "top1_rate", "use_rate", "metrics_authority", "strength_source", "source_role",
  "provenance", "evidence_boundary", "transition_populations", "transition_steps",
]);

function sameCandidate(left, right) {
  const a = candidateIdentity(left);
  const b = candidateIdentity(right);
  return a && b && (a.evidenceId && b.evidenceId
    ? a.evidenceId === b.evidenceId
    : a.id === b.id && a.variant === b.variant);
}

const ARCHIVE_FIELDS = new Set(["archive", "archives"]);

function archiveReceipt(value, { candidateEvidenceId, field }) {
  const serialized = JSON.stringify(value);
  return {
    schema: "jcc-host-evidence-archive-receipt-v1",
    field,
    candidate_evidence_id: candidateEvidenceId || null,
    content_ref: evidenceIdentityFor(value),
    content_bytes: Buffer.byteLength(serialized),
    entry_count: Array.isArray(value) ? value.length : null,
    status: "omitted_from_host_turn",
  };
}

function trimCandidateArchives(candidate) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const evidenceId = candidate.candidate_evidence_id || candidate.canonical_variant?.candidate_evidence_id || null;
  const receipts = array(candidate.host_evidence_archive_receipts).map((receipt) => structuredClone(receipt));
  const trimObject = (container, prefix) => {
    if (!container || typeof container !== "object" || Array.isArray(container)) return;
    for (const key of Object.keys(container)) {
      if (!ARCHIVE_FIELDS.has(key) || container[key] === null || container[key] === undefined) continue;
      receipts.push(archiveReceipt(container[key], { candidateEvidenceId: evidenceId, field: `${prefix}.${key}` }));
      delete container[key];
    }
  };
  trimObject(candidate, "candidate");
  trimObject(candidate.canonical_variant, "canonical_variant");
  // Runtime projection already bounds retained variants and mature recipes.
  // Those retained values are Host evidence and must survive materialization;
  // only explicitly named archive containers are removed here.
  if (receipts.length) candidate.host_evidence_archive_receipts = receipts;
  return candidate;
}

function candidateKey(value) {
  const identity = value?.evidenceId !== undefined ? value : candidateIdentity(value);
  return identity?.evidenceId || `${identity?.id || ""}:${identity?.variant || ""}`;
}

function durableTargetCandidateIds(delta) {
  const candidates = [
    delta?.target_plan,
    delta?.runtime_context?.match_facts?.target_plan,
    delta?.runtime_context?.target_plan,
    delta?.context?.runtime_context?.match_facts?.target_plan,
    delta?.context?.match_context?.target_plan,
  ];
  const target = candidates.find((value) => value && typeof value === "object"
    && (value.authority === "durable_target_plan" || value.persisted === true));
  if (!target) return null;
  const values = [
    target.candidate_id,
    target.selected_candidate_id,
    target.selected_variant_id,
    target.lineup_id,
    ...array(target.candidate_ids),
    ...array(target.unit_names),
    ...array(target.core_unit_names),
  ].filter(Boolean).map(String);
  return values.length ? new Set(values) : null;
}

function durableTargetExactIdentity(delta) {
  const candidates = [
    delta?.target_plan,
    delta?.runtime_context?.match_facts?.target_plan,
    delta?.runtime_context?.target_plan,
    delta?.context?.runtime_context?.match_facts?.target_plan,
    delta?.context?.match_context?.target_plan,
  ];
  const target = candidates.find((value) => value && typeof value === "object"
    && (value.authority === "durable_target_plan" || value.persisted === true));
  if (!target) return null;
  const candidateIds = [
    target.candidate_id,
    target.selected_candidate_id,
    target.lineup_id,
    target.lineup_group_id,
  ].filter(Boolean).map(String);
  const evidenceIds = [target.candidate_evidence_id].filter(Boolean).map(String);
  const variantIds = [target.selected_variant_id, target.variant_id].filter(Boolean).map(String);
  if (!candidateIds.length && !evidenceIds.length && !variantIds.length) return null;
  return { candidateIds, evidenceIds, variantIds };
}

function candidateMatchesDurableTarget(candidate, targetIds) {
  if (!targetIds) return false;
  return [
    candidate?.candidate_id,
    candidate?.line_id,
    candidate?.id,
    candidate?.candidate_evidence_id,
    candidate?.selected_variant_id,
    candidate?.canonical_variant?.variant_id,
  ].filter(Boolean).some((value) => targetIds.has(String(value)));
}

function candidateMatchesExactDurableTarget(candidate, identity) {
  if (!identity || !candidate) return false;
  const candidateId = String(candidate?.candidate_id || candidate?.line_id || candidate?.id || candidate?.lineup_group_id || "");
  const evidenceId = String(candidate?.candidate_evidence_id
    || candidate?.canonical_variant?.candidate_evidence_id || "");
  const variantId = String(candidate?.selected_variant_id
    || candidate?.query_variant_id || candidate?.canonical_variant?.variant_id || "");
  return (identity.candidateIds.length === 0 || identity.candidateIds.includes(candidateId))
    && (identity.evidenceIds.length === 0 || identity.evidenceIds.includes(evidenceId))
    && (identity.variantIds.length === 0 || identity.variantIds.includes(variantId));
}

// Select at candidate boundaries, before any payload deduplication. The source
// is this turn's rebuilt evidence, never a previous serialized Host request.
export function materializeHostEvidence(delta, { runtimeContext = {}, ledger = null } = {}) {
  const output = structuredClone(delta);
  const contract = taskContractFor(delta.mode, delta.request_kind);
  if (["manual_match_variables"].includes(delta.mode) || contract.id === "fact_capture") return output;
  const context = output.runtime_context || {};
  const policy = output.evidence_policy_id || context.current_turn_contract?.source_policy?.evidence_policy
    || runtimeContext.context_policy?.evidence_policy_id || runtimeContext.context_policy?.evidence_policy
    || context.strategy_evidence_plan?.evidence_policy_id || "normal_selected_context";
  const rankingAllowed = !["active_core_profile_only", "popular_recipe_catalog_only"].includes(policy)
    && !["core_only", "popular_recipe"].includes(contract.id);
  const sourceFit = !rankingAllowed ? null
    : runtimeContext.strategy_fit_packet || runtimeContext.cruise_decision_context?.strategy_fit_packet;
  const sourceSelected = runtimeContext.selected_ranking_candidates;
  const fit = rankingAllowed ? context.strategy_fit_packet : null;
  for (const candidate of array(fit?.candidate_working_set).slice(0, MAX_RANKING_AGENT_CANDIDATES)) {
    const source = array(sourceFit?.candidate_working_set).find((row) => sameCandidate(candidate, row));
    if (!source) continue;
    for (const key of RANKING_ATOMIC_FIELDS) {
      if (source[key] !== undefined) candidate[key] = structuredClone(source[key]);
    }
    trimCandidateArchives(candidate);
  }
  let candidates = !rankingAllowed ? [] : array(fit?.candidate_working_set).length
    ? fit.candidate_working_set : array(output.selected_ranking_candidates?.candidates);
  const targetIds = durableTargetCandidateIds(delta);
  if (targetIds && (delta.mode === "lineup_card" || delta.request_kind === "lineup_card")) {
    const exact = durableTargetExactIdentity(delta);
    const targetIndex = exact
      ? candidates.findIndex((candidate) => candidateMatchesExactDurableTarget(candidate, exact))
      : candidates.findIndex((candidate) => candidateMatchesDurableTarget(candidate, targetIds));
    if (targetIndex >= 0) {
      const targetCandidate = candidates[targetIndex];
      // An exact final-target confirmation is a single-target delivery. Open
      // lineup exploration may still retain bounded comparators for Host
      // judgment, but it must not inherit them after an exact identity exists.
      const targetIsExact = Boolean(exact);
      const comparators = targetIsExact ? [] : candidates.filter((candidate, index) => index !== targetIndex
        && !sameCandidate(candidate, targetCandidate)).slice(0, 2);
      candidates = [targetCandidate, ...comparators];
      if (Array.isArray(fit?.candidate_working_set)) fit.candidate_working_set = candidates;
      if (Array.isArray(output.selected_ranking_candidates?.candidates)) {
        output.selected_ranking_candidates.candidates = candidates;
      }
    }
  }
  const ledgerIdentity = fit?.candidate_working_set_reused
    ? ledger?.stable_strategy_evidence || fit?.candidate_working_set_identity : null;
  const reusedIdentity = ledgerIdentity ? {
    id: ledgerIdentity.id || null,
    fingerprint: ledgerIdentity.fingerprint,
    candidate_content_fingerprints: array(ledgerIdentity.candidate_content_fingerprints).map(row => ({
      candidate_id: row.candidate_id || row.line_id || row.id,
      selected_variant_id: candidateIdentity(row)?.variant || null,
      candidate_evidence_id: row.candidate_evidence_id || null,
      content_fingerprint: row.content_fingerprint || row.fingerprint || null,
    })),
  } : null;
  if (fit?.candidate_working_set_reused && !reusedIdentity?.fingerprint) {
    throw new Error("host_evidence_ledger_requires_current_turn_rebuild");
  }
  const identities = [];
  const selectionRows = reusedIdentity
    ? array(reusedIdentity.candidate_content_fingerprints)
    : candidates;
  for (const candidate of selectionRows) {
    const identity = candidateIdentity(candidate);
    if (identity && !identities.some((entry) => candidateKey(entry) === candidateKey(identity))) identities.push(identity);
    if (identities.length === MAX_RANKING_AGENT_CANDIDATES) break;
  }
  function retained(candidate) {
    const identity = candidateIdentity(candidate);
    return identity && identities.some((entry) => candidateKey(entry) === candidateKey(identity));
  }
  const bounded = output;
  const boundedContext = bounded.runtime_context || {};
  const fits = new Set();
  const rankings = new Set();
  function collect(container, rankingContainer = false) {
    if (!container || typeof container !== "object") return;
    if (container.candidate_working_set || container.candidate_working_set_reused
      || container.next_coach_plan || container.strategic_obligation || container.strategic_checkpoint) fits.add(container);
    if (rankingContainer && (container.candidates || container.candidate_refs)) rankings.add(container);
    if (container.strategy_fit_packet) collect(container.strategy_fit_packet);
    if (container.selected_ranking_candidates) collect(container.selected_ranking_candidates, true);
  }
  collect(boundedContext.strategy_fit_packet);
  collect(boundedContext.cruise_decision_context?.strategy_fit_packet);
  collect(boundedContext.selected_ranking_candidates, true);
  collect(bounded.selected_ranking_candidates, true);
  const prefetchEvidence = boundedContext.strategy_evidence_prefetch?.evidence || {};
  const receipts = array(boundedContext.strategy_evidence_coverage?.receipts);
  const frontierKeys = new Set();
  for (const [key, value] of Object.entries(prefetchEvidence)) {
    const facets = receipts.filter(receipt => array(receipt.evidence_keys).includes(key)).map(receipt => receipt.facet_id);
    collect(value, facets.some(facet => facet.startsWith("ranking_")));
    // A frontier's source is declared by the kernel, not inferred from the
    // generic `candidates` field used by Core augment/equipment calculations.
    if (facets.includes("candidate_frontier") && receipts.some(receipt =>
      receipt.facet_id === "candidate_frontier" && array(receipt.evidence_keys).includes(key)
      && receipt.source_domain === "ranking")) frontierKeys.add(key);
  }
  if (!rankingAllowed && [...fits, ...rankings].some((value) =>
    array(value.candidate_working_set).length || array(value.candidates).length || array(value.candidate_refs).length)) {
    throw new Error("task_source_policy_ranking_evidence_forbidden");
  }
  const rowsForTurn = (rows) => {
    const seen = new Set();
    return array(rows).filter((row) => {
      const key = candidateKey(row);
      if (!retained(row) || seen.has(key)) return false;
      seen.add(key);
      trimCandidateArchives(row);
      return true;
    }).slice(0, MAX_RANKING_AGENT_CANDIDATES);
  };
  const ledgerRef = (row) => ({
    candidate_id: row.candidate_id || row.line_id || row.id || null,
    candidate_evidence_id: row.candidate_evidence_id || row.canonical_variant?.candidate_evidence_id || null,
    selected_variant_id: candidateIdentity(row)?.variant || null,
    working_set_identity: reusedIdentity?.id || reusedIdentity?.fingerprint,
  });
  const canonicalFit = [...fits].find((container) => container === boundedContext.strategy_fit_packet)
    || [...fits][0] || null;
  const canonicalCandidateAddresses = new Map();
  if (canonicalFit === boundedContext.strategy_fit_packet) {
    for (const [index, row] of array(canonicalFit?.candidate_working_set).entries()) {
      const identity = candidateIdentity(row);
      if (identity) canonicalCandidateAddresses.set(candidateKey(identity),
        `/runtime_context/strategy_fit_packet/candidate_working_set/${index}`);
    }
  }
  const addressRefForCandidate = (row) => {
    const identity = candidateIdentity(row);
    const address = identity ? canonicalCandidateAddresses.get(candidateKey(identity)) : null;
    const canonical = address
      ? array(canonicalFit?.candidate_working_set).find((candidate) => candidateKey(candidate) === candidateKey(row))
      : null;
    return address ? {
      schema: REF_SCHEMA,
      address,
      evidence_identity: evidenceIdentityFor(canonical),
      candidate_id: row.candidate_id || row.line_id || row.id || null,
      candidate_evidence_id: row.candidate_evidence_id || row.canonical_variant?.candidate_evidence_id || null,
      selected_variant_id: identity?.variant || null,
    } : row;
  };
  for (const key of frontierKeys) {
    if (!rankingAllowed && array(prefetchEvidence[key]).length) throw new Error("task_source_policy_ranking_evidence_forbidden");
    prefetchEvidence[key] = rowsForTurn(prefetchEvidence[key]).map(row => reusedIdentity ? ledgerRef(row) : addressRefForCandidate(row));
  }
  for (const container of fits) {
    if (reusedIdentity) {
      delete container.candidate_working_set;
      container.candidate_working_set_reused = true;
      container.candidate_working_set_identity = reusedIdentity;
    } else if (Array.isArray(container.candidate_working_set)) {
      container.candidate_working_set = rowsForTurn(container.candidate_working_set);
      for (const row of container.candidate_working_set) {
        const source = array(sourceFit?.candidate_working_set).find((entry) => sameCandidate(row, entry));
        for (const key of RANKING_ATOMIC_FIELDS) {
          if (source?.[key] !== undefined) row[key] = structuredClone(source[key]);
        }
        trimCandidateArchives(row);
      }
    }
    for (const key of ["candidate_lines", "candidate_frontier"]) {
      if (Array.isArray(container[key])) container[key] = rowsForTurn(container[key]).map((row) => (
        reusedIdentity || container !== canonicalFit ? ledgerRef(row) : row
      ));
    }
    container.candidate_working_set_count = identities.length;
    container.candidate_working_set_limit = MAX_RANKING_AGENT_CANDIDATES;
  }
  for (const container of rankings) {
    if (Array.isArray(container.candidates)) {
      const rows = rowsForTurn(container.candidates);
      if (reusedIdentity) {
        container.candidate_refs = rows.map(ledgerRef);
        delete container.candidates;
      } else container.candidates = rows;
    }
    if (Array.isArray(container.candidate_refs)) container.candidate_refs = rowsForTurn(container.candidate_refs).map((row) => reusedIdentity ? ledgerRef(row) : row);
    container.candidate_working_set_count = identities.length;
  }
  if (contract.output_contract === "choice_handoff" && !delta.response_contract_ref?.candidate_refs) {
    delete boundedContext.strategic_obligation;
    for (const container of fits) {
      for (const key of ["strategic_obligation", "strategic_checkpoint", "required_decisions", "required_decision_keys"]) delete container[key];
      if (container.next_coach_plan) {
        for (const key of ["strategic_obligation", "required_decisions", "required_decision_keys"]) delete container.next_coach_plan[key];
      }
    }
  }
  const snapshotId = boundedContext.strategy_evidence_snapshot?.evidence_snapshot_id
    || `turn:${bounded.request_id || bounded.request_hash || "anonymous"}`;
  const { intern, references } = createEvidenceEncoder(snapshotId);
  const encodedContainers = new WeakSet();
  function encodeRows(container, base) {
    if (!container || encodedContainers.has(container)) return;
    encodedContainers.add(container);
    for (const key of ["candidate_working_set", "candidate_lines", "candidate_frontier", "candidates"]) {
      if (Array.isArray(container[key])) container[key] = container[key].map((row, index) =>
        intern(row, `${base}/${key}/${index}`, true));
    }
  }
  encodeRows(boundedContext.strategy_fit_packet, "/runtime_context/strategy_fit_packet");
  encodeRows(bounded.selected_ranking_candidates, "/selected_ranking_candidates");
  encodeRows(boundedContext.selected_ranking_candidates, "/runtime_context/selected_ranking_candidates");
  encodeRows(boundedContext.cruise_decision_context?.strategy_fit_packet, "/runtime_context/cruise_decision_context/strategy_fit_packet");
  if (boundedContext.match_facts) {
    boundedContext.match_facts = intern(boundedContext.match_facts, "/runtime_context/match_facts");
  }
  for (const key of ["decision_math_context", "itemization_context", "theorycraft_context", "open_reasoning_task"]) {
    if (boundedContext[key]) boundedContext[key] = intern(boundedContext[key], `/runtime_context/${key}`);
  }
  for (const [key, value] of Object.entries(prefetchEvidence)) {
    const base = `/runtime_context/strategy_evidence_prefetch/evidence/${pointerToken(key)}`;
    if (fits.has(value) || rankings.has(value)) encodeRows(value, base);
    else if (value?.strategy_fit_packet || value?.selected_ranking_candidates) {
      encodeRows(value.strategy_fit_packet, `${base}/strategy_fit_packet`);
      encodeRows(value.selected_ranking_candidates, `${base}/selected_ranking_candidates`);
    } else prefetchEvidence[key] = intern(value, base);
  }
  boundedContext.host_evidence_materialization = {
    schema: "jcc-host-evidence-materialization-v1",
    evidence_snapshot_id: snapshotId,
    reference_schema: REF_SCHEMA,
    reference_count: references.length,
    agent_candidate_count: identities.length,
    agent_candidate_limit: MAX_RANKING_AGENT_CANDIDATES,
    retrieval_pool_count: candidates.length,
    ranking_source_count: sourceFit?.candidate_working_set_source_count
      ?? sourceFit?.candidate_working_set_count ?? sourceSelected?.candidate_working_set_source_count ?? candidates.length,
    requested_display_count: fit?.requested_display_count ?? output.selected_ranking_candidates?.requested_display_count ?? null,
    recovery_policy: taskContractFor(delta.mode, delta.request_kind).recovery_policy,
    ledger_identity: ledger?.stable_strategy_evidence?.id || null,
    recovery_delivery: reusedIdentity ? "existing_session_ledger_reuse_no_source_reinjection" : "current_fields_with_local_address_references",
  };
  bounded.runtime_context = boundedContext;
  return bounded;
}

function createEvidenceEncoder(snapshotId) {
  const registry = createEvidenceMaterializationRegistry(snapshotId);
  const addresses = new Map();
  const candidateAddresses = new Map();
  const references = [];
  const containsReference = (value) => value && typeof value === "object"
    && (value.schema === REF_SCHEMA || Object.values(value).some(containsReference));
  // Decide parent reuse before visiting children: hidden descendants must never
  // become address targets. Hash original values, then retain the encoded hash.
  function intern(value, address, candidateRow = false) {
    if (!value || typeof value !== "object") return value;
    if (value.schema === REF_SCHEMA) return value;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    // Existing frontier refs already encode their children; their parent's raw
    // JSON hash is not an expanded evidence identity. Keep that parent inline.
    const entry = bytes >= 256 && !containsReference(value) ? registry.register(address, value) : null;
    const identityKey = entry && candidateRow && candidateIdentity(value)?.evidenceId ? candidateKey(value) : null;
    const target = (identityKey && candidateAddresses.get(identityKey))
      || (entry && addresses.get(entry.evidence_key));
    const reference = target ? { schema: REF_SCHEMA, ...target } : null;
    if (reference && (identityKey || Buffer.byteLength(JSON.stringify(reference)) < bytes)) {
      references.push(address);
      return reference;
    }
    const encoded = Array.isArray(value)
      ? value.map((child, index) => intern(child, `${address}/${index}`))
      : Object.fromEntries(Object.entries(value).map(([key, child]) =>
        [key, intern(child, `${address}/${pointerToken(key)}`)]));
    if (entry && !target) {
      const materialized = { address, evidence_identity: entry.evidence_identity };
      const encodedIdentity = evidenceIdentityFor(encoded);
      if (encodedIdentity !== entry.evidence_identity) materialized.encoded_evidence_identity = encodedIdentity;
      addresses.set(entry.evidence_key, materialized);
      if (identityKey) candidateAddresses.set(identityKey, materialized);
    }
    return encoded;
  }
  return { intern, references };
}

// One result is a self-contained document. No address can refer to an earlier call.
export function materializeReadonlyEvidence(payload) {
  return createEvidenceEncoder(payload?.evidence_snapshot_id || "readonly-result").intern(payload, "");
}

export function restoreHostEvidence(payload) {
  const registry = createEvidenceMaterializationRegistry("restore");
  const resolving = new Set();
  function restore(value) {
    if (!value || typeof value !== "object") return value;
    if (value.schema === REF_SCHEMA) {
      if (typeof value.address !== "string" || !value.address.startsWith("/") || resolving.has(value.address)) {
        throw new Error("host_evidence_reference_invalid_or_cyclic");
      }
      resolving.add(value.address);
      let target = payload;
      for (const token of value.address.slice(1).split("/")) {
        const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
        if (!target || !Object.hasOwn(target, key)) throw new Error("host_evidence_reference_missing");
        target = target[key];
      }
      if (target?.schema === REF_SCHEMA) throw new Error("host_evidence_reference_target_must_be_materialized");
      if (value.encoded_evidence_identity !== undefined
        && evidenceIdentityFor(target) !== value.encoded_evidence_identity) {
        throw new Error("host_evidence_reference_encoded_identity_mismatch");
      }
      const result = restore(target);
      if (registry.register(value.address, result)?.evidence_identity !== value.evidence_identity) {
        throw new Error("host_evidence_reference_identity_mismatch");
      }
      resolving.delete(value.address);
      return result;
    }
    if (Array.isArray(value)) return value.map(restore);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restore(child)]));
  }
  return restore(payload);
}
