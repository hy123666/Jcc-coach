const TIER_ORDER = ["silver", "gold", "prismatic"];

function normalizeTier(value) {
  const normalized = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  const aliases = new Map([
    ["1", "silver"], ["silver", "silver"], ["\u94f6", "silver"], ["\u94f6\u8272", "silver"],
    ["2", "gold"], ["gold", "gold"], ["\u91d1", "gold"], ["\u91d1\u8272", "gold"],
    ["3", "prismatic"], ["prismatic", "prismatic"], ["\u5f69", "prismatic"],
    ["\u5f69\u8272", "prismatic"], ["\u68f1\u5f69", "prismatic"],
  ]);
  return aliases.get(normalized) || null;
}

function choiceTier(choice) {
  return normalizeTier(
    choice?.tier_color
      ?? choice?.tier
      ?? choice?.rarity
      ?? choice?.selected_tier
      ?? choice?.selected_candidate_metadata?.tier_color
      ?? choice?.selected_candidate_metadata?.tier,
  );
}

function choiceRound(choice) {
  return String(choice?.stage_round ?? choice?.choice_stage_round ?? choice?.target_stage_round ?? "").trim();
}

function distribution(entries) {
  const total = entries.reduce((sum, entry) => sum + Number(entry.probability_pct || 0), 0);
  if (!(total > 0)) return [];
  const aggregated = new Map();
  for (const entry of entries) {
    const tier = normalizeTier(entry.tier);
    if (tier) aggregated.set(tier, (aggregated.get(tier) || 0) + Number(entry.probability_pct || 0));
  }
  return TIER_ORDER.filter((tier) => aggregated.has(tier)).map((tier) => ({
    tier,
    probability_pct: Math.round((aggregated.get(tier) / total) * 1000) / 10,
  }));
}

export function nextAugmentTierForecast(table, confirmedChoices = []) {
  if (!table || !Array.isArray(table.rows)) return null;
  const order = ["2-1", "3-2", "4-2"];
  const relevantChoices = confirmedChoices
    .filter((choice) => order.includes(choiceRound(choice)))
    .filter((choice) => !choice?.kind || /augment|\u5f3a\u5316|\u6d77\u514b\u65af/iu.test(String(choice.kind)))
    .map((choice) => ({ stage_round: choiceRound(choice), tier: choiceTier(choice) }));
  if (relevantChoices.some((choice) => !choice.tier)) return null;
  const choices = relevantChoices
    .sort((left, right) => order.indexOf(left.stage_round) - order.indexOf(right.stage_round));

  if (choices.length === 0) {
    const tiers = (table.first_choice_tier_distribution?.tiers || []).map((entry) => ({
      tier: normalizeTier(entry.tier),
      probability_pct: Number(entry.display_probability_pct),
    })).filter((entry) => entry.tier && Number.isFinite(entry.probability_pct));
    return tiers.length ? {
      schema: "jcc-next-augment-tier-forecast-v1",
      next_choice_round: "2-1",
      conditioned_on: [],
      tiers,
      semantics: "approximate_probability_from_current_core_table",
    } : null;
  }

  const first = choices.find((choice) => choice.stage_round === "2-1");
  if (!first) return null;
  const second = choices.find((choice) => choice.stage_round === "3-2");
  if (!second) {
    const tiers = distribution(table.rows
      .filter((row) => normalizeTier(row.first_choice_tier) === first.tier)
      .map((row) => ({ tier: row.second_choice_tier, probability_pct: row.probability_pct })));
    return tiers.length ? {
      schema: "jcc-next-augment-tier-forecast-v1",
      next_choice_round: "3-2",
      conditioned_on: [{ stage_round: "2-1", tier: first.tier }],
      tiers,
      semantics: "conditional_probability_from_current_core_table",
    } : null;
  }

  if (choices.some((choice) => choice.stage_round === "4-2")) return null;
  const tiers = distribution(table.rows
    .filter((row) => normalizeTier(row.first_choice_tier) === first.tier
      && normalizeTier(row.second_choice_tier) === second.tier)
    .map((row) => ({ tier: row.third_choice_tier, probability_pct: row.probability_pct })));
  return tiers.length ? {
    schema: "jcc-next-augment-tier-forecast-v1",
    next_choice_round: "4-2",
    conditioned_on: [
      { stage_round: "2-1", tier: first.tier },
      { stage_round: "3-2", tier: second.tier },
    ],
    tiers,
    semantics: "conditional_probability_from_current_core_table",
  } : null;
}
