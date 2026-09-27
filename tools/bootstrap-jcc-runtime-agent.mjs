import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

function run(label, command, args) {
  console.log(`[jcc-runtime bootstrap] ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const forwardedArgs = process.argv.slice(2);
const loaderArgs = [];
for (let index = 0; index < forwardedArgs.length; index += 1) {
  const arg = forwardedArgs[index];
  if (arg === "--tier-part" || arg === "--rank-label") {
    loaderArgs.push(arg, forwardedArgs[index + 1]);
    index += 1;
  }
}

run("inspect live rankings", "node", ["tools/ensure-jcc-live-rankings.mjs", "--local-only", ...forwardedArgs]);
run("verify runtime mainline paths", "node", ["tools/verify-jcc-runtime-mainline-paths.mjs"]);
run("verify hard data", "node", ["tools/verify-jcc-hard-data.mjs"]);
const runtimePaths = createRuntimePaths(path.resolve("."));
if (runtimePaths.activeRankingGenerationId) {
  run("verify runtime rank signal contract", "node", ["tools/verify-jcc-runtime-rank-signal-contract.mjs"]);
  run("load runtime rank signal context", "node", ["tools/load-jcc-runtime-rank-signal.mjs", ...loaderArgs]);
} else {
  console.log(JSON.stringify({
    status: "live_rankings_unavailable",
    ranking_overlay_id: null,
    stat_date: null,
    reason: "compatible_master_plus_rankings_unavailable",
    core_only_runtime_ready: true,
  }));
}
run("build startup host-agent context pack", "node", ["tools/build-jcc-host-agent-context-pack.mjs", "--scope", "startup"]);

console.log("[jcc-runtime bootstrap] ready");
