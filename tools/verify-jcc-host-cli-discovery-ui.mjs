import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectHostAgent,
  discoverHostAgents,
} from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-host-discovery-ui-"));
  const fakeDir = path.join(tempRoot, "portable", "Kimi CLI", "node_modules", ".bin");
  const fakeCodexDir = path.join(tempRoot, "portable", "Codex CLI", "node_modules", ".bin");
  await mkdir(fakeDir, { recursive: true });
  await mkdir(fakeCodexDir, { recursive: true });
  const fakeKimi = path.join(fakeDir, process.platform === "win32" ? "kimi.cmd" : "kimi");
  const fakeCodex = path.join(fakeCodexDir, process.platform === "win32" ? "codex.cmd" : "codex");
  const fakeContent = process.platform === "win32"
    ? [
        "@echo off",
        "if \"%1\"==\"provider\" if \"%2\"==\"list\" if \"%3\"==\"--json\" (",
        "  echo {\"providers\":{\"moonshot\":{\"id\":\"moonshot\"}},\"models\":{\"kimi-code/kimi-for-coding\":{\"provider\":\"moonshot\",\"displayName\":\"K2.7 Code\",\"capabilities\":[\"image_in\",\"thinking\"]},\"kimi-code/kimi-for-coding-highspeed\":{\"provider\":\"moonshot\",\"displayName\":\"K2.7 Code HighSpeed\",\"capabilities\":[\"image_in\",\"thinking\"]},\"kimi-code/k3\":{\"provider\":\"moonshot\",\"displayName\":\"K3\",\"capabilities\":[\"image_in\",\"thinking\"],\"supportEfforts\":[\"low\",\"high\",\"max\"],\"defaultEffort\":\"high\"}}}",
        "  exit /b 0",
        ")",
        "echo kimi-cli fake-ui 0.0.1",
        "",
      ].join("\r\n")
    : [
        "#!/usr/bin/env sh",
        "if [ \"$1\" = \"provider\" ] && [ \"$2\" = \"list\" ] && [ \"$3\" = \"--json\" ]; then",
        "  echo '{\"providers\":{\"moonshot\":{\"id\":\"moonshot\"}},\"models\":{\"kimi-code/kimi-for-coding\":{\"provider\":\"moonshot\",\"displayName\":\"K2.7 Code\",\"capabilities\":[\"image_in\",\"thinking\"]},\"kimi-code/kimi-for-coding-highspeed\":{\"provider\":\"moonshot\",\"displayName\":\"K2.7 Code HighSpeed\",\"capabilities\":[\"image_in\",\"thinking\"]},\"kimi-code/k3\":{\"provider\":\"moonshot\",\"displayName\":\"K3\",\"capabilities\":[\"image_in\",\"thinking\"],\"supportEfforts\":[\"low\",\"high\",\"max\"],\"defaultEffort\":\"high\"}}}'",
        "  exit 0",
        "fi",
        "echo kimi-cli fake-ui 0.0.1",
        "",
      ].join("\n");
  await writeFile(fakeKimi, fakeContent, "utf8");
  const fakeCodexContent = process.platform === "win32"
    ? [
        "@echo off",
        "if \"%1\"==\"debug\" if \"%2\"==\"models\" (",
        "  echo {\"models\":[{\"slug\":\"gpt-5.6-sol\",\"display_name\":\"GPT-5.6-Sol\",\"visibility\":\"list\",\"supported_reasoning_levels\":[{\"effort\":\"low\"},{\"effort\":\"medium\"},{\"effort\":\"high\"},{\"effort\":\"xhigh\"},{\"effort\":\"max\"},{\"effort\":\"ultra\"}]},{\"slug\":\"codex-dynamic-1\",\"display_name\":\"Codex Dynamic One\",\"visibility\":\"list\",\"supported_reasoning_levels\":[{\"effort\":\"low\"},{\"effort\":\"medium\"}]}]}",
        "  exit /b 0",
        ")",
        "echo codex-cli 9.9.9",
        "",
      ].join("\r\n")
    : [
        "#!/usr/bin/env sh",
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"models\" ]; then",
        "  echo '{\"models\":[{\"slug\":\"gpt-5.6-sol\",\"display_name\":\"GPT-5.6-Sol\",\"visibility\":\"list\",\"supported_reasoning_levels\":[{\"effort\":\"low\"},{\"effort\":\"medium\"},{\"effort\":\"high\"},{\"effort\":\"xhigh\"},{\"effort\":\"max\"},{\"effort\":\"ultra\"}]},{\"slug\":\"codex-dynamic-1\",\"display_name\":\"Codex Dynamic One\",\"visibility\":\"list\",\"supported_reasoning_levels\":[{\"effort\":\"low\"},{\"effort\":\"medium\"}]}]}'",
        "  exit 0",
        "fi",
        "echo codex-cli 9.9.9",
        "",
      ].join("\n");
  await writeFile(fakeCodex, fakeCodexContent, "utf8");

  try {
    const discovered = await discoverHostAgents({
      search_roots: [tempRoot],
      search_max_depth: 6,
      search_max_entries: 200,
      model: "default",
    });
    const kimi = discovered.agents.find((agent) => agent.provider === "kimi");
    const codex = discovered.agents.find((agent) => agent.provider === "codex");
    assert(codex, "discovery must include Codex provider");
    assert(codex.available === true, "discovery should find fake Codex CLI outside PATH");
    assert(path.resolve(codex.command) === path.resolve(fakeCodex), "discovery should expose the found Codex command");
    assert(codex.version === "codex-cli 9.9.9", "Codex discovery should read the discovered command version");
    assert(codex.model_options.some((option) => option.value === "codex-dynamic-1"), "Codex discovery should expose CLI-native model options from codex debug models");
    assert(codex.model_options.some((option) => option.value === "codex-dynamic-1" && /Codex Dynamic One/.test(option.label)), "Codex native model display names should appear in model options");
    assert(codex.model_options.some((option) => option.value === "gpt-5.6-sol" && option.supported_reasoning_levels?.includes("ultra")), "Codex discovery should expose gpt-5.6-sol ultra reasoning from CLI-native model catalog");
    const selectedSol = await detectHostAgent({
      provider: "codex",
      command: codex.command,
      model: "gpt-5.6-sol",
      reasoning_effort: "ultra",
    });
    assert(selectedSol.selected_model === "gpt-5.6-sol", "Codex should preserve a model advertised by the selected CLI");
    assert(selectedSol.reasoning_effort === "ultra", "Codex should preserve a reasoning level advertised for the selected model");
    const selectedLimited = await detectHostAgent({
      provider: "codex",
      command: codex.command,
      model: "codex-dynamic-1",
      reasoning_effort: "ultra",
    });
    assert(selectedLimited.selected_model === "codex-dynamic-1", "Codex should preserve another advertised model");
    assert(selectedLimited.reasoning_effort === null, "Codex must reject a reasoning level omitted by the selected model catalog entry");
    const selectedStale = await detectHostAgent({
      provider: "codex",
      command: codex.command,
      model: "gpt-stale-not-advertised",
      reasoning_effort: "ultra",
    });
    assert(selectedStale.selected_model === null, "Codex must not preserve a model omitted by the selected CLI catalog");
    assert(selectedStale.reasoning_effort === null, "Codex must not preserve reasoning for an omitted model");
    assert(/not advertised/i.test(selectedStale.model_options_error || ""), "Codex should explain when a requested model is absent from the selected CLI catalog");
    const staleDiscovery = await discoverHostAgents({
      search_roots: [tempRoot],
      search_max_depth: 6,
      search_max_entries: 200,
      model: "gpt-stale-not-advertised",
      reasoning_effort: "ultra",
    });
    const staleDiscoveredCodex = staleDiscovery.agents.find((agent) => agent.provider === "codex");
    assert(staleDiscoveredCodex?.selected_model === null, "Codex discovery must not reintroduce a model rejected by direct CLI catalog detection");
    assert(/not advertised/i.test(staleDiscoveredCodex?.model_options_error || ""), "Codex discovery should preserve the rejected-model diagnostic");
    assert(kimi, "discovery must include Kimi provider");
    assert(kimi.available === true, "discovery should find fake Kimi CLI");
    assert(path.resolve(kimi.command) === path.resolve(fakeKimi), "discovery should expose the found Kimi command");
    assert(kimi.selected_model === null, "Kimi discovery must not inherit Codex/GPT model selections");
    assert(Array.isArray(kimi.model_options), "Kimi discovery should expose provider-native model options");
    assert(kimi.model_options.some((option) => option.value === "kimi-code/kimi-for-coding"), "Kimi configured model aliases should appear in model options");
    assert(kimi.model_options.some((option) => option.value === "kimi-code/kimi-for-coding" && /K2\.7 Code/.test(option.label)), "Kimi native model display names should appear in model options");
    assert(kimi.model_options.some((option) => option.value === "kimi-code/kimi-for-coding-highspeed" && /HighSpeed/.test(option.label)), "Kimi HighSpeed model alias should appear when Kimi Code provider exposes it");
    assert(kimi.model_options.some((option) => option.value === "kimi-code/k3" && option.supported_reasoning_levels?.includes("max")), "Kimi K3 should expose provider-advertised max reasoning");
    assert(!kimi.model_options.some((option) => option.value === "gpt-5.5"), "Kimi model options must not include Codex GPT defaults unless Kimi exposes that alias");

    const selected = await detectHostAgent({
      provider: "kimi",
      command: kimi.command,
      model: "kimi-code/kimi-for-coding-highspeed",
    });
    assert(selected.available === true, "selected Kimi command should be connectable");
    assert(selected.selected_model === "kimi-code/kimi-for-coding-highspeed", "selected Kimi command should preserve the configured provider-native HighSpeed model alias");
    const selectedK3 = await detectHostAgent({
      provider: "kimi",
      command: kimi.command,
      model: "kimi-code/k3",
      reasoning_effort: "max",
    });
    assert(selectedK3.selected_model === "kimi-code/k3", "selected Kimi command should preserve K3");
    assert(selectedK3.reasoning_effort === "max", "Kimi should preserve a reasoning effort advertised by the selected K3 catalog entry");
    assert(selectedK3.capabilities?.reasoning_effort_options?.some((option) => option.value === "max"), "Kimi capabilities should expose K3 max reasoning to the UI");
    const selectedStaleKimi = await detectHostAgent({
      provider: "kimi",
      command: kimi.command,
      model: "kimi-code/stale-model",
      reasoning_effort: "max",
    });
    assert(selectedStaleKimi.selected_model === null, "Kimi must not preserve a model omitted by the selected CLI catalog");
    assert(selectedStaleKimi.reasoning_effort === null, "Kimi must not preserve reasoning for an omitted model");
    assert(/not advertised/i.test(selectedStaleKimi.model_options_error || ""), "Kimi should explain when a requested model is absent from the selected CLI catalog");

    const preload = await readFile("ui/electron/preload.js", "utf8");
    const bridge = await readFile("ui/src/runtimeBridge.ts", "utf8");
    const app = await readFile("ui/src/App.tsx", "utf8");
    const adapter = await readFile("ui/electron/host-adapters.js", "utf8");
    const service = await readFile("ui/electron/runtime-service.js", "utf8");
    const client = await readFile("ui/electron/runtime-daemon-client.js", "utf8");

    for (const [label, source] of [
      ["preload", preload],
      ["runtimeBridge", bridge],
      ["App", app],
      ["runtime-service", service],
    ]) {
      assert(source.includes("discoverHostCliAgents"), `${label} must expose discoverHostCliAgents`);
    }
    assert(!app.includes("Codex / Kimi"), "scan status must not hard-code provider names before discovery results");
    assert(app.includes("hostDiscoveryStatus"), "UI should keep a visible scan status near the CLI list");
    assert(app.includes("hostModelOptions"), "UI should use provider-aware model options");
    assert(app.includes("model: hostModel"), "UI should pass the selected provider-native model alias to the host adapter");
    assert(app.includes("CLI 默认模型"), "UI should expose the resolved CLI default model label when known");
    assert(app.includes("model_options_error"), "UI should show a safe model-list diagnostic when provider model discovery fails");
    assert(!app.includes("selectedHostProvider === \"kimi\" ? \"default\" : hostModel"), "UI must not force Kimi model selection back to default");
    assert(!app.includes("selectedHostProvider === \"kimi\" ? \"default\" : hostReasoning"), "UI must not force Kimi reasoning selection back to default");
    assert(!service.includes("reasoning_effort: provider === \"kimi\" ? \"default\" : payload.reasoning_effort"), "runtime service must not force Kimi reasoning selection back to default");
    assert(app.includes("preferredAvailableHostProvider"), "rescanning should preserve the selected provider when it is still available");
    assert(app.includes("hostCliCandidateStatusLabel"), "UI should distinguish not-found, probe-failed, and browser-preview discovery states");
    assert(service.includes("repoRoot,"), "runtime service should pass the canonical repo root to host CLI discovery");
    assert(adapter.includes("KIMI_MODEL_THINKING_EFFORT"), "Kimi adapter should pass a provider-advertised reasoning effort through the official CLI environment contract");
    assert(service.includes("default_model_label: host.default_model_label"), "runtime state should preserve host default model labels from the adapter");
    assert(service.includes("model_options_error: host.model_options_error"), "runtime state should preserve host model option diagnostics");
    assert(service.includes("sanitizeHostCliDiscovery"), "runtime state load should sanitize stale provider/command discovery candidates");
    assert(service.includes("Discarded stale ${provider} discovery candidate"), "stale discovery candidates should become unavailable instead of remaining selectable");
    assert(app.includes("正在扫描本机 CLI Agent..."), "UI should show a visible in-progress scan state");
    assert(app.includes("扫描完成："), "UI should show a visible completion state");
    assert(app.includes("扫描失败："), "UI should show a visible failure state");
    assert(app.includes("扫描本机 CLI Agent"), "UI should present scan action, not only detect/save");
    assert(app.includes("连接所选 Agent"), "UI should let user connect selected discovered agent");
    assert(app.includes('hostDiscoveryStatus.includes("失败")'), "localized discovery failures must keep warning styling");
    assert(app.includes("hostCandidates.length ? hostCandidates"), "UI should render discovered candidates rather than one hard-coded host");
    assert(app.includes("selectedHostProvider === \"kimi\""), "UI should handle Kimi-specific login guidance after selection");
    assert(client.includes("Unknown runtime action"), "daemon client should detect old reused daemons that lack new actions");
    assert(client.includes("await this.restart()"), "daemon client should restart old reused daemons and retry new actions");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-host-cli-discovery-ui-verification-v1",
      checked: [
        "discover-all-host-agents-api",
        "codex-discovered-outside-path-from-search-root",
        "kimi-discovered-outside-path-from-search-root",
        "selected-kimi-connects-via-provider-command",
        "electron-preload-action-exposed",
        "runtime-bridge-action-exposed",
        "ui-scan-and-select-copy",
        "scan-copy-does-not-hardcode-providers",
        "visible-scan-progress-and-completion",
        "provider-native-model-options",
        "codex-debug-model-options",
        "kimi-provider-model-aliases",
        "stale-provider-command-discovery-sanitizer",
        "old-daemon-action-restart-retry",
      ],
      codex_command: codex.command,
      kimi_command: kimi.command,
    }, null, 2)}\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
