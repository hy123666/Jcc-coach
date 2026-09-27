import { readFile, writeFile } from "node:fs/promises";

const SOURCE_CONTRACT_PATH = "data/runtime/jcc/android-source-contract.json";

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-android-source-health.mjs --probe-report <probe-report.json> [--out <source-health.json>]",
    "",
    "Normalizes a read-only Android probe report into generic ADB source health.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--probe-report") options.probeReport = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function classifyProfile(probe) {
  const device = String(probe.device || "");
  const focus = String(probe.evidence?.focus || "");
  if (device === "127.0.0.1:7555" || /MuMu|ApolloZGame/.test(focus)) return "mumu";
  if (/emulator-\d+|127\.0\.0\.1:\d+/.test(device)) return "generic-adb";
  return "generic-adb";
}

function capability(value, positiveValues) {
  return positiveValues.includes(value) ? "verified" : value ? "not_verified" : "unknown";
}

function buildSourceHealth(probe, contract) {
  const emulatorProfile = classifyProfile(probe);
  const capabilities = {
    adb_transport: capability(probe.verdict?.adb_transport, ["online"]),
    foreground_package: capability(probe.verdict?.foreground_game, ["yes"]),
    external_files: capability(probe.verdict?.public_external_logs, ["readable"]),
    dumpsys: probe.evidence?.focus ? "verified" : "unknown",
    logcat: probe.verdict?.logcat === "readable" ? "verified" : "unknown",
    ui_tree: probe.verdict?.android_ui_tree || "unknown",
    private_app_data: probe.verdict?.private_app_data_without_root || "unknown",
  };

  const nextExperiments = [];
  if (capabilities.logcat !== "verified") nextExperiments.push("Verify adb logcat source with focused in-game capture.");
  if (capabilities.external_files !== "verified") nextExperiments.push("Probe /sdcard/Android/data external readable logs for this emulator.");
  if (capabilities.foreground_package !== "verified") nextExperiments.push("Verify foreground package/activity before live_state ingestion.");
  if (probe.capture_scope !== "in_game") nextExperiments.push("Capture in_game scope for strategy-eligible live_state evidence.");

  return {
    contract_id: "jcc-android-runtime-source-health",
    product_boundary: contract.product_boundary,
    source_contract_ref: SOURCE_CONTRACT_PATH,
    package_id: probe.package_id || "unknown",
    adb_device_id: probe.device || null,
    capture_scope: probe.capture_scope || "unknown",
    emulator_profile: emulatorProfile,
    profile_is_product_boundary: false,
    capabilities,
    source_events: contract.source_events || [],
    allowed_sources: contract.allowed_sources || [],
    forbidden_sources: contract.forbidden_sources || [],
    evidence_summary: {
      foreground_focus: probe.evidence?.focus || null,
      log_summary_count: probe.evidence?.log_summaries?.length || 0,
      pulled_external_logs: probe.evidence?.pulled_net?.ok === true,
    },
    next_experiments: nextExperiments,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.probeReport) throw new Error(`Missing --probe-report\n${usage()}`);
  const probe = JSON.parse(await readFile(options.probeReport, "utf8"));
  const contract = JSON.parse(await readFile(SOURCE_CONTRACT_PATH, "utf8"));
  const health = buildSourceHealth(probe, contract);
  const text = `${JSON.stringify(health, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
