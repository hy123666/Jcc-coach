import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/extract-jcc-mumu-gi-events-from-companion-log.mjs --input <companion.jsonl> [--out <events.jsonl>]",
    "",
    "Extracts MuMu gi_plugin_jkchess bridge messages from companion runtime JSONL.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--input") options.input = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseGiParams(params) {
  const text = String(params || "").trim();
  const match = /^(\d+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  const command = Number(match[1]);
  const payloadText = (match[2] || "").trim();
  let payload = {};
  if (payloadText) payload = JSON.parse(payloadText);
  return { command, payload };
}

function lines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.input) throw new Error("Missing --input");
  const out = [];
  for (const line of lines(await readFile(options.input, "utf8"))) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type !== "mumu_gi_message") continue;
    if (message.plugin_name !== "gi_plugin_jkchess") continue;
    const parsed = parseGiParams(message.params);
    if (!parsed) continue;
    out.push(JSON.stringify({
      command: parsed.command,
      payload: parsed.payload,
      match_session_id: message.match_session_id || null,
      capture_session_id: message.capture_session_id || null,
      observed_at_epoch_ms: message.observed_at_epoch_ms || null,
      source: "android_companion_mumu_gi_message",
    }));
  }
  const text = `${out.join("\n")}${out.length ? "\n" : ""}`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
