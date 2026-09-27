import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SOURCE_ROOT = ".omx/runtime-evidence/mumu-gameassist-jadx/sources";
const DEFAULT_HOST_ROOT = ".omx/runtime-evidence/mumu-host-bridge";
const DEFAULT_OUT = "data/runtime/jcc/mumu-nemuinit-bridge-map.json";

const COMMANDS = [
  {
    command: 1,
    hex: "0x0001",
    name: "plugin_version",
    parser_class: null,
    payload_class: null,
    runtime_target: "metadata.mumu_gameassist_plugin_version",
    promotion: "canary_response_only",
  },
  {
    command: 2,
    hex: "0x0002",
    name: "screen_size",
    parser_class: null,
    payload_class: null,
    runtime_target: "metadata.screen_size",
    promotion: "canary_response_only",
  },
  {
    command: 3,
    hex: "0x0003",
    name: "toggle_overlay_state",
    parser_class: null,
    payload_class: null,
    runtime_target: null,
    promotion: "do_not_probe_state_changing",
  },
  {
    command: 4096,
    hex: "0x1000",
    name: "match_start",
    parser_class: null,
    payload_class: null,
    runtime_target: "match.status",
    promotion: "match_session_boundary",
  },
  {
    command: 4107,
    hex: "0x100b",
    name: "lineup_or_config_update",
    parser_class: "i3.C0816o",
    payload_class: null,
    runtime_target: "source_insights.mumu_lineup_config",
    promotion: "debug_or_config_only",
  },
  {
    command: 4352,
    hex: "0x1100",
    name: "bench_wait_hero_list",
    parser_class: "i3.C",
    payload_class: "GiWaitHeroList",
    payload_root_key: "wl",
    runtime_target: "bench.bench_units",
    promotion: "structured_candidate_until_bridge_access_and_local_scope_proven",
  },
  {
    command: 4353,
    hex: "0x1101",
    name: "board_hero_list",
    parser_class: "i3.C0804c",
    payload_class: "GiHeroList",
    payload_root_key: "hl",
    runtime_target: "board.board_units",
    promotion: "structured_candidate_until_bridge_access_and_local_scope_proven",
  },
  {
    command: 4354,
    hex: "0x1102",
    name: "shop_buy_hero_list",
    parser_class: "i3.B",
    payload_class: "GiBuyHeroList",
    payload_root_key: "bl",
    runtime_target: "shop.shop_units",
    promotion: "structured_candidate_until_bridge_access_proven",
  },
  {
    command: 4355,
    hex: "0x1103",
    name: "round_select_unit_list",
    parser_class: "i3.I",
    payload_class: "GiRoundSelectUnitList",
    payload_root_key: "hl",
    runtime_target: "carousel.available_units",
    promotion: "structured_candidate_until_bridge_access_proven",
  },
  {
    command: 4356,
    hex: "0x1104",
    name: "board_or_current_equip_list",
    parser_class: "i3.C0803b",
    payload_class: "GiEquipList",
    payload_root_key: "el",
    runtime_target: "items.equipped_items",
    promotion: "structured_candidate_until_slot_semantics_proven",
  },
  {
    command: 4357,
    hex: "0x1105",
    name: "inventory_equip_list",
    parser_class: "i3.C0805d",
    payload_class: "GiEquipList",
    payload_root_key: "el",
    runtime_target: "items.item_bench",
    promotion: "structured_candidate_until_slot_semantics_proven",
  },
  {
    command: 4358,
    hex: "0x1106",
    name: "game_status",
    parser_class: "i3.A",
    payload_class: "GiGameStatus",
    payload_root_key: "s",
    runtime_target: "phase.phase",
    promotion: "structured_candidate_status_enum_needs_calibration",
  },
  {
    command: 8192,
    hex: "0x2000",
    name: "match_end",
    parser_class: null,
    payload_class: null,
    runtime_target: "match.status",
    promotion: "match_session_boundary",
  },
];

const DATA_CLASSES = [
  "GiHeroInfo",
  "GiHeroList",
  "GiWaitHeroList",
  "GiBuyHeroChosenInfo",
  "GiBuyHeroInfo",
  "GiBuyHeroList",
  "GiEquipInfo",
  "GiEquipList",
  "GiRoundSelectUnitInfo",
  "GiRoundSelectUnitList",
  "GiGameStatus",
];

const HOST_FILES = [
  "nemu-vapi-android-pack.apk",
  "nemu-vapi-android-pack/classes.dex",
  "com.mumu.shared.sdk.apk",
  "com.mumu.shared.sdk/classes.dex",
  "nemuinit.bin",
  "libnemuinitaidl.so",
];

const HOST_TOKENS = [
  "android.INemuInit",
  "INemuInitProxyCallback",
  "sendNemuInitCommand",
  "setNemuInitProxyCallback",
  "handleNemuInitMessage",
  "sendMessageToHost",
  "sendMessageToVbox",
  "callHost",
  "getProp",
  "setProp",
  "game_util_get_ready",
  "Proxy: finish handleNemuInitMessage",
];

function usage() {
  return [
    "Usage:",
    "  node tools/analyze-jcc-mumu-nemuinit-bridge.mjs [--source-root <jadx-sources>] [--host-root <pulled-host-artifacts>] [--out <json>]",
    "",
    "Builds a machine-readable map for MuMu's gi_plugin_jkchess NemuInit bridge.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { sourceRoot: DEFAULT_SOURCE_ROOT, hostRoot: DEFAULT_HOST_ROOT, out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--source-root") options.sourceRoot = argv[++index];
    else if (arg === "--host-root") options.hostRoot = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(file) {
  if (!(await exists(file))) return "";
  return readFile(file, "utf8");
}

async function fileInfo(file) {
  try {
    const info = await stat(file);
    return { path: file, exists: true, size_bytes: info.size };
  } catch {
    return { path: file, exists: false, size_bytes: 0 };
  }
}

function relSource(sourceRoot, ...parts) {
  return path.join(sourceRoot, ...parts);
}

function parseHandlerEvidence(handlerSource) {
  const observed = new Set();
  for (const match of handlerSource.matchAll(/i4\s*==\s*(\d+)/g)) observed.add(Number(match[1]));
  for (const match of handlerSource.matchAll(/if\s*\(i4\s*!=\s*(\d+)\)/g)) observed.add(Number(match[1]));
  return {
    implements_local_handler: /implements\s+com\.mumu\.nemuinit\.NemuInitProxy\.LocalNemuInitMessageHandler/.test(handlerSource),
    parses_space_separated_command: /e0\(str,\s*new java\.lang\.String\[\]\{" "\}/.test(handlerSource),
    observed_commands: [...observed].sort((a, b) => a - b),
    returns_ok_for_state_commands: /string\s*=\s*"ok"/.test(handlerSource),
  };
}

function parseRegistrationEvidence(serviceInitializer, proxyStub) {
  return {
    registered_plugin_name: /setNemuInitMessageHandler\("([^"]+)"/.exec(serviceInitializer)?.[1] || null,
    registration_handler_class: /setNemuInitMessageHandler\("[^"]+",\s*new\s+([^)]+)\(\)\)/.exec(serviceInitializer)?.[1] || null,
    apk_proxy_is_stub: /None impl for NemuInitProxy#setNemuInitMessageHandler/.test(proxyStub),
    local_handler_interface_declared: /interface\s+LocalNemuInitMessageHandler/.test(proxyStub),
  };
}

function parseJsonFields(source) {
  const fields = [];
  const seen = new Set();
  const pattern = /@F3\.i\(name\s*=\s*"([^"]+)"\)\s+([^\s,)]+(?:<[^)]*?>)?)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(pattern)) {
    const field = {
      json_key: match[1],
      java_type: match[2],
      source_parameter: match[3],
    };
    const key = `${field.json_key}:${field.source_parameter}:${field.java_type}`;
    if (!seen.has(key)) {
      seen.add(key);
      fields.push(field);
    }
  }
  return fields;
}

async function parseDataClass(sourceRoot, className) {
  const file = relSource(sourceRoot, "com", "mumu", "gameassist", "games", "jcc", "data", `${className}.java`);
  const source = await readTextIfExists(file);
  return {
    class_name: className,
    source: file,
    exists: source.length > 0,
    json_fields: parseJsonFields(source),
    generate_adapter: /@F3\.l\(generateAdapter\s*=\s*true\)/.test(source),
    to_string_shape: /toString\(\)/.test(source) ? /new java\.lang\.StringBuilder\("([^"]+)/.exec(source)?.[1] || null : null,
  };
}

async function scanBinaryTokens(hostRoot) {
  const out = {};
  for (const fileName of HOST_FILES) {
    const file = path.join(hostRoot, fileName);
    if (!(await exists(file))) {
      out[fileName] = { exists: false, tokens: {} };
      continue;
    }
    const bytes = await readFile(file);
    const latin1 = bytes.toString("latin1");
    const tokens = {};
    for (const token of HOST_TOKENS) tokens[token] = latin1.includes(token);
    out[fileName] = { exists: true, size_bytes: bytes.length, tokens };
  }
  return out;
}

function buildCommandEvidence(commands, handlerEvidence, dataClasses) {
  const dataByName = new Map(dataClasses.map((entry) => [entry.class_name, entry]));
  return commands.map((command) => ({
    ...command,
    observed_in_dispatcher: handlerEvidence.observed_commands.includes(command.command),
    payload_schema: command.payload_class ? dataByName.get(command.payload_class) || null : null,
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const sourceRoot = path.resolve(options.sourceRoot);
  const hostRoot = path.resolve(options.hostRoot);
  const handlerSourcePath = relSource(sourceRoot, "U3", "C1590d.java");
  const serviceInitializerPath = relSource(sourceRoot, "com", "mumu", "gameassist", "startup", "ServiceInitializer.java");
  const proxyStubPath = relSource(sourceRoot, "com", "mumu", "nemuinit", "NemuInitProxy.java");

  const [handlerSource, serviceInitializer, proxyStub] = await Promise.all([
    readTextIfExists(handlerSourcePath),
    readTextIfExists(serviceInitializerPath),
    readTextIfExists(proxyStubPath),
  ]);
  const dataClasses = await Promise.all(DATA_CLASSES.map((className) => parseDataClass(sourceRoot, className)));
  const hostFiles = Object.fromEntries(await Promise.all(HOST_FILES.map(async (fileName) => [fileName, await fileInfo(path.join(hostRoot, fileName))])));
  const hostTokenScan = await scanBinaryTokens(hostRoot);
  const handlerEvidence = parseHandlerEvidence(handlerSource);
  const registration = parseRegistrationEvidence(serviceInitializer, proxyStub);

  const map = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_roots: {
      jadx_sources: sourceRoot,
      host_artifacts: hostRoot,
    },
    product_boundary: "mumu_host_nemuinit_bridge_readonly_investigation",
    safety_policy: {
      allowed: [
        "read decompiled APK/source evidence",
        "read Android service/process/package metadata",
        "subscribe to or parse structured payloads if access is available",
      ],
      disallowed: [
        "modify game process memory",
        "write game state",
        "send state-changing NemuInit commands such as overlay toggles or freeze/unfreeze",
        "promote board_units/bench_units until bridge access and local-scope semantics are proven",
      ],
    },
    registration,
    dispatcher: {
      source: handlerSourcePath,
      ...handlerEvidence,
    },
    commands: buildCommandEvidence(COMMANDS, handlerEvidence, dataClasses),
    payload_classes: dataClasses,
    host_bridge: {
      service_name: "nemuinit",
      interface_descriptor: "android.INemuInit",
      callback_descriptor: "android.INemuInitProxyCallback",
      files: hostFiles,
      token_scan: hostTokenScan,
      native_symbols_of_interest: HOST_TOKENS,
      current_access_claim: "host binder bridge exists locally, but ordinary companion APK access is not proven",
    },
    runtime_plan: {
      primary_source_if_access_proven: "gi_plugin_jkchess NemuInit structured payloads from MuMu gameassist logcat",
      fallback_sources: [
        "4358 s=4 as a visual-attention trigger only; active choice candidates come from current-match structured reports, not emulator helper text or host visual inference",
        "host CLI multimodal current-frame sensing for equipment choice, selected augments, and economy/status fields not exposed by GI",
        "companion MediaProjection small ROI OCR for phone/tablet or non-MuMu devices",
        "visual slot occupancy only as confidence/cross-check",
        "Android action logs as debug-only reducer evidence",
      ],
      expected_features_if_bridge_works: [
        "match start/end session isolation from our own match_session_id; 4096/8192 remain optional diagnostics",
        "bench_units from 4352 GiWaitHeroList",
        "current_view units from 4353 GiHeroList; local board only after visible 4354 shop self-view anchor and fresh-current-view gate",
        "shop_units from 4354 GiBuyHeroList",
        "carousel choices from 4355 GiRoundSelectUnitList",
        "item/equipment candidates from 4356/4357 GiEquipList",
        "phase/status candidates from 4358 GiGameStatus",
      ],
    },
    live_calibration_2026_06_09: {
      status: "partially_live_verified",
      desktop_mumu_source: "adb logcat from com.mumu.gameassist.jkchess / nemuinit GI messages",
      catalog_overlay: "data/runtime/jcc/mumu-catalog-overlay.json",
      catalog_overlay_policy: "MuMu cfg is the primary current-season Chinese name/id/icon overlay; project hard-data remains mechanics/formula evidence; MuMu lus/lineup is excluded from strategy sources.",
      phase_status_enum: {
        "1": "planning_or_actionable",
        "2": "observing_or_non_self_current_view; do not bind to battle state and keep diagnostic only",
        "4": "choice_window_visual_attention_trigger; may be augment/item/anvil/or another descriptor-owned panel; it does not identify the semantic choice or provide candidate ids",
        "5": "transition_or_unstable; hold/freeze board and bench promotion",
      },
      local_board_promotion_rule: {
        requirement: "runtime starts a fresh match_session_id; the first non-empty 4354 shop list observed in that match auto-establishes the self-view anchor",
        allowed_when: "visible 4354 shop has established the self-view anchor and the 4353 current-view list is fresh after that shop anchor",
        derivation: "bench_units = 4352 wl; board_units_candidate = fresh 4353 hl minus overlapping 4352 units",
        freeze_when: "4358 s=2/s=4/s=5 or filtered current-view is empty for own-board promotion; s=2 is observing/non-self current view and stays diagnostic only",
        resume_when: "the next visible 4354 shop clears the suspension, but promotion waits for a fresh post-shop 4353",
        caveat: "4353 has no chair/owner/playerId field and can contain current-view units; never promote without the visible-shop self-view gate.",
      },
      command_live_status: {
        "4096": "static_dispatcher_seen; not reliable as product session boundary yet",
        "8192": "static_dispatcher_seen; not reliable as product session boundary yet",
        "4107": "static_dispatcher_seen; config/lineup update, debug/config only",
        "4352": "live_verified_bench_wait_units",
        "4353": "live_verified_current_view_hero_list; self-board candidate only under visible 4354 shop anchor plus fresh current-view",
        "4354": "live_verified_shop_units",
        "4355": "static_dispatcher_seen; live payload not verified in current season tests",
        "4356": "live_verified_visible_equipment_rectangles; promote to own equipped items only under S=1 + fresh 4354 + trusted 4353 coordinate assignment",
        "4357": "live_verified_left_item_rail_inventory; primary item bench source",
        "4358": "live_verified_phase_status_s_1_2_4_5",
      },
      remaining_unknowns: [
        "no GI payload field for local chair/owner/playerId",
        "no GI payload for player HP/gold/level/xp observed",
        "no structured active-choice option id payload observed; use current-match structured user reports for candidate truth",
        "other-player board/HP binding is not exposed by current logcat source",
      ],
    },
    current_claims: {
      can_claim: [
        "MuMu gameassist registers gi_plugin_jkchess into a NemuInit message handler",
        "MuMu gameassist has first-class structured JCC payload classes for board/bench/shop/status/equipment",
        "MuMu host exposes a nemuinit Binder service and native AIDL symbols",
        "MuMu desktop runtime can read live 4352/4353/4354/4358 payloads from adb logcat when the official MuMu JCC assistant is running",
        "4358 s=1/2/4/5 has a live calibrated phase meaning",
      ],
      cannot_claim_yet: [
        "our ordinary APK can register the same callback",
        "4353 exposes opponent board unit identity",
        "4355 carousel is product-ready in current season tests",
        "4096/8192 are reliable product session boundaries",
      ],
    },
  };

  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    out,
    commands: map.commands.length,
    observed_commands: handlerEvidence.observed_commands,
    bridge_claim: map.host_bridge.current_access_claim,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
