import { readFile } from "node:fs/promises";

const DEFAULT_LIVE_STATE = ".omx/runtime-evidence/android-probe-ingame-20260605-214908/match-live-state.json";

function parseArgs(argv) {
  const options = { liveState: DEFAULT_LIVE_STATE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-match-set-candidate.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies match.set is exposed as a partial runtime candidate without inventing mode or patch.",
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

  const snapshot = JSON.parse(await readFile(options.liveState, "utf8"));
  const liveState = snapshot.live_state || {};
  const status = liveState.field_status?.["match.set"];

  assert(liveState.match?.set === "17", "match.set must expose observed set candidate 17");
  assert(status?.status === "partial", "match.set must be partial until source semantics are fully calibrated");
  assert(status?.confidence > 0, "match.set must carry confidence");
  assert(status?.evidence, "match.set must carry evidence");
  assert(liveState.match?.mode == null, "match.mode must not be invented");
  assert(liveState.match?.patch == null, "match.patch must not be invented");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "match.set candidate exposed",
      "match.set marked partial with evidence",
      "mode and patch remain unknown",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
