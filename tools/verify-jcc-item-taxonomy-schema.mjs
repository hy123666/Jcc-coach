import { readFile } from "node:fs/promises";

const DEFAULT_SCHEMA = "data/runtime/jcc/android-live-state-schema.json";
const DEFAULT_MATRIX = "data/runtime/jcc/android-live-state-field-evidence-matrix.json";
const DEFAULT_LIVE_STATE = "data/runtime/jcc/fixtures/item-taxonomy-live-state.json";

const REQUIRED_ITEM_FIELDS = [
  "item_bench",
  "equipped_items",
  "components",
  "completed",
  "radiant_items",
  "artifact_items",
  "support_items",
  "emblems",
  "anvils",
  "reforgers",
  "removers",
  "duplicators",
  "loot_orbs",
];

function parseArgs(argv) {
  const options = {
    schema: DEFAULT_SCHEMA,
    matrix: DEFAULT_MATRIX,
    liveState: DEFAULT_LIVE_STATE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--schema") options.schema = argv[++index];
    else if (arg === "--matrix") options.matrix = argv[++index];
    else if (arg === "--live-state") options.liveState = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-item-taxonomy-schema.mjs [--schema <schema.json>] [--matrix <matrix.json>] [--live-state <match-live-state.json>]",
    "",
    "Verifies item taxonomy fields required by the runtime goal are explicit schema/matrix/live_state fields.",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const schema = JSON.parse(await readFile(options.schema, "utf8"));
  const matrix = JSON.parse(await readFile(options.matrix, "utf8"));
  const snapshot = JSON.parse(await readFile(options.liveState, "utf8"));
  const schemaItemFields = new Set((schema.sections?.items?.fields || []).map((field) => field.key));
  const matrixFields = new Map((matrix.fields || []).map((field) => [field.field_key, field]));
  const liveState = snapshot.live_state || {};
  const items = liveState.items || {};

  for (const field of REQUIRED_ITEM_FIELDS) {
    assert(schemaItemFields.has(field), `schema items must include ${field}`);
    assert(matrixFields.has(`items.${field}`), `field matrix must include items.${field}`);
    assert(Object.hasOwn(items, field), `live_state.items must include ${field}`);
    assert(liveState.field_status?.[`items.${field}`], `field_status must include items.${field}`);
    assert(liveState.field_status[`items.${field}`].blocker != null, `items.${field} must carry blocker until verified`);
    assert(liveState.field_status[`items.${field}`].next_experiment != null, `items.${field} must carry next_experiment`);
  }

  assert(!schemaItemFields.has("special_items"), "schema must not hide typed item categories behind special_items");
  assert(!matrixFields.has("items.special_items"), "field matrix must not hide typed item categories behind items.special_items");
  assert(!Object.hasOwn(items, "special_items"), "live_state.items must not hide typed item categories behind special_items");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "item taxonomy fields are explicit in schema",
      "item taxonomy fields are explicit in field matrix",
      "item taxonomy fields are explicit in live_state with blockers",
      "special_items bucket is removed from the runtime contract",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
