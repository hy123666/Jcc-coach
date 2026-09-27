import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return [
    "Usage:",
    "  node tools/write-jcc-host-agent-json.mjs --out <response.json> [--in <raw.json>]",
    "",
    "Writes host CLI agent response JSON through Node's UTF-8 path.",
    "Use this instead of PowerShell Set-Content for visual/coach response backfill.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--in") options.in = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonText(raw, label) {
  const text = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error(`${label} is empty`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function writeJsonAtomic(file, value) {
  const out = path.resolve(file);
  await mkdir(path.dirname(out), { recursive: true });
  const temp = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  await rename(temp, out);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.out) throw new Error(`Missing --out\n${usage()}`);
  const raw = options.in ? await readFile(path.resolve(options.in), "utf8") : await readStdin();
  const json = parseJsonText(raw, options.in || "stdin");
  await writeJsonAtomic(options.out, json);
  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-host-agent-json-write-result-v1",
    out: path.resolve(options.out),
    writer: "node_utf8_no_bom_atomic",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
