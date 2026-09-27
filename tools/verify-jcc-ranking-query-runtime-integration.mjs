import assert from "node:assert/strict";
import {
  compileRankingQueryRetrievalIntent,
  compactHostTurnDelta,
  compactSelectedRankingCandidatesForTurn,
  buildRuntimeHostContext,
  acknowledgeRankingCandidatesForResponse,
  hostContextCapsuleForRequest,
  hostRequestExplicitlyRequestsRankingWorkingSet,
  rankingCandidateFrontierOrder,
  selectRelevantRankingCandidates,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";
import { parseRankingQueryIntent } from "../ui/electron/ranking-query-intent.js";

const entities = {
  star: { kind: "trait", id: "trait-star", name: "星界", breakpoints: [3, 4, 6] },
  guard: { kind: "trait", id: "trait-guard", name: "守卫", breakpoints: [2, 4] },
  arcane: { kind: "trait", id: "trait-arcane", name: "奥术", breakpoints: [2, 3, 5] },
  bruiser: { kind: "trait", id: "trait-bruiser", name: "斗士", breakpoints: [2, 4] },
  hidden: { kind: "trait", id: "trait-hidden", name: "冷门", breakpoints: [2, 4] },
  nami: { kind: "champion", id: "nami", name: "娜美" },
  lulu: { kind: "champion", id: "lulu", name: "璐璐" },
};
const rankingQueryCatalog = { entities: Object.values(entities) };

function trait(traitId, breakpoint) {
  return { canonical_trait_id: traitId, trait_id: traitId, breakpoint };
}

function variant(id, {
  traits = [],
  mainCarry = entities.lulu,
  members = [entities.lulu],
} = {}) {
  return {
    variant_id: id,
    semantic_role: "published_final_lineup_variant",
    trait_signature: { traits },
    main_carry: { champion_id: mainCarry.id, champion_name: mainCarry.name },
    lineup_ids: members.map(({ id: championId }) => championId),
    lineup_names: members.map(({ name }) => name),
    core_units: members.map(({ id: championId, name }) => ({ champion_id: championId, champion_name: name })),
  };
}

function candidate(id, variants, strength = 0.5) {
  return {
    id,
    display_name: id,
    summary: {
      top4_rate: strength,
      top1_rate: strength / 3,
      use_rate: strength / 20,
      source_interpretation: "national_trait_ranking_primary_strength_evidence",
    },
    strategy_profile: {
      strength_anchor: {
        anchor_id: `national:${id}`,
        metrics: { top4_rate: strength, top1_rate: strength / 3, use_rate: strength / 20 },
      },
      main_carry: variants[0].main_carry,
      core_units: variants[0].core_units,
      variants,
    },
  };
}

const starCandidates = Array.from({ length: 12 }, (_, index) => candidate(
  `star-${String(index + 1).padStart(2, "0")}`,
  [variant(`star-v${index + 1}`, {
    traits: [trait(entities.star.id, 4), ...(index === 0 ? [trait(entities.guard.id, 2)] : [])],
  })],
  0.7 - index / 100,
));
const arcaneCandidates = Array.from({ length: 6 }, (_, index) => candidate(
  `arcane-${String(index + 1).padStart(2, "0")}`,
  [variant(`arcane-v${index + 1}`, {
    traits: [trait(entities.arcane.id, 3), ...(index === 0 ? [trait(entities.bruiser.id, 2)] : [])],
  })],
  0.62 - index / 100,
));
const crossVariantCandidate = candidate("cross-variant-only", [
  variant("cross-star", { traits: [trait(entities.star.id, 4)] }),
  variant("cross-guard", { traits: [trait(entities.guard.id, 2)] }),
], 0.99);
const partialEmergingCandidate = candidate("partial-emerging", [
  variant("partial-emerging-v1", { traits: [trait(entities.star.id, 3)] }),
], 0.98);
partialEmergingCandidate.strategy_profile.strength_anchor.quality = {
  currentness: { interpretation: "emerging_low_adoption_signal" },
};
const hiddenCandidate = candidate("outside-meta-map", [
  variant("hidden-v1", { traits: [trait(entities.hidden.id, 2)] }),
], 0.58);
hiddenCandidate.strategy_profile.strength_anchor.quality = { band: "c", current_day_score: 0.4 };
const namiCarryCandidate = candidate("nami-main-carry", [
  variant("nami-carry-v1", {
    traits: [trait(entities.arcane.id, 3)],
    mainCarry: entities.nami,
    members: [entities.nami, entities.lulu],
  }),
], 0.55);
const namiMemberCandidate = candidate("nami-member-only", [
  variant("nami-member-v1", {
    traits: [trait(entities.arcane.id, 3)],
    mainCarry: entities.lulu,
    members: [entities.nami, entities.lulu],
  }),
], 0.95);
const completePool = [
  ...starCandidates,
  ...arcaneCandidates,
  crossVariantCandidate,
  partialEmergingCandidate,
  hiddenCandidate,
  namiCarryCandidate,
  namiMemberCandidate,
];
const metaMapWhitelist = [starCandidates[0], arcaneCandidates[0]].map((entry) => ({
  id: entry.id,
  display_name: entry.display_name,
  summary: entry.summary,
}));
const dailyBigData = {
  schema: "jcc-live-rankings-host-context-summary-v1",
  available: true,
  stat_date: "20991231",
  tiers: {
    0: {
      label: "master_plus",
      top_lineups: metaMapWhitelist,
      lineup_groups: completePool,
      reverse_indexes: {},
    },
  },
};

const largePool = Array.from({ length: 85 }, (_, i) => candidate(`full-${i}`, [variant(`full-v${i}`)]));
const fullQuery = selectRelevantRankingCandidates({ ...dailyBigData,
  tiers: { 0: { label: "master_plus", lineup_groups: largePool } },
}, { mode: "daily_chat", user_message: "当前上分阵容", ranking_full_pool: true, ranking_recommendation: true });
assert.equal(fullQuery.candidates.length, 85, "native retrieval must not stop at the old working-set/meta-map limit");
const lowerBandQuery = selectRelevantRankingCandidates(dailyBigData, {
  mode: "daily_chat", user_message: "给我看 C 档阵容", ranking_full_pool: true,
  ranking_recommendation: true, ranking_include_band_directory: true,
});
assert.deepEqual(lowerBandQuery.requested_strength_bands, ["c"]);
assert.deepEqual(lowerBandQuery.candidates.map((entry) => entry.id), ["outside-meta-map"],
  "an explicit lower-band question must not inherit the generic S/A filter");
assert.equal(lowerBandQuery.band_directory.bands.find((entry) => entry.band === "c").total_atomic_candidates, 1);

assert.equal(hostRequestExplicitlyRequestsRankingWorkingSet({
  mode: "daily_chat",
  user_message: "聊一下当前上分思路，并且推荐几套 Master+ 大数据阵容。",
}), true, "an explicit Ranking request appended to the daily strategy preset must load the working set");
assert.equal(hostRequestExplicitlyRequestsRankingWorkingSet({
  mode: "daily_chat",
  user_message: "聊一下当前上分思路。",
}), false, "a general daily strategy discussion must not eagerly attach the full Ranking set");

setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "inactive", match_session_id: null },
  match_context: {},
  user_preferences: { rank_tier: "master" },
});

function request(requestId, userMessage, routeKey) {
  return {
    request_id: requestId,
    request_hash: requestId,
    mode: "cruise",
    task: { type: "direct_chat" },
    user_message: userMessage,
    ranking_query_route_key: routeKey,
    ranking_query_catalog: rankingQueryCatalog,
    user_preferences: { rank_tier: "master" },
    daily_big_data: dailyBigData,
    season_catalog: {
      traits: Object.values(entities).filter(({ kind }) => kind === "trait"),
      champions: Object.values(entities).filter(({ kind }) => kind === "champion"),
    },
    runtime_context: { match_facts: {} },
    context: {},
  };
}

function select(requestId, userMessage, routeKey) {
  return selectRelevantRankingCandidates(dailyBigData, request(requestId, userMessage, routeKey));
}

const twoGroups = select(
  "daily-two-groups-1",
  "4星界2守卫，还有一套：3奥术2斗士",
  "daily:ranking-integration:two-groups",
);
assert.equal(twoGroups.query_status, "typed_query_exact");
assert.equal(twoGroups.explicit_group_coverage.length, 2, "daily chat must retain two independent trait groups");
assert(twoGroups.explicit_group_coverage.every(({ status, candidate_id: candidateId }) => status === "exact" && candidateId),
  "each independent group must receive an exact representative");
assert.deepEqual(
  new Set(twoGroups.explicit_group_coverage.map(({ candidate_id: candidateId }) => candidateId)),
  new Set(["star-01", "arcane-01"]),
  "the two groups must not collapse into one representative",
);
assert(twoGroups.candidates.some(({ id }) => id === "star-01"));
assert(twoGroups.candidates.some(({ id }) => id === "arcane-01"));

const explicitAlternatives = select(
  "daily-explicit-alternatives-1",
  "4星界还是3奥术，分别给我一个方向",
  "daily:ranking-integration:explicit-alternatives",
);
assert.equal(explicitAlternatives.explicit_group_coverage.length, 2,
  "an explicit OR comparison must expose one bounded retrieval branch per alternative");
assert(explicitAlternatives.explicit_group_coverage.every(({ status, candidate_id: candidateId }) => status === "exact" && candidateId),
  "both explicit alternatives must receive exact representatives instead of treating the first exact hit as the whole OR answer");
assert.equal(new Set(explicitAlternatives.explicit_group_coverage.map(({ candidate_id: candidateId }) => candidateId)).size, 2,
  "the explicit alternatives must not collapse into one representative");

const ordinaryOr = compileRankingQueryRetrievalIntent(parseRankingQueryIntent(
  "4星界还是3奥术，给我3套",
  { catalog: rankingQueryCatalog },
));
assert.equal(ordinaryOr.groups.length, 1, "ordinary OR is one query group, not multiple mandatory display obligations");
assert.equal(ordinaryOr.groups[0].expression.op, "or");

const andThenOr = compileRankingQueryRetrievalIntent(parseRankingQueryIntent(
  "4星界和2守卫，或者3奥术",
  { catalog: rankingQueryCatalog },
));
assert.equal(andThenOr.groups[0].expression.op, "or");
assert.equal(andThenOr.groups[0].expression.clauses[0].op, "and", "A AND B OR C must preserve the A+B branch");

const nineAlternatives = compileRankingQueryRetrievalIntent(parseRankingQueryIntent(
  "3星界还是4星界还是6星界，2奥术还是3奥术还是5奥术，每种组合分别给我一个",
  { catalog: rankingQueryCatalog },
));
assert.equal(nineAlternatives.groups.length, 9, "a valid 3x3 explicit comparison must not be silently truncated to eight branches");

const excessiveAlternatives = compileRankingQueryRetrievalIntent({
  groups: [{
    id: "adversarial-cartesian-expansion",
    expand_alternatives: true,
    constraints: [
      ...[2, 3, 4, 5, 6].map((breakpoint) => ({ candidates: [entities.star], breakpoint, polarity: 1 })),
      ...[2, 3, 4, 5, 6].map((breakpoint) => ({ candidates: [entities.arcane], breakpoint, polarity: 1 })),
    ],
    expression_plan: {
      op: "and",
      clauses: [
        { op: "or", clauses: [0, 1, 2, 3, 4].map((constraint_index) => ({ constraint_index })) },
        { op: "or", clauses: [5, 6, 7, 8, 9].map((constraint_index) => ({ constraint_index })) },
      ],
    },
  }],
});
assert.equal(excessiveAlternatives.groups.length, 0, "an excessive Cartesian expansion must not emit a partial branch set");
assert.equal(excessiveAlternatives.unresolved_groups.length, 1, "an excessive Cartesian expansion must become one explicit unresolved obligation");
assert.equal(excessiveAlternatives.unresolved_groups[0].unresolved_mentions[0].reason, "query_expression_too_complex");
assert.equal(excessiveAlternatives.unresolved_groups[0].unresolved_mentions[0].max_branches, 16);

const unresolvedGroup = select(
  "daily-unresolved-group-1",
  "5未知羁绊配2守卫",
  "daily:ranking-integration:unresolved-group",
);
assert.equal(unresolvedGroup.explicit_group_coverage[0].status, "unresolved");
assert.equal(unresolvedGroup.candidates.length, 0, "an unresolved group must not masquerade as a normal Meta fallback");

for (const [requestId, text] of [
  ["daily-unresolved-role-entity", "幽灵英雄主C阵容"],
  ["daily-unresolved-trait-entity", "未知羁绊阵容"],
]) {
  const unresolved = select(requestId, text, `daily:ranking-integration:${requestId}`);
  assert.equal(unresolved.explicit_group_coverage[0].status, "unresolved");
  assert.equal(unresolved.candidates.length, 0, `${text} must request clarification instead of returning Meta candidates`);
}

function verifyContinuation(pageSize, routeSuffix) {
  const routeKey = `daily:ranking-integration:${routeSuffix}`;
  const firstRequest = request(`${routeSuffix}-first`, `星界阵容，给我${pageSize}套`, routeKey);
  const first = selectRelevantRankingCandidates(dailyBigData, firstRequest);
  firstRequest.selected_ranking_candidates = first;
  acknowledgeRankingCandidatesForResponse(firstRequest, {
    strategy_selection: {
      selected_candidate_ids: first.candidates.slice(0, pageSize).map(({ id }) => id),
    },
  });
  const more = select(`${routeSuffix}-more`, `再来${pageSize}套，不重复`, routeKey);
  assert.equal(first.query_page.page_size, pageSize);
  assert.equal(first.query_page.requested_display_count, pageSize);
  assert.equal(first.query_page.returned_count, first.candidates.length);
  assert(first.query_page.working_set_size >= pageSize, "the Ranking working set must not be narrower than the requested display count");
  assert(first.query_page.returned_count >= pageSize, "the first Ranking page must retain enough real candidates for Agent selection");
  assert.equal(first.query_page.exhausted, false, `${pageSize} results must be a display page, not a search limit`);
  assert.equal(more.query_page.page_size, pageSize);
  assert.equal(more.query_page.requested_display_count, pageSize);
  assert.equal(more.query_page.returned_count, more.candidates.length);
  const firstIds = new Set(first.candidates.slice(0, pageSize).map(({ id }) => id));
  const moreIds = new Set(more.candidates.slice(0, pageSize).map(({ id }) => id));
  assert.equal([...moreIds].some((id) => firstIds.has(id)), false, `the next ${pageSize} must not repeat shown candidates`);
  assert.equal(new Set([...firstIds, ...moreIds]).size, firstIds.size + moreIds.size);
  assert(firstIds.size + moreIds.size > pageSize, "pagination must expose the wider real candidate pool rather than only the requested display count");
  assert.match(first.query_page.policy, /working set|search pool/i);
  return { first, more };
}

const pagesOfThree = verifyContinuation(3, "pages-of-three");
const pagesOfFive = verifyContinuation(5, "pages-of-five");

const invalidationRoute = "daily:ranking-integration:fingerprint-invalidation";
select("fingerprint-first", "星界阵容，给我3套", invalidationRoute);
const changedDailyBigData = structuredClone(dailyBigData);
changedDailyBigData.tiers[0].lineup_groups.at(-1).strategy_profile.variants[0].trait_signature = {
  traits: [trait(entities.hidden.id, 4)],
};
const invalidatedContinuation = selectRelevantRankingCandidates(
  changedDailyBigData,
  request("fingerprint-more", "再来3套，不重复", invalidationRoute),
);
assert.equal(invalidatedContinuation.query_page.invalidated, true, "a promoted typed-index content change must invalidate the old cursor explicitly");
assert.equal(invalidatedContinuation.query_page.invalidation_reason, "query_or_fingerprint_changed");
assert.equal(invalidatedContinuation.candidates.length, 0, "an invalidated continuation must not masquerade as the next page of the old query");

const recipeOnlyInvalidationRoute = "daily:ranking-integration:recipe-fingerprint-invalidation";
select("recipe-fingerprint-first", "星界阵容，给我3套", recipeOnlyInvalidationRoute);
const recipeChangedDailyBigData = structuredClone(dailyBigData);
recipeChangedDailyBigData.tiers[0].lineup_groups[0].strategy_profile.lifecycle_prior = {
  archetype: "changed-recipe-only",
};
const recipeInvalidatedContinuation = selectRelevantRankingCandidates(
  recipeChangedDailyBigData,
  request("recipe-fingerprint-more", "再来3套，不重复", recipeOnlyInvalidationRoute),
);
assert.equal(recipeInvalidatedContinuation.query_page.invalidated, true,
  "a recipe-only promoted content change must invalidate the old cursor");
assert.equal(recipeInvalidatedContinuation.candidates.length, 0);

const correctionRoute = "daily:ranking-integration:correction";
const beforeCorrection = select("correction-before", "星界阵容，给我3套", correctionRoute);
const afterCorrection = select("correction-after", "不要星界，改成奥术，给我3套", correctionRoute);
assert(beforeCorrection.candidates.every((entry) => entry.query_match?.exact_group_ids?.includes("g1")),
  "the pre-correction page must contain only exact matches for the old condition");
assert.equal(beforeCorrection.candidates.some(({ id }) => id.startsWith("arcane-") || id.startsWith("nami-")), false);
assert(afterCorrection.candidates.every(({ id }) => id.startsWith("arcane-") || id.startsWith("nami-")),
  "new positive conditions must replace the corrected old condition");
const correctedConstraints = afterCorrection.query_intent.groups.flatMap((group) => group.constraints);
assert(correctedConstraints.some((constraint) => constraint.polarity === 1
  && constraint.candidates.some(({ id }) => id === entities.arcane.id)));
assert.equal(correctedConstraints.some((constraint) => constraint.polarity === 1
  && constraint.candidates.some(({ id }) => id === entities.star.id)), false,
"the old positive trait condition must not survive user correction");

const startMatchPool = select("start-match-full-pool", "", "match:ranking-integration:start-match");
assert.equal(startMatchPool.candidates.length, completePool.length,
  "Start Match retrieval must hydrate the complete Master+ candidate pool, not the Meta Map whitelist");
assert(startMatchPool.candidates.length > metaMapWhitelist.length);
assert(startMatchPool.candidates.some(({ id }) => id === hiddenCandidate.id));
const expandedWorkingSet = selectRelevantRankingCandidates(dailyBigData, {
  ...request("ranking-expansion-hint", "大数据阵容，给我5套", "daily:ranking-integration:expanded-working-set"),
  ranking_recommendation: true,
  ranking_working_set_hint: 40,
});
assert.equal(expandedWorkingSet.query_page.working_set_size, 40,
  "an Agent-requested Ranking expansion must honor a bounded working-set hint above the legacy page size");
assert.equal(expandedWorkingSet.query_page.requested_display_count, 5);
assert.equal(expandedWorkingSet.candidates.length, completePool.length,
  "an expanded Ranking working set must expose every available real candidate in the fixture instead of truncating at 16");
const startMatchHidden = select("start-match-hidden-query", "冷门阵容", "match:ranking-integration:hidden-query");
assert(startMatchHidden.candidates.some(({ id }) => id === hiddenCandidate.id),
  "a typed Start Match query must find a candidate outside the static Meta Map whitelist");

const atomicVariant = select(
  "atomic-variant-evidence",
  "4星界2守卫",
  "match:ranking-integration:atomic-variant",
);
const crossVariantMatch = atomicVariant.candidates.find(({ id }) => id === crossVariantCandidate.id)?.query_match;
assert(crossVariantMatch, "the cross-variant fixture must remain visible as downgraded evidence");
assert.equal(crossVariantMatch.exact_group_ids.length, 0,
  "one candidate must not compose trait evidence across sibling variants");
assert.deepEqual(crossVariantMatch.partial_group_ids, ["g1"]);
assert.equal(
  crossVariantMatch.group_matches[0].variant_id === "cross-star"
    || crossVariantMatch.group_matches[0].variant_id === "cross-guard",
  true,
  "the partial match must identify one atomic source variant",
);
assert.equal(atomicVariant.explicit_group_coverage[0].candidate_id, "star-01",
  "an atomic exact variant must represent the group instead of a stronger cross-variant composition");

const exactBeforePartial = rankingCandidateFrontierOrder([
  ...starCandidates.slice(0, 6).map((entry) => ({ ...entry, match_type: "typed_query_exact" })),
  { ...partialEmergingCandidate, match_type: "typed_query_partial_downgrade" },
]);
const firstPartialIndex = exactBeforePartial.findIndex((entry) => entry.match_type === "typed_query_partial_downgrade");
const lastExactIndex = exactBeforePartial.reduce((last, entry, index) => (
  entry.match_type === "typed_query_exact" ? index : last
), -1);
assert(firstPartialIndex >= 0 && lastExactIndex >= 0,
  "the typed currentness fixture must contain both exact and partial candidates");
assert(lastExactIndex < firstPartialIndex,
  "currentness coverage may reorder candidates inside a typed match class, but a partial match must never cross an exact match");

const variantBoundSelection = {
  schema: "jcc-decision-evidence-packet-v1",
  query_status: "typed_query_exact",
  explicit_group_coverage: [{ group_id: "g1", candidate_id: crossVariantCandidate.id, variant_id: "cross-guard", status: "exact" }],
  candidates: [{
    ...crossVariantCandidate,
    query_match: {
      exact_group_ids: ["g1"],
      partial_group_ids: [],
      group_matches: [{ group_id: "g1", variant_id: "cross-guard", exact: true, positive_matched: 1 }],
    },
  }],
};
const variantBoundRequest = {
  ...request("variant-bound-host-delta", "2守卫阵容", "daily:ranking-integration:variant-bound-host-delta"),
  selected_ranking_candidates: variantBoundSelection,
};
const variantBoundDelta = compactHostTurnDelta(
  variantBoundRequest,
  hostContextCapsuleForRequest(variantBoundRequest, { routeKey: "daily:ranking-integration:variant-bound-host-delta" }),
);
assert.equal(
  variantBoundDelta.selected_ranking_candidates.candidates[0].strategy_profile.canonical_variant.variant_id,
  "cross-guard",
  "the exact typed-query variant must become the Host canonical variant instead of a different sibling",
);

const committedAtomicVariant = select(
  "committed-atomic-variant-evidence",
  "我现在明确玩4星界2守卫，锁定这个方向",
  "match:ranking-integration:committed-atomic-variant",
);
assert.equal(committedAtomicVariant.query_status, "typed_query_exact",
  "committing to a target must not disable typed atomic retrieval");
assert.equal(committedAtomicVariant.explicit_group_coverage[0].candidate_id, "star-01",
  "a committed target must bind the same exact atomic candidate as an ordinary typed query");

const twoGroupCompaction = compactSelectedRankingCandidatesForTurn({
  schema: "jcc-decision-evidence-packet-v1",
  explicit_group_coverage: [
    { group_id: "g1", candidate_id: crossVariantCandidate.id, variant_id: "cross-star", status: "exact" },
    { group_id: "g2", candidate_id: "star-01", variant_id: "star-01-v1", status: "exact" },
  ],
  candidates: [{
    ...crossVariantCandidate,
    query_match: {
      exact_group_ids: ["g1"],
      partial_group_ids: [],
      group_matches: [
        { group_id: "g1", variant_id: "cross-star", exact: true, positive_matched: 1 },
        { group_id: "g1", variant_id: "cross-guard", exact: true, positive_matched: 1 },
      ],
    },
  }, {
    ...completePool.find((candidate) => candidate.id === "star-01"),
    query_match: {
      exact_group_ids: ["g2"],
      partial_group_ids: [],
      group_matches: [{ group_id: "g2", variant_id: "star-01-v1", exact: true, positive_matched: 1 }],
    },
  }],
}, { maxCandidates: 2, includeLineupIds: true });
assert.deepEqual(
  new Set(twoGroupCompaction.candidates.flatMap((candidate) => candidate.query_group_ids)),
  new Set(["g1", "g2"]),
  "Host compaction must preserve one real evidence instance for every resolved independent query group",
);

const mainCarry = select(
  "main-carry-only",
  "娜美主C阵容",
  "match:ranking-integration:main-carry",
);
assert.equal(mainCarry.query_status, "typed_query_exact");
assert(mainCarry.candidates.some(({ id }) => id === namiCarryCandidate.id));
assert.equal(mainCarry.candidates.some(({ id }) => id === namiMemberCandidate.id), false,
  "explicit main-carry intent must match recipe main carry, not mere roster membership");
assert.equal(mainCarry.explicit_group_coverage[0].candidate_id, namiCarryCandidate.id);

setRuntimeServiceState({
  active_mode: "daily_chat",
  daily_session: { generation: 17 },
  match_session: null,
  match_context: {},
  user_preferences: { rank_tier: "master" },
});
const ordinaryLobbyRankingContext = await buildRuntimeHostContext("daily_chat", null, {
  request_id: "ordinary-lobby-ranking-route",
  provider_readonly_tool_mode: "prefetch_complete",
  mode: "daily_chat",
  user_message: "给我大数据的5套你推荐的阵容",
});
assert.equal(
  ordinaryLobbyRankingContext.selected_ranking_candidates.requested_display_count,
  5,
  "explicit lobby Ranking requests must preserve the requested display count",
);
assert.equal(
  ordinaryLobbyRankingContext.selected_ranking_candidates.candidate_working_set_limit,
  10,
  "explicit lobby Ranking requests must expose a wider bounded working set",
);
assert.equal(
  ordinaryLobbyRankingContext.selected_ranking_candidates.query_status,
  "ranking_browse_available",
  "real Ranking browse candidates must not be labeled as Core-only fallback evidence",
);
assert.equal(
  ordinaryLobbyRankingContext.selected_ranking_candidates.candidates.length,
  10,
  "explicit lobby Ranking requests must retain the bounded real candidate pool",
);
const explicitRankingActionContext = await buildRuntimeHostContext("daily_chat", null, {
  request_id: "explicit-ranking-action-route",
  provider_readonly_tool_mode: "prefetch_complete",
  mode: "daily_chat",
  user_message: "给我5套",
  ranking_recommendation: true,
  ranking_requested_count: 5,
});
assert.equal(
  explicitRankingActionContext.context_policy.ranking_intent,
  true,
  "the explicit Ranking action must enable Ranking context even when its user text has no Ranking keyword",
);
assert.equal(
  explicitRankingActionContext.selected_ranking_candidates?.requested_display_count,
  5,
  "the explicit Ranking action must preserve its requested count",
);
const productionCatalogContext = await buildRuntimeHostContext("daily_chat", null, {
  request_id: "production-ranking-catalog-route",
  provider_readonly_tool_mode: "prefetch_complete",
  mode: "daily_chat",
  user_message: "永恒之森阵容，给我1套",
});
assert(
  productionCatalogContext.selected_ranking_candidates.query_intent?.groups?.length > 0,
  "the production Ranking selector must receive the Core-derived catalog for natural-language trait parsing",
);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-ranking-query-runtime-integration-verifier-v1",
  complete_pool_size: completePool.length,
  meta_map_size: metaMapWhitelist.length,
  independent_group_representatives: twoGroups.explicit_group_coverage.map(({ candidate_id: candidateId }) => candidateId),
  non_repeating_pages: {
    three: [pagesOfThree.first.candidates.length, pagesOfThree.more.candidates.length],
    five: [pagesOfFive.first.candidates.length, pagesOfFive.more.candidates.length],
  },
  corrected_to: afterCorrection.candidates.map(({ id }) => id),
  atomic_variant_representative: atomicVariant.explicit_group_coverage[0].candidate_id,
  main_carry_representative: mainCarry.explicit_group_coverage[0].candidate_id,
  ordinary_lobby_ranking: {
    requested: ordinaryLobbyRankingContext.selected_ranking_candidates.requested_display_count,
    working_set: ordinaryLobbyRankingContext.selected_ranking_candidates.candidate_working_set_limit,
    status: ordinaryLobbyRankingContext.selected_ranking_candidates.query_status,
  },
  explicit_ranking_action: {
    requested: explicitRankingActionContext.selected_ranking_candidates.requested_display_count,
    status: explicitRankingActionContext.selected_ranking_candidates.query_status,
  },
  production_catalog_groups: productionCatalogContext.selected_ranking_candidates.query_intent.groups.length,
}, null, 2));
