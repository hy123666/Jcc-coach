import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-apk-static-"));
  try {
    const apkRoot = path.join(tempDir, "apk");
    const outDir = path.join(tempDir, "out");
    await mkdir(apkRoot, { recursive: true });
    await writeFile(path.join(apkRoot, "base.apk"), [
      "global-metadata.dat",
      "libil2cpp.so",
      "libGameCore.so",
      "FileDescriptorProto",
      "google.protobuf.MessageLite",
      "InGameRoundFlow",
      "AITreeNode_SellChess",
      "board_units",
      "bench_units",
      "Board Bench Shop",
      "schema.proto",
    ].join("\n"), "utf8");

    const result = await runNode([
      "tools/discover-jcc-apk-static-source.mjs",
      "--apk-root",
      apkRoot,
      "--out-dir",
      outDir,
    ]);
    assert(result.code === 0, `discovery exited ${result.code}\n${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    const discovery = JSON.parse(await readFile(summary.out, "utf8"));

    assert(discovery.schema_version === 1, "schema_version must be 1");
    assert(discovery.product_boundary === "jcc_installed_apk_static_source", "product boundary mismatch");
    assert(discovery.scan_scope === "copied_local_apk_only", "scan scope must be local copied APK only");
    assert(discovery.source_contract_ref === "data/runtime/jcc/apk-static-source-contract.json", "contract ref mismatch");
    assert(discovery.source_provenance?.local_evidence_dir === outDir, "source provenance must name local evidence dir");
    assert(discovery.source_provenance?.local_apk_root === apkRoot, "source provenance must name local APK root");
    assert(discovery.source_provenance?.copied_files?.every((file) => file.startsWith(apkRoot)), "copied file provenance must stay inside local APK root");
    assert(discovery.source_decision.status === "candidate_static_hints_found", "fixture terms should produce candidate hints");
    assert(discovery.source_decision.status_kind === "static_apk_source_discovery_only", "status kind must be static-only");
    assert(discovery.source_decision.proto_descriptor_status === "candidate_terms_found", "proto terms should be candidate-only");
    assert(discovery.source_decision.il2cpp_status === "candidate_terms_found", "il2cpp terms should be candidate-only");
    assert(discovery.source_decision.live_state_promotion_status === "forbidden_without_runtime_local_binding", "static source must not promote live_state");
    assert(/Never merge APK static candidates/i.test(discovery.source_decision.pollution_guard), "pollution guard must be explicit");
    assert(discovery.forbidden_sources.includes("SSL pinning bypass"), "forbidden sources must reject SSL pinning bypass");
    assert(discovery.forbidden_sources.includes("Frida hooks"), "forbidden sources must reject Frida hooks");
    assert(discovery.static_evidence.aggregate.groups.proto.matched === true, "aggregate proto evidence missing");
    assert(discovery.static_evidence.aggregate.groups.board_bench_shop.matched === true, "aggregate board/bench/shop evidence missing");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "read-only APK static boundary",
        "local copied APK scan provenance",
        "proto/il2cpp/runtime terms remain candidates",
        "no live_state promotion",
        "pollution guard",
        "forbidden bypass sources",
      ],
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
