import { detectHostAgent, runHostAgentRequest } from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function lower(value) {
  return String(value || "").toLowerCase();
}

async function main() {
  const wrongKimiCommand = "G:\\OneDrive\\000-AI\\000-001-VIBE-CODE\\CLI Launchers\\kimi.cmd";
  const codex = await detectHostAgent({
    provider: "codex",
    command: wrongKimiCommand,
    model: "default",
    reasoning_effort: "default",
  });

  assert(codex.provider === "codex", "codex detector must keep provider=codex");
  assert(!lower(codex.command).includes("kimi.cmd"), "codex detector must ignore a stale Kimi launcher command");
  assert(!lower(codex.model_options_error).includes("unknown command 'debug'"), "codex model probing must not run kimi debug models");
  if (codex.available) {
    assert(lower(codex.command).includes("codex"), "available codex detector must resolve a Codex command");
  }

  const wrongCodexCommand = codex.command || "C:\\Users\\hyy\\AppData\\Local\\OpenAI\\Codex\\omx-cli-bin\\codex.cmd";
  const kimi = await detectHostAgent({
    provider: "kimi",
    command: wrongCodexCommand,
    model: "default",
    reasoning_effort: "default",
  });

  assert(kimi.provider === "kimi", "kimi detector must keep provider=kimi");
  assert(!lower(kimi.command).includes("codex.cmd"), "kimi detector must ignore a stale Codex launcher command");
  if (kimi.available) {
    assert(lower(kimi.command).includes("kimi"), "available kimi detector must resolve a Kimi command");
  }

  const unknownDetect = await detectHostAgent({ provider: "definitely-not-a-host-provider" });
  assert(unknownDetect.available === false, "unknown provider detection must fail explicitly");
  assert(/Unsupported host provider/i.test(unknownDetect.error || ""), "unknown provider detection must expose unsupported provider error");

  const unknownRun = await runHostAgentRequest({ provider: "definitely-not-a-host-provider" }, "{}", { parseJson: true });
  assert(unknownRun.ok === false, "unknown provider run must fail explicitly");
  assert(/Unsupported host provider/i.test(unknownRun.error || ""), "unknown provider run must not silently fall back to Codex");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "codex-detector-ignores-kimi-command",
      "kimi-detector-ignores-codex-command",
      "unknown-provider-does-not-fallback-to-codex",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
