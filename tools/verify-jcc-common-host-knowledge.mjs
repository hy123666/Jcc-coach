import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  commonHostKnowledgeForStaticCapsule,
  queryCommonHostKnowledge,
} from "../ui/electron/runtime-service.js";

const candidate = JSON.parse(await readFile("data/game-knowledge/jcc/candidates/candidate-profile.json", "utf8"));
const bundle = JSON.parse(await readFile(`data/game-knowledge/jcc/${candidate.bundle_path}`, "utf8"));
const common = commonHostKnowledgeForStaticCapsule(bundle);

assert.equal(common?.schema, "jcc-common-host-knowledge-v1");
assert.equal(common.logical_id, "COMMON_HOST_KNOWLEDGE");
assert.equal(common.sections.length, Object.keys(bundle.common).length,
  "every canonical Common document with decision entries must be represented");

const sourceBodies = Object.values(bundle.common).flatMap((document) => document.entries || [])
  .map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => ![
    "schema", "logical_id", "scope", "kind", "season_neutral", "entity_references",
  ].includes(key))));
const uniqueSourceBodies = new Set(sourceBodies.map((entry) => JSON.stringify(entry)));
const renderedBodies = common.sections.flatMap((section) => section.entries);
assert.equal(renderedBodies.length, uniqueSourceBodies.size,
  "the Host view must preserve every unique decision fact exactly once");
assert.equal(new Set(renderedBodies.map((entry) => JSON.stringify(entry))).size, renderedBodies.length,
  "the Host view must not repeat identical decision facts");
assert(!JSON.stringify(common).includes('"entity_references"'),
  "machine association metadata must not enter the Agent-readable Common view");

const reroll = queryCommonHostKnowledge(bundle, { question: "三费追三什么时候上八继续追" });
assert.equal(reroll.status, "ok");
assert.equal(reroll.completeness, "matching_complete_sections");
assert(reroll.sections.some((section) => JSON.stringify(section).includes("three_cost_reroll")),
  "natural-language Common recovery must return the complete reroll doctrine section");

const full = queryCommonHostKnowledge(bundle, {});
assert.equal(full.status, "ok");
assert.equal(full.sections.length, common.sections.length);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-common-host-knowledge-verification-v1",
  source_document_count: Object.keys(bundle.common).length,
  section_count: common.sections.length,
  unique_decision_fact_count: renderedBodies.length,
}));
