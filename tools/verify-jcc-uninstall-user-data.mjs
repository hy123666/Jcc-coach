import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") throw new Error("This verifier needs Windows NSIS");
const exists = async target => access(target).then(() => true, () => false);
async function locateNsis() {
  if (process.env.JCC_NSIS_MAKENSIS) return process.env.JCC_NSIS_MAKENSIS;
  const cache = path.join(process.env.LOCALAPPDATA, "electron-builder", "Cache");
  for (const version of (await readdir(cache)).filter(name => name.startsWith("nsis-")).sort().reverse()) {
    const dir = path.join(cache, version);
    for (const child of await readdir(dir)) {
      const candidate = path.join(dir, child, "Bin", "makensis.exe");
      if (await exists(candidate)) return candidate;
    }
  }
  throw new Error("NSIS not cached; set JCC_NSIS_MAKENSIS to makensis.exe");
}
const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-uninstall-"));
const profile = path.join(temp, "profile", "jcc-runtime-ui");
const logs = path.join(temp, "logs", "jcc-runtime-ui");
const unrelated = path.join(temp, "unrelated-provider");
try {
  await exec(await locateNsis(), ["/V2", "/INPUTCHARSET", "UTF8", `/DFIXTURE_ROOT=${temp}`, `/DREPO_ROOT=${root}`, path.join(root, "tools/fixtures/jcc-uninstall-fixture.nsi")], { timeout: 30000 });
  await exec(path.join(temp, "maker.exe"), ["/S"], { timeout: 15000 });
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "keep.txt"), "unrelated fixture");
  for (const mode of ["default", "delete", "silent", "updated", "cancel", "absent", "junction"]) {
    for (const dir of [profile, logs]) {
      await rm(dir, { recursive: true, force: true });
      if (mode !== "absent") {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "state.txt"), "isolated fixture");
      }
    }
    await rm(path.join(temp, "ran.txt"), { force: true });
    if (mode === "junction") await symlink(unrelated, path.join(profile, "external"), "junction");
    const args = [`/CASE=${mode}`];
    if (mode === "silent") args.push("/S");
    args.push("/END");
    // NSIS requires _?= to be last and unquoted to avoid a detached copy.
    args.push(`_?=${temp}`);
    await exec(path.join(temp, "fixture-uninstall.exe"), args, { windowsVerbatimArguments: true, timeout: 20000 });
    assert.equal(await readFile(path.join(temp, "default.txt"), "utf8"), "0", "cleanup checkbox must start unchecked");
    const retained = ["default", "silent", "updated", "cancel"].includes(mode);
    assert.equal(await exists(profile), retained, `${mode}: profile retention`);
    assert.equal(await exists(logs), retained, `${mode}: log retention`);
    assert.equal(await exists(path.join(temp, "ran.txt")), mode !== "cancel", `${mode}: uninstall completion`);
    assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "unrelated fixture", `${mode}: external data must survive`);
    console.log(JSON.stringify({ test: "uninstall-user-data", mode, ok: true }));
  }
} catch (error) {
  console.error(JSON.stringify({ fixture_default: await readFile(path.join(temp, "default.txt"), "utf8").catch(() => null), fixture_shown: await readFile(path.join(temp, "shown.txt"), "utf8").catch(() => null), section_ran: await exists(path.join(temp, "ran.txt")) }));
  throw error;
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
