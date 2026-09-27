const SCHEMA = "jcc-ranking-query-intent-v1";
const MAX_GROUPS = 8;
const MAX_MATCHES = 8;
const MAX_INTERPRETATIONS = 16;
const MAX_TRAIT_CONSTRAINTS_PER_GROUP = 6;
const NON_TRAIT_COUNTER_WORDS = new Set([
  "套", "个", "组", "条", "种", "队", "页", "人口", "级", "阶段", "回合", "金币", "费卡", "张", "星",
  "格", "框", "框里", "行", "列",
]);

const ROLE_PATTERNS = [
  ["main_carry", /(?:主\s*[cC]|主力输出|核心输出|carry)/iu],
  ["primary_tank", /(?:主坦|主\s*[tT]|主力前排|核心前排|坦克|tank)/iu],
  ["member", /(?:成员|挂件|副手|辅助|工具人|阵容里|带上|包含|要有)/iu],
];

const CONTINUATION_PATTERNS = {
  continue: /(?:继续|接着|延续|沿用|同样条件|按这个条件)/iu,
  more: /(?:更多|再来|再给|还有吗|换一批|下一批|下一页|下页|more|next)/iu,
  exclude_shown: /(?:别重复|不要重复|不重复|排除(?:刚才|之前|上面|已有|已展示)|没看过的|新的|换一批)/iu,
};

export const rankingQueryIntentContract = Object.freeze({
  schema: SCHEMA,
  season_neutral: true,
  max_groups: MAX_GROUPS,
  max_interpretations: MAX_INTERPRETATIONS,
  max_trait_constraints_per_group: MAX_TRAIT_CONSTRAINTS_PER_GROUP,
});

export function normalizeRankingQueryText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u00a0\t\r]+/g, " ")
    .replace(/[•・]/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRankingQueryIntent(text, options = {}) {
  const sourceText = normalizeRankingQueryText(text);
  const catalog = buildCatalog(options.catalog || options.entityCatalog || options.entity_catalog || {}, options);
  const spans = splitIndependentGroups(sourceText, catalog, options).slice(0, MAX_GROUPS);
  const groups = spans
    .map((span, index) => parseGroup(span, index, catalog, options))
    .filter((group) => array(group.constraints).length || array(group.roles).length || array(group.unresolved_mentions).length);
  const continuation = parseContinuation(sourceText, options);
  const shownRefs = compactShownRefs(options.shown || options.shownResults || options.excludeShownRefs || []);
  const result = compactIntent({
    schema: SCHEMA,
    normalized_text: sourceText,
    groups,
    continuation: continuation
      ? {
          ...continuation,
          ...(shownRefs.length ? { shown_refs: shownRefs } : {}),
        }
      : shownRefs.length
        ? { mode: "continue", exclude_shown: true, shown_refs: shownRefs }
        : null,
    interpretations: buildInterpretations(groups),
  });
  result.groups ||= [];
  for (const group of result.groups) {
    group.constraints ||= [];
    group.roles ||= [];
  }
  assertValidRankingQueryIntent(result);
  return result;
}

export const buildRankingQueryIntent = parseRankingQueryIntent;

export function reduceRankingQueryIntent(previous, parsed) {
  if (!previous) return assertValidRankingQueryIntent(cloneJson(parsed));
  assertValidRankingQueryIntent(previous);
  assertValidRankingQueryIntent(parsed);

  const parsedGroups = array(parsed.groups);
  const hasNegative = parsedGroups.some((group) => array(group.constraints).some((constraint) => constraint.polarity < 0));
  const hasPositive = parsedGroups.some((group) => array(group.constraints).some((constraint) => constraint.polarity > 0));
  const explicitCorrection = /(?:继续|接着|改成|换成|纠正|而是|才是|不对|算了)/u.test(parsed.normalized_text || "");
  const negativeQueryTargetsPrevious = hasNegative
    && !hasPositive
    && pureNegativeQueryTargetsPrevious(previous.groups || [], parsedGroups, parsed.normalized_text || "");
  const incremental = Boolean(parsed.continuation) || explicitCorrection || negativeQueryTargetsPrevious;
  if (!incremental) return assertValidRankingQueryIntent(cloneJson(parsed));

  const groups = cloneJson(previous.groups || []);
  if (parsedGroups.length) mergeIncrementalGroups(groups, parsedGroups, parsed.normalized_text || "");
  reindexGroups(groups);
  const continuation = mergeContinuation(previous.continuation, parsed.continuation);
  const result = compactIntent({
    schema: SCHEMA,
    normalized_text: parsed.normalized_text || previous.normalized_text || "",
    groups,
    continuation,
    interpretations: buildInterpretations(groups),
    inherited_from_previous: true,
  });
  result.groups ||= [];
  return assertValidRankingQueryIntent(result);
}

export function rankingQueryIntentDiagnostics(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["intent must be an object"];
  if (value.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  if (!Array.isArray(value.groups)) errors.push("groups must be an array");
  for (const [groupIndex, group] of (value.groups || []).entries()) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      errors.push(`groups[${groupIndex}] must be an object`);
      continue;
    }
    if (!Array.isArray(group.constraints)) errors.push(`groups[${groupIndex}].constraints must be an array`);
    if (group.unresolved_mentions && !Array.isArray(group.unresolved_mentions)) {
      errors.push(`groups[${groupIndex}].unresolved_mentions must be an array`);
    }
    for (const [constraintIndex, constraint] of (group.constraints || []).entries()) {
      const path = `groups[${groupIndex}].constraints[${constraintIndex}]`;
      if (!constraint?.mention) errors.push(`${path}.mention must be non-empty`);
      if (!Array.isArray(constraint?.candidates) || !constraint.candidates.length) errors.push(`${path}.candidates must be non-empty`);
      if (![-1, 1].includes(constraint?.polarity)) errors.push(`${path}.polarity must be -1 or 1`);
      if (constraint?.breakpoint !== undefined && (!Number.isInteger(constraint.breakpoint) || constraint.breakpoint < 1)) {
        errors.push(`${path}.breakpoint must be a positive integer`);
      }
    }
  }
  if (value.interpretations && !Array.isArray(value.interpretations)) errors.push("interpretations must be an array");
  return errors;
}

export function assertValidRankingQueryIntent(value) {
  const errors = rankingQueryIntentDiagnostics(value);
  if (errors.length) throw new Error(`ranking query intent schema error: ${errors.join("; ")}`);
  return value;
}

function parseGroup(text, index, catalog, options) {
  const mentions = resolveMentions(text, catalog, options);
  const constraints = [];
  const roles = [];
  const invalidBreakpoints = [];
  for (const mention of mentions) {
    const context = mentionContext(text, mention);
    const polarity = mentionPolarity(context, mention.text);
    const role = mentionRole(context, mention.text);
    const breakpoint = mentionBreakpoint(context, mention, polarity);
    const allowedBreakpoints = uniqueNumbers(mention.candidates
      .filter((candidate) => candidate.kind === "trait")
      .flatMap((candidate) => candidate.breakpoints));
    const invalidBreakpoint = breakpoint && allowedBreakpoints.length && !allowedBreakpoints.includes(breakpoint)
      ? { mention: mention.text, requested: breakpoint, allowed: allowedBreakpoints }
      : null;
    const connector = connectorBefore(text, mention.start, constraints.length);
    const constraint = {
      mention: mention.text,
      polarity,
      connector,
      segment_index: punctuationSegmentIndex(text, mention.start),
      candidates: mention.candidates.slice(0, MAX_MATCHES).map(compactEntity),
      ...(breakpoint ? { breakpoint } : {}),
      ...(mention.candidates.length > 1 ? { ambiguous: true } : {}),
    };
    constraints.push(constraint);
    if (invalidBreakpoint) invalidBreakpoints.push(invalidBreakpoint);
    if (role) {
      roles.push({
        role,
        polarity,
        candidates: constraint.candidates,
      });
    }
  }
  applyCorrectionSemantics(text, constraints, roles);
  const unresolvedMentions = unresolvedExplicitEntityMentions(text, mentions, catalog);
  const traitConstraintCount = constraints.filter((constraint) => (
    constraint.candidates.some((candidate) => candidate.kind === "trait")
  )).length;
  if (traitConstraintCount > MAX_TRAIT_CONSTRAINTS_PER_GROUP) {
    unresolvedMentions.push({
      reason: "too_many_trait_constraints",
      observed_count: traitConstraintCount,
      max_supported: MAX_TRAIT_CONSTRAINTS_PER_GROUP,
    });
  }
  const continuation = parseContinuation(text, options);
  const expressionPlan = buildGroupExpressionPlan(text, constraints);
  return compactIntent({
    id: `g${index + 1}`,
    source_text: text,
    logic: constraints.some((constraint) => constraint.connector === "or") ? "mixed" : "and",
    constraints,
    roles: uniqueRows(roles, (row) => `${row.role}:${row.polarity}:${row.candidates.map(refKey).join("|")}`),
    unresolved_mentions: unresolvedMentions,
    invalid_breakpoints: invalidBreakpoints,
    validation_status: unresolvedMentions.length || invalidBreakpoints.length ? "needs_clarification" : "resolved",
    expression_plan: expressionPlan,
    expand_alternatives: /(?:分别|各(?:给|来|推荐|列)|逐个|每种组合|所有组合|逐一|是.{0,24}还是|配.{0,16}还是配|选.{0,16}还是)/u.test(text),
    ...(continuation ? { continuation: continuation.mode } : {}),
    ...(continuation?.count ? { requested_count: continuation.count } : {}),
  });
}

function unresolvedExplicitEntityMentions(text, resolvedMentions, catalog) {
  if (!array(catalog?.entities).length) return [];
  const compact = compactText(text);
  const resolvedRanges = resolvedMentions.map((mention) => ({ start: mention.start, end: mention.end }));
  const rows = [];
  const pattern = /([一二两三四五六七八九十\d]{1,3})([\p{Script=Han}A-Za-z_·]{1,12}?)(?=(?:配|和|与|加|以及|还是|或者|或|带|开|补|上|用|走)|[，,；;。!?！？]|$)/gu;
  for (const match of compact.matchAll(pattern)) {
    const count = parseSmallNumber(match[1]);
    const name = String(match[2] || "").replace(/(?:阵容|体系|有哪些|怎么|哪套|比较|强势|最好|可以|吗|呢)+$/u, "");
    if (match[1] === "一" && /^(?:下|些|点|起|直|并|同)/u.test(name)) continue;
    if (!count || !name || [...NON_TRAIT_COUNTER_WORDS].some((word) => name.startsWith(word))) continue;
    const start = Number(match.index || 0) + compactText(match[1]).length;
    const end = start + compactText(name).length;
    if (resolvedRanges.some((range) => range.start <= start && range.end > start)) continue;
    rows.push({ mention: name, requested_breakpoint: count, reason: "unresolved_explicit_trait_slot" });
  }
  const rolePattern = /([\p{Script=Han}A-Za-z_·]{1,20}?)(?=(?:主\s*[cCtT]|主坦|主力输出|主力前排|核心输出|核心前排|carry|tank))/giu;
  for (const match of compact.matchAll(rolePattern)) {
    const raw = String(match[1] || "");
    const name = cleanExplicitEntityName(raw);
    if (!name) continue;
    const localOffset = raw.lastIndexOf(name);
    const start = Number(match.index || 0) + Math.max(0, localOffset);
    const end = start + compactText(name).length;
    if (resolvedRanges.some((range) => range.start < end && range.end > start)) continue;
    const suffix = compact.slice(end, end + 12);
    const role = /^(?:主\s*[tT]|主坦|主力前排|核心前排|tank)/iu.test(suffix) ? "primary_tank" : "main_carry";
    rows.push({ mention: name, entity_kind_hint: "champion", role, reason: "unresolved_explicit_role_entity" });
  }
  const traitPattern = /([\p{Script=Han}A-Za-z_·]{1,20}?)(?=(?:羁绊|体系)(?:阵容|路线|方向)?(?:配|和|与|加|以及|还是|或者|或|带|开|补|上|用|走|有哪些|怎么|哪套|比较|强势|最好|可以|吗|呢|[，,；;。!?！？]|$))/gu;
  for (const match of compact.matchAll(traitPattern)) {
    const raw = String(match[1] || "");
    const name = cleanExplicitEntityName(raw);
    if (!name || /^未知$/u.test(name) === false && /^(?:阵容|羁绊|体系|路线|方向)$/u.test(name)) continue;
    const localOffset = raw.lastIndexOf(name);
    const start = Number(match.index || 0) + Math.max(0, localOffset);
    const end = start + compactText(name).length;
    if (resolvedRanges.some((range) => range.start < end && range.end > start)) continue;
    rows.push({ mention: name, entity_kind_hint: "trait", reason: "unresolved_explicit_trait_entity" });
  }
  return uniqueRows(rows, (row) => `${row.requested_breakpoint}:${compactText(row.mention)}`);
}

function cleanExplicitEntityName(value) {
  return String(value || "")
    .replace(/^(?:我想玩|我想用|我想要|给我找|帮我找|想玩|想用|围绕|给我|看看|查询|搜索|查找|使用|用|拿|玩|以|让|要|查|找)+/u, "")
    .replace(/(?:英雄|棋子|弈子)$/u, "")
    .trim();
}

function pureNegativeQueryTargetsPrevious(previousGroups, parsedGroups, normalizedText) {
  if (incrementalTargetGroupIndex(normalizedText, previousGroups.length) >= 0) return true;
  const negativeConstraints = parsedGroups.flatMap((group) => (
    array(group.constraints).filter((constraint) => constraint.polarity < 0)
  ));
  return findIncrementalTargetGroup(previousGroups, negativeConstraints, []) >= 0;
}

function punctuationSegmentIndex(text, compactOffset) {
  let visible = 0;
  let segment = 0;
  for (const char of text) {
    if (visible >= compactOffset) break;
    if (/[，,；;]/u.test(char)) segment += 1;
    visible += compactText(char).length;
  }
  return segment;
}

function buildGroupExpressionPlan(text, constraints) {
  if (!constraints.length) return null;
  const indexed = constraints.map((constraint, index) => ({ ...constraint, constraint_index: index }));
  const segments = [];
  for (const constraint of indexed) {
    const index = Number(constraint.segment_index || 0);
    if (!segments[index]) segments[index] = [];
    segments[index].push(constraint);
  }
  const meaningfulSegments = segments.filter((segment) => segment?.length);
  const groupedAlternatives = meaningfulSegments.length > 1 && meaningfulSegments.every((segment) => (
    segment.length > 1 && segment.slice(1).some((constraint) => constraint.connector === "or")
  ));
  if (groupedAlternatives) {
    return expressionPlanNode("and", meaningfulSegments.map(buildPrecedencePlan));
  }
  return buildPrecedencePlan(indexed);
}

function buildPrecedencePlan(constraints) {
  const terms = [];
  let current = [];
  for (const constraint of constraints) {
    if (constraint.connector === "or" && current.length) {
      terms.push(current);
      current = [];
    }
    current.push({ constraint_index: constraint.constraint_index });
  }
  if (current.length) terms.push(current);
  return expressionPlanNode("or", terms.map((term) => expressionPlanNode("and", term)));
}

function expressionPlanNode(op, clauses) {
  const compactClauses = clauses.filter(Boolean);
  if (!compactClauses.length) return null;
  if (compactClauses.length === 1) return compactClauses[0];
  return { op, clauses: compactClauses };
}

function splitIndependentGroups(text, catalog, options) {
  if (!text) return [];
  const prepared = text
    .replace(/([?？!！;；。])\s*/g, "$1\n")
    .replace(/(?:^|[，,]\s*)(?:另外|另一个问题|第二个问题|再问(?:一个)?|还有个问题|然后问)[:：]?/gimu, "\n");
  return prepared
    .split(/\n+/)
    .flatMap((part) => splitCompleteTraitCombinations(part, catalog, options))
    .map((part) => part.replace(/^[?？!！;；。，,、\s]+|[?？!！;；。，,、\s]+$/g, "").trim())
    .filter(Boolean);
}

function splitCompleteTraitCombinations(text, catalog, options) {
  const marker = /[，,]\s*(?:还有|以及|同时还有)(?:一套|一组|一种|一个)?[:：]?/gu;
  let remaining = text;
  const groups = [];
  while (remaining) {
    let split = null;
    for (const match of remaining.matchAll(marker)) {
      const left = remaining.slice(0, match.index);
      const right = remaining.slice(match.index + match[0].length);
      if (isCompleteTraitCombination(left, catalog, options) && isCompleteTraitCombination(right, catalog, options)) {
        split = { left, right };
        break;
      }
    }
    if (!split) {
      groups.push(remaining);
      break;
    }
    groups.push(split.left);
    remaining = split.right;
  }
  return groups;
}

function isCompleteTraitCombination(text, catalog, options) {
  const traits = resolveMentions(text, catalog, options)
    .filter((mention) => mention.candidates.some((candidate) => candidate.kind === "trait"));
  return traits.length >= 2;
}

function parseContinuation(text, options) {
  const requestedCount = explicitRequestedCount(text);
  const mode = CONTINUATION_PATTERNS.more.test(text)
    ? "more"
    : CONTINUATION_PATTERNS.continue.test(text)
      ? "continue"
      : requestedCount
        ? "new"
        : null;
  const excludeShown = options.excludeShown === true
    || options.exclude_shown === true
    || CONTINUATION_PATTERNS.exclude_shown.test(text);
  if (!mode && !excludeShown) return null;
  return {
    mode: mode || "continue",
    ...(requestedCount ? { count: requestedCount } : {}),
    ...(excludeShown ? { exclude_shown: true } : {}),
  };
}

function explicitRequestedCount(text) {
  const patterns = [
    /(?:给我|推荐|找|查|列|看|来|要|再来|再给)\s*([一二两三四五六七八九十\d]{1,3})\s*(?:套|个|组|条|种|队|页)/iu,
    /([2-9]|[1-9]\d)\s*(?:套|个|组|条|种|队)\s*(?:阵容|方案|推荐|结果)?/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const count = match ? parseSmallNumber(match[1]) : null;
    if (count) return Math.min(50, count);
  }
  return null;
}

function buildCatalog(input, options) {
  const entities = [];
  const add = (raw, fallbackKind = null) => {
    if (typeof raw === "string") raw = { name: raw, id: raw, kind: fallbackKind };
    if (!raw || typeof raw !== "object") return;
    const name = String(raw.name || raw.display_name || raw.trait_name || raw.champion_name || "").trim();
    const id = String(raw.id ?? raw.entity_id ?? raw.code_id ?? raw.address ?? name).trim();
    const kind = normalizeKind(raw.kind || raw.entity_kind || raw.type || fallbackKind);
    if (!name || !id || !kind) return;
    entities.push({
      kind,
      id,
      name,
      ...(raw.address ? { address: String(raw.address) } : {}),
      aliases: stringArray(raw.aliases || raw.alias || raw.search_aliases),
      breakpoints: numberArray(raw.breakpoints || raw.trait_breakpoints),
    });
  };
  for (const entity of Array.isArray(input) ? input : []) add(entity);
  for (const entity of array(input.entities)) add(entity);
  for (const entity of array(input.traits)) add(entity, "trait");
  for (const entity of array(input.champions || input.units)) add(entity, "champion");
  for (const name of array(input.trait_names)) add(name, "trait");
  for (const name of array(input.champion_names || input.unit_names)) add(name, "champion");
  for (const rows of Object.values(input.champions_by_cost || {})) for (const entity of array(rows)) add(entity, "champion");

  const aliasRows = array(input.aliases);
  const aliases = new Map();
  const register = (alias, entity) => {
    const key = compactText(alias);
    if (!key) return;
    const rows = aliases.get(key) || [];
    if (!rows.some((row) => refKey(row) === refKey(entity))) rows.push(entity);
    aliases.set(key, rows);
  };
  for (const entity of entities) {
    register(entity.name, entity);
    for (const alias of entity.aliases) register(alias, entity);
  }
  for (const row of aliasRows) {
    const ref = row?.ref || row?.entity_ref || row;
    const matches = entities.filter((entity) => (
      (ref?.kind ? normalizeKind(ref.kind) === entity.kind : true)
      && [ref?.id, ref?.address, row?.entity_id].filter(Boolean).map(String).some((value) => value === entity.id || value === entity.address)
    ));
    for (const entity of matches) register(row.alias || row.name, entity);
  }
  return {
    entities: uniqueRows(entities, refKey),
    aliases,
    resolver: options.aliasResolver || options.alias_resolver || options.resolveAlias || input.resolveAlias || input.resolve,
  };
}

function resolveMentions(text, catalog, options) {
  const normalized = compactText(text);
  const found = [];
  for (const [alias, candidates] of catalog.aliases) {
    if (!alias || !normalized.includes(alias)) continue;
    let from = 0;
    while ((from = normalized.indexOf(alias, from)) >= 0) {
      found.push({ text: sliceByCompactOffset(text, from, alias.length), compact: alias, start: from, end: from + alias.length, candidates });
      from += alias.length;
    }
  }
  for (const token of lexicalTokens(text)) {
    const resolved = resolveExternally(token.text, catalog.resolver, options)
      .map((row) => normalizeResolvedEntity(row, catalog.entities))
      .filter(Boolean);
    if (resolved.length) found.push({ ...token, compact: compactText(token.text), candidates: uniqueRows(resolved, refKey) });
  }
  return found
    .filter((mention) => mention.candidates.length)
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((mention, index, rows) => !rows.some((other, otherIndex) => (
      otherIndex !== index
      && other.start <= mention.start
      && other.end >= mention.end
      && (other.end - other.start) > (mention.end - mention.start)
    )))
    .filter((mention, index, rows) => !rows.slice(0, index).some((other) => other.start === mention.start && other.end === mention.end));
}

function resolveExternally(token, resolver, options) {
  if (!resolver) return [];
  try {
    const result = typeof resolver === "function"
      ? resolver(token, options)
      : typeof resolver.resolve === "function"
        ? resolver.resolve(token, options)
        : typeof resolver.search === "function"
          ? resolver.search(token, options)
          : resolver[compactText(token)] || resolver[token];
    if (result && typeof result.then === "function") throw new Error("ranking query alias resolver must be synchronous");
    return array(result?.candidates || result?.matches || result?.results || result);
  } catch (error) {
    const wrapped = new Error(`ranking query alias resolver failed for token ${JSON.stringify(token)}: ${error?.message || error}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function lexicalTokens(text) {
  const rows = [];
  const pattern = /[\p{Script=Han}A-Za-z0-9_·+-]{1,24}/gu;
  const grammar = /(?:主\s*[cC]|主\s*[tT]|主坦|主力输出|核心输出|主力前排|核心前排|成员|挂件|副手|辅助|工具人|阵容里|带上|包含|要有|当|作为|担任|还是|或者|二选一|以及|同时|并且|和|与|或)/giu;
  for (const match of text.matchAll(pattern)) {
    const baseStart = compactText(text.slice(0, match.index)).length;
    rows.push({ text: match[0], start: baseStart, end: baseStart + compactText(match[0]).length });
    let cursor = 0;
    for (const separator of match[0].matchAll(grammar)) {
      const fragment = match[0].slice(cursor, separator.index);
      if (fragment) {
        const start = baseStart + compactText(match[0].slice(0, cursor)).length;
        rows.push({ text: fragment, start, end: start + compactText(fragment).length });
      }
      cursor = separator.index + separator[0].length;
    }
    const tail = match[0].slice(cursor);
    if (tail && cursor > 0) {
      const start = baseStart + compactText(match[0].slice(0, cursor)).length;
      rows.push({ text: tail, start, end: start + compactText(tail).length });
    }
  }
  return uniqueRows(rows.filter((row) => compactText(row.text)), (row) => `${row.start}:${row.end}:${compactText(row.text)}`);
}

function normalizeResolvedEntity(row, knownEntities) {
  if (typeof row === "string") {
    const key = compactText(row);
    return knownEntities.find((entity) => compactText(entity.name) === key || compactText(entity.id) === key) || null;
  }
  const source = row?.entity || row?.value || row;
  if (!source || typeof source !== "object") return null;
  const known = knownEntities.find((entity) => (
    (source.id !== undefined && String(source.id) === entity.id)
    || (source.address && source.address === entity.address)
  ));
  if (known) return known;
  const name = String(source.name || source.display_name || source.trait_name || source.champion_name || "").trim();
  const id = String(source.id ?? source.entity_id ?? source.address ?? name).trim();
  const kind = normalizeKind(source.kind || source.entity_kind || source.type);
  return name && id && kind ? { kind, id, name, ...(source.address ? { address: String(source.address) } : {}) } : null;
}

function mentionContext(text, mention) {
  const compact = compactText(text);
  let visibleOffset = 0;
  let segmentStart = 0;
  let segmentEnd = compact.length;
  for (const char of String(text || "")) {
    if (/[，,；;。!?！？]/u.test(char)) {
      if (visibleOffset <= mention.start) segmentStart = visibleOffset;
      else if (visibleOffset >= mention.end) {
        segmentEnd = visibleOffset;
        break;
      }
    }
    visibleOffset += compactText(char).length;
  }
  const start = Math.max(segmentStart, mention.start - 10);
  const end = Math.min(segmentEnd, mention.end + 10);
  return { before: compact.slice(start, mention.start), after: compact.slice(mention.end, end), around: compact.slice(start, end) };
}

function mentionPolarity(context, mention) {
  const escaped = escapeRegExp(compactText(mention));
  const around = context.around;
  const negative = new RegExp(`(?:不要|别用|不玩|不走|排除|去掉|不含|不带|不要有|不是|非)[一二两三四五六七八九十\\d]{0,3}${escaped}|${escaped}(?:不要|排除|不对|不行|不是|算了)`, "u");
  return negative.test(around) ? -1 : 1;
}

function mentionRole(context, mention) {
  for (const [role, rolePattern] of ROLE_PATTERNS) {
    const roleSource = rolePattern.source;
    const after = new RegExp(`^(?:只是|仅是|就是|是|当|做|作为|为|担任)?${roleSource}`, "iu");
    if (after.test(context.after)) return role;
  }
  for (const [role, rolePattern] of ROLE_PATTERNS) {
    const before = new RegExp(`${rolePattern.source}(?:是|用|给|让|选)?$`, "iu");
    if (before.test(context.before)) return role;
  }
  return null;
}

function mentionBreakpoint(context, mention) {
  if (!mention.candidates.some((candidate) => candidate.kind === "trait")) return null;
  const before = /([一二两三四五六七八九十\d]{1,3})$/u.exec(context.before);
  const after = /^([一二两三四五六七八九十\d]{1,3})/u.exec(context.after);
  const value = parseSmallNumber(before?.[1] || after?.[1]);
  return value && value <= 99 ? value : null;
}

function connectorBefore(text, start, existingCount) {
  if (!existingCount) return "and";
  const compact = compactText(text);
  const left = compact.slice(Math.max(0, start - 14), start);
  if (/(?:或者|还是|或|二选一|任一)(?:配|带|开|补|上|用|走)?[一二两三四五六七八九十\d]{0,3}$/u.test(left)) return "or";
  return "and";
}

function applyCorrectionSemantics(text, constraints, roles) {
  if (!/(?:不是|不对|改成|换成|而是|才是|算了|纠正)/u.test(text)) return;
  const positive = constraints.filter((constraint) => constraint.polarity === 1);
  const negative = constraints.filter((constraint) => constraint.polarity === -1);
  if (
    !negative.length
    && positive.length >= 2
    && (/(?:不是|不对).*(?:而是|才是|改成|换成)/u.test(text) || /.+(?:改成|换成).+/u.test(text))
  ) {
    positive[0].polarity = -1;
    positive[0].correction = "replaced";
  }
  for (const constraint of negative) constraint.correction = "excluded";
  for (const role of roles) {
    if (role.candidates.some((candidate) => constraints.some((constraint) => constraint.polarity < 0 && constraint.candidates.some((item) => refKey(item) === refKey(candidate))))) {
      role.polarity = -1;
    }
  }
}

function mergeIncrementalGroups(groups, parsedGroups, normalizedText = "") {
  const explicitTargetIndex = incrementalTargetGroupIndex(normalizedText, groups.length);
  for (const [parsedIndex, parsedGroup] of parsedGroups.entries()) {
    const negativeConstraints = array(parsedGroup.constraints).filter((constraint) => constraint.polarity < 0);
    const positiveRoles = array(parsedGroup.roles).filter((role) => role.polarity > 0);
    let targetIndex = explicitTargetIndex >= 0
      ? explicitTargetIndex
      : findIncrementalTargetGroup(groups, negativeConstraints, positiveRoles);
    if (targetIndex < 0) {
      const declaredIndex = Number.parseInt(String(parsedGroup.id || "").slice(1), 10) - 1;
      targetIndex = Math.min(groups.length, Number.isInteger(declaredIndex) && declaredIndex >= 0 ? declaredIndex : parsedIndex);
      if (!groups[targetIndex]) groups[targetIndex] = emptyGroup(targetIndex);
    }

    const target = groups[targetIndex] || (groups[targetIndex] = emptyGroup(targetIndex));
    for (const constraint of negativeConstraints) {
      const excludedRefs = new Set(constraint.candidates.map(refKey));
      target.constraints = array(target.constraints).filter((existing) => (
        existing.polarity < 0 || !existing.candidates.some((candidate) => excludedRefs.has(refKey(candidate)))
      ));
      target.roles = array(target.roles).filter((existing) => (
        existing.polarity < 0 || !existing.candidates.some((candidate) => excludedRefs.has(refKey(candidate)))
      ));
    }

    for (const role of positiveRoles) {
      const replacedRefs = new Set();
      for (const existing of array(target.roles)) {
        if (existing.role === role.role && existing.polarity > 0) {
          existing.candidates.forEach((candidate) => replacedRefs.add(refKey(candidate)));
        }
      }
      target.roles = array(target.roles).filter((existing) => existing.role !== role.role || existing.polarity < 0);
      if (replacedRefs.size) {
        target.constraints = array(target.constraints).filter((constraint) => (
          constraint.polarity < 0 || !constraint.candidates.some((candidate) => replacedRefs.has(refKey(candidate)))
        ));
      }
    }

    target.source_text = [target.source_text, parsedGroup.source_text].filter(Boolean).join(" | ");
    target.constraints = uniqueRows(
      [...array(target.constraints), ...array(parsedGroup.constraints)],
      constraintIdentity,
    );
    target.roles = uniqueRows(
      [...array(target.roles), ...array(parsedGroup.roles)],
      roleIdentity,
    );
    target.unresolved_mentions = uniqueRows(
      [...array(target.unresolved_mentions), ...array(parsedGroup.unresolved_mentions)],
      (row) => `${row.requested_breakpoint || ""}:${compactText(row.mention)}`,
    );
    target.invalid_breakpoints = uniqueRows(
      [...array(target.invalid_breakpoints), ...array(parsedGroup.invalid_breakpoints)],
      (row) => `${compactText(row.mention)}:${row.requested || ""}`,
    );
    target.validation_status = target.unresolved_mentions.length || target.invalid_breakpoints.length
      ? "needs_clarification"
      : "resolved";
    if (parsedGroup.requested_count) target.requested_count = parsedGroup.requested_count;
    if (parsedGroup.continuation) target.continuation = parsedGroup.continuation;
  }
  for (const group of groups) refreshGroupLogic(group);
}

function incrementalTargetGroupIndex(text, groupCount) {
  const match = /第([一二两三四五六七八九十\d]{1,2})(?:组|套|个)/u.exec(text);
  const explicit = parseSmallNumber(match?.[1]);
  if (explicit && explicit <= groupCount) return explicit - 1;
  if (/(?:后一组|后一个|后面那组|第二组|第二套)/u.test(text) && groupCount >= 2) return 1;
  if (/(?:前一组|前一个|前面那组|第一组|第一套)/u.test(text) && groupCount >= 1) return 0;
  return -1;
}

function findIncrementalTargetGroup(groups, negativeConstraints, positiveRoles) {
  const negativeRefs = new Set(negativeConstraints.flatMap((constraint) => constraint.candidates.map(refKey)));
  if (negativeRefs.size) {
    const index = groups.findIndex((group) => array(group.constraints).some((constraint) => (
      constraint.candidates.some((candidate) => negativeRefs.has(refKey(candidate)))
    )));
    if (index >= 0) return index;
  }
  for (const role of positiveRoles) {
    const index = groups.findIndex((group) => array(group.roles).some((existing) => existing.role === role.role && existing.polarity > 0));
    if (index >= 0) return index;
  }
  return -1;
}

function mergeContinuation(previous, parsed) {
  if (!previous && !parsed) return null;
  const shownRefs = uniqueRows(
    [...array(previous?.shown_refs), ...array(parsed?.shown_refs)],
    (value) => `${value.kind || ""}:${value.id || ""}`,
  );
  return compactIntent({
    mode: parsed?.mode || previous?.mode || "continue",
    count: parsed?.count ?? previous?.count,
    exclude_shown: parsed?.exclude_shown === true || previous?.exclude_shown === true,
    shown_refs: shownRefs,
  });
}

function reindexGroups(groups) {
  groups.forEach((group, index) => {
    group.id = `g${index + 1}`;
    group.constraints ||= [];
    refreshGroupLogic(group);
  });
}

function refreshGroupLogic(group) {
  group.logic = array(group.constraints).some((constraint) => constraint.connector === "or") ? "mixed" : "and";
  group.expression_plan = buildGroupExpressionPlan(group.source_text || "", array(group.constraints));
  const traitConstraintCount = array(group.constraints).filter((constraint) => (
    array(constraint.candidates).some((candidate) => candidate.kind === "trait")
  )).length;
  const retainedIssues = array(group.unresolved_mentions)
    .filter((issue) => issue?.reason !== "too_many_trait_constraints");
  group.unresolved_mentions = traitConstraintCount > MAX_TRAIT_CONSTRAINTS_PER_GROUP
    ? [...retainedIssues, {
        reason: "too_many_trait_constraints",
        observed_count: traitConstraintCount,
        max_supported: MAX_TRAIT_CONSTRAINTS_PER_GROUP,
      }]
    : retainedIssues;
  group.validation_status = group.unresolved_mentions.length || array(group.invalid_breakpoints).length
    ? "needs_clarification"
    : "resolved";
}

function emptyGroup(index) {
  return { id: `g${index + 1}`, source_text: "", logic: "and", constraints: [], roles: [] };
}

function constraintIdentity(constraint) {
  return `${constraint.polarity}:${constraint.breakpoint || ""}:${constraint.connector}:${constraint.candidates.map(refKey).sort().join("|")}`;
}

function roleIdentity(role) {
  return `${role.role}:${role.polarity}:${role.candidates.map(refKey).sort().join("|")}`;
}

function buildInterpretations(groups) {
  let rows = [{ bindings: [] }];
  for (const group of groups) {
    for (const constraint of array(group.constraints)) {
      const choices = constraint.candidates.slice(0, 4);
      if (!choices.length) continue;
      const expanded = [];
      for (const row of rows) {
        for (const candidate of choices) {
          expanded.push({ bindings: [...row.bindings, { group_id: group.id, mention: constraint.mention, entity: candidate }] });
          if (expanded.length >= MAX_INTERPRETATIONS) break;
        }
        if (expanded.length >= MAX_INTERPRETATIONS) break;
      }
      rows = expanded;
    }
  }
  if (!groups.some((group) => array(group.constraints).some((constraint) => constraint.ambiguous))) return [];
  return rows.map((row, index) => ({ id: `i${index + 1}`, bindings: row.bindings }));
}

function compactEntity(entity) {
  return {
    kind: entity.kind,
    id: String(entity.id),
    name: String(entity.name),
    ...(entity.address ? { address: String(entity.address) } : {}),
  };
}

function compactShownRefs(values) {
  return uniqueRows(array(values).map((value) => {
    if (typeof value === "string" || typeof value === "number") return { id: String(value) };
    if (!value || typeof value !== "object") return null;
    return compactIntent({ kind: normalizeKind(value.kind || value.entity_kind), id: String(value.id ?? value.lineup_id ?? value.address ?? ""), name: value.name || value.display_name });
  }).filter((value) => value?.id), (value) => `${value.kind || ""}:${value.id}`);
}

function compactIntent(value) {
  if (Array.isArray(value)) return value.map(compactIntent);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== null && entry !== undefined && entry !== false && entry !== "" && (!Array.isArray(entry) || entry.length))
    .map(([key, entry]) => [key, compactIntent(entry)]));
}

function normalizeKind(value) {
  const key = compactText(value);
  if (["trait", "traits", "羁绊", "特质"].includes(key)) return "trait";
  if (["champion", "champions", "unit", "units", "hero", "棋子", "英雄", "弈子"].includes(key)) return "champion";
  return key || null;
}

function compactText(value) {
  return normalizeRankingQueryText(value).toLowerCase().replace(/[\s，,。.!！?？;；:：、/\\|_()（）\[\]【】{}《》<>+＋-]+/g, "");
}

function sliceByCompactOffset(text, compactStart, compactLength) {
  let compactIndex = 0;
  let started = false;
  let result = "";
  for (const char of text) {
    const visible = compactText(char).length > 0;
    if (visible && compactIndex >= compactStart && compactIndex < compactStart + compactLength) started = true;
    if (started && compactIndex < compactStart + compactLength) result += char;
    if (visible) compactIndex += 1;
    if (compactIndex >= compactStart + compactLength) break;
  }
  return result.trim() || compactText(text).slice(compactStart, compactStart + compactLength);
}

function parseSmallNumber(value) {
  if (/^\d+$/.test(String(value))) return Number(value);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const raw = String(value || "");
  if (raw === "十") return 10;
  if (raw.includes("十")) {
    const [left, right] = raw.split("十");
    return (left ? digits[left] || 0 : 1) * 10 + (right ? digits[right] || 0 : 0);
  }
  return digits[raw] || null;
}

function numberArray(value) {
  return array(value).map((row) => Number(row?.count ?? row)).filter((number) => Number.isInteger(number) && number > 0);
}

function uniqueNumbers(value) {
  return [...new Set(numberArray(value))].sort((left, right) => left - right);
}

function stringArray(value) {
  return array(value).map((row) => String(row?.alias ?? row?.name ?? row).trim()).filter(Boolean);
}

function array(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueRows(rows, keyFor) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = keyFor(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function refKey(entity) {
  return `${entity?.kind || ""}:${entity?.id || entity?.address || ""}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
