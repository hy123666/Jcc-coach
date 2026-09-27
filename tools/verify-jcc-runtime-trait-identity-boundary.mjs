import assert from "node:assert/strict";
import {
  currentCoreTraitIdentity,
  readableTraitEntry,
} from "../ui/electron/runtime-service.js";

const currentCoreTraits = {
  "458": { id: "458", name: "地狱火" },
  "847001": { id: "847001", name: "未来赛季合法长 ID" },
};

assert.equal(currentCoreTraitIdentity("458", currentCoreTraits), "458");
assert.equal(currentCoreTraitIdentity("847001", currentCoreTraits), "847001",
  "a future Core may legitimately own a longer trait id");
assert.equal(currentCoreTraitIdentity("847001", { "458": currentCoreTraits["458"] }), "",
  "an upstream raw family id absent from current Core must not become semantic identity");

const unresolvedRawEntry = readableTraitEntry({
  trait_id: "847001",
  hero_num: 3,
  display_name: "待解析羁绊847001:3",
});
assert.equal(unresolvedRawEntry.trait_id, undefined);
assert.equal(unresolvedRawEntry.canonical_trait_id, undefined);
assert.equal(unresolvedRawEntry.display_name, "未知羁绊3");
assert.equal(JSON.stringify(unresolvedRawEntry).includes("847001"), false,
  "raw source ids must not leak into Host-visible fallback labels");

const resolvedCanonicalEntry = readableTraitEntry({
  canonical_trait_id: "458",
  trait_name: "地狱火",
  hero_num: 3,
});
assert.equal(resolvedCanonicalEntry.canonical_trait_id, "458");
assert.equal(resolvedCanonicalEntry.display_name, "地狱火3");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-runtime-trait-identity-boundary-verification-v1",
}, null, 2));
