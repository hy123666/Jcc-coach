import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildStrategyTables } from "./build-jcc-strategy-tables.mjs";

const CATALOG_FILE = path.resolve(
  import.meta.dirname,
  "..",
  "data",
  "runtime",
  "jcc",
  "resource-policy-modifier-catalog.json",
);

const XP_COMPAT_FILE = path.resolve(
  import.meta.dirname,
  "..",
  "data",
  "runtime",
  "jcc",
  "xp-policy-modifier-catalog.json",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function assertArray(value, message) {
  assert(Array.isArray(value), message);
  assert(value.length > 0, `${message} should not be empty`);
}

function verifyRows(rows, catalog, promotionState) {
  const domains = new Set(catalog.resource_domains || []);
  const effectClasses = new Set(catalog.taxonomy.effect_classes || []);
  const knownPolicyFields = new Set(catalog.taxonomy.known_policy_fields || []);
  for (const row of rows) {
    assert(row.key && typeof row.key === "string", `${promotionState} row missing key`);
    assert(row.kind && typeof row.kind === "string", `${row.key} missing kind`);
    assertArray(row.resource_domains, `${row.key} missing resource_domains`);
    assertArray(row.match, `${row.key} missing match aliases`);
    assertArray(row.effect_classes, `${row.key} missing effect_classes`);
    assertArray(row.trigger_timing, `${row.key} missing trigger_timing`);
    assertArray(row.runtime_consumers, `${row.key} missing runtime_consumers`);
    assert(row.mutation_scope === "match_session", `${row.key} mutation_scope must be match_session`);
    assert(row.promotion_state === promotionState, `${row.key} promotion_state mismatch`);
    assert(row.classification?.primary_domain, `${row.key} missing classification primary_domain`);

    for (const domain of row.resource_domains) {
      assert(domains.has(domain), `${row.key} has unknown resource domain ${domain}`);
    }
    for (const effectClass of row.effect_classes) {
      assert(effectClasses.has(effectClass), `${row.key} has unknown effect class ${effectClass}`);
    }
    for (const field of Object.keys(row.patch || {})) {
      assert(knownPolicyFields.has(field), `${row.key} has unknown policy patch field ${field}`);
    }
    if (promotionState === "pending") {
      assert(Object.keys(row.patch || {}).length === 0, `${row.key} pending row must fail closed with empty patch`);
    }
    if (promotionState === "confirmed") {
      assert(row.confidence === "high_hard_data", `${row.key} confirmed row should be high_hard_data`);
      assert(row.source && typeof row.source === "string", `${row.key} confirmed row needs source`);
    }
  }
}

async function main() {
  const catalog = await readJson(CATALOG_FILE);
  const xpCompat = await readJson(XP_COMPAT_FILE);
  assert(catalog.schema === "jcc-resource-policy-modifier-catalog-v1", "resource catalog schema mismatch");
  assert(catalog.source_policy?.xp_policy_is_a_view_of_resource_policy === true, "XP policy must be a derived view");
  assertArray(catalog.resource_domains, "resource_domains");
  assert(catalog.taxonomy, "catalog missing taxonomy");
  assert(catalog.taxonomy.promotion_rules?.pending_rows_do_not_mutate_policy === true, "pending rows must fail closed");
  assert(catalog.taxonomy.promotion_rules?.xp_policy_is_derived_view_not_separate_source === true, "taxonomy must mark XP as derived");
  for (const domain of catalog.resource_domains) {
    assertArray(catalog.taxonomy.resource_domains?.[domain], `taxonomy.resource_domains.${domain}`);
  }

  verifyRows(catalog.confirmed_modifiers || [], catalog, "confirmed");
  verifyRows(catalog.pending_confirmation || [], catalog, "pending");

  assert(xpCompat.source_catalog === "data/runtime/jcc/resource-policy-modifier-catalog.json", "XP compat catalog should point at resource catalog");
  assert(xpCompat.deprecated_direct_xp_rows === true, "XP compat catalog should mark direct rows deprecated");

  const tables = buildStrategyTables();
  const pollutedOverrideTables = buildStrategyTables({
    xp_modifier_catalog: [
      { key: "legacy_no_domain", match: ["level up"], patch: { manual_xp_per_click_delta: 99 } },
      { key: "pending_direct_xp", promotion_state: "pending", resource_domains: ["xp"], match: ["pending"], patch: { manual_xp_per_click_delta: 99 } },
      { key: "confirmed_gold_only", promotion_state: "confirmed", resource_domains: ["gold"], match: ["gold"], patch: { manual_xp_per_click_delta: 99 } },
      { key: "confirmed_xp_override", promotion_state: "confirmed", resource_domains: ["xp"], match: ["safe"], patch: { manual_xp_per_click_delta: 1 } },
    ],
  });
  assert(tables.resource_modifier_catalog?.taxonomy, "strategy tables should expose resource taxonomy");
  assert(tables.resource_policy_index?.row_count === (catalog.confirmed_modifiers.length + catalog.pending_confirmation.length), "strategy tables resource row count mismatch");
  assert(tables.xp_modifier_catalog.every((row) => row.resource_domains?.includes("xp")), "XP view should only include XP-domain rows");
  assert(!tables.xp_modifier_catalog.some((row) => row.key === "level_up" && !row.source), "legacy hard-coded XP fallback should not leak into XP view");
  assert(!pollutedOverrideTables.xp_modifier_catalog.some((row) => row.key === "legacy_no_domain"), "legacy no-domain override must not enter XP view");
  assert(!pollutedOverrideTables.xp_modifier_catalog.some((row) => row.key === "pending_direct_xp"), "pending override must not enter XP view");
  assert(!pollutedOverrideTables.xp_modifier_catalog.some((row) => row.key === "confirmed_gold_only"), "non-XP override must not enter XP view");
  assert(pollutedOverrideTables.xp_modifier_catalog.some((row) => row.key === "confirmed_xp_override"), "confirmed XP override should remain available for tests/explicit compatibility");

  const output = {
    ok: true,
    checked: {
      schema: catalog.schema,
      domains: catalog.resource_domains.length,
      confirmed: catalog.confirmed_modifiers.length,
      pending: catalog.pending_confirmation.length,
      xp_view_rows: tables.xp_modifier_catalog.length,
      policy_index: tables.resource_policy_index,
    },
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
