import assert from "node:assert/strict";
import { createHostReadonlyToolBroker } from "../ui/electron/host-readonly-tool-broker.js";
import { buildKnowledgeRelationIndex, queryKnowledgeRelationIndex } from "../ui/electron/knowledge-relation-index.js";

const index = buildKnowledgeRelationIndex({
  snapshotId: "snapshot:broker",
  coreProfileId: "core:18.1b",
  core: { champions: [{ id: "champion:zyra", name: "婕拉", traits: ["trait:inferno"] }] },
  wiki: { pages: [{ page_id: "wiki:full", title: "Full page", scope: "cross_season", body_md: "evidence ".repeat(200) }] },
});
const broker = createHostReadonlyToolBroker({
  evidencePacket: {
    evidence_snapshot: { evidence_snapshot_id: "snapshot:broker" },
    plan: { evidence_policy_id: "current_core" },
    coverage: { receipts: [] },
  },
  queryKnowledge: async (args) => queryKnowledgeRelationIndex(index, {
    operation: args.operation,
    entity_names: args.entity_names,
    facets: args.facets,
    limit: args.limit,
    sourcePolicy: "current_core",
  }),
});
const result = await broker.call("jcc.query_knowledge", {
  operation: "get_related_entities",
  entity_names: ["婕拉"],
});
assert.equal(result.schema, "jcc-query-knowledge-result-v2");
assert.equal(result.ok, true);
assert(result.result.relations.some((edge) => edge.relation === "relation.has_trait"));
assert.equal(result.evidence_snapshot_id, "snapshot:broker");
const wiki = await broker.call("jcc.query_knowledge", { operation: "get_strategy_wiki", entity_names: ["wiki:full"] });
assert.equal(wiki.result.entities[0].details.body_md, "evidence ".repeat(200), "explicit Wiki retrieval preserves full selected page content");
console.log(JSON.stringify({ ok: true, schema: "jcc-knowledge-broker-integration-verification-v1" }));
