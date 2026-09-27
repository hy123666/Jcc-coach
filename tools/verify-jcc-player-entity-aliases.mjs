import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  decisionInputTextMentionsTerm,
  createDecisionInputCatalog,
  searchDecisionInputCatalog,
} from "../ui/electron/decision-input-catalog.js";
import {
  compactMatchFactCaptureCatalog,
  MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES,
  resolveMatchFactCaptureOperations,
} from "../ui/electron/match-fact-capture.js";
import {
  compileEntityAliasGateway,
  compileGameKnowledge,
} from "./jcc_game_knowledge_compiler.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function names(rows) {
  return rows.map((row) => row.entity.name);
}

function search(catalog, kind, query, itemCategory = null) {
  return searchDecisionInputCatalog(catalog, {
    kind,
    query,
    itemCategory,
    searchScope: "global_search",
    includeUnknownRound: true,
    limit: 12,
  });
}

const result = await compileGameKnowledge({
  repoRoot,
  seasonId: "s18",
  patchId: "s18_1",
  write: false,
});
const catalog = createDecisionInputCatalog(result.decisionInputCatalog);
const audit = result.bundle.entity_alias_gateway?.declared_alias_audit;
assert.equal(audit?.counts?.unbound, 8, "only absent support items and the absent reforger may remain unbound in S18");
assert.deepEqual(
  audit.entries.filter((entry) => entry.status === "unbound_current_core").map((entry) => entry.canonical_name).sort(),
  ["装备重铸器", "基克的先驱", "兰顿之兆", "能量圣杯", "静止法衣", "兹诺特传送门", "钢铁烈阳之闸", "女妖面纱"].sort(),
);

assert.deepEqual(names(search(catalog, "champion", "挖掘机")), ["雷克塞"]);
assert.deepEqual(names(search(catalog, "champion", "蓝buff")), ["苍蓝雕纹魔像", "苍蓝哨戒"]);
assert.deepEqual(names(search(catalog, "champion", "小红")), ["绯红树怪"]);
assert.deepEqual(names(search(catalog, "champion", "小蓝")), ["苍蓝哨戒"]);
assert.deepEqual(names(search(catalog, "champion", "光辉")), ["拉克丝"]);
assert.deepEqual(names(search(catalog, "champion", "小鸡")), ["深红锋喙鸟"]);
assert.equal(search(catalog, "item", "攻速", "components")[0]?.entity?.name, "反曲之弓");
assert.equal(search(catalog, "item", "羊刀", "completed")[0]?.entity?.name, "鬼索的狂暴之刃");
assert.equal(search(catalog, "item", "光明羊刀", "radiant")[0]?.entity?.name, "光明版鬼索的狂暴之刃");
assert.equal(search(catalog, "item", "电刀", "artifacts")[0]?.entity?.name, "斯塔缇克电刃");
assert.equal(
  result.decisionInputCatalog.aliases.some((alias) => alias.evidence_kind === "player_alias" && alias.alias === "斯塔提克电刃"),
  false,
  "the user-corrected typo must not become a declared player alias",
);
assert.equal(search(catalog, "item", "基克", "support").length, 0, "Common aliases must not create absent S18 support entities");
assert.equal(result.decisionInputCatalog.entities.some((entity) => entity.name === "基克的先驱"), false);

const championNames = result.decisionInputCatalog.entities
  .filter((entity) => entity.kind === "champion")
  .map((entity) => entity.name);
const compactCaptureCatalog = compactMatchFactCaptureCatalog(catalog, {
  championNames,
  queryText: "挖掘机穿羊刀",
});
assert(
  compactCaptureCatalog.aliases.some((entry) => entry.kind === "champion" && entry.alias === "挖掘机" && entry.canonical_name === "雷克塞"),
  "Quick Record evidence must include the queried champion alias",
);
assert(
  compactCaptureCatalog.aliases.some((entry) => entry.kind === "item" && entry.alias === "羊刀" && entry.canonical_name === "鬼索的狂暴之刃"),
  "Quick Record evidence must include the queried item alias",
);
assert(
  Buffer.byteLength(JSON.stringify(compactCaptureCatalog)) <= MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES,
  "Quick Record alias evidence must stay within its bounded catalog budget",
);
for (const queryText of ["狼人攻速是多少", "记录狼人攻速", "我有50%攻速", "我有攻速加成"]) {
  const attributeOnlyCatalog = compactMatchFactCaptureCatalog(catalog, { championNames, queryText });
  assert.equal(
    attributeOnlyCatalog.entities.item.some((entry) => entry.name === "反曲之弓"),
    false,
    `attribute-only Quick Record text must not surface equipment: ${queryText}`,
  );
}
const explicitEquipmentCatalog = compactMatchFactCaptureCatalog(catalog, {
  championNames,
  queryText: "我有一个攻速",
});
assert(
  explicitEquipmentCatalog.aliases.some((entry) => entry.kind === "item" && entry.alias === "攻速" && entry.canonical_name === "反曲之弓"),
  "an explicit equipment ownership report must retain the component alias",
);

assert.equal(decisionInputTextMentionsTerm("龙牙适合谁", "龙"), false);
assert.equal(decisionInputTextMentionsTerm("巨龙之爪怎么分配", "龙"), false);
assert.equal(decisionInputTextMentionsTerm("toolsjshelper", "js"), false);
assert.equal(decisionInputTextMentionsTerm("龙", "龙"), true);
assert.equal(decisionInputTextMentionsTerm("js装备", "js"), true);

const emptyPatchAliases = {
  schema: "jcc-patch-player-entity-aliases-v1",
  identity: { season_id: "s-test", patch_id: "s-test_1" },
  entries: [],
};
const wrongCategoryGateway = compileEntityAliasGateway({
  seasonId: "s-test",
  patchId: "s-test_1",
  baseGateway: { lookup: {}, by_kind_and_name: {} },
  champions: [],
  items: [{ id: "item-1", address: "jcc:s-test:item:item-1", name: "测试装备", tags: ["component"] }],
  augments: [],
  traits: [],
  commonAliasDocument: {
    kind: "equipment_player_aliases",
    entries: [{ id: "wrong-category", entity_kind: "item", canonical_name: "测试装备", category: "artifacts", aliases: ["测试别名"] }],
  },
  patchAliasDocument: emptyPatchAliases,
});
assert.equal(wrongCategoryGateway.lookup["item:测试别名"], undefined);
assert.equal(wrongCategoryGateway.declared_alias_audit.entries[0].reason, "category_mismatch");

const wrongRadiantGateway = compileEntityAliasGateway({
  seasonId: "s-test",
  patchId: "s-test_1",
  baseGateway: { lookup: {}, by_kind_and_name: {} },
  champions: [],
  items: [
    { id: "item-1", address: "jcc:s-test:item:item-1", name: "测试成装", tags: [] },
    { id: "item-2", address: "jcc:s-test:item:item-2", name: "光明版测试成装", tags: ["artifact"] },
  ],
  augments: [],
  traits: [],
  commonAliasDocument: {
    kind: "equipment_player_aliases",
    entries: [{ id: "wrong-radiant", entity_kind: "item", canonical_name: "测试成装", category: "completed", aliases: ["测试成装别名"], generate_radiant_aliases: true }],
  },
  patchAliasDocument: emptyPatchAliases,
});
assert.equal(wrongRadiantGateway.lookup["item:光明测试成装别名"], undefined);

assert.throws(() => compileEntityAliasGateway({
  seasonId: "s-test",
  patchId: "s-test_1",
  baseGateway: { lookup: {}, by_kind_and_name: {} },
  champions: [],
  items: [],
  augments: [],
  traits: [],
  commonAliasDocument: { kind: "equipment_player_aliases", entries: [] },
  patchAliasDocument: {
    ...emptyPatchAliases,
    entries: [{ id: "missing", entity_kind: "champion", canonical_id: "404", canonical_name: "不存在", aliases: ["缺失"] }],
  },
}), /must bind one current Core entity/);

assert.throws(() => compileEntityAliasGateway({
  seasonId: "s-test",
  patchId: "s-test_1",
  baseGateway: { lookup: {}, by_kind_and_name: {} },
  champions: [
    { id: "1", address: "jcc:s-test:champion:1", name: "甲" },
    { id: "2", address: "jcc:s-test:champion:2", name: "乙" },
  ],
  items: [],
  augments: [],
  traits: [],
  commonAliasDocument: { kind: "equipment_player_aliases", entries: [] },
  patchAliasDocument: {
    ...emptyPatchAliases,
    entries: [
      { id: "one", entity_kind: "champion", canonical_id: "1", canonical_name: "甲", aliases: ["冲突"] },
      { id: "two", entity_kind: "champion", canonical_id: "2", canonical_name: "乙", aliases: ["冲突"] },
    ],
  },
}), /ambiguous/);
const capture = resolveMatchFactCaptureOperations({
  operations: [{
    op: "assign_equipment",
    champion_name: "挖掘机",
    item_name: "羊刀",
    quantity: 1,
    holder_intent: "unspecified",
  }],
}, {
  catalog,
  championNames,
});
assert.equal(capture.accepted.length, 1);
assert.equal(capture.accepted[0].champion.name, "雷克塞");
assert.equal(capture.accepted[0].item.name, "鬼索的狂暴之刃");
assert.equal(capture.accepted[0].champion.id, "1504");
assert.equal(capture.accepted[0].item.id, "2010");

const decisionCatalogSource = await readFile(path.join(repoRoot, "ui/electron/decision-input-catalog.js"), "utf8");
assert.equal(decisionCatalogSource.includes("SPEECH_ALIAS_SEEDS"), false, "player aliases must be data-owned rather than embedded in JavaScript");

console.log(JSON.stringify({
  ok: true,
  core_profile_id: result.combinedFingerprint,
  alias_audit: audit.counts,
  checked: [
    "Common equipment aliases bind only to current Core entities",
    "S18 champion aliases bind to exact current champion ids",
    "radiant aliases are generated only for existing radiant counterparts",
    "equipment-mode alias search remains kind and category scoped",
    "attribute text does not become Quick Record equipment without an equipment fact context",
    "short aliases do not become unrestricted free-text substring triggers",
    "category mismatches, false radiant counterparts, unbound patch aliases, and ambiguity fail closed",
    "Quick Record receives only the bounded aliases relevant to the spoken fact",
    "canonical ids and names survive alias-based Quick Record resolution",
    "absent support items remain inactive",
    "JavaScript speech alias seeds remain retired",
  ],
}, null, 2));
