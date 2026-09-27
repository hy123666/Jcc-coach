import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostAgentRequest } from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-codex-empty-response-"));
  try {
    const shim = path.join(temp, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
    if (process.platform === "win32") {
      await writeFile(shim, "@echo off\r\nexit /b 0\r\n", "utf8");
    } else {
      await writeFile(shim, "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
    }

    const result = await runHostAgentRequest({
      provider: "codex",
      available: true,
      command: shim,
      selected_model: null,
      reasoning_effort: null,
    }, "{\"hello\":\"world\"}", {
      parseJson: true,
      repoRoot: path.resolve("."),
      hostCwd: temp,
      timeoutMs: 5000,
    });

    assert(result.ok === false, "empty Codex stream should fail");
    assert(!/Host CLI returned empty response/i.test(result.error || ""), "Codex empty response must not regress to generic empty response");
    assert(/Codex CLI returned no assistant text/i.test(result.error || ""), "Codex empty response should identify the Codex CLI adapter");
    assert(/command=/i.test(result.error || ""), "Codex empty response should include command diagnostics");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      checked: ["codex-empty-response-provider-diagnostics"],
    }, null, 2)}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
