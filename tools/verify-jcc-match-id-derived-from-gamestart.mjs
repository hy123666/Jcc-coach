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
    "  node tools/verify-jcc-match-id-derived-from-gamestart.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies match.match_id is a deterministic per-match id derived from GameStart.",
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
  const gameStart = liveState.match?.game_start_time;
  const matchId = liveState.match?.match_id;
  const status = liveState.field_status?.["match.match_id"];

  assert(gameStart, "game_start_time must be present");
  assert(matchId === `jcc:${gameStart}`, "match_id must be derived from game_start_time");
  assert(status?.status === "verified", "match.match_id field status must be verified");
  assert(status?.confidence >= 0.9, "match.match_id must inherit high GameStart confidence");
  assert(status?.evidence, "match.match_id must carry evidence");
  assert(status?.blocker == null, "match.match_id must not keep a blocker once derived");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "match_id derived from game_start_time",
      "match.match_id marked verified",
      "match.match_id carries confidence and evidence",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
