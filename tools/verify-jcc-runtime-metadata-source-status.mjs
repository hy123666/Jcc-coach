import { readFile } from "node:fs/promises";

const DEFAULT_LIVE_STATE = ".omx/runtime-evidence/android-probe-ingame-20260605-214908/match-live-state.json";

function parseArgs(argv) {
  const options = { liveState: DEFAULT_LIVE_STATE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-runtime-metadata-source-status.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies populated runtime metadata fields are not left as missing in field_status.",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const snapshot = JSON.parse(await readFile(options.liveState, "utf8"));
  const liveState = snapshot.live_state || {};
  const metadata = liveState.metadata || {};
  const fieldStatus = liveState.field_status || {};

  assert(metadata.source_health?.contract_id === "jcc-android-runtime-source-health", "metadata.source_health must be attached");
  assert(metadata.adb_device_id === metadata.source_health.adb_device_id, "metadata.adb_device_id must mirror source health");
  assert(metadata.emulator_profile === metadata.source_health.emulator_profile, "metadata.emulator_profile must mirror source health");
  assert(metadata.foreground_package === metadata.source_health.package_id, "metadata.foreground_package must mirror source health package");
  assert(metadata.freshness?.active_window_signal_count === snapshot.source?.active_signal_count, "metadata.freshness must mirror active signal count");

  for (const field of [
    "metadata.source_health",
    "metadata.adb_device_id",
    "metadata.emulator_profile",
    "metadata.foreground_package",
    "metadata.freshness",
  ]) {
    assert(fieldStatus[field]?.status === "verified", `${field} must be verified`);
    assert(fieldStatus[field]?.evidence, `${field} must carry evidence`);
    assert(fieldStatus[field]?.source_type === "adb_probe_metadata", `${field} must use adb_probe_metadata source_type`);
    assert(!liveState.missing_fields?.includes(field), `${field} must not remain missing`);
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "source health metadata is attached",
      "ADB device, emulator profile, foreground package mirror source health",
      "freshness metadata mirrors active signal evidence",
      "metadata field_status entries are verified with evidence",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
