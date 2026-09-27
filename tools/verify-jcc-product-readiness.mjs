import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readText(file) {
  return readFile(file, "utf8");
}

function requireScript(pkg, name, expectedSnippet) {
  const actual = pkg.scripts?.[name];
  assert(typeof actual === "string", `missing package script: ${name}`);
  if (expectedSnippet) assert(actual.includes(expectedSnippet), `script ${name} must include ${expectedSnippet}`);
}

function has(text, needle, label) {
  assert(text.includes(needle), `${label} missing ${needle}`);
}

function hasNormalized(text, needle, label) {
  const normalizedText = text.replace(/\s+/g, " ");
  const normalizedNeedle = needle.replace(/\s+/g, " ");
  assert(normalizedText.includes(normalizedNeedle), `${label} missing ${needle}`);
}

async function main() {
  const rootPackage = await readJson("package.json");
  const uiPackage = await readJson("ui/package.json");
  const readinessDoc = await readText("docs/jcc-runtime-product-readiness.md");
  const agentSkill = await readText(".codex/skills/jcc-runtime-agent/SKILL.md");
  const gitignore = await readText(".gitignore");

  for (const [name, expected] of [
    ["runtime:bootstrap", "tools/bootstrap-jcc-runtime-agent.mjs"],
    ["runtime:product-gate", "tools/verify-jcc-runtime-product-gate.mjs"],
    ["runtime:benchmark:modes", "tools/verify-jcc-runtime-mode-host-request-benchmark.mjs"],
    ["runtime:readiness", "tools/verify-jcc-product-readiness.mjs"],
    ["runtime:live:mumu", "--require-live-mumu"],
    ["runtime:live:codex", "--require-live"],
    ["runtime:live:kimi", "--require-live"],
    ["runtime:login:kimi", "tools/login-jcc-kimi-cli.mjs"],
    ["runtime:verify:kimi-discovery", "tools/verify-jcc-kimi-discovery-policy.mjs"],
    ["repo:hygiene", "tools/audit-jcc-repo-hygiene.mjs"],
    ["repo:cleanup:dry", "tools/cleanup-jcc-generated-artifacts.mjs"],
    ["repo:cleanup", "--apply"],
    ["ui:start", "npm --prefix ui run start"],
    ["ui:launch", "tools/launch-jcc-runtime-electron.mjs"],
    ["ui:shortcut:install", "tools/install-jcc-runtime-desktop-shortcut.ps1"],
    ["ui:shortcut:remove", "-Action Remove"],
    ["ui:build", "npm --prefix ui run build"],
  ]) {
    requireScript(rootPackage, name, expected);
  }

  for (const [name, expected] of [
    ["start", "concurrently"],
    ["electron", "electron"],
    ["build", "tsc --noEmit"],
  ]) {
    requireScript(uiPackage, name, expected);
  }

  for (const needle of [
    "runtime-daemon-server.js",
    "runtime-state-store.js",
    "app.sqlite",
    ".jcc-runtime-data",
    "JCC_RUNTIME_DATA_DIR",
    "runtime:bootstrap",
    "runtime:product-gate",
    "runtime:benchmark:modes",
    "runtime:live:mumu",
    "runtime:live:codex",
    "runtime:live:kimi",
    "runtime:login:kimi",
    "runtime:verify:kimi-discovery",
    "Kimi CLI",
    "must not scan MuMu ports",
    "current-match user-reported choice intake",
    "Choice OCR and multimodal",
    "tools are compatibility/calibration paths",
    "ui:shortcut:install",
    "desktop shortcut",
    "installed executable",
  ]) {
    has(readinessDoc, needle, "product readiness doc");
  }
  for (const needle of [
    "authenticated Kimi CLI",
    "authenticated Codex CLI",
    "runtime adapter discovery order",
    "packaged Windows smoke test",
  ]) {
    hasNormalized(readinessDoc, needle, "product readiness doc");
  }

  for (const needle of [
    "JCC Runtime Daemon owns runtime state",
    "app.sqlite",
    "Do not run it on every startup",
    "Choice candidate intake is current-match user report only",
    "Legacy icon matcher paths remain fallback/debug only",
  ]) {
    has(agentSkill, needle, "jcc-runtime-agent skill");
  }

  for (const ignored of [
    ".jcc-runtime-data/",
    ".omx/runtime-evidence/",
    ".omx/bin/",
    "ui/dist",
    "ui/release",
    "ui/node_modules",
    "android-companion/app/build/",
  ]) {
    has(gitignore, ignored, ".gitignore");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-product-readiness-verification-v1",
    checked: [
      "root-product-scripts",
      "ui-start-build-scripts",
      "operator-readiness-doc",
      "strict-live-gate-docs",
      "runtime-agent-product-contract",
      "generated-artifact-ignore-policy",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
