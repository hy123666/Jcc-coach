import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectHostAgent } from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const adapter = await readFile("ui/electron/host-adapters.js", "utf8");
  const login = await readFile("tools/login-jcc-kimi-cli.mjs", "utf8");
  const docs = await readFile("docs/jcc-runtime-product-readiness.md", "utf8");

  for (const needle of [
    "globalPackageManagerBinDirs",
    "configuredCliSearchRoots",
    "boundedCliSearchCandidates",
    "windowsDriveRoots",
    "commonWindowsCliSearchRoots",
    "configuredKimiInstallCandidates",
    "boundedKimiSearchCandidates",
    "codexCliCandidates",
    "commonUserKimiCliCandidates",
    "repoNearbyKimiCliCandidates",
    "kimiCliCandidates",
    "JCC_${upperBin}_SEARCH_ROOTS",
    "JCC_${upperBin}_SEARCH_MAX_DEPTH",
    "JCC_${upperBin}_SEARCH_MAX_ENTRIES",
    "lastSuccessfulCommand",
    "JCC_KIMI_CANDIDATE_DIRS",
    "KIMI_BIN",
    "PATH",
  ]) {
    assert(adapter.includes(needle), `Kimi discovery policy missing ${needle}`);
  }

  for (const source of [adapter, login, docs]) {
    assert(!source.includes("G:\\OneDrive\\000-AI\\000-001-VIBE-CODE\\KIMI CLI"), "product code/docs must not require the local developer Kimi path");
    assert(!source.includes("standard JCC Runtime KIMI CLI install directory"), "product guidance must not force a single install directory");
  }
  assert(login.includes('["login"]'), "Kimi login helper must launch the official `kimi login` command");
  assert(!login.includes('"acp", "--login"'), "Kimi login helper must not use the ACP server as a login command");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-discovery-"));
  await mkdir(path.join(tempRoot, "arbitrary", "nested", "Kimi Portable", "node_modules", ".bin"), { recursive: true });
  const fakeKimi = path.join(tempRoot, "arbitrary", "nested", "Kimi Portable", "node_modules", ".bin", process.platform === "win32" ? "kimi.cmd" : "kimi");
  const fakeContent = process.platform === "win32"
    ? [
        "@echo off",
        "if \"%1\"==\"provider\" if \"%2\"==\"list\" if \"%3\"==\"--json\" (",
        "  echo {\"models\":{\"kimi-code/kimi-for-coding\":{\"displayName\":\"K2.7 Code\",\"capabilities\":[\"image_in\"]},\"kimi-code/kimi-for-coding-highspeed\":{\"displayName\":\"K2.7 Code HighSpeed\",\"capabilities\":[\"image_in\"]},\"kimi-thinking\":{\"displayName\":\"Kimi Thinking\"}}}",
        "  exit /b 0",
        ")",
        "echo kimi-cli fake-search 0.0.1",
        "",
      ].join("\r\n")
    : [
        "#!/usr/bin/env sh",
        "if [ \"$1\" = \"provider\" ] && [ \"$2\" = \"list\" ] && [ \"$3\" = \"--json\" ]; then",
        "  printf '%s\\n' '{\"models\":{\"kimi-code/kimi-for-coding\":{\"displayName\":\"K2.7 Code\",\"capabilities\":[\"image_in\"]},\"kimi-code/kimi-for-coding-highspeed\":{\"displayName\":\"K2.7 Code HighSpeed\",\"capabilities\":[\"image_in\"]},\"kimi-thinking\":{\"displayName\":\"Kimi Thinking\"}}}'",
        "  exit 0",
        "fi",
        "echo kimi-cli fake-search 0.0.1",
        "",
      ].join("\n");
  await writeFile(fakeKimi, fakeContent, "utf8");
  try {
    const explicit = await detectHostAgent({
      provider: "kimi",
      command: fakeKimi,
      model: "default",
      search_roots: [tempRoot],
    });
    assert(explicit.available === true, "explicit Kimi command should be accepted when it is a runnable Kimi CLI");
    assert(path.resolve(explicit.command) === path.resolve(fakeKimi), "explicit command must have highest discovery priority");
    assert(path.resolve(explicit.attempts?.[0]?.command || "") === path.resolve(fakeKimi), "explicit command should be the first attempted candidate");

    const searched = await detectHostAgent({
      provider: "kimi",
      model: "kimi-code/kimi-for-coding-highspeed",
      search_roots: [tempRoot],
      search_max_depth: 6,
      search_max_entries: 200,
    });
    assert(searched.available === true, "bounded search roots should discover a Kimi CLI outside PATH/KIMI_BIN");
    assert(path.resolve(searched.command) === path.resolve(fakeKimi), "bounded search should select the fake Kimi CLI");
    assert(searched.model_options?.some((option) => option.value === "kimi-code/kimi-for-coding"), "Kimi provider model aliases from provider list should be exposed");
    assert(searched.model_options?.some((option) => option.value === "kimi-code/kimi-for-coding" && /K2\.7 Code/.test(option.label)), "Kimi provider display names should be exposed in model options");
    assert(searched.model_options?.some((option) => option.value === "kimi-code/kimi-for-coding-highspeed" && /HighSpeed/.test(option.label)), "Kimi provider model options should include the K2.7 Code HighSpeed alias");
    assert(searched.selected_model === "kimi-code/kimi-for-coding-highspeed", "configured Kimi HighSpeed model alias should be selected when the provider exposes it");

    const cached = await detectHostAgent({
      provider: "kimi",
      model: "kimi-thinking",
      lastSuccessfulCommand: fakeKimi,
      search_roots: [],
    });
    assert(cached.available === true, "last successful Kimi command should be reusable");
    assert(cached.attempts?.[0]?.command === fakeKimi, "last successful command should be attempted before generic discovery");
    assert(cached.selected_model === "kimi-thinking", "cached Kimi command should still honor the configured model alias");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-kimi-discovery-policy-verification-v1",
    checked: [
      "generic-kimi-candidate-sources",
      "shared-cli-search-roots-for-codex-and-kimi",
      "bounded-user-search-roots",
      "bounded-common-drive-tool-roots",
      "last-successful-command-priority",
      "kimi-provider-model-aliases",
      "kimi-selected-model-persistence-input",
      "no-local-developer-path-contract",
      "explicit-command-priority",
      "auth-boundary-remains-external",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
