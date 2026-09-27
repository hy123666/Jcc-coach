import { readFile } from "node:fs/promises";

const DEFAULT_REPORT = ".omx/runtime-evidence/current-open-game-runtime-check-20260606-165542/runtime-coverage-report.json";

function parseArgs(argv) {
  const options = { report: DEFAULT_REPORT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--report") options.report = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-runtime-coverage-transition-audit.mjs [--report <runtime-coverage-report.json>]",
    "",
    "Verifies coverage report lists runtime field promotions and protected missing core fields.",
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

  const report = JSON.parse(await readFile(options.report, "utf8"));
  const audit = report.runtime_transition_audit || {};
  const promoted = audit.promoted_from_matrix || [];
  const protectedMissing = audit.protected_core_missing_fields || [];
  const protectedPartial = audit.protected_unresolved_partial_fields || [];

  assert(audit.kind === "runtime_field_transition_audit", "transition audit kind mismatch");
  assert(Array.isArray(promoted) && promoted.length > 0, "promoted_from_matrix must list runtime evidence transitions");
  assert(promoted.some((entry) => entry.runtime_status === "verified"), "promoted fields must include at least one verified runtime transition");
  assert(promoted.some((entry) => entry.runtime_status === "partial"), "promoted fields must include at least one partial runtime transition");
  assert(promoted.some((entry) => entry.runtime_status === "blocked"), "promoted fields must include at least one blocked runtime transition when local binding is unavailable");
  assert(promoted.every((entry) => entry.matrix_status !== entry.runtime_status), "promoted entries must be actual status transitions");
  assert(promoted.every((entry) => entry.evidence || entry.blocker), "promoted entries must carry evidence or blocker");

  for (const field of [
    "economy.gold",
    "economy.level",
    "economy.xp",
    "traits.active_traits",
  ]) {
    const entry = protectedMissing.find((candidate) => candidate.field === field);
    assert(entry, `protected missing fields must include ${field}`);
    assert(entry.runtime_status === "missing", `${field} must remain missing`);
    assert(entry.reason, `${field} must include a reason`);
    assert(entry.next_experiment, `${field} must include next experiment`);
  }
  const augmentChoices = protectedPartial.find((entry) => entry.field === "augments.choices");
  assert(augmentChoices, "protected unresolved partial fields must include augments.choices");
  assert(augmentChoices.runtime_status === "partial", "augments.choices must be unresolved partial");
  assert(augmentChoices.reason, "augments.choices must include a reason");
  assert(augmentChoices.next_experiment, "augments.choices must include next experiment");

  assert(audit.counts?.promoted_from_matrix === promoted.length, "promoted count must match list length");
  assert(audit.counts?.protected_core_missing_fields === protectedMissing.length, "protected missing count must match list length");
  assert(audit.counts?.protected_unresolved_partial_fields === protectedPartial.length, "protected partial count must match list length");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "coverage report lists runtime status transitions",
      "coverage report lists protected core missing fields",
      "transition entries include evidence or blockers",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
