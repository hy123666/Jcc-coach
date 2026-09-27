import { spawn } from "node:child_process";
import { detectHostAgent } from "../ui/electron/host-adapters.js";

function commandShimSpec(command, args) {
  const lower = String(command || "").toLowerCase();
  if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    return { command: "cmd.exe", args: ["/d", "/c", command, ...args] };
  }
  return { command, args };
}

async function main() {
  const detected = await detectHostAgent({
    provider: "kimi",
    model: process.env.JCC_KIMI_MODEL || "default",
  });

  if (!detected.available || !detected.command) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      schema: "jcc-kimi-cli-login-v1",
      status: "external_dependency_pending",
      reason: detected.error || "Kimi CLI not found",
      attempts: detected.attempts || [],
      next_step: "Install Kimi CLI, set KIMI_BIN, choose a command in settings, or add the Kimi CLI bin directory to PATH.",
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const spec = commandShimSpec(detected.command, ["login"]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-kimi-cli-login-v1",
    status: "launching_login_flow",
    provider: "kimi",
    command: detected.command,
    version: detected.version || null,
    note: "Follow the Kimi CLI login prompt, then run npm run runtime:live:kimi.",
  }, null, 2)}\n`);

  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: false,
    shell: false,
  });

  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
  child.on("error", (error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
