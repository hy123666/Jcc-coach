import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runPowerShell(args) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    ...args,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stderr || result.stdout || "PowerShell command failed"));
  return String(result.stdout || "").trim();
}

const contract = JSON.parse(await readFile(path.join(repoRoot, "data/runtime/jcc/windows-distribution-contract.json"), "utf8"));
const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const uiPackage = JSON.parse(await readFile(path.join(repoRoot, "ui/package.json"), "utf8"));
const builderConfig = await readFile(path.join(repoRoot, "ui/electron-builder.yml"), "utf8");
const mainSource = await readFile(path.join(repoRoot, "ui/electron/main.js"), "utf8");
const launcherSource = await readFile(path.join(repoRoot, "tools/launch-jcc-runtime-electron.mjs"), "utf8");
const hiddenLauncherSource = await readFile(path.join(repoRoot, "tools/launch-jcc-runtime-hidden.vbs"), "utf8");
const viteConfig = await readFile(path.join(repoRoot, "ui/vite.config.ts"), "utf8");
const installerSource = await readFile(path.join(repoRoot, "tools/install-jcc-runtime-desktop-shortcut.ps1"), "utf8");
const ico = await readFile(path.join(repoRoot, "ui/assets/jcc-runtime.ico"));
const pngStats = await stat(path.join(repoRoot, "ui/assets/jcc-runtime.png"));

assert.equal(contract.schema, "jcc-runtime-windows-distribution-contract-v1");
assert.equal(contract.release_installer.desktop_shortcut, "always");
assert.equal(contract.release_installer.target, "installed_executable");
assert.equal(contract.release_installer.development_launcher_forbidden, true);
assert.match(contract.developer_shortcut.renderer_freshness || "", /fingerprint/i);
assert.match(rootPackage.scripts?.["ui:launch"] || "", /launch-jcc-runtime-electron\.mjs/);
assert.equal(uiPackage.scripts?.["start:built"], "npm run electron:built");
assert.match(viteConfig, /base:\s*["']\.\/["']/);
assert.match(rootPackage.scripts?.["ui:shortcut:install"] || "", /install-jcc-runtime-desktop-shortcut\.ps1/);
assert.match(rootPackage.scripts?.["ui:shortcut:remove"] || "", /-Action Remove/);
assert.match(builderConfig, /appId:\s*com\.jcc\.runtime/);
assert.match(builderConfig, /createDesktopShortcut:\s*always/);
assert.match(builderConfig, /createStartMenuShortcut:\s*true/);
assert.match(builderConfig, /shortcutName:\s*JCC Runtime/);
assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/);
assert.match(mainSource, /app\.on\("second-instance"/);
assert.match(mainSource, /app\.setAppUserModelId\(appUserModelId\)/);
assert.match(launcherSource, /already_running/);
assert.match(launcherSource, /renderer_running/);
assert.match(launcherSource, /persistLatestLaunch\(\{/);
assert.match(launcherSource, /observed_at:\s*new Date\(\)\.toISOString\(\)/);
assert.match(launcherSource, /openSync\(stdoutFile, "a"\)/);
assert.match(launcherSource, /openSync\(stderrFile, "a"\)/);
assert.doesNotMatch(launcherSource, /createWriteStream/);
assert.match(launcherSource, /"\/c",\s*\n\s*"call",\s*\n\s*npm,/);
assert.doesNotMatch(launcherSource, /"\/s"/);
assert.match(launcherSource, /detached:\s*false/);
assert.doesNotMatch(launcherSource, /child\.unref\(\)/);
assert.match(launcherSource, /await waitForRuntimeReady\(child, \{/);
assert.match(launcherSource, /requireVisible:\s*true/);
assert.match(launcherSource, /ensureBuiltUiAvailable\(\)/);
assert.match(launcherSource, /rendererSourceFingerprint\(\)/);
assert.match(launcherSource, /\.jcc-renderer-source\.sha256/);
assert.match(launcherSource, /builtFingerprint === expectedFingerprint/);
assert.match(launcherSource, /writeFileSync\(rendererBuildFingerprintFile/);
assert.match(launcherSource, /"\/c",\s*\n\s*"call",\s*\n\s*npm,\s*\n\s*"--prefix",\s*\n\s*"ui",\s*\n\s*"run",\s*\n\s*"build"/);
assert.match(launcherSource, /startRuntime\(inspection\.status === "renderer_running" \? "electron" : "start:built"\)/);
assert.match(launcherSource, /CommandLine -notmatch '--type='/);
assert.match(launcherSource, /CommandLine -notmatch 'runtime-daemon-server\\\.js'/);
assert.match(mainSource, /windowActivationPipe/);
assert.match(mainSource, /desktop-launcher-activation/);
assert.match(mainSource, /socket\.setTimeout\(3_000/);
assert.match(mainSource, /request\.includes\("\\n"\)/);
assert.match(launcherSource, /requestWindowActivation/);
assert.match(launcherSource, /existing_window_activated/);
assert.match(launcherSource, /visible = \[bool\]\(\$handle -ne 0\)/);
assert.match(launcherSource, /inspection\.visible/);
assert.match(launcherSource, /runtime_activated/);
assert.match(launcherSource, /waitForExistingRuntimeVisible/);
assert.match(launcherSource, /existing_window_recovered/);
assert.match(launcherSource, /timeoutMs:\s*scriptName === "electron" \? 90_000 : 120_000/);
assert.match(mainSource, /window-visibility-fallback/);
assert.match(mainSource, /revealMainWindow\("second-instance"\)/);
assert.match(mainSource, /revealMainWindow\("did-finish-load"\)/);
assert.match(hiddenLauncherSource, /shell\.Run command, 0, False/);
assert.match(installerSource, /target_kind/);
assert.equal(ico.readUInt16LE(0), 0, "ICO reserved header must be zero");
assert.equal(ico.readUInt16LE(2), 1, "ICO must declare image type");
assert.ok(ico.readUInt16LE(4) >= 1, "ICO must contain at least one image");
assert.ok(pngStats.size > 1024, "PNG icon must contain a real rendered asset");

let shortcutRoundTrip = { skipped: process.platform !== "win32" };
if (process.platform === "win32") {
  const tempDesktop = await mkdtemp(path.join(os.tmpdir(), "jcc-shortcut-"));
  try {
    const installer = path.join(repoRoot, "tools/install-jcc-runtime-desktop-shortcut.ps1");
    const installOutput = runPowerShell(["-File", installer, "-DesktopPath", tempDesktop]);
    const installed = JSON.parse(installOutput.split(/\r?\n/).filter(Boolean).at(-1));
    const shortcutPath = path.join(tempDesktop, "JCC Runtime.lnk");
    await stat(shortcutPath);
    const inspectScript = `
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
[pscustomobject]@{
  target = $shortcut.TargetPath
  arguments = $shortcut.Arguments
  working_directory = $shortcut.WorkingDirectory
  icon = $shortcut.IconLocation
} | ConvertTo-Json -Compress
`;
    const inspected = JSON.parse(runPowerShell(["-Command", inspectScript]));
    assert.match(inspected.target, /wscript\.exe$/i);
    assert.match(inspected.arguments, /launch-jcc-runtime-hidden\.vbs/i);
    assert.equal(path.resolve(inspected.working_directory), repoRoot);
    assert.match(inspected.icon, /jcc-runtime\.ico/i);
    const removeOutput = runPowerShell(["-File", installer, "-Action", "Remove", "-DesktopPath", tempDesktop]);
    const removed = JSON.parse(removeOutput.split(/\r?\n/).filter(Boolean).at(-1));
    await assert.rejects(stat(shortcutPath), /ENOENT/);
    shortcutRoundTrip = {
      installed: installed.action,
      target_kind: installed.target_kind,
      target: inspected.target,
      removed: removed.action,
    };
  } finally {
    await rm(tempDesktop, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-runtime-windows-desktop-shortcut-verifier-v1",
  checked: [
    "versioned_windows_distribution_contract",
    "reproducible_png_and_ico_assets",
    "hidden_idempotent_developer_launcher",
    "cold_start_stdio_is_synchronously_opened",
    "cold_start_batch_invocation_and_readiness_wait",
    "hidden_supervisor_owns_development_process_lifecycle",
    "existing_instance_launch_audit",
    "hidden_window_native_activation",
    "first_window_visibility_fallback",
    "single_instance_focus_contract",
    "nsis_desktop_and_start_menu_shortcut_policy",
    "shortcut_install_remove_roundtrip",
  ],
  shortcut_roundtrip: shortcutRoundTrip,
}, null, 2)}\n`);
