import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("data/core-patches/tft-lab/set17-17.4");
const RULES_DIR = path.join(ROOT, "rules");
const REFERENCE_DIR = path.join(ROOT, "reference");

function source(slug, extra = {}) {
  return {
    source: "tft_lab",
    set: 17,
    patch: "17.4",
    url: `https://tft-lab.com/en/handbook/${slug}`,
    fetchedPackage: ROOT,
    confidence: "high_reference",
    ...extra,
  };
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function text(slug, locale = "en") {
  try {
    return await readFile(path.join(ROOT, "extracted", "text", `${locale}_${slug}.txt`), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

function lines(value) {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildShop() {
  return {
    ...source("shop", {
      jccUsage:
        "Use as TFT Set 17 system rule reference. Does not override JCC official champion stats or entity lists.",
    }),
    refreshCostGold: 2,
    slotsPerShop: 5,
    slotRollMode: "independent",
    oddsByLevel: [
      { level: 2, cost1: 100, cost2: 0, cost3: 0, cost4: 0, cost5: 0 },
      { level: 3, cost1: 75, cost2: 25, cost3: 0, cost4: 0, cost5: 0 },
      { level: 4, cost1: 55, cost2: 30, cost3: 15, cost4: 0, cost5: 0 },
      { level: 5, cost1: 45, cost2: 33, cost3: 20, cost4: 2, cost5: 0 },
      { level: 6, cost1: 30, cost2: 40, cost3: 25, cost4: 5, cost5: 0 },
      { level: 7, cost1: 19, cost2: 30, cost3: 40, cost4: 10, cost5: 1 },
      { level: 8, cost1: 15, cost2: 20, cost3: 32, cost4: 30, cost5: 3 },
      { level: 9, cost1: 10, cost2: 17, cost3: 25, cost4: 33, cost5: 15 },
      { level: 10, cost1: 5, cost2: 10, cost3: 20, cost4: 40, cost5: 25 },
    ],
    poolByCost: [
      { cost: 1, variety: 14, copiesPerChampion: 30, totalCopies: 420 },
      { cost: 2, variety: 13, copiesPerChampion: 25, totalCopies: 325 },
      { cost: 3, variety: 13, copiesPerChampion: 18, totalCopies: 234 },
      { cost: 4, variety: 13, copiesPerChampion: 10, totalCopies: 130 },
      { cost: 5, variety: 10, copiesPerChampion: 9, totalCopies: 90 },
    ],
    rules: [
      "Each refresh costs 2 gold.",
      "Each shop slot rolls independently using the level-specific table.",
      "Lock the shop to keep it into the next round.",
      "Selling a unit returns its copies to the shared pool.",
      "1-cost units refund full price by star. Higher costs lose 1 gold per sale: 2-star = cost * 3 - 1, 3-star = cost * 9 - 1.",
    ],
  };
}

function buildGold() {
  return {
    ...source("gold"),
    roundIncome: [
      { round: "1-2", gold: 2 },
      { round: "1-3", gold: 2 },
      { round: "1-4", gold: 3 },
      { round: "2-1", gold: 4 },
      { round: "2-2+", gold: 5 },
    ],
    interest: [
      { minGold: 0, maxGold: 9, gold: 0 },
      { minGold: 10, maxGold: 19, gold: 1 },
      { minGold: 20, maxGold: 29, gold: 2 },
      { minGold: 30, maxGold: 39, gold: 3 },
      { minGold: 40, maxGold: 49, gold: 4 },
      { minGold: 50, maxGold: null, gold: 5 },
    ],
    streakBonus: [
      { streak: 2, gold: 1 },
      { streak: 3, gold: 1 },
      { streak: 4, gold: 1 },
      { streak: 5, gold: 2 },
      { streak: "6+", gold: 3 },
    ],
    pvpCombatGold: {
      win: 1,
      loss: 0,
    },
  };
}

function buildXp() {
  return {
    ...source("xp"),
    startingLevel: 2,
    maxLevel: 10,
    freeXpPerRound: 2,
    buyXp: {
      goldCost: 4,
      xpGain: 4,
    },
    overflowCarries: true,
    levelCurve: [
      { from: 2, to: 3, xpToNext: 2, cumulativeXp: 2, buyUpCostGold: 0 },
      { from: 3, to: 4, xpToNext: 6, cumulativeXp: 8, buyUpCostGold: 4 },
      { from: 4, to: 5, xpToNext: 10, cumulativeXp: 18, buyUpCostGold: 8 },
      { from: 5, to: 6, xpToNext: 20, cumulativeXp: 38, buyUpCostGold: 20 },
      { from: 6, to: 7, xpToNext: 36, cumulativeXp: 74, buyUpCostGold: 36 },
      { from: 7, to: 8, xpToNext: 60, cumulativeXp: 134, buyUpCostGold: 60 },
      { from: 8, to: 9, xpToNext: 68, cumulativeXp: 202, buyUpCostGold: 68 },
      { from: 9, to: 10, xpToNext: 68, cumulativeXp: 270, buyUpCostGold: 68 },
    ],
  };
}

function buildRounds() {
  const stages = [
    {
      stage: 1,
      pvpLossStageDamage: 0,
      damageFormula: null,
      rounds: [
        { round: "1-1", type: "gods", note: "Lobby gods reveal" },
        { round: "1-2", type: "pve", note: "Minions" },
        { round: "1-3", type: "pve", note: "Minions" },
        { round: "1-4", type: "pve", note: "Minions" },
      ],
    },
    {
      stage: 2,
      pvpLossStageDamage: 2,
      rounds: [
        { round: "2-1", type: "augment", note: "1st augment" },
        { round: "2-2", type: "pvp" },
        { round: "2-3", type: "pvp" },
        { round: "2-4", type: "carousel", note: "Mid carousel" },
        { round: "2-5", type: "pvp" },
        { round: "2-6", type: "pvp" },
        { round: "2-7", type: "pve", note: "Krugs / minions PvE" },
      ],
    },
    {
      stage: 3,
      pvpLossStageDamage: 3,
      rounds: [
        { round: "3-1", type: "pvp" },
        { round: "3-2", type: "augment", note: "2nd augment" },
        { round: "3-3", type: "pvp" },
        { round: "3-4", type: "carousel" },
        { round: "3-5", type: "pvp" },
        { round: "3-6", type: "pvp" },
        { round: "3-7", type: "pve", note: "Wolves / Raptors PvE" },
      ],
    },
    {
      stage: 4,
      pvpLossStageDamage: 4,
      rounds: [
        { round: "4-1", type: "pvp" },
        { round: "4-2", type: "augment", note: "3rd augment" },
        { round: "4-3", type: "pvp" },
        { round: "4-4", type: "carousel" },
        { round: "4-5", type: "pvp" },
        { round: "4-6", type: "pvp" },
        { round: "4-7", type: "boon", note: "God Boon" },
      ],
    },
    {
      stage: 5,
      pvpLossStageDamage: 6,
      rounds: [
        { round: "5-1", type: "pvp" },
        { round: "5-2", type: "pvp" },
        { round: "5-3", type: "pvp" },
        { round: "5-4", type: "carousel" },
        { round: "5-5", type: "pvp" },
        { round: "5-6", type: "pvp" },
        { round: "5-7", type: "pve", note: "Boss PvE" },
      ],
    },
    {
      stage: 6,
      pvpLossStageDamage: 8,
      rounds: [
        { round: "6-1", type: "pvp" },
        { round: "6-2", type: "pvp" },
        { round: "6-3", type: "pvp" },
        { round: "6-4", type: "carousel" },
        { round: "6-5", type: "pvp" },
        { round: "6-6", type: "pvp" },
        { round: "6-7", type: "pve", note: "Boss PvE" },
      ],
    },
    {
      stage: 7,
      pvpLossStageDamage: 10,
      rounds: [
        { round: "7-1", type: "pvp" },
        { round: "7-2", type: "pvp" },
        { round: "7-3", type: "pvp" },
        { round: "7-4", type: "carousel" },
        { round: "7-5", type: "pvp" },
        { round: "7-6", type: "pvp" },
        { round: "7-7", type: "pve", note: "Boss PvE" },
      ],
    },
  ];
  return {
    ...source("rounds"),
    pvpLossDamageFormula: "stage_value + alive_enemy_units",
    nonDamageRoundTypes: ["pve", "augment", "carousel", "boon", "gods"],
    stages,
  };
}

function buildCombatDamageCalculator() {
  return {
    ...source("damage", {
      scope: "combat damage calculator, not player HP loss. Player HP loss is in rules/rounds.json.",
    }),
    inputs: {
      attacker: ["damage_type", "base_damage", "bonus_damage_pct", "flat_pen", "pct_pen", "crit_chance", "crit_multiplier"],
      defender: ["armor", "magic_resist", "durability_pct", "shield", "health"],
    },
    formulas: {
      rawDamage: "base_damage * (1 + bonus_damage_pct / 100)",
      effectiveResist: "max(0, resist * (1 - pct_pen / 100) - flat_pen)",
      mitigationMultiplier: "100 / (100 + effective_resist)",
      durabilityMultiplier: "1 - durability_pct / 100",
      nonCritDamage: "raw_damage * mitigation_multiplier * durability_multiplier",
      critDamage: "raw_damage * (crit_multiplier / 100) * mitigation_multiplier * durability_multiplier",
      expectedDamage:
        "non_crit_damage * (1 - crit_chance / 100) + crit_damage * (crit_chance / 100)",
      trueDamage: "raw_damage; ignores armor, magic resist, and durability according to TFT Lab calculator text.",
    },
  };
}

function buildEncounters() {
  return {
    ...source("encounters"),
    counts: {
      newThisPatch: 5,
      active: 20,
      removedIn17_2: 4,
    },
    new: [
      { id: "cheaper_levels", name: "Cheaper Levels", effect: "Each level costs 2 XP less." },
      { id: "reroll_start", name: "Reroll Start", effect: "Gain 8 free rerolls on 2-1." },
      {
        id: "stage3_augments",
        name: "Stage Three Augments",
        effect: "Augments roll on 3-1, 3-2 and 3-3 instead of the usual rounds.",
      },
      { id: "artifact_anvil", name: "Artifact Anvil", effect: "All players gain an Artifact Anvil on 3-3." },
      {
        id: "double_duplicators",
        name: "Double Duplicators",
        effect: "Receive a Lesser Champion Duplicator immediately and another on 3-3.",
      },
    ],
    returning: [
      { id: "golden_gala", name: "Golden Gala", effect: "All three augment rounds offer Gold-tier augments." },
      { id: "prismatic_party", name: "Prismatic Party", effect: "All three augment rounds offer Prismatic-tier augments." },
      { id: "prismatic_finale", name: "Prismatic Finale", effect: "The last augment round is guaranteed Prismatic." },
      { id: "prismatic_opener", name: "Prismatic Opener", effect: "The first augment round is guaranteed Prismatic." },
      { id: "three_cost_start", name: "3-cost Start", effect: "Begin with a free 3-cost champion." },
      { id: "two_cost_start", name: "2-cost Start", effect: "Begin with a free 2-cost champion." },
      { id: "upgraded_start", name: "Upgraded Start", effect: "Your starting champion arrives at 2-star." },
      {
        id: "component_anvils",
        name: "Component Anvils",
        effect: "PvE rounds drop Component Anvils in place of some component rewards.",
      },
      {
        id: "loot_subscription",
        name: "Loot Subscription",
        effect: "Steady stream of loot; 17.2 reduced both gold reward and Spatula odds.",
      },
      { id: "emblem_ensemble", name: "Emblem Ensemble", effect: "Receive a curated emblem at a fixed round." },
      {
        id: "gold_subscription",
        name: "Gold Subscription",
        effect: "Bonus gold each turn for the duration of the subscription; 17.2 reduced the per-turn gold.",
      },
      { id: "no_encounter", name: "No Encounter", effect: "Standard lobby; no opening encounter applied." },
      { id: "howling_abyss", name: "Howling Abyss", effect: "Howling Abyss-themed encounter." },
      { id: "silver_scrapes", name: "Silver Scrapes", effect: "Combat-themed encounter." },
      { id: "scouting_party", name: "Scouting Party", effect: "Bench expanded so you can scout more shop options." },
    ],
    removed: [
      { id: "augment_round_swap", name: "Augment Round Swap", effect: "Augments rolled on shifted rounds; removed in 17.2." },
      { id: "gwens_gifts", name: "Gwen's Gifts", effect: "Time-limited buff packets through the early game; removed in 17.2." },
      { id: "reckoner_arena", name: "Reckoner Arena", effect: "Combat arena with custom hex layout; removed in 17.2." },
      { id: "scuttle_puddle", name: "Scuttle Puddle", effect: "Stage-2 PvE replaced with a Scuttle minion encounter; removed in 17.2." },
    ],
  };
}

function buildGods() {
  return {
    ...source("gods", {
      jccUsage:
        "Use for system-rule interpretation and cross-checking. JCC official godreward.json remains the authoritative Chinese entity source.",
    }),
    selection: {
      lateGameBoonRound: "4-7",
      stageRewards: ["Stage 2", "Stage 3", "Stage 4"],
    },
    gods: [
      {
        id: "ahri",
        name: "Ahri",
        title: "God of Love",
        boon: "Each round, gain +2 gold, +2 XP and 2 free rerolls.",
        modifierTags: ["gold_income", "xp_income", "free_reroll"],
      },
      {
        id: "aurelion_sol",
        name: "Aurelion Sol",
        title: "God of Wonders",
        boon: "Choose one of three trials to prove yourself to Aurelion Sol.",
        modifierTags: ["quest", "trial", "choice"],
      },
      {
        id: "ekko",
        name: "Ekko",
        title: "God of Time",
        boon: "Gain the Anomaly item; units evolve based on their role.",
        modifierTags: ["item_grant", "role_scaling"],
      },
      {
        id: "evelynn",
        name: "Evelynn",
        title: "God of Temptation",
        boon: "Team gains 10% Durability. Lose +1 player health per combat loss.",
        modifierTags: ["durability", "loss_penalty"],
      },
      {
        id: "kayle",
        name: "Kayle",
        title: "God of Order",
        boon: "Upgrade a random completed item to Radiant.",
        modifierTags: ["item_upgrade", "radiant_item"],
      },
      {
        id: "soraka",
        name: "Soraka",
        title: "God of Stars",
        boon: "Team gains +2 HP per missing Tactician health. +1 current/max HP each round.",
        modifierTags: ["missing_health_scaling", "hp_income"],
      },
      {
        id: "thresh",
        name: "Thresh",
        title: "God of Pacts",
        boon: "After each PvP combat, roll a die. Get a bonus based on the roll.",
        modifierTags: ["post_combat_random_reward"],
      },
      {
        id: "varus",
        name: "Varus",
        title: "God of the Abyss",
        boon: "Team gains 10 HP per total star level. 5-cost shop odds +4%.",
        modifierTags: ["team_star_scaling", "shop_odds_modifier"],
        ruleModifiers: [{ target: "shop.odds.cost5", operation: "add_percent_points", value: 4 }],
      },
      {
        id: "yasuo",
        name: "Yasuo",
        title: "God of Opulence",
        boon: "Increase Yasuo hex power by 50%. With only 2 hexes active, gain 12 gold.",
        modifierTags: ["hex_power", "gold_condition"],
      },
    ],
    rawTextFile: path.join(ROOT, "extracted", "text", "en_gods.txt"),
  };
}

async function buildGlossary() {
  const glossaryText = await text("glossary");
  const entries = [];
  const known = [
    ["Fast 8", "Reach level 8 quickly, usually around 4-2 or 4-5, to roll for 4-cost carries."],
    ["Slow roll", "Stay at a level and roll excess gold above interest thresholds for upgrades."],
    ["Hyper roll", "Spend aggressively on rerolls to hit low-cost 3-star units early."],
    ["Donkey roll", "Roll every round with little or no economy, usually when stabilizing or near elimination."],
    ["Open fort", "Intentionally play weak boards to lose streak and maximize economy or priority."],
    ["Board strength", "How strong the current fielded board is relative to lobby state."],
    ["Tempo", "Playing for immediate strength and pressure instead of maximizing long-term economy."],
    ["Greed", "Delay spending resources for a stronger later payoff."],
    ["Stabilize", "Spend gold or items to stop bleeding HP and reach a survivable board state."],
    ["Pivot", "Change the intended composition or carry line based on items, augments, shops, or lobby."],
    ["Best In Slot", "Optimal item set for a champion."],
    ["Carousel", "Shared selection round where players pick a unit and item."],
    ["Augment", "Persistent in-game perk chosen at augment rounds."],
    ["Emblem", "Special item that grants the wearer an extra trait."],
    ["Artifact", "Non-craftable special item from anvils or other rewards."],
    ["Prismatic", "Highest augment tier."],
    ["AoE", "Area of Effect damage."],
    ["CC", "Crowd Control such as stun, silence, taunt, or root."],
    ["DPS", "Damage Per Second."],
  ];
  for (const [term, desc] of known) entries.push({ term, desc });
  return {
    ...source("glossary"),
    entries,
    rawTextFile: path.join(ROOT, "extracted", "text", "en_glossary.txt"),
    note: "Known tactical terms are seeded for runtime use; raw page contains the fuller TFT Lab glossary snapshot.",
    rawLineCount: lines(glossaryText).length,
  };
}

function buildEntityReferencePolicy() {
  return {
    ...source("season", {
      scope: "reference policy for TFT Lab entity pages",
    }),
    entityPagesCaptured: ["champions", "traits", "items", "augments"],
    policy: [
      "Do not use TFT Lab champion base stats as JCC authoritative values.",
      "Use TFT Lab entity pages for terminology, alternate English names, category labels, and cross-checking only.",
      "JCC official data under data/core-patches/jcc remains authoritative for champion stats, skills, item text, trait text, augments, and god rewards.",
      "If a TFT Lab rule references an entity, map it to JCC official entity IDs before use in runtime decisions.",
    ],
  };
}

async function main() {
  await Promise.all([ensureDir(RULES_DIR), ensureDir(REFERENCE_DIR)]);

  const ruleFiles = {
    "shop.json": buildShop(),
    "gold.json": buildGold(),
    "xp.json": buildXp(),
    "rounds.json": buildRounds(),
    "combat_damage_calculator.json": buildCombatDamageCalculator(),
    "encounters.json": buildEncounters(),
    "glossary.json": await buildGlossary(),
  };

  for (const [file, data] of Object.entries(ruleFiles)) {
    await writeJson(path.join(RULES_DIR, file), data);
    console.log(`wrote rules/${file}`);
  }

  await writeJson(path.join(ROOT, "manifest.json"), {
    source: {
      site: "https://tft-lab.com",
      handbook: "https://tft-lab.com/en/handbook",
      set: 17,
      patch: "17.4",
    },
    runtimeScope: [
      "opening encounters",
      "shop refresh rules",
      "round/stage schedule",
      "gold economy",
      "XP curve",
      "combat damage calculator formulas",
      "gameplay/tactical glossary",
    ],
    excludedFromRuntimeScope: [
      "champion/entity stats",
      "traits",
      "items",
      "augments",
      "gods/god rewards",
      "comp database",
    ],
    authorityPolicy: {
      jccOfficial:
        "Authoritative for champions, stats, skills, traits, items, augments, gods/god rewards, and per-match entity variants.",
      tftLab:
        "Authoritative reference for shared TFT system rules listed in runtimeScope, unless a JCC override is later verified.",
    },
    notes: [
      "Raw TFT Lab pages/chunks are intentionally not kept in the runtime package. Re-run tools/scrape-tft-lab.mjs only when source audit is needed.",
      "Chinese and English TFT Lab text can differ; preserve English rules as primary and add JCC/Chinese overrides only after checking.",
    ],
  });

  await writeJson(path.join(ROOT, "reference-manifest.json"), {
    builtAt: new Date().toISOString(),
    package: ROOT,
    rules: Object.keys(ruleFiles).map((file) => `rules/${file}`),
    reference: [],
  });
  console.log(`wrote ${path.join(ROOT, "reference-manifest.json")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
