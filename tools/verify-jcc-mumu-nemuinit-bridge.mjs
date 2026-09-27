import { readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAP = "data/runtime/jcc/mumu-nemuinit-bridge-map.json";

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-mumu-nemuinit-bridge.mjs [--map <json>] [--skip-build]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { map: DEFAULT_MAP, skipBuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--map") options.map = argv[++index];
    else if (arg === "--skip-build") options.skipBuild = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
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

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function findCommand(map, command) {
  return map.commands.find((entry) => entry.command === command);
}

async function verifyNormalizer() {
  const temp = path.join(os.tmpdir(), `jcc-mumu-normalize-${Date.now()}.json`);
  const board = await runNode([
    "tools/normalize-jcc-mumu-gi-message.mjs",
    "--cmd",
    "4353",
    "--payload",
    '{"hl":[{"i":11450,"x":2,"y":3}]}',
    "--match-session-id",
    "match:test",
    "--out",
    temp,
  ]);
  assert(board.code === 0, `normalizer board command failed: ${board.stderr || board.stdout}`);
  const boardEvent = await readJson(temp);
  assert(boardEvent.type === "current_view_units_candidate", "4353 must normalize to current_view_units_candidate");
  assert(boardEvent.current_view_patch.current_view_units[0].raw_hero_id === 11450, "4353 raw hero id mapping failed");
  assert(boardEvent.current_view_patch.current_view_units[0].champion_id === 11450, "4353 champion id mapping failed");
  assert(boardEvent.current_view_patch.current_view_units[0].position.x === 2, "4353 x mapping failed");
  assert(boardEvent.current_view_patch.current_view_units[0].position.y === 3, "4353 y mapping failed");

  const bench = await runNode([
    "tools/normalize-jcc-mumu-gi-message.mjs",
    "--cmd",
    "4352",
    "--payload",
    '{"wl":[{"i":11451,"x":4,"y":-1}]}',
  ]);
  assert(bench.code === 0, `normalizer bench command failed: ${bench.stderr || bench.stdout}`);
  const benchEvent = JSON.parse(bench.stdout);
  assert(benchEvent.type === "bench_units_candidate", "4352 must normalize to bench_units_candidate");
  assert(benchEvent.bench_patch.bench_units[0].position.area === "bench", "4352 must tag bench area");
}

async function verifyLiveStateBuilder() {
  const temp = path.join(os.tmpdir(), `jcc-mumu-gi-events-${Date.now()}.jsonl`);
  await writeFile(temp, [
    JSON.stringify({ command: 4096, payload: {}, match_session_id: "match:test" }),
    JSON.stringify({ command: 4353, payload: { hl: [{ i: 11450, x: 2, y: 3 }] }, match_session_id: "match:test" }),
    JSON.stringify({ command: 4352, payload: { wl: [{ i: 11451, x: 4, y: -1 }] }, match_session_id: "match:test" }),
    JSON.stringify({ command: 4354, payload: { bl: [{ i: 11452, l: 10, t: 20, r: 30, b: 40 }] }, match_session_id: "match:test" }),
    JSON.stringify({ command: 4355, payload: { hl: [{ i: 11453, e: 1001, x: 1, y: 2 }] }, match_session_id: "match:test" }),
    JSON.stringify({ command: 4356, payload: { el: [{ i: 1001, l: 1, t: 2, r: 3, b: 4 }] }, match_session_id: "match:test" }),
    JSON.stringify({ command: 4357, payload: { el: [{ i: 1002, l: 5, t: 6, r: 7, b: 8 }] }, match_session_id: "match:test" }),
  ].join("\n"), "utf8");
  const result = await runNode(["tools/build-jcc-mumu-gi-live-state.mjs", "--events", temp]);
  assert(result.code === 0, `GI live state builder failed: ${result.stderr || result.stdout}`);
  const state = JSON.parse(result.stdout);
  assert(state.match.status === "in_game", "match_start must set in_game");
  assert(state.current_view.filtered_units[0].champion_id === 11450, "current view state champion mapping failed");
  assert(state.bench.bench_units[0].position.y === -1, "bench state coordinate mapping failed");
  assert(state.shop.shop_units[0].rect.left === 10, "shop rect mapping failed");
  assert(state.carousel.available_units[0].item_id === 1001, "carousel unit item mapping failed");
  assert(state.items.equipped_items[0].item_id === 1001, "equipped item mapping failed");
  assert(state.items.item_bench[0].item_id === 1002, "item bench mapping failed");
  assert(state.field_status["current_view.filtered_units"].status === "candidate", "current_view filtered units must remain candidate");
  assert(state.field_status["board.local_board_units_candidate"].status === "blocked", "local board must remain blocked without local binding");
  assert(state.source_insights.promotion_decision.includes("candidate_only"), "live state must keep candidate-only promotion decision");
  assert(state.pollution_guard.cross_match_fusion_allowed === false, "cross-match fusion must be disabled");
}

async function verifyCompanionExtraction() {
  const companion = path.join(os.tmpdir(), `jcc-companion-mumu-gi-${Date.now()}.jsonl`);
  const events = path.join(os.tmpdir(), `jcc-companion-mumu-gi-events-${Date.now()}.jsonl`);
  await writeFile(companion, [
    JSON.stringify({
      schema: "jcc-android-companion-runtime-intake-v1",
      type: "mumu_gi_message",
      match_session_id: "match:test",
      capture_session_id: "capture:test",
      observed_at_epoch_ms: 1,
      plugin_name: "gi_plugin_jkchess",
      params: '4353 {"hl":[{"i":11450,"x":2,"y":3}]}',
    }),
  ].join("\n"), "utf8");
  const extract = await runNode(["tools/extract-jcc-mumu-gi-events-from-companion-log.mjs", "--input", companion, "--out", events]);
  assert(extract.code === 0, `companion GI extraction failed: ${extract.stderr || extract.stdout}`);
  const build = await runNode(["tools/build-jcc-mumu-gi-live-state.mjs", "--events", events]);
  assert(build.code === 0, `extracted GI live-state build failed: ${build.stderr || build.stdout}`);
  const state = JSON.parse(build.stdout);
  assert(state.current_view.filtered_units[0].champion_id === 11450, "extracted companion GI current-view mapping failed");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.skipBuild) {
    const result = await runNode(["tools/analyze-jcc-mumu-nemuinit-bridge.mjs", "--out", options.map]);
    if (result.code !== 0) throw new Error(`bridge analyzer failed\n${result.stdout}\n${result.stderr}`);
  }

  const file = path.resolve(options.map);
  const info = await stat(file);
  assert(info.size > 0, "bridge map must not be empty");
  assert(info.size < 2_000_000, "bridge map must remain small");
  const map = await readJson(file);

  assert(map.schema_version === 1, "schema_version must be 1");
  assert(map.registration.registered_plugin_name === "gi_plugin_jkchess", "plugin registration must be gi_plugin_jkchess");
  assert(map.registration.apk_proxy_is_stub === true, "APK NemuInitProxy must be recognized as host-supplied stub");
  assert(map.dispatcher.implements_local_handler === true, "dispatcher must implement LocalNemuInitMessageHandler");
  for (const command of [1, 2, 3, 4096, 4107, 4352, 4353, 4354, 4355, 4356, 4357, 4358, 8192]) {
    const entry = findCommand(map, command);
    assert(entry, `missing command ${command}`);
    assert(entry.observed_in_dispatcher === true, `command ${command} must be observed in dispatcher`);
  }

  const board = findCommand(map, 4353);
  const bench = findCommand(map, 4352);
  const shop = findCommand(map, 4354);
  const status = findCommand(map, 4358);
  assert(board.payload_schema.json_fields.some((field) => field.json_key === "hl"), "GiHeroList must expose hl");
  assert(bench.payload_schema.json_fields.some((field) => field.json_key === "wl"), "GiWaitHeroList must expose wl");
  assert(shop.payload_schema.json_fields.some((field) => field.json_key === "bl"), "GiBuyHeroList must expose bl");
  assert(status.payload_schema.json_fields.some((field) => field.json_key === "s"), "GiGameStatus must expose s");
  const heroInfo = map.payload_classes.find((entry) => entry.class_name === "GiHeroInfo");
  assert(heroInfo.json_fields.some((field) => field.json_key === "i"), "GiHeroInfo must expose i");
  assert(heroInfo.json_fields.some((field) => field.json_key === "x"), "GiHeroInfo must expose x");
  assert(heroInfo.json_fields.some((field) => field.json_key === "y"), "GiHeroInfo must expose y");

  const hostDexTokens = map.host_bridge.token_scan["nemu-vapi-android-pack/classes.dex"]?.tokens || {};
  const aidlTokens = map.host_bridge.token_scan["libnemuinitaidl.so"]?.tokens || {};
  assert(hostDexTokens["android.INemuInit"] === true, "host DEX must contain android.INemuInit descriptor");
  assert(aidlTokens.INemuInitProxyCallback === true, "libnemuinitaidl.so must contain INemuInitProxyCallback symbols");
  assert(aidlTokens.sendNemuInitCommand === true, "libnemuinitaidl.so must contain sendNemuInitCommand");
  assert(aidlTokens.setNemuInitProxyCallback === true, "libnemuinitaidl.so must contain setNemuInitProxyCallback");
  assert(aidlTokens.handleNemuInitMessage === true, "libnemuinitaidl.so must contain handleNemuInitMessage");
  assert(map.current_claims.cannot_claim_yet.some((claim) => /ordinary APK/i.test(claim)), "map must not overclaim ordinary APK access");
  assert(map.current_claims.can_claim.some((claim) => /live 4352\/4353\/4354\/4358/i.test(claim)), "map must record live desktop GI payload access");
  assert(map.current_claims.cannot_claim_yet.some((claim) => /4353 is always local-player scoped/i.test(claim)), "map must not overclaim 4353 local scope");
  assert(map.live_calibration_2026_06_09?.phase_status_enum?.["1"] === "planning_or_actionable", "map must record s=1 calibration");
  assert(map.live_calibration_2026_06_09?.command_live_status?.["4356"]?.includes("empty el"), "map must record 4356 live verification gap");

  await verifyNormalizer();
  await verifyLiveStateBuilder();
  await verifyCompanionExtraction();

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "gi_plugin_jkchess registration",
      "dispatcher command table",
      "board/bench/shop/status payload JSON keys",
      "native INemuInit callback symbols",
      "normalizer 4352/4353 samples",
      "GI event live-state builder sample",
      "companion mumu_gi_message extraction sample",
      "no overclaim of ordinary APK access",
      "live 2026-06-09 phase and command calibration",
      "4355/4356/4357 candidate folding samples",
    ],
    output: file,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
