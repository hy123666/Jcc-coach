import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compactMatureRecipeVariantPacket } from "./jcc_mature_recipe_variant_packet.mjs";

const variants = Array.from({ length: 8 }, (_, index) => ({ recipe_id: `recipe-${index + 1}` }));
const capped = compactMatureRecipeVariantPacket({
  variants,
  receipt: {
    schema: "jcc-mature-recipe-variant-set-v1",
    source_count: variants.length,
    retained_count: variants.length,
    truncated: false,
    evidence_boundary: "fixture_boundary",
  },
  limit: 6,
});

assert.deepEqual(capped.mature_recipe_variants, variants.slice(0, 6));
assert.equal(capped.mature_recipe_variant_receipt.source_count, 8);
assert.equal(capped.mature_recipe_variant_receipt.retained_count, 6);
assert.equal(capped.mature_recipe_variant_receipt.truncated, true);
assert.equal(capped.mature_recipe_variant_receipt.evidence_boundary, "fixture_boundary");

const recapped = compactMatureRecipeVariantPacket({
  variants: capped.mature_recipe_variants,
  receipt: capped.mature_recipe_variant_receipt,
  limit: 4,
});

assert.deepEqual(recapped.mature_recipe_variants, variants.slice(0, 4));
assert.equal(recapped.mature_recipe_variant_receipt.source_count, 8);
assert.equal(recapped.mature_recipe_variant_receipt.retained_count, 4);
assert.equal(recapped.mature_recipe_variant_receipt.truncated, true);

const uncapped = compactMatureRecipeVariantPacket({ variants: variants.slice(0, 3), limit: 6 });
assert.equal(uncapped.mature_recipe_variant_receipt.source_count, 3);
assert.equal(uncapped.mature_recipe_variant_receipt.retained_count, 3);
assert.equal(uncapped.mature_recipe_variant_receipt.truncated, false);

const empty = compactMatureRecipeVariantPacket();
assert.deepEqual(empty.mature_recipe_variants, []);
assert.equal(empty.mature_recipe_variant_receipt, null);

assert.throws(
  () => compactMatureRecipeVariantPacket({ variants, limit: -1 }),
  /non-negative integer/,
);

const pipelineSource = await readFile(
  path.resolve(import.meta.dirname, "run-jcc-cruise-runtime-pipeline.mjs"),
  "utf8",
);
assert.match(
  pipelineSource,
  /import \{ compactMatureRecipeVariantPacket \} from "\.\/jcc_mature_recipe_variant_packet\.mjs";/,
);
assert.equal(
  pipelineSource.match(/compactMatureRecipeVariantPacket\(\{/g)?.length,
  2,
  "candidate and nested variant packet boundaries must share the mature recipe compactor",
);
assert.doesNotMatch(
  pipelineSource,
  /mature_recipe_variants[^\n]*\.slice\(/,
  "mature recipe caps must not bypass receipt recomputation",
);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-mature-recipe-variant-packet-verification-v1",
  capped_receipt: capped.mature_recipe_variant_receipt,
  recapped_receipt: recapped.mature_recipe_variant_receipt,
  uncapped_receipt: uncapped.mature_recipe_variant_receipt,
}, null, 2));
