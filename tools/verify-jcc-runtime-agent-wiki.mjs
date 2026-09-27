import { access, readFile } from "node:fs/promises";
import path from "node:path";

const WIKI_ROOT = "data/runtime/jcc/runtime-agent-wiki";
const INDEX = path.join(WIKI_ROOT, "index.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file) {
  return readFile(file, "utf8");
}

async function main() {
  const index = JSON.parse(await readText(INDEX));
  assert(index.schema === "jcc-runtime-agent-wiki-index-v1", "unexpected wiki index schema");
  assert(/not an OMX development wiki/i.test(index.purpose), "wiki purpose must distinguish OMX wiki");
  assert(/not a strategy data source/i.test(index.purpose), "wiki purpose must forbid strategy use");
  assert(index.namespaces?.official?.mutable_by_runtime_agent === false, "official namespace must be immutable to runtime agents");
  assert(index.namespaces?.user_memory?.mutable_by_runtime_agent === true, "user_memory namespace must be runtime-agent mutable through memory writer");
  assert(index.source_policy?.strategy_inputs?.includes("current match live_state"), "live_state must be a strategy input");
  assert(index.source_policy?.strategy_inputs?.includes("user-confirmed current-match variables"), "manual current-match variables must be a strategy input");
  const forbiddenStrategySources = new Set(index.source_policy?.forbidden_strategy_sources || []);
  for (const source of [
    "runtime-agent wiki prose",
    "MuMu lus.json",
    "MuMu lineup_index",
    "MuMu user_lineup",
    "unverified debug logs",
    "previous-match observations",
  ]) {
    assert(forbiddenStrategySources.has(source), `missing forbidden strategy source: ${source}`);
  }

  for (const page of index.pages || []) {
    const pagePath = path.join(WIKI_ROOT, page.path);
    assert(await exists(pagePath), `missing wiki page: ${page.path}`);
  }

  const readme = await readText(path.join(WIKI_ROOT, "README.md"));
  assert(readme.includes("Runtime strategy must use"), "README must list strategy source order");
  assert(readme.includes("Current Runtime Source Order"), "README must include runtime source order");
  assert(readme.includes("User memory can influence"), "README must define user memory boundary");
  assert(readme.includes("Detect MuMu and Connect"), "README must capture the future one-click MuMu UI requirement");
  assert(readme.includes("Optional Current-Match Variables"), "README must capture optional current-match variables");

  const mumuRuntime = await readText(path.join(WIKI_ROOT, "official", "mumu-desktop-runtime.md"));
  assert(mumuRuntime.includes("Future UI Requirement"), "MuMu runtime page must capture future UI requirement");
  assert(mumuRuntime.includes("tools/start-jcc-mumu-runtime-watch.mjs --dry-run"), "MuMu runtime page must point UI health check at autodiscovery wrapper");
  assert(mumuRuntime.includes("Manual Match Variables"), "MuMu runtime page must capture manual match variable UI");
  assert(mumuRuntime.includes("manual_match_variables_confirmed"), "MuMu runtime page must name manual variable event");

  const quickstart = await readText(path.join(WIKI_ROOT, "official", "quickstart.md"));
  assert(quickstart.startsWith("# Quickstart"), "quickstart page must be the overall setup tutorial");
  assert(quickstart.includes("MuMu GI bridge path"), "quickstart page must mention the MuMu gameassist/GI bridge setup step");
  assert(quickstart.includes("not the whole setup"), "quickstart must not frame gameassist as the whole tutorial");
  assert(quickstart.includes("Detect MuMu and Connect"), "quickstart page must include one-click connect action");
  assert(quickstart.includes("Match Variables"), "quickstart page must include optional match variables");

  const obsoleteOcrRunbook = `${["on", "demand", "ocr"].join("-")}-runbook.md`;
  assert(!(await exists(path.join(WIKI_ROOT, "official", obsoleteOcrRunbook))), "obsolete legacy visual runbook must not exist in product wiki");
  const visualSensingRunbook = await readText(path.join(WIKI_ROOT, "official", "host-multimodal-visual-sensing-runbook.md"));
  assert(/Host Multimodal Visual Sensing Runbook/.test(visualSensingRunbook), "visual sensing runbook title mismatch");
  assert(/Do not persist screenshots by default/i.test(visualSensingRunbook), "visual sensing runbook must forbid raw screenshot persistence");
  assert(visualSensingRunbook.includes("mumu-catalog-overlay"), "visual sensing runbook must reference MuMu catalog overlay");
  assert(visualSensingRunbook.includes("visual-icons/manifest"), "visual sensing runbook must reference icon manifest as reference data");

  const userMemory = await readText(path.join(WIKI_ROOT, "user-memory", "README.md"));
  assert(/allowed memory/i.test(userMemory), "user memory page must define allowed memory");
  assert(/forbidden memory/i.test(userMemory), "user memory page must define forbidden memory");

  console.log(JSON.stringify({
    ok: true,
    wiki_root: WIKI_ROOT,
    checked_pages: index.pages.map((page) => page.path),
    boundaries: {
      official_mutable_by_runtime_agent: index.namespaces.official.mutable_by_runtime_agent,
      user_memory_mutable_by_runtime_agent: index.namespaces.user_memory.mutable_by_runtime_agent,
      wiki_is_strategy_source: false,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
