import { spawn } from "node:child_process";

const REQUIRED_SCOPES = [
  "lobby_baseline",
  "match_history",
  "in_game",
  "loading",
  "opening",
  "planning_shop",
  "combat",
  "augment_choice",
  "item_reward",
  "carousel",
  "opponent_scout",
  "postgame",
];

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const listed = await runNode(["tools/probe-jcc-android-runtime.mjs", "--list-scopes"]);
  assert(listed.code === 0, `--list-scopes must exit 0\n${listed.stderr}`);
  const payload = JSON.parse(listed.stdout);
  assert(payload.contract_ref === "data/runtime/jcc/android-runtime-capture-contract.json", "scope list must cite targeted capture contract");
  for (const scope of REQUIRED_SCOPES) {
    assert(payload.scopes?.includes(scope), `--list-scopes missing ${scope}`);
  }
  assert(payload.targeted_scopes?.includes("planning_shop"), "--list-scopes must separate targeted scopes");
  assert(payload.baseline_scopes?.includes("lobby_baseline"), "--list-scopes must separate baseline scopes");

  const help = await runNode(["tools/probe-jcc-android-runtime.mjs", "--help"]);
  assert(help.code === 0, "--help must exit 0");
  assert(help.stdout.includes("--list-scopes"), "help must mention --list-scopes");
  assert(help.stdout.includes("planning_shop"), "help must mention targeted scopes");
  assert(help.stdout.includes("android-runtime-capture-contract.json"), "help must cite capture contract");

  const invalid = await runNode(["tools/probe-jcc-android-runtime.mjs", "--adb", "adb", "--device", "x", "--scope", "bad_scope"]);
  assert(invalid.code !== 0, "invalid scope must fail");
  assert((invalid.stderr + invalid.stdout).includes("planning_shop"), "invalid scope error must list valid targeted scopes");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "probe lists baseline and targeted capture scopes without adb",
      "probe help cites targeted capture contract",
      "invalid scope errors include targeted scope names",
    ],
    scope_count: payload.scopes.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
