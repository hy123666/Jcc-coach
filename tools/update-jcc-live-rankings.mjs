import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "");
    process.exit(result.status ?? 1);
  }
  const parsed = parseLastJson(result.stdout);
  return { parsed, stdout: result.stdout, stderr: result.stderr };
}

function parseLastJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  let last = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        last = trimmed.slice(start, index + 1);
        start = -1;
      }
    }
  }
  if (!last) throw new Error(`Command did not return JSON: ${trimmed.slice(0, 500)}`);
  return JSON.parse(last);
}

const forwardedArgs = process.argv.slice(2);

const sync = run("node", ["tools/sync-jcc-live-rankings.mjs", ...forwardedArgs]);
const target = sync.parsed?.ranking_target || null;
if (sync.parsed?.status === "ranking_strength_unavailable_recipes_cached") {
  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-live-rankings-update-result-v1",
    status: "ranking_strength_unavailable_recipes_cached",
    sync: sync.parsed,
    verification: {
      status: "skipped_strength_unavailable",
      reason: "No Master+ canonical strength overlay was published; independently cached recipes are not ranking authority.",
    },
    stat_date: null,
    attempted_stat_date: sync.parsed?.attempted_stat_date || null,
    output_dir: null,
  }, null, 2));
  process.exit(0);
}
const verifyExplicitGeneration = target?.publication_scope === "candidate" || sync.parsed?.prepared_generation;
const verifyArgs = verifyExplicitGeneration
  ? [
      "tools/verify-jcc-live-rankings.mjs",
      "--dir", sync.parsed.output_dir,
      "--season", target.season_id,
      "--patch", target.patch_id,
      "--expected-core-profile-id", target.core_profile_id,
      "--profile", target.selection,
    ]
  : ["tools/verify-jcc-live-rankings.mjs"];
const verify = run("node", verifyArgs);
const preparedForSemanticMaintenance = Boolean(sync.parsed?.prepared_generation?.generation_id);

console.log(JSON.stringify({
  ok: verify.parsed?.status === "pass",
  schema: "jcc-live-rankings-update-result-v1",
  status: preparedForSemanticMaintenance
    ? "prepared_for_semantic_maintenance"
    : "verified_without_deferred_publication",
  complete: !preparedForSemanticMaintenance,
  publication_committed: false,
  sync: sync.parsed,
  verification: verify.parsed,
  stat_date: verify.parsed?.stat_date || sync.parsed?.stat_date || null,
  output_dir: sync.parsed?.output_dir || null,
}, null, 2));
