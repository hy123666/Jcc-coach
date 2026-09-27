import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-migrate-"));
  const dataRoot = path.join(tempRoot, "data-root");
  const legacyState = path.join(process.cwd(), ".omx", "state");
  const legacySettings = path.join(legacyState, "jcc-runtime-user-settings.json");
  const legacySession = path.join(legacyState, "jcc-current-match-session.json");
  const backupSuffix = `.verify-backup-${Date.now()}`;
  const backups = [];
  async function backupIfExists(file) {
    try {
      const raw = await readFile(file);
      const backup = `${file}${backupSuffix}`;
      await writeFile(backup, raw);
      backups.push({ file, backup, existed: true });
    } catch {
      backups.push({ file, backup: null, existed: false });
    }
  }
  async function restoreBackups() {
    for (const entry of backups) {
      if (entry.existed) {
        const raw = await readFile(entry.backup);
        await writeFile(entry.file, raw);
        await rm(entry.backup, { force: true });
      } else {
        await rm(entry.file, { force: true });
      }
    }
  }

  await mkdir(legacyState, { recursive: true });
  await backupIfExists(legacySettings);
  await backupIfExists(legacySession);
  try {
    await writeFile(legacySettings, `${JSON.stringify({ rank_tier: "challenger", default_goal: "balanced" }, null, 2)}\n`, "utf8");
    await writeFile(legacySession, `${JSON.stringify({ match_session_id: "legacy-match-verify", started_at: "2026-06-19T00:00:00.000Z" }, null, 2)}\n`, "utf8");
    const result = await runNode(["tools/migrate-jcc-runtime-data-dir.mjs", "--data-dir", dataRoot], { cwd: process.cwd() });
    assert(result.code === 0, `migration command failed: ${result.stderr || result.stdout}`);
    const parsed = JSON.parse(result.stdout);
    assert(parsed.runtime_data_root === path.resolve(dataRoot), "migration must write to requested runtime data dir");
    assert(parsed.migrated_count >= 2, "migration should move legacy settings and match session");
    const migratedSettings = JSON.parse(await readFile(path.join(dataRoot, "state", "jcc-runtime-user-settings.json"), "utf8"));
    const migratedSession = JSON.parse(await readFile(path.join(dataRoot, "state", "jcc-current-match-session.json"), "utf8"));
    const marker = JSON.parse(await readFile(path.join(dataRoot, "migration", "legacy-omx-state.json"), "utf8"));
    assert(migratedSettings.rank_tier === "challenger", "legacy user settings should migrate");
    assert(migratedSession.match_session_id === "legacy-match-verify", "legacy match session should migrate");
    assert(marker.migrated_count >= 2, "migration marker should record migrated count");
  } finally {
    await restoreBackups();
    await rm(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "legacy-omx-state-to-runtime-data-dir",
      "migration-marker",
      "user-settings-migration",
      "match-session-migration",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
