import { readFile } from "node:fs/promises";

const DEFAULT_REPORT = ".omx/runtime-evidence/jcc-il2cpp-static-current/il2cpp-static-hints.json";

function parseArgs(argv) {
  const options = { report: DEFAULT_REPORT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--report") options.report = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-apk-il2cpp-hints.mjs [--report <il2cpp-static-hints.json>]",
    "",
    "Verifies IL2CPP/APK static hints remain candidate-only and do not claim current live_state.",
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

  const report = JSON.parse(await readFile(options.report, "utf8"));
  assert(report.schema_version === 1, "schema_version must be 1");
  assert(report.product_boundary === "jcc_installed_apk_il2cpp_static_hints", "product boundary mismatch");
  assert(report.scan_scope === "copied_local_apk_selected_entries_only", "scan scope must be copied selected entries only");
  assert(report.source_decision?.status_kind === "static_il2cpp_source_discovery_only", "status kind must be static-only");
  assert(report.source_decision?.live_state_promotion_status === "forbidden_without_runtime_local_binding", "must forbid live_state promotion");
  assert(/Never merge IL2CPP\/APK static hints/i.test(report.source_decision?.pollution_guard || ""), "pollution guard missing");

  const entries = report.extracted_entries || [];
  const metadata = entries.find((entry) => entry.name?.endsWith("global-metadata.dat"));
  const lib = entries.find((entry) => entry.name === "lib/arm64-v8a/libil2cpp.so");
  assert(metadata?.present && metadata?.extracted, "global-metadata.dat must be extracted when present in current APK");
  assert(lib?.present && lib?.extracted, "arm64 libil2cpp.so must be extracted when present in current APK");
  assert(lib.string_summary?.protocol?.terms?.includes("InGameRoundFlow"), "libil2cpp hints must include InGameRoundFlow");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "selected local APK entries only",
      "candidate-only IL2CPP hints",
      "no live_state promotion",
      "global metadata extracted",
      "libil2cpp InGameRoundFlow hint",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
