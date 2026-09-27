import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const EXPECTED_UTF8 = {
  champion: "\u4f0a\u6cfd\u745e\u5c14",
  item: "\u65e0\u7528\u5927\u68d2",
  augment: "\u6e05\u6670\u5934\u8111",
};

function hasMojibake(value) {
  const text = String(value ?? "");
  if (text.includes("\uFFFD")) return true;
  return /[绱鍗媺瑙璧鐨锛閼闁鐎閸閺閻閹娴姒][\u4e00-\u9fffA-Za-z0-9+]{1,12}/.test(text);
}

function hasUiMojibake(value) {
  const text = String(value ?? "");
  return hasMojibake(text) || /\u951b|\u9286|\u9225|\u95c2\?/.test(text);
}

function walk(value, pathLabel = "$", hits = []) {
  if (value == null) return hits;
  if (typeof value === "string") {
    if (hasMojibake(value)) hits.push({ path: pathLabel, value });
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${pathLabel}[${index}]`, hits));
    return hits;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) walk(entry, `${pathLabel}.${key}`, hits);
  }
  return hits;
}

function nameScopedHits(value) {
  return walk(value).filter((hit) => /name|label|title|trait|augment|item|unit|champion/i.test(hit.path)).slice(0, 8);
}

const catalog = await readJson("data/runtime/jcc/mumu-catalog-overlay.json");
const names = {
  champion: catalog.champions_by_id?.["11451"]?.name,
  item: catalog.items_by_id?.["1003"]?.name,
  augment: catalog.augments_by_id?.["1011"]?.name,
};
assert(names.champion === EXPECTED_UTF8.champion, `catalog champion name corrupted: ${JSON.stringify(names.champion)}`);
assert(names.item === EXPECTED_UTF8.item, `catalog item name corrupted: ${JSON.stringify(names.item)}`);
assert(names.augment === EXPECTED_UTF8.augment, `catalog augment name corrupted: ${JSON.stringify(names.augment)}`);

const catalogHits = nameScopedHits(catalog);
assert(catalogHits.length === 0, `catalog contains mojibake-like names: ${JSON.stringify(catalogHits, null, 2)}`);

const outputContract = await readJson("data/runtime/jcc/cruise-agent-output-loop-contract.json");
assert(
  outputContract.runtime_json_read_policy?.trusted_reader === "node_fs_readFile_utf8_json_parse",
  "runtime JSON read policy must require Node UTF-8 JSON parsing",
);
assert(
  outputContract.runtime_json_read_policy?.powershell_console_output_trusted_for_chinese_correctness === false,
  "PowerShell console output must not be trusted for Chinese correctness",
);
assert(
  outputContract.runtime_json_write_policy?.trusted_writer_tool === "tools/write-jcc-host-agent-json.mjs",
  "host response JSON write policy must require the Node writer tool",
);
assert(
  outputContract.runtime_json_write_policy?.powershell_set_content_allowed_for_host_response_json === false,
  "PowerShell Set-Content must not be allowed for host response JSON backfill",
);
assert(
  outputContract.ai_native_output_policy?.host_model_contract?.final_user_visible_text_must_come_from_host_model === true,
  "final user-visible advice must come from the host CLI main model",
);
assert(
  outputContract.ai_native_output_policy?.host_model_contract?.backend_latest_backend_draft_must_not_be_displayed_as_final === true,
  "backend latest_backend_draft must not be displayed as final advice",
);
assert(
  outputContract.ai_native_output_policy?.host_model_contract?.watcher_latest_advice_must_remain_null_until_host_response === true,
  "watcher latest_advice must remain null until host response exists",
);

const mainlineSources = [
  "tools/run-jcc-vision-model-observation.mjs",
  "tools/run-jcc-multimodal-runtime-observation.mjs",
  "tools/build-jcc-vision-reference-pack.mjs",
  "tools/stage-jcc-s18-hard-data.mjs",
  "data/runtime/jcc/runtime-mode-sensing-map.json",
  "data/runtime/jcc/vision-model-sensing-contract.json",
  "data/runtime/jcc/cruise-agent-output-loop-contract.json",
  "data/runtime/jcc/lineup-display-contract.json",
];
for (const file of mainlineSources) {
  const text = await readFile(file, "utf8");
  assert(!hasMojibake(text), `${file} contains mojibake-like mainline text`);
}

const productUiSources = ["ui/src/App.tsx", "ui/src/runtimeBridge.ts"];
for (const file of productUiSources) {
  const text = await readFile(file, "utf8");
  assert(!hasUiMojibake(text), `${file} contains mojibake-like product UI text`);
}

try {
  const pointer = await readJson(".omx/runtime-evidence/mumu-gi-live/current-augment-reroll-source-test.json");
  const liveStateFile = pointer?.out_dir ? path.join(pointer.out_dir, "cruise-live-state.json") : null;
  if (liveStateFile) {
    const liveState = await readJson(liveStateFile);
    const liveHits = nameScopedHits(liveState);
    assert(liveHits.length === 0, `current live context contains mojibake-like names: ${JSON.stringify(liveHits, null, 2)}`);
  }
} catch {
  // Optional live watcher pointer may not exist on clean machines.
}

const writerTool = await readFile("tools/write-jcc-host-agent-json.mjs", "utf8");
assert(writerTool.includes("writeJsonAtomic"), "host response writer must write JSON atomically");
assert(writerTool.includes("replace(/^\\uFEFF/, \"\")"), "host response writer must strip BOM before parsing input");
const tmp = await mkdtemp(path.join(tmpdir(), "jcc-host-json-writer-"));
const rawResponseFile = path.join(tmp, "raw-response.json");
const cleanResponseFile = path.join(tmp, "clean-response.json");
await writeFile(rawResponseFile, `\uFEFF${JSON.stringify({
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  final_text: "\u4e2d\u6587\u56de\u586b\u6b63\u5e38",
}, null, 2)}\n`, "utf8");
const writerRun = await runNode([
  "tools/write-jcc-host-agent-json.mjs",
  "--in",
  rawResponseFile,
  "--out",
  cleanResponseFile,
]);
assert(writerRun.code === 0, `host response JSON writer failed: ${writerRun.stderr || writerRun.stdout}`);
const cleanBytes = await readFile(cleanResponseFile);
assert(!(cleanBytes[0] === 0xef && cleanBytes[1] === 0xbb && cleanBytes[2] === 0xbf), "host response JSON writer must not write BOM");
const cleanJson = JSON.parse(cleanBytes.toString("utf8"));
assert(cleanJson.final_text === "\u4e2d\u6587\u56de\u586b\u6b63\u5e38", "host response JSON writer must preserve Chinese text");
assert(!hasMojibake(cleanJson.final_text), "host response writer must not introduce mojibake in Chinese text");

console.log(JSON.stringify({
  ok: true,
  checked: {
    catalog_names: names,
    runtime_json_read_policy: outputContract.runtime_json_read_policy.trusted_reader,
    runtime_json_write_policy: outputContract.runtime_json_write_policy.trusted_writer_tool,
    final_advice_source: outputContract.ai_native_output_policy.host_model_contract.ui_must_read_final_response_from,
    mainline_sources: mainlineSources,
    product_ui_sources: productUiSources,
    powershell_policy: "PowerShell console text is not a Chinese correctness oracle; Node UTF-8 JSON parse is required.",
  },
}, null, 2));
