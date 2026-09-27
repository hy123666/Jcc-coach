#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const serverScript = join(repoRoot, "tools", "jcc-runtime-companion-intake-server.mjs");

function message(overrides = {}) {
  return {
    schema: "jcc-android-companion-runtime-intake-v1",
    type: "frame_meta",
    match_session_id: "match:test:001",
    capture_session_id: "capture:test:001",
    frame_seq: 1,
    monotonic_ms: 1234,
    observed_at_epoch_ms: 1760000000000,
    game_package: "com.tencent.jkchess",
    orientation: 90,
    resolution: { width: 1920, height: 1080 },
    storage_policy: "no_frame_or_screenshot_persistence",
    ...overrides,
  };
}

function startServer(port, output) {
  const child = spawn(process.execPath, [
    serverScript,
    "--port",
    String(port),
    "--match-session-id",
    "match:test:001",
    "--output",
    output,
    "--max-messages",
    "5",
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

function waitForListen(handle) {
  return new Promise((resolveWait, rejectWait) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (handle.getStderr().includes('"event":"listen"')) {
        clearInterval(timer);
        resolveWait();
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        rejectWait(new Error(`server did not start\nstderr=${handle.getStderr()}`));
      }
    }, 50);
  });
}

function sendLines(port, lines) {
  return new Promise((resolveSend, rejectSend) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      for (const line of lines) {
        socket.write(JSON.stringify(line));
        socket.write("\n");
      }
      socket.end();
    });
    socket.on("error", rejectSend);
    socket.on("close", resolveSend);
  });
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("exit", (code) => resolveExit(code));
  });
}

function assert(condition, messageText) {
  if (!condition) throw new Error(messageText);
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), "jcc-companion-intake-"));
  const output = join(temp, "accepted.jsonl");
  const port = 49387;
  try {
    const handle = startServer(port, output);
    await waitForListen(handle);
    await sendLines(port, [
      message({ frame_seq: 1 }),
      message({ frame_seq: 2, match_session_id: "match:old:999" }),
      message({ frame_seq: 3, frame_base64: "forbidden" }),
      message({ frame_seq: 4, type: "semantic_observations", promotion_status: "candidate_only", observations: { kind: "capture_started", confidence: 1 } }),
      message({ frame_seq: 5, type: "heartbeat" }),
      message({ frame_seq: 6, type: "roi_observations", promotion_status: "candidate_only", observations: { slot_occupancy: [] } }),
      message({ frame_seq: 7, type: "ocr_text_blocks", promotion_status: "candidate_only", blocks: { blocks: [] } }),
    ]);
    const code = await waitForExit(handle.child);
    assert(code === 0, `server exited with code ${code}\nstderr=${handle.getStderr()}`);

    const outputText = await readFile(output, "utf8");
    const accepted = outputText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert(accepted.length === 5, `expected 5 accepted messages, got ${accepted.length}`);
    assert(accepted.every((row) => row.match_session_id === "match:test:001"), "accepted output contains wrong match_session_id");
    assert(!outputText.includes("frame_base64"), "forbidden frame payload leaked into persisted output");

    const stderr = handle.getStderr();
    assert(stderr.includes('"event":"quarantine"'), "mismatched match session was not quarantined");
    assert(stderr.includes("frame payload field frame_base64 is forbidden by default"), "frame payload guard did not fire");

    console.log(JSON.stringify({
      ok: true,
      checks: [
        "valid companion messages accepted",
        "mismatched match_session_id quarantined",
        "frame payload persistence rejected by default",
        "semantic observations remain candidate_only",
        "ROI observations remain candidate_only",
        "OCR text blocks remain candidate_only",
      ],
      output,
    }, null, 2));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
