import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/extract-jcc-mumu-gi-events-from-logcat.mjs --input <logcat.txt> [--out <events.jsonl>] [--match-session-id <id>]",
    "",
    "Extracts MuMu nemuinit gi_plugin_jkchess messages from adb logcat text.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--input") options.input = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseLine(line) {
  const match = /start name:\s*gi_plugin_jkchess,\s*operation:\s*(\d+)(?:\s+(\{.*\}))?,\s*id:\s*(\d+)/.exec(line);
  if (!match) return null;
  const command = Number(match[1]);
  if (!Number.isInteger(command)) return null;
  const payloadText = match[2] || "{}";
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  return {
    command,
    payload,
    nemuinit_message_id: Number(match[3]),
    source: "adb_logcat_nemuinit_gi_plugin_jkchess",
  };
}

function dedupeKey(event) {
  return `${event.nemuinit_message_id}:${event.command}:${JSON.stringify(event.payload)}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.input) throw new Error("Missing --input");
  const seen = new Set();
  const events = [];
  const text = await readFile(options.input, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const event = parseLine(line);
    if (!event) continue;
    const key = dedupeKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    if (options.matchSessionId) event.match_session_id = options.matchSessionId;
    events.push(JSON.stringify(event));
  }
  const output = `${events.join("\n")}${events.length ? "\n" : ""}`;
  if (options.out) await writeFile(options.out, output, "utf8");
  else process.stdout.write(output);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
