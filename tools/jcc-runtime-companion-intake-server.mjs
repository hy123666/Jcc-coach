#!/usr/bin/env node
import net from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_PORT = 49377;
const DEFAULT_HOST = "127.0.0.1";
const SCHEMA = "jcc-android-companion-runtime-intake-v1";
const ALLOWED_TYPES = new Set(["frame_meta", "roi_observations", "ocr_text_blocks", "semantic_observations", "heartbeat"]);

function parseArgs(argv) {
  const args = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    expectedMatchSessionId: null,
    output: null,
    maxMessages: 0,
    allowFramePayloads: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") args.host = argv[++i];
    else if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--match-session-id") args.expectedMatchSessionId = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--max-messages") args.maxMessages = Number(argv[++i]);
    else if (arg === "--allow-frame-payloads") args.allowFramePayloads = true;
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node tools/jcc-runtime-companion-intake-server.mjs [options]

Options:
  --host <host>                    Listen host. Default: ${DEFAULT_HOST}
  --port <port>                    Listen port. Default: ${DEFAULT_PORT}
  --match-session-id <id>          Drop/quarantine messages from other matches.
  --output <path>                  Persist accepted semantic JSONL messages only.
  --max-messages <n>               Exit after n accepted messages. 0 means run until interrupted.
  --allow-frame-payloads           Debug-only escape hatch; disabled by default.
`);
}

function validateMessage(message, args) {
  const errors = [];
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, errors: ["message must be a JSON object"] };
  }
  if (message.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  if (!ALLOWED_TYPES.has(message.type)) errors.push(`type must be one of ${Array.from(ALLOWED_TYPES).join(", ")}`);
  for (const field of ["match_session_id", "capture_session_id", "frame_seq", "monotonic_ms", "game_package", "orientation", "resolution"]) {
    if (!(field in message)) errors.push(`missing ${field}`);
  }
  if (args.expectedMatchSessionId && message.match_session_id !== args.expectedMatchSessionId) {
    errors.push(`match_session_id mismatch: expected ${args.expectedMatchSessionId}, got ${message.match_session_id}`);
  }
  if (!args.allowFramePayloads) {
    for (const field of ["frame_base64", "image_base64", "png_base64", "jpeg_base64", "webp_base64", "raw_rgba_base64"]) {
      if (field in message) errors.push(`frame payload field ${field} is forbidden by default`);
    }
  }
  if (message.storage_policy && message.storage_policy !== "no_frame_or_screenshot_persistence") {
    errors.push("storage_policy must remain no_frame_or_screenshot_persistence when present");
  }
  if (message.resolution && (typeof message.resolution.width !== "number" || typeof message.resolution.height !== "number")) {
    errors.push("resolution.width and resolution.height must be numbers");
  }
  if (typeof message.frame_seq !== "number" || message.frame_seq < 0) errors.push("frame_seq must be a non-negative number");
  if (["semantic_observations", "roi_observations", "ocr_text_blocks"].includes(message.type) && message.promotion_status !== "candidate_only") {
    errors.push(`${message.type} from companion must remain candidate_only until runtime promotion`);
  }
  return { ok: errors.length === 0, errors };
}

async function appendLine(path, line) {
  if (!path) return;
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, line + "\n", { flag: "a", encoding: "utf8" });
}

async function main() {
  const args = parseArgs(process.argv);
  let accepted = 0;
  let rejected = 0;
  let quarantined = 0;

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          rejected += 1;
          console.error(JSON.stringify({ event: "reject", reason: "invalid_json", error: String(error.message) }));
          continue;
        }
        const validation = validateMessage(parsed, args);
        if (!validation.ok) {
          const mismatch = validation.errors.some((error) => error.startsWith("match_session_id mismatch"));
          if (mismatch) quarantined += 1;
          else rejected += 1;
          console.error(JSON.stringify({ event: mismatch ? "quarantine" : "reject", errors: validation.errors, message_type: parsed.type ?? null }));
          continue;
        }
        accepted += 1;
        const normalized = JSON.stringify(parsed);
        await appendLine(args.output, normalized);
        console.log(JSON.stringify({ event: "accept", type: parsed.type, match_session_id: parsed.match_session_id, frame_seq: parsed.frame_seq, accepted, rejected, quarantined }));
        if (args.maxMessages > 0 && accepted >= args.maxMessages) {
          server.close();
          socket.end();
        }
      }
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(args.port, args.host, resolveListen);
  });
  console.error(JSON.stringify({ event: "listen", host: args.host, port: args.port, schema: SCHEMA }));

  await new Promise((resolveClose) => server.on("close", resolveClose));
  console.error(JSON.stringify({ event: "closed", accepted, rejected, quarantined }));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
