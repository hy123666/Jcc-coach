import { registerHooks } from "node:module";

// Inherited through NODE_OPTIONS, including child Node processes and workers.
// Do not change adapters or silently substitute a successful model response.
registerHooks({
  load(url, context, nextLoad) {
    const target = new URL(url);
    if (!target.pathname.endsWith("/ui/electron/host-adapters.js") || target.searchParams.has("gate-original")) {
      return nextLoad(url, context);
    }
    target.searchParams.set("gate-original", "1");
    return {
      format: "module",
      shortCircuit: true,
      source: `
export * from ${JSON.stringify(target.href)};
function forbiddenProviderCall() {
  const error = new Error("deterministic_gate_provider_call_forbidden");
  process.stderr.write(error.message + "\\n");
  process.once("exit", () => { process.exitCode = 1; });
  throw error;
}
export const runHostAgentRequest = forbiddenProviderCall;
export const detectHostAgent = forbiddenProviderCall;
export const discoverHostAgents = forbiddenProviderCall;
`,
    };
  },
});
