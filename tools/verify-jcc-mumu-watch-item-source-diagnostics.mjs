import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function runFixture(name, lines) {
  const root = path.join(".omx", "runtime-evidence", "mumu-gi-live", `watch-item-source-${name}`);
  const fixture = `${root}.logcat.txt`;
  await rm(root, { recursive: true, force: true });
  await mkdir(path.dirname(root), { recursive: true });
  await writeFile(fixture, lines.join("\n"), "utf8");
  const result = await runNode([
    "tools/watch-jcc-mumu-runtime-logcat.mjs",
    "--out-dir", root,
    "--match-session-id", `watch-item-source-${name}`,
    "--logcat-fixture", fixture,
  ]);
  assert(result.code === 0, `${name} watcher fixture failed: ${result.stderr || result.stdout}`);
  return JSON.parse(await readFile(path.join(root, "summary.json"), "utf8"));
}

const boardLine = '06-11 10:00:00.000 1000 2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4353 {"hl":[{"i":1451,"x":540,"y":420}]}, id: 1';
const selfViewLines = [
  '06-11 09:59:59.800 1000 2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4358 {"s":1}, id: 1',
  '06-11 09:59:59.900 1000 2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4354 {"bl":[{"i":11453,"l":0,"t":0,"r":10,"b":10}]}, id: 2',
];

const sourceMissing = await runFixture("source-not-emitted", [
  ...selfViewLines,
  boardLine,
  '06-11 10:00:00.100 1000 2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4356 {"el":[]}, id: 2',
]);
assert(sourceMissing.command_counts["4354"] === 1, "source-missing fixture must prove the non-empty shop self-view anchor is active");
assert(sourceMissing.command_counts["4353"] === 1, "source-missing fixture must prove the GI board stream is active");
assert(sourceMissing.command_counts["4356"] === 1, "source-missing fixture must retain the empty 4356 observation");
assert(Number(sourceMissing.command_counts["4357"] || 0) === 0, "source-missing fixture must not invent 4357");
assert(sourceMissing.source_diagnostics?.item_source_classification?.status === "source_not_emitted", "active GI stream without 4357 must be classified as source_not_emitted");
assert(sourceMissing.source_diagnostics?.payload_shape_counts_by_command?.["4356"]?.el_empty === 1, "empty 4356 payload shape must be visible in diagnostics");

const callbackFanout = await runFixture("callback-fanout", [
  ...selfViewLines,
  boardLine,
  '06-11 10:00:00.100 1000 2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4356 {"el":[]}, id: 2',
  '06-11 10:00:00.110 1000 2000 D NemuInit: callback dispatched for operation: 4356, id: 2',
  '06-11 10:00:00.120 1000 2000 D Proxy: use callback: 88, handleNemuInitMessage, name: gi_plugin_jkchess, params: 4356 {"el":[]}, res: ok',
]);
assert(callbackFanout.source_diagnostics?.item_source_classification?.status === "source_not_emitted", "callback fanout mentioning or echoing 4356 payloads must not become parse_rejection");
assert(callbackFanout.source_diagnostics?.line_counts?.gi_plugin_lines_rejected === 0, "callback fanout and payload echoes must not be counted as rejected source payloads");

const promotionRejected = await runFixture("promotion-gate-rejected", [
  ...selfViewLines,
  boardLine,
  '06-11 10:00:00.100 1000 2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4356 {"el":[{"i":3101,"l":1500,"t":800,"r":1550,"b":850}]}, id: 2',
]);
assert(promotionRejected.source_diagnostics?.payload_shape_counts_by_command?.["4356"]?.el_non_empty === 1, "promotion-gate fixture must contain a non-empty 4356 payload");
assert(promotionRejected.source_diagnostics?.item_source_classification?.status === "promotion_gate_rejected", "unassigned non-empty 4356 must be classified separately from source absence");
assert(promotionRejected.source_diagnostics?.item_source_classification?.evidence?.equipped_item_count === 0, "rejected 4356 evidence must not create equipped item facts");
assert(promotionRejected.source_diagnostics?.item_source_classification?.evidence?.visible_equipment_unassigned_count === 1, "rejected 4356 evidence must preserve one unassigned diagnostic row");

const changedCommand = await runFixture("changed-command", [
  boardLine,
  '06-11 10:01:00.100 1000 2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4367 {"el":[{"i":3102,"l":36,"t":280,"r":86,"b":330}]}, id: 2',
]);
assert(changedCommand.command_counts["4367"] === 1, "unknown GI commands must remain counted");
assert(changedCommand.source_diagnostics?.command_presence?.has_equipment_like_unknown_command === true, "unknown el command must be marked equipment-like");
assert(changedCommand.source_diagnostics?.equipment_like_unknown_command_counts?.["4367"] === 1, "unknown equipment-like command count must be bounded structured evidence");
assert(changedCommand.source_diagnostics?.item_source_classification?.status === "changed_command_id_suspected", "unknown el command must be classified as possible command drift");

const malformedPayload = await runFixture("parse-rejection", [
  boardLine,
  '06-11 10:02:00.100 1000 2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4357 {"el":[,]}, id: 2',
]);
assert(malformedPayload.command_counts["4357"] === 1, "malformed known command must remain counted before promotion");
assert(malformedPayload.source_diagnostics?.parse_rejection_counts?.malformed_json_payload === 1, "malformed payload must increment parse rejection diagnostics");
assert(malformedPayload.source_diagnostics?.item_source_classification?.status === "parse_rejection", "malformed 4357 must not look like a clean empty rail");

const cleanEmpty = await runFixture("clean-empty", [
  boardLine,
  '06-11 10:03:00.100 1000 2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4357 {"el":[]}, id: 2',
]);
assert(cleanEmpty.source_diagnostics?.payload_shape_counts_by_command?.["4357"]?.el_empty === 1, "clean empty 4357 must retain its payload shape");
assert(cleanEmpty.source_diagnostics?.item_source_classification?.status === "item_source_ready", "clean empty 4357 is an observed empty rail, not a source failure");
assert(cleanEmpty.source_diagnostics?.item_source_classification?.reason === "4357_observed_empty_left_item_rail", "clean empty 4357 must have a distinct reason");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-mumu-watch-item-source-diagnostics-verifier-v1",
  checked: [
    "active_gi_stream_without_4357_is_source_not_emitted",
    "callback_fanout_does_not_create_false_parse_rejection",
    "nonempty_unassigned_4356_is_promotion_gate_rejected",
    "unknown_el_command_is_command_drift_suspected",
    "malformed_4357_is_parse_rejection",
    "clean_empty_4357_is_source_ready",
  ],
}, null, 2));
