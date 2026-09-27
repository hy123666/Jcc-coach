import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-source-health-"));
  try {
    const probeFile = path.join(tempDir, "probe-report.json");
    const outFile = path.join(tempDir, "source-health.json");
    await writeFile(probeFile, JSON.stringify({
      ok: true,
      package_id: "com.tencent.jkchess",
      device: "127.0.0.1:7555",
      capture_scope: "in_game",
      verdict: {
        adb_transport: "online",
        foreground_game: "yes",
        android_ui_tree: "unity_surface_only_no_structured_text",
        public_external_logs: "readable",
        direct_live_state_from_current_sample: "unproven_terms_only",
        server_event_names_from_current_sample: "present",
      },
      evidence: {
        focus: "mCurrentFocus=Window{ com.tencent.jkchess/com.tencent.jkchess.ApolloZGame }",
        pulled_net: { ok: true },
        log_summaries: [
          { file: "21_39_33", counts: { shop: 3, Battle: 9 }, evidence: { shop: ["TAC_GenerateHeroListFromHeroPool"] } },
        ],
      },
    }, null, 2), "utf8");

    const result = await runNode([
      "tools/build-jcc-android-source-health.mjs",
      "--probe-report",
      probeFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `source health builder exited ${result.code}\n${result.stderr}`);

    const health = JSON.parse(await readFile(outFile, "utf8"));
    assert(health.contract_id === "jcc-android-runtime-source-health", "contract id mismatch");
    assert(health.product_boundary === "generic_android_adb_source", "source health must keep generic boundary");
    assert(health.emulator_profile === "mumu", "127.0.0.1:7555 should classify as mumu sample profile");
    assert(health.profile_is_product_boundary === false, "MuMu profile must not become product boundary");
    assert(health.capabilities.adb_transport === "verified", "adb transport should be verified");
    assert(health.capabilities.foreground_package === "verified", "foreground package should be verified");
    assert(health.capabilities.external_files === "verified", "external file source should be verified");
    assert(health.capabilities.logcat === "unknown", "logcat should remain unknown unless probe proves it");
    assert(health.source_events.includes("raw_event") && health.source_events.includes("candidate_signal"), "source events must be declared");
    assert(health.forbidden_sources.includes("anti-cheat bypass"), "forbidden sources must carry through");
    assert(health.next_experiments.some((entry) => entry.includes("logcat")), "logcat missing capability should produce next experiment");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "generic ADB product boundary",
        "MuMu sample profile classification",
        "capability normalization",
        "forbidden sources carried through",
        "next experiments emitted",
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
