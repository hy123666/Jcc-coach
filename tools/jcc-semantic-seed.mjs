import { createHash } from "node:crypto";

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();
}

function unique(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function inferArchetype(query) {
  const text = normalize(query);
  if (/(?:九五|95(?:阵容|体系|上限)?)/u.test(text)) return "legendary_cap";
  if (/(?:八四|84(?:阵容|体系)?)/u.test(text)) return "eight_four_operation";
  if (/(?:盗宗|四费赌狗|4费赌狗)/u.test(text)) return "four_cost_carry";
  if (/(?:一费|1费).{0,10}(?:赌狗|主c|核心|追三|三星|阵容)/u.test(text)) return "one_cost_reroll";
  if (/(?:二费|2费).{0,10}(?:赌狗|主c|核心|追三|三星|阵容)/u.test(text)) return "two_cost_reroll";
  if (/(?:三费|3费).{0,10}(?:赌狗|主c|核心|追三|三星|阵容)/u.test(text)) return "three_cost_reroll";
  return null;
}

function inferDomains(query) {
  const text = normalize(query);
  const domains = [];
  if (/(?:阵容|羁绊|主c|主坦|主t|过渡|赌狗|运营|人口|转阵)/u.test(text)) domains.push("lineup");
  if (/(?:装备|出装|合成|神器|光明|转职|纹章|装备冲突)/u.test(text)) domains.push("itemization");
  if (/(?:强化|海克斯|刷新|保留)/u.test(text)) domains.push("augment");
  if (/(?:成型|上限|下限|质量|强度|赌|d牌|搜牌|拉人口|保血)/u.test(text)) domains.push("formation");
  return unique(domains.length ? domains : ["general_strategy"]);
}

function inferObjectives(query) {
  const text = normalize(query);
  const objectives = [];
  if (/(?:前四|保血|稳)/u.test(text)) objectives.push("survive");
  if (/(?:吃鸡|登顶|上限|质变)/u.test(text)) objectives.push("cap");
  if (/(?:经济|利息|存钱|上人口|拉人口)/u.test(text)) objectives.push("economy_tempo");
  if (/(?:三星|追三|d牌|搜牌)/u.test(text)) objectives.push("quality");
  if (/(?:转阵|换阵|过渡)/u.test(text)) objectives.push("transition");
  return unique(objectives.length ? objectives : ["best_fit"]);
}

function inferTargetRole(query) {
  const text = normalize(query);
  if (/(?:主坦|主t|前排)/u.test(text)) return "main_tank";
  if (/(?:主c|核心|输出)/u.test(text)) return "main_carry";
  if (/(?:强化|海克斯)/u.test(text)) return "augment_choice";
  if (/(?:装备|神器|出装)/u.test(text)) return "itemization";
  return "lineup";
}

export function buildSemanticSeed({
  query = "",
  context = {},
  archetype = null,
  domains = [],
  objectives = [],
  targetRole = null,
  referencedEntities = [],
  sourcePolicy = null,
} = {}) {
  const normalizedQuery = String(query || "").normalize("NFKC").trim();
  const priorSeed = context?.semantic_seed && typeof context.semantic_seed === "object" ? context.semantic_seed : null;
  const resolvedArchetype = archetype?.id || archetype || context?.archetype?.id || context?.archetype || priorSeed?.archetype || inferArchetype(normalizedQuery);
  const resolvedDomains = unique([
    ...asArray(priorSeed?.domains),
    ...(domains.length ? domains : context?.requested_domains?.length ? context.requested_domains : inferDomains(normalizedQuery)),
  ]);
  const resolvedObjectives = unique([
    ...asArray(priorSeed?.objectives),
    ...(objectives.length ? objectives : context?.objectives?.length ? context.objectives : inferObjectives(normalizedQuery)),
  ]);
  const resolvedTargetRole = targetRole || context?.target_role || priorSeed?.target_role || inferTargetRole(normalizedQuery);
  const seed = {
    schema: "jcc-semantic-seed-v1",
    intent: context?.intent || priorSeed?.intent || (resolvedDomains.includes("lineup") ? "construct_or_evaluate_lineup" : "evaluate_strategy"),
    archetype: resolvedArchetype || null,
    domains: resolvedDomains,
    objectives: resolvedObjectives,
    target_role: resolvedTargetRole,
    referenced_entities: unique([
      ...asArray(priorSeed?.referenced_entities),
      ...asArray(referencedEntities.length ? referencedEntities : context?.referenced_entities),
    ]),
    source_policy: sourcePolicy || context?.source_policy || priorSeed?.source_policy || "current_selected_context",
    user_query: normalizedQuery.slice(0, 4000),
    selection_owner: "agent",
    expansion_owner: "runtime_deterministic",
    final_validation_owner: "runtime_deterministic",
  };
  return Object.freeze({ ...seed, seed_id: priorSeed?.seed_id || `seed:${hash(seed)}` });
}

export function buildMechanicalExpansionPlan(seed, {
  population = null,
  stabilizePopulation = null,
  targetPopulation = null,
  coreCost = null,
} = {}) {
  const archetype = seed?.archetype || null;
  const isReroll = ["one_cost_reroll", "two_cost_reroll", "three_cost_reroll", "four_cost_carry"].includes(archetype);
  const resolvedStabilize = stabilizePopulation ?? (
    archetype === "one_cost_reroll" ? 5
      : archetype === "two_cost_reroll" ? 6
        : archetype === "three_cost_reroll" ? 7
          : archetype === "four_cost_carry" ? 8
            : 8
  );
  const resolvedTarget = targetPopulation ?? (archetype === "legendary_cap" ? 9 : isReroll ? (archetype === "one_cost_reroll" ? 7 : 8) : population ?? 8);
  const resolvedCoreCost = coreCost ?? ({
    one_cost_reroll: 1,
    two_cost_reroll: 2,
    three_cost_reroll: 3,
    four_cost_carry: 4,
    legendary_cap: 5,
  }[archetype] ?? null);
  return Object.freeze({
    schema: "jcc-mechanical-expansion-plan-v1",
    seed_id: seed?.seed_id || null,
    stage_constraints: [
      { population: resolvedStabilize, role: "stage_core", max_core_unit_cost: isReroll ? resolvedCoreCost : null },
      { population: resolvedTarget, role: "formation", max_core_unit_cost: isReroll ? Math.min(5, resolvedCoreCost + Math.max(0, resolvedTarget - resolvedStabilize)) : null },
    ],
    required_expansions: unique([
      "atomic_roster",
      "trait_effects",
      "skill_and_role_evidence",
      "formation_burden",
      "star_and_copy_cost",
      "xp_and_roll_cost",
      "item_continuity",
      "augment_fit",
      "emblem_and_special_mechanics",
      "transition_chain",
      "exit_conditions",
    ]),
    hard_guards: [
      "preserve_atomic_roster",
      "reject_population_illegal_units",
      "do_not_merge_recipe_variants",
      "do_not_promote_proxy_score_to_strength",
      "do_not_widen_source_policy",
    ],
    population: population ?? null,
  });
}
