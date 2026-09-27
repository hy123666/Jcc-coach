import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_GENERATION_POINTER,
  liveRankingBindingFromSourceIdentity,
  publishLiveRankingGeneration,
  resolveActiveLiveRankingGeneration,
  sha256File,
} from "../jcc_live_rankings_generation_store.mjs";
import { ACTIVE_RANKING_CLOSURE_FILE } from "../jcc_live_rankings_active_closure.mjs";

// One-time compatibility migration for repositories predating the immutable
// Active Ranking closure. This is not a refresh or publication entrypoint.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const rankingRoot = path.join(repoRoot, "data", "live-rankings", "jcc");
const currentDir = path.join(rankingRoot, "current");
const files = [
  "snapshot.json",
  "rank-signal.json",
  "lineup-strategy-index.json",
  "latest-diff.json",
  "audit.json",
  "manifest.json",
];

function verifyCurrent() {
  const result = spawnSync(process.execPath, ["tools/verify-jcc-live-rankings.mjs", "--dir", currentDir], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Current Ranking migration input is not publishable: ${result.stderr || result.stdout}`);
  return JSON.parse(String(result.stdout || "{}").trim());
}

try {
  await access(path.join(rankingRoot, ACTIVE_RANKING_CLOSURE_FILE));
  throw new Error("Ranking migration is closed after active-ranking-closure.json exists; use the full Ranking refresh pipeline");
} catch (error) {
  if (error?.message?.includes("Ranking migration is closed")) throw error;
  if (error?.code !== "ENOENT") throw error;
}

let active = null;
try {
  await access(path.join(rankingRoot, ACTIVE_GENERATION_POINTER));
  active = await resolveActiveLiveRankingGeneration({ rootDir: rankingRoot });
} catch (error) {
  if (error?.code !== "ENOENT" && !/binding requires/u.test(String(error?.message || ""))) throw error;
}

if (active) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: "immutable_generation_ready",
    generation_id: active.generation_id,
    generation_dir: active.generation_dir,
    authority: "retired_authority_guard",
  }, null, 2)}\n`);
} else {
  const verification = verifyCurrent();
  const manifest = JSON.parse(await readFile(path.join(currentDir, "manifest.json"), "utf8"));
  const artifacts = await Promise.all(files.map(async (file) => ({
    path: file,
    sha256: await sha256File(path.join(currentDir, file)),
  })));
  const published = await publishLiveRankingGeneration({
    rootDir: rankingRoot,
    candidateDir: currentDir,
    artifacts,
    statDate: verification.stat_date,
    binding: liveRankingBindingFromSourceIdentity(manifest.source_identity),
  });
  active = await resolveActiveLiveRankingGeneration({ rootDir: rankingRoot });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: "migrated_current_to_immutable_generation",
    generation_id: published.pointer.generation_id,
    generation_dir: published.generation_dir,
    authority: "retired_authority_guard",
  }, null, 2)}\n`);
}
