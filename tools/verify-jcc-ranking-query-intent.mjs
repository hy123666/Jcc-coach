import assert from "node:assert/strict";
import {
  assertValidRankingQueryIntent,
  parseRankingQueryIntent,
  rankingQueryIntentDiagnostics,
  reduceRankingQueryIntent,
} from "../ui/electron/ranking-query-intent.js";

const catalog = {
  entities: [
    { kind: "trait", id: "t-sky", name: "天穹", aliases: ["天空"], breakpoints: [2, 4, 6] },
    { kind: "trait", id: "t-forest", name: "森灵", aliases: ["森林"], breakpoints: [2, 3, 4, 5, 6] },
    { kind: "trait", id: "t-blade", name: "剑盟", breakpoints: [2, 4, 6] },
    { kind: "trait", id: "t-moon", name: "月庭", breakpoints: [2, 4, 6] },
    { kind: "trait", id: "t-ember", name: "烬火", breakpoints: [2, 4, 6] },
    { kind: "trait", id: "t-guard", name: "铁卫", breakpoints: [2, 4, 6] },
    { kind: "trait", id: "t-wave", name: "潮汐", breakpoints: [2, 4, 6] },
    { kind: "champion", id: "c-river", name: "河音", aliases: ["小河"] },
    { kind: "champion", id: "c-river-alt", name: "河影", aliases: ["小河"] },
    { kind: "champion", id: "c-stone", name: "石垒" },
    { kind: "champion", id: "c-flame", name: "焰歌" },
  ],
};

function constraint(intent, name, group = 0) {
  return intent.groups[group].constraints.find((row) => row.candidates.some((candidate) => candidate.name === name));
}

const connectors = parseRankingQueryIntent("找4天穹和2森灵，或者6剑盟的阵容", { catalog });
assert.equal(connectors.groups.length, 1);
assert.equal(constraint(connectors, "天穹").breakpoint, 4);
assert.equal(constraint(connectors, "森灵").connector, "and");
assert.equal(constraint(connectors, "剑盟").connector, "or");

const twoQuestions = parseRankingQueryIntent("4天穹配2森灵有哪些？另外，河音主C、石垒主坦的阵容给我3套？", { catalog });
assert.equal(twoQuestions.groups.length, 2, "two questions must remain independent candidate groups");
assert.equal(twoQuestions.groups[1].requested_count, 3);
assert(twoQuestions.groups[1].roles.some((row) => row.role === "main_carry" && row.candidates[0].name === "河音"));
assert(twoQuestions.groups[1].roles.some((row) => row.role === "primary_tank" && row.candidates[0].name === "石垒"));

const commaSecondComposition = parseRankingQueryIntent("4天穹配2森灵，还有6剑盟和2月庭", { catalog });
assert.equal(commaSecondComposition.groups.length, 2, "还有 must split two complete trait compositions");
assert.deepEqual(commaSecondComposition.groups.map((group) => group.constraints.length), [2, 2]);
const noBreakpointSecondComposition = parseRankingQueryIntent("天穹配森灵，还有剑盟和月庭", { catalog });
assert.equal(noBreakpointSecondComposition.groups.length, 2, "explicit independent multi-trait groups must not require breakpoint numbers");
const andAlsoSecondComposition = parseRankingQueryIntent("天穹配森灵，以及剑盟和月庭", { catalog });
assert.equal(andAlsoSecondComposition.groups.length, 2, "以及 must split two complete multi-trait groups");
const noFalseCommaSplit = parseRankingQueryIntent("4天穹配2森灵，还有河音当成员", { catalog });
assert.equal(noFalseCommaSplit.groups.length, 1, "还有 one member must not split a complete composition group");

for (const [text, name] of [
  ["4天穹还是配2森灵", "森灵"],
  ["4天穹还是带河音", "河音"],
  ["4天穹还是开6剑盟", "剑盟"],
  ["4天穹还是补2月庭", "月庭"],
]) {
  const intent = parseRankingQueryIntent(text, { catalog });
  assert.equal(constraint(intent, name).connector, "or", `${text} must produce OR`);
  assert.equal(intent.groups[0].logic, "mixed");
}

const sixTraits = parseRankingQueryIntent("2天穹、3森灵、4剑盟、2月庭、4烬火和6铁卫", { catalog });
assert.equal(sixTraits.groups[0].constraints.filter((row) => row.candidates[0].kind === "trait").length, 6);
assert.deepEqual(sixTraits.groups[0].constraints.map((row) => row.breakpoint), [2, 3, 4, 2, 4, 6]);

const sevenTraits = parseRankingQueryIntent("2天穹、3森灵、4剑盟、2月庭、4烬火、6铁卫和2潮汐", { catalog });
assert.equal(sevenTraits.groups[0].validation_status, "needs_clarification");
assert(sevenTraits.groups[0].unresolved_mentions.some((row) => (
  row.reason === "too_many_trait_constraints" && row.observed_count === 7 && row.max_supported === 6
)));

const invalidBreakpoint = parseRankingQueryIntent("5天穹配2森灵", { catalog });
assert.equal(invalidBreakpoint.groups[0].validation_status, "needs_clarification");
assert.deepEqual(invalidBreakpoint.groups[0].invalid_breakpoints[0], {
  mention: "天穹",
  requested: 5,
  allowed: [2, 4, 6],
});

const unresolvedTrait = parseRankingQueryIntent("5未知羁绊配2森灵", { catalog });
assert.equal(unresolvedTrait.groups[0].validation_status, "needs_clarification");
assert.equal(unresolvedTrait.groups[0].unresolved_mentions[0].mention, "未知羁绊");

for (const conversationalPrefix of ["查一下", "看一下", "问一下", "了解一下"]) {
  const prefixed = parseRankingQueryIntent(`${conversationalPrefix}天穹和森灵能组成什么阵容`, { catalog });
  assert.equal(prefixed.groups[0].validation_status, "resolved", `${conversationalPrefix} must not be parsed as a 1-trait breakpoint`);
  assert.deepEqual(prefixed.groups[0].unresolved_mentions || [], []);
}

const unresolvedRoleEntity = parseRankingQueryIntent("幽灵英雄主C阵容", { catalog });
assert.equal(unresolvedRoleEntity.groups[0].validation_status, "needs_clarification");
assert(unresolvedRoleEntity.groups[0].unresolved_mentions.some((row) => (
  row.mention === "幽灵" && row.entity_kind_hint === "champion" && row.role === "main_carry"
)));

const unresolvedTraitWithoutBreakpoint = parseRankingQueryIntent("未知羁绊阵容", { catalog });
assert.equal(unresolvedTraitWithoutBreakpoint.groups[0].validation_status, "needs_clarification");
assert(unresolvedTraitWithoutBreakpoint.groups[0].unresolved_mentions.some((row) => (
  row.mention === "未知" && row.entity_kind_hint === "trait"
)));

assert.throws(
  () => parseRankingQueryIntent("4天穹", { catalog, aliasResolver() { throw new Error("resolver offline"); } }),
  /ranking query alias resolver failed/,
  "resolver faults must fail closed instead of looking like an entity miss",
);

const correction = parseRankingQueryIntent("不要河音主C，改成焰歌主C；排除6剑盟，要4天穹", { catalog });
assert.equal(constraint(correction, "河音", 0).polarity, -1);
assert.equal(constraint(correction, "焰歌", 0).polarity, 1);
assert.equal(constraint(correction, "剑盟", 1).polarity, -1);
assert.equal(constraint(correction, "剑盟", 1).breakpoint, 6, "NOT trait conditions must preserve their exact breakpoint");
assert.equal(constraint(correction, "天穹", 1).breakpoint, 4);

const more = parseRankingQueryIntent("继续，再来5套新的，别重复刚才看过的", {
  catalog,
  shown: [{ id: "line-1", kind: "lineup" }, "line-2"],
});
assert.equal(more.continuation.mode, "more");
assert.equal(more.continuation.count, 5);
assert.equal(more.continuation.exclude_shown, true);
assert.equal(more.continuation.shown_refs.length, 2);

const ambiguous = parseRankingQueryIntent("小河主C还是焰歌主C？", { catalog });
const river = ambiguous.groups[0].constraints.find((row) => row.mention === "小河");
assert.equal(river.ambiguous, true);
assert.deepEqual(river.candidates.map((row) => row.name).sort(), ["河影", "河音"].sort());
assert(ambiguous.interpretations.length >= 2, "ambiguous aliases must retain multiple interpretations");

const resolverOnly = parseRankingQueryIntent("阿星当成员", {
  catalog,
  aliasResolver(token) {
    return token === "阿星" ? [
      { kind: "champion", id: "external-a", name: "星澜" },
      { kind: "champion", id: "external-b", name: "星岚" },
    ] : [];
  },
});
assert.equal(resolverOnly.groups[0].constraints[0].candidates.length, 2);
assert.equal(resolverOnly.groups[0].roles[0].role, "member");

const bareCatalog = parseRankingQueryIntent("4云环", {
  catalog: [{ kind: "trait", id: "bare-trait", name: "云环", breakpoints: [2, 4, 6] }],
});

const lineupLayoutRequest = parseRankingQueryIntent("给我一张当前能转的阵容卡片，棋子放到 4x7 框里。", { catalog });
assert.deepEqual(
  lineupLayoutRequest.groups,
  [],
  "lineup-card layout dimensions must not be parsed as an unresolved trait breakpoint",
);
assert.equal(bareCatalog.groups[0].constraints[0].breakpoint, 4);

const previous = parseRankingQueryIntent("4天穹配2森灵，河音主C，石垒主坦", { catalog });
const continued = reduceRankingQueryIntent(previous, parseRankingQueryIntent("继续", { catalog }));
assert.deepEqual(continued.groups, previous.groups, "pure continuation must inherit the previous query groups");
assert.equal(continued.continuation.mode, "continue");
assert.equal(continued.inherited_from_previous, true);

const paged = reduceRankingQueryIntent(previous, parseRankingQueryIntent("再来4套新的，别重复", {
  catalog,
  shown: ["line-a", "line-b"],
}));
assert.equal(paged.groups[0].constraints.length, previous.groups[0].constraints.length);
assert.equal(paged.continuation.mode, "more");
assert.equal(paged.continuation.count, 4);
assert.equal(paged.continuation.exclude_shown, true);
assert.deepEqual(paged.continuation.shown_refs.map((row) => row.id), ["line-a", "line-b"]);

const carryCorrection = reduceRankingQueryIntent(
  previous,
  parseRankingQueryIntent("不要河音主C，改成焰歌主C", { catalog }),
);
assert(carryCorrection.groups[0].constraints.some((row) => row.polarity < 0 && row.candidates.some((candidate) => candidate.name === "河音")));
assert(carryCorrection.groups[0].constraints.some((row) => row.polarity > 0 && row.candidates.some((candidate) => candidate.name === "焰歌")));
assert(!carryCorrection.groups[0].roles.some((row) => row.polarity > 0 && row.candidates.some((candidate) => candidate.name === "河音")));
assert(carryCorrection.groups[0].roles.some((row) => row.polarity > 0 && row.role === "main_carry" && row.candidates.some((candidate) => candidate.name === "焰歌")));
assert(carryCorrection.groups[0].constraints.some((row) => row.candidates.some((candidate) => candidate.name === "天穹")), "carry correction must retain unrelated traits");

const traitExclusion = reduceRankingQueryIntent(previous, parseRankingQueryIntent("排除2森灵", { catalog }));
assert.equal(constraint(traitExclusion, "森灵").polarity, -1);
assert.equal(constraint(traitExclusion, "天穹").polarity, 1);

const multiGroupContinuation = reduceRankingQueryIntent(
  previous,
  parseRankingQueryIntent("继续，补4烬火配2铁卫？另外6剑盟配2月庭", { catalog }),
);
assert.equal(multiGroupContinuation.groups.length, 2, "incremental independent groups must not collapse into the first group");
assert(multiGroupContinuation.groups[0].constraints.some((row) => row.candidates.some((candidate) => candidate.name === "烬火")));
assert(multiGroupContinuation.groups[1].constraints.some((row) => row.candidates.some((candidate) => candidate.name === "剑盟")));

const breakpointReplacement = reduceRankingQueryIntent(
  previous,
  parseRankingQueryIntent("4天穹改成6天穹", { catalog }),
);
const skyConstraints = breakpointReplacement.groups[0].constraints.filter((row) => row.candidates.some((candidate) => candidate.name === "天穹"));
assert(skyConstraints.some((row) => row.polarity < 0), "breakpoint correction must retain an explicit old-query exclusion");
assert(skyConstraints.some((row) => row.polarity > 0 && row.breakpoint === 6), "breakpoint correction must add the replacement breakpoint");

const unrelatedNewQuery = parseRankingQueryIntent("6铁卫配2月庭", { catalog });
assert.deepEqual(reduceRankingQueryIntent(previous, unrelatedNewQuery), unrelatedNewQuery, "a non-incremental query must replace previous intent");

const independentNegativeQuery = parseRankingQueryIntent("不要6剑盟，要4铁卫阵容", { catalog });
assert.deepEqual(
  reduceRankingQueryIntent(previous, independentNegativeQuery),
  independentNegativeQuery,
  "a complete new query containing NOT must not inherit unrelated prior conditions",
);

const pureUnrelatedNegativeQuery = parseRankingQueryIntent("不要剑盟阵容", { catalog });
assert.deepEqual(
  reduceRankingQueryIntent(previous, pureUnrelatedNegativeQuery),
  pureUnrelatedNegativeQuery,
  "a pure NOT query must not inherit an unrelated previous query",
);

const pureRelatedNegativeCorrection = reduceRankingQueryIntent(
  previous,
  parseRankingQueryIntent("不要森灵", { catalog }),
);
assert.equal(pureRelatedNegativeCorrection.inherited_from_previous, true);
assert.equal(constraint(pureRelatedNegativeCorrection, "森灵").polarity, -1);
assert.equal(constraint(pureRelatedNegativeCorrection, "天穹").polarity, 1);

const sharedTraitGroups = parseRankingQueryIntent("4天穹配2森灵？另外4天穹配2月庭", { catalog });
const secondGroupCorrection = reduceRankingQueryIntent(
  sharedTraitGroups,
  parseRankingQueryIntent("纠正第二组：排除4天穹", { catalog }),
);
assert.equal(secondGroupCorrection.groups[0].constraints.some((row) => row.polarity > 0 && row.candidates.some((candidate) => candidate.name === "天穹")), true);
assert.equal(secondGroupCorrection.groups[1].constraints.some((row) => row.polarity < 0 && row.candidates.some((candidate) => candidate.name === "天穹")), true);

assert.deepEqual(rankingQueryIntentDiagnostics(ambiguous), []);
assert.equal(assertValidRankingQueryIntent(ambiguous), ambiguous);
assert(!JSON.stringify(connectors).includes("undefined"));
assert(Buffer.byteLength(JSON.stringify(sixTraits), "utf8") < 16 * 1024, "validated intent JSON must stay compact");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-ranking-query-intent-verification-v1",
  checked: [
    "chinese_and_or_connectors",
    "two_independent_questions",
    "comma_second_complete_composition",
    "adversarial_no_false_comma_split",
    "or_with_pair_carry_open_supplement_verbs",
    "two_to_six_trait_breakpoints",
    "conversational_prefix_not_breakpoint",
    "negation_and_correction",
    "carry_tank_member_roles",
    "continue_more_explicit_count",
    "exclude_shown",
    "ambiguous_catalog_and_resolver_aliases",
    "bare_array_catalog",
    "continuation_reducer_inheritance",
    "more_reducer_pagination",
    "reducer_role_correction",
    "reducer_trait_exclusion_and_breakpoint_replacement",
    "reducer_multi_group_increment",
    "non_incremental_reducer_replacement",
    "compact_validated_json",
    "season_neutral_entities",
  ],
}, null, 2));
