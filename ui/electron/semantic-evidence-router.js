import MiniSearch from "minisearch";
import { createHash } from "node:crypto";

export const SEMANTIC_EVIDENCE_ROUTER_SCHEMA = "jcc-semantic-evidence-router-v1";

export const DEFAULT_SEMANTIC_EVIDENCE_POLICY = Object.freeze({
  max_documents: 96,
  max_hits: 8,
  max_document_chars: 8_000,
  max_excerpt_chars: 420,
  max_serialized_bytes: 8_192,
  fuzzy: 0.24,
  prefix: true,
  field_weights: Object.freeze({
    aliases: 5,
    title: 4,
    entities: 3,
    facts: 2.5,
    features: 3.5,
    relations: 2.5,
    conditions: 2,
    route_kind: 1.5,
    content: 1,
  }),
});

const SOURCE_PRIORITY = Object.freeze({
  patch_doc: 400,
  season_doc: 300,
  common_doc: 200,
  wiki_doc: 100,
});

const INDEX_FIELDS = ["aliases", "title", "entities", "facts", "features", "relations", "conditions", "route_kind", "content"];

export function normalizeSemanticEvidenceText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u00a0\t\r]+/g, " ")
    .replace(/[•・]/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeSemanticEvidence(value) {
  const terms = [];
  const normalized = normalizeSemanticEvidenceText(value);
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[a-z0-9_+.-]+/gu)) {
    const term = match[0];
    if (/^[\p{Script=Han}]+$/u.test(term)) {
      terms.push(term);
      const characters = [...term];
      if (characters.length === 1) terms.push(characters[0]);
      for (let index = 0; index < characters.length - 1; index += 1) {
        terms.push(`${characters[index]}${characters[index + 1]}`);
      }
    } else {
      terms.push(term);
    }
  }
  return uniqueStrings(terms);
}

export function routeSemanticEvidence(input = {}, policyOverride = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("semantic evidence input must be an object");
  }

  const policy = resolvePolicy(input.policy, policyOverride);
  const routeKinds = uniqueStrings([
    ...stringValues(input.route_kinds ?? input.routeKinds),
    cleanString(input.route_kind ?? input.routeKind ?? input.kind),
  ].filter(Boolean).map(normalizeSemanticEvidenceText));
  if (!routeKinds.length) routeKinds.push("unspecified");
  const routeKind = routeKinds[0];
  const query = cleanString(input.query ?? input.text);
  const aliases = normalizeAliases(input.aliases ?? input.alias_map ?? input.aliasMap ?? input.supplied_aliases ?? input.suppliedAliases);
  const semanticRegistry = controlledSemanticRegistry(input.semantic_feature_document ?? input.semanticFeatureDocument);
  const semanticIdentity = input.semantic_identity ?? input.semanticIdentity ?? null;
  const authoritativeContext = {
    resolved_typed_entities: input.resolved_typed_entities ?? input.resolvedTypedEntities ?? input.typed_entities ?? input.typedEntities ?? [],
    compact_match_facts: input.compact_match_facts ?? input.compactMatchFacts ?? {},
    selected_ranking_candidates: input.selected_ranking_candidates ?? input.selectedRankingCandidates ?? input.selected_candidates ?? input.selectedCandidates ?? [],
  };
  const queryText = expandAliases([
    query,
    collectTypedEntityTerms(authoritativeContext.resolved_typed_entities),
  ].filter(Boolean).join(" "), aliases);

  const collected = collectDocuments(input, routeKinds, aliases, policy, semanticRegistry, semanticIdentity);
  const documents = collected.documents;
  const rawHits = queryText && documents.length
    ? searchDocuments(documents, queryText, routeKinds, policy)
    : [];

  const output = {
    schema: SEMANTIC_EVIDENCE_ROUTER_SCHEMA,
    route_kind: routeKind,
    route_kinds: routeKinds,
    normalized_query: normalizeSemanticEvidenceText(query),
    authority: {
      policy: "typed constraints and hard facts are authoritative and remain unchanged",
      lexical_effect: "supplement_only_and_cannot_change_candidate_membership_or_order",
      protected_fields: ["traits", "breakpoints", "strength", "main_carry", "candidate_identity"],
      input_summary: summarizeAuthoritativeContext(authoritativeContext),
    },
    hits: rawHits.slice(0, policy.max_hits),
    budgets: {
      max_documents: policy.max_documents,
      max_hits: policy.max_hits,
      max_serialized_bytes: policy.max_serialized_bytes,
      documents_considered: collected.considered,
      documents_indexed: documents.length,
      hits_considered: rawHits.length,
      documents_truncated: collected.considered > documents.length,
      hits_truncated: rawHits.length > policy.max_hits,
      serialized_evidence_truncated: false,
      serialized_bytes: 0,
    },
    policy: {
      field_weights: { ...policy.field_weights },
      fuzzy: policy.fuzzy,
      prefix: policy.prefix,
      chinese_tokenization: "normalized_terms_and_bigrams",
      deterministic_dedupe: "content_fingerprint_with_sorted_provenance",
    },
  };

  enforceSerializedBudget(output, policy.max_serialized_bytes);
  return output;
}

export const buildSemanticEvidence = routeSemanticEvidence;

function searchDocuments(documents, queryText, routeKinds, policy) {
  const miniSearch = new MiniSearch({
    idField: "id",
    fields: INDEX_FIELDS,
    storeFields: [
      "source_kind",
      "source_id",
      "title",
      "content",
      "route_kinds",
      "provenance",
      "authority",
      "content_truncated",
      "features",
      "relations",
      "conditions",
    ],
    tokenize: tokenizeSemanticEvidence,
    processTerm: (term) => normalizeSemanticEvidenceText(term),
  });
  miniSearch.addAll(documents);
  const routeKeys = new Set(routeKinds.map(normalizeSemanticEvidenceText));
  return miniSearch.search(queryText, {
    boost: policy.field_weights,
    fuzzy: policy.fuzzy,
    prefix: policy.prefix,
    combineWith: "OR",
  }).map((result) => {
    const routeMatch = result.route_kinds.some((routeKey) => routeKeys.has(routeKey));
    const score = result.score + (routeMatch ? policy.field_weights.route_kind : 0);
    return {
      id: result.id,
      source_kind: result.source_kind,
      source_id: result.source_id,
      authority: "supplemental_reference",
      supplemental_only: true,
      title: result.title,
      excerpt: excerpt(result.content, policy.max_excerpt_chars),
      features: result.features,
      relations: result.relations,
      conditions: result.conditions,
      _score: Number(score.toFixed(6)),
      matched_terms: uniqueStrings(result.terms || []).sort(compareText),
      provenance: cloneJson(result.provenance),
      ...(result.content_truncated ? { source_content_truncated: true } : {}),
    };
  }).sort((left, right) => (
    right._score - left._score
    || sourcePriority(right.source_kind) - sourcePriority(left.source_kind)
    || compareText(left.id, right.id)
  )).map(({ _score, ...result }) => result);
}

function collectDocuments(input, routeKinds, aliases, policy, semanticRegistry, semanticIdentity) {
  const rows = [];
  const grouped = input.documents && typeof input.documents === "object" ? input.documents : {};
  validateAuthoritativeSemanticPackets({
    compactMatchFacts: input.compact_match_facts ?? input.compactMatchFacts,
    selectedRankingCandidates: input.selected_ranking_candidates ?? input.selectedRankingCandidates ?? input.selected_candidates ?? input.selectedCandidates,
    semanticRegistry,
    semanticIdentity,
  });
  appendSourceDocuments(rows, "common_doc", input.common_docs ?? input.commonDocs ?? grouped.common);
  appendSourceDocuments(rows, "season_doc", input.season_docs ?? input.seasonDocs ?? grouped.season);
  appendSourceDocuments(rows, "patch_doc", input.patch_docs ?? input.patchDocs ?? grouped.patch);
  appendSourceDocuments(rows, "wiki_doc", input.wiki_docs ?? input.wikiDocs ?? grouped.wiki);

  const normalized = rows
    .map((row, index) => normalizeDocument(row, index, routeKinds, aliases, policy, semanticRegistry, semanticIdentity))
    .filter(Boolean)
    .sort(compareDocuments);
  const deduped = dedupeDocuments(normalized);
  return {
    considered: deduped.length,
    documents: deduped.slice(0, policy.max_documents),
  };
}

function appendSourceDocuments(target, sourceKind, value) {
  for (const document of asArray(value)) target.push({ source_kind: sourceKind, document });
}

function validateAuthoritativeSemanticPackets({ compactMatchFacts, selectedRankingCandidates, semanticRegistry, semanticIdentity }) {
  for (const facts of asArray(compactMatchFacts)) {
    validateAuthoritativeSemanticPacket(facts?.semantic_features, "match_fact", semanticRegistry, semanticIdentity);
  }
  for (const candidate of asArray(selectedRankingCandidates)) {
    const packet = candidate?.semantic_features || candidate?.strategy_profile?.semantic_features;
    validateAuthoritativeSemanticPacket(packet, "ranking_candidate", semanticRegistry, semanticIdentity);
  }
}

function validateAuthoritativeSemanticPacket(packet, sourceKind, semanticRegistry, semanticIdentity) {
  if (!packet || typeof packet !== "object") return;
  const controlledFeatures = stringValues(packet.features);
  const controlledRelations = asArray(packet.relations).map((relation) => (
    typeof relation === "object" ? relation?.type : relation
  )).filter(Boolean).map(String);
  assertControlledSemanticValues(controlledFeatures, semanticRegistry.features, "feature");
  assertControlledSemanticValues(controlledRelations, semanticRegistry.relations, "relation");
  assertSemanticIdentity(packet.identity, semanticIdentity, sourceKind);
}

function normalizeDocument(row, index, defaultRouteKinds, aliases, policy, semanticRegistry, expectedIdentity) {
  const source = row.document;
  if (source === null || source === undefined) return null;
  const document = typeof source === "string" ? { content: source } : source;
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const sourceId = cleanString(
    document.id
    ?? document.source_id
    ?? document.doc_id
    ?? document.path
    ?? document.slug,
  ) || `${row.source_kind}-${index + 1}`;
  const title = cleanString(document.title ?? document.name ?? document.heading) || sourceId;
  const rawContent = cleanString(
    document.content
    ?? document.body
    ?? document.text
    ?? document.summary
    ?? document.markdown,
  ) || stableStringify(document);
  const contentTruncated = [...rawContent].length > policy.max_document_chars;
  const content = truncateCharacters(rawContent, policy.max_document_chars);
  const controlledFeatures = stringValues(document.features);
  const controlledRelations = asArray(document.relations).map((relation) => (
    typeof relation === "object" ? relation?.type : relation
  )).filter(Boolean).map(String);
  assertControlledSemanticValues(controlledFeatures, semanticRegistry.features, "feature");
  assertControlledSemanticValues(controlledRelations, semanticRegistry.relations, "relation");
  assertSemanticIdentity(document.semantic_identity, expectedIdentity, row.source_kind);
  const documentAliases = uniqueStrings([
    ...stringValues(document.aliases ?? document.search_aliases),
    ...aliasTermsForText(`${title} ${content}`, aliases),
  ]);
  const routeKinds = uniqueStrings([
    ...stringValues(document.route_kinds ?? document.routeKinds ?? document.route_kind),
    ...(document.route_kind === undefined && document.routeKinds === undefined && document.route_kinds === undefined
      ? defaultRouteKinds
      : []),
  ].map(normalizeSemanticEvidenceText));
  const provenance = [{
    source_kind: row.source_kind,
    source_id: sourceId,
    authority: "supplemental_reference",
  }];
  const fingerprint = documentFingerprint(title, content);
  return {
    id: `${row.source_kind}:${sourceId}:${fingerprint.slice(0, 12)}`,
    source_kind: row.source_kind,
    source_id: sourceId,
    authority: provenance[0].authority,
    title: expandAliases(title, aliases),
    aliases: documentAliases.join(" "),
    entities: expandAliases(stringValues(document.entities ?? document.entity_names).join(" "), aliases),
    facts: expandAliases(formatSearchValue(document.facts), aliases),
    features: expandAliases(controlledFeatures.join(" "), aliases),
    relations: expandAliases(formatSearchValue(document.relations), aliases),
    conditions: expandAliases(formatSearchValue(document.conditions), aliases),
    route_kind: routeKinds.join(" "),
    route_kinds: routeKinds,
    content: expandAliases(content, aliases),
    provenance,
    content_fingerprint: fingerprint,
    content_truncated: contentTruncated,
  };
}

function dedupeDocuments(documents) {
  const byFingerprint = new Map();
  for (const document of documents) {
    const previous = byFingerprint.get(document.content_fingerprint);
    if (!previous) {
      byFingerprint.set(document.content_fingerprint, document);
      continue;
    }
    previous.provenance = uniqueRows(
      [...previous.provenance, ...document.provenance].sort(compareProvenance),
      (entry) => `${entry.source_kind}:${entry.source_id}`,
    );
  }
  return [...byFingerprint.values()].sort(compareDocuments);
}

function normalizeAliases(value) {
  const pairs = [];
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!row || typeof row !== "object") continue;
      const canonical = cleanString(row.canonical ?? row.target ?? row.name ?? row.canonical_name);
      for (const alias of stringValues(row.aliases ?? row.alias)) {
        if (canonical && alias) pairs.push({ alias, canonical });
      }
    }
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (Array.isArray(entry)) {
        for (const alias of stringValues(entry)) pairs.push({ alias, canonical: key });
      } else if (entry && typeof entry === "object") {
        const canonical = cleanString(entry.canonical ?? entry.target ?? entry.name ?? key);
        for (const alias of stringValues(entry.aliases ?? entry.alias ?? key)) pairs.push({ alias, canonical });
      } else {
        pairs.push({ alias: key, canonical: cleanString(entry) });
      }
    }
  }
  return uniqueRows(
    pairs
      .map(({ alias, canonical }) => ({
        alias: normalizeSemanticEvidenceText(alias),
        canonical: normalizeSemanticEvidenceText(canonical),
      }))
      .filter((row) => row.alias && row.canonical),
    (row) => `${row.alias}\u0000${row.canonical}`,
  ).sort((left, right) => compareText(left.alias, right.alias) || compareText(left.canonical, right.canonical));
}

function expandAliases(value, aliases) {
  const normalized = normalizeSemanticEvidenceText(value);
  if (!normalized) return "";
  return uniqueStrings([normalized, ...aliasTermsForText(normalized, aliases)]).join(" ");
}

function aliasTermsForText(value, aliases) {
  const normalized = normalizeSemanticEvidenceText(value);
  const terms = [];
  for (const pair of aliases) {
    if (normalized.includes(pair.alias) || normalized.includes(pair.canonical)) {
      terms.push(pair.alias, pair.canonical);
    }
  }
  return uniqueStrings(terms);
}

function collectTypedEntityTerms(value) {
  const terms = [];
  visit(value, (key, entry) => {
    if (typeof entry !== "string" && typeof entry !== "number") return;
    if (/(?:name|id|alias|mention|role|kind|breakpoint|value)$/iu.test(key)) terms.push(String(entry));
  });
  return uniqueStrings(terms).join(" ");
}

function summarizeAuthoritativeContext(context) {
  const matchFacts = context.compact_match_facts && typeof context.compact_match_facts === "object"
    ? context.compact_match_facts
    : {};
  return {
    resolved_typed_entity_count: asArray(context.resolved_typed_entities).length,
    selected_ranking_candidate_count: asArray(context.selected_ranking_candidates).length,
    compact_match_fact_field_count: Array.isArray(matchFacts) ? matchFacts.length : Object.keys(matchFacts).length,
    resolved_typed_entities_fingerprint: valueFingerprint(context.resolved_typed_entities),
    compact_match_facts_fingerprint: valueFingerprint(context.compact_match_facts),
    selected_ranking_candidates_fingerprint: valueFingerprint(context.selected_ranking_candidates),
  };
}

function valueFingerprint(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function controlledSemanticRegistry(document) {
  const entries = asArray(document?.entries);
  return {
    features: new Set(stringValues(entries.find((entry) => entry?.id === "controlled_feature_ids")?.values)),
    relations: new Set(stringValues(entries.find((entry) => entry?.id === "controlled_relation_ids")?.values)),
  };
}

function assertControlledSemanticValues(values, allowed, kind) {
  if (!values.length) return;
  if (!allowed.size) throw new TypeError(`semantic ${kind} values require the Common controlled registry`);
  for (const value of values) {
    if (!allowed.has(value)) throw new TypeError(`unknown controlled semantic ${kind}: ${value}`);
  }
}

function assertSemanticIdentity(actual, expected, sourceKind) {
  if (!expected || !["match_fact", "ranking_candidate"].includes(sourceKind)) return;
  if (!actual || typeof actual !== "object") {
    throw new TypeError(`semantic ${sourceKind} identity is required`);
  }
  const requiredFields = sourceKind === "ranking_candidate"
    ? ["core_profile_id", "stat_date"]
    : ["core_profile_id", "ranking_overlay_id", "match_session_id"];
  for (const field of requiredFields) {
    const expectedValue = cleanString(expected[field]);
    const actualValue = cleanString(actual[field]);
    if (expectedValue && actualValue !== expectedValue) {
      throw new TypeError(`semantic ${sourceKind} ${field} mismatch`);
    }
  }
  if (sourceKind === "ranking_candidate") {
    if (actual.ranking_overlay_binding !== "enclosing_immutable_generation") {
      throw new TypeError("semantic ranking_candidate must bind through the enclosing immutable generation");
    }
    const expectedOverlayId = cleanString(expected.ranking_overlay_id);
    const actualOverlayId = cleanString(actual.ranking_overlay_id);
    if (expectedOverlayId && actualOverlayId && actualOverlayId !== expectedOverlayId) {
      throw new TypeError("semantic ranking_candidate ranking_overlay_id mismatch");
    }
  }
}

function enforceSerializedBudget(output, maxBytes) {
  stabilizeSerializedBytes(output);
  while (output.budgets.serialized_bytes > maxBytes && output.hits.length) {
    output.hits.pop();
    output.budgets.hits_truncated = true;
    output.budgets.serialized_evidence_truncated = true;
    stabilizeSerializedBytes(output);
  }
  if (output.budgets.serialized_bytes > maxBytes) {
    throw new RangeError(
      `semantic evidence authoritative envelope requires ${output.budgets.serialized_bytes} bytes, exceeding max_serialized_bytes ${maxBytes}`,
    );
  }
}

function stabilizeSerializedBytes(output) {
  for (let index = 0; index < 4; index += 1) {
    const bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
    if (bytes === output.budgets.serialized_bytes) return;
    output.budgets.serialized_bytes = bytes;
  }
  output.budgets.serialized_bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
}

function resolvePolicy(...values) {
  const overrides = Object.assign({}, ...values.filter((value) => value && typeof value === "object"));
  const fieldWeights = {
    ...DEFAULT_SEMANTIC_EVIDENCE_POLICY.field_weights,
    ...(overrides.field_weights || overrides.fieldWeights || {}),
  };
  for (const field of INDEX_FIELDS) fieldWeights[field] = positiveNumber(fieldWeights[field], `field_weights.${field}`);
  return {
    max_documents: positiveInteger(overrides.max_documents ?? overrides.maxDocuments ?? DEFAULT_SEMANTIC_EVIDENCE_POLICY.max_documents, "max_documents"),
    max_hits: positiveInteger(overrides.max_hits ?? overrides.maxHits ?? DEFAULT_SEMANTIC_EVIDENCE_POLICY.max_hits, "max_hits"),
    max_document_chars: positiveInteger(overrides.max_document_chars ?? overrides.maxDocumentChars ?? DEFAULT_SEMANTIC_EVIDENCE_POLICY.max_document_chars, "max_document_chars"),
    max_excerpt_chars: positiveInteger(overrides.max_excerpt_chars ?? overrides.maxExcerptChars ?? DEFAULT_SEMANTIC_EVIDENCE_POLICY.max_excerpt_chars, "max_excerpt_chars"),
    max_serialized_bytes: positiveInteger(overrides.max_serialized_bytes ?? overrides.maxSerializedBytes ?? DEFAULT_SEMANTIC_EVIDENCE_POLICY.max_serialized_bytes, "max_serialized_bytes"),
    fuzzy: boundedNumber(overrides.fuzzy ?? DEFAULT_SEMANTIC_EVIDENCE_POLICY.fuzzy, 0, 1, "fuzzy"),
    prefix: overrides.prefix === undefined ? DEFAULT_SEMANTIC_EVIDENCE_POLICY.prefix : overrides.prefix === true,
    field_weights: fieldWeights,
  };
}

function compareDocuments(left, right) {
  return sourcePriority(right.source_kind) - sourcePriority(left.source_kind)
    || compareText(left.source_id, right.source_id)
    || compareText(left.id, right.id);
}

function compareProvenance(left, right) {
  return sourcePriority(right.source_kind) - sourcePriority(left.source_kind)
    || compareText(left.source_id, right.source_id);
}

function sourcePriority(sourceKind) {
  return SOURCE_PRIORITY[sourceKind] || 0;
}

function documentFingerprint(title, content) {
  return createHash("sha256")
    .update(`${normalizeSemanticEvidenceText(title)}\u0000${normalizeSemanticEvidenceText(content)}`)
    .digest("hex");
}

function excerpt(value, maxCharacters) {
  const normalized = cleanString(value);
  return truncateCharacters(normalized, maxCharacters);
}

function truncateCharacters(value, maxCharacters) {
  const characters = [...String(value ?? "")];
  return characters.length <= maxCharacters
    ? characters.join("")
    : `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}

function formatSearchValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return stableStringify(value);
}

function stableStringify(value) {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function visit(value, callback, key = "") {
  if (Array.isArray(value)) {
    value.forEach((entry) => visit(entry, callback, key));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, entry] of Object.entries(value)) visit(entry, callback, childKey);
    return;
  }
  callback(key, value);
}

function stringValues(value) {
  return asArray(value)
    .flatMap((entry) => {
      if (entry === null || entry === undefined) return [];
      if (typeof entry === "object") return [entry.name, entry.alias, entry.value, entry.id].filter(Boolean).map(String);
      return [String(entry)];
    })
    .map(cleanString)
    .filter(Boolean);
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values) {
  return [...new Set(values.map(cleanString).filter(Boolean))];
}

function uniqueRows(values, keyFor) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyFor(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function cleanString(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new RangeError(`${name} must be a positive integer`);
  return number;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return number;
}

function boundedNumber(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}
