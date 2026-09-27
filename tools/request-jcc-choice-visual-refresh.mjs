import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const REQUIRED_SELF_STATE_REFRESH_FIELDS = [
  "phase.stage_round",
  "economy.gold",
  "economy.hp",
  "economy.level",
  "economy.xp",
  "items.item_bench",
  "items.equipped_items",
];

function normalizeFieldsForMode(mode, fields = []) {
  const required = mode === "refresh_self_state" ? REQUIRED_SELF_STATE_REFRESH_FIELDS : [];
  const normalized = [];
  for (const field of [...required, ...(Array.isArray(fields) ? fields : [])]) {
    if (typeof field !== "string" || !field.trim()) continue;
    if (!normalized.includes(field)) normalized.push(field);
  }
  return normalized;
}

const MODE_CONFIG = {
  augment_choice: {
    fields: ["augments.choices"],
    target: "augments.choices",
    attention_hint: "visible_augment_choice_cards",
    reason: "runtime_mode_augment_choice_visual_refresh",
  },
  item_choice: {
    fields: ["items.choice_options", "items.item_bench", "items.equipped_items"],
    target: "items.choice_options",
    attention_hint: "visible_item_forge_reward_or_inventory_context",
    reason: "runtime_mode_item_choice_visual_refresh",
  },
  refresh_self_state: {
    fields: ["phase.stage_round", "economy.gold", "economy.hp", "economy.level", "economy.xp", "items.item_bench", "items.equipped_items", "augments.selected_augments"],
    target: "live_state.self_visual_context",
    attention_hint: "own_status_inventory_and_board_context",
    reason: "runtime_mode_refresh_self_state_visual_refresh",
  },
};

function usage() {
  return [
    "Usage:",
    "  node tools/request-jcc-choice-visual-refresh.mjs --watch-dir <dir> --mode <runtime-mode> [--source <label>] [--out <json>]",
    "",
    "Queues a host multimodal visual request for the active runtime mode.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { source: "runtime_ui_mode_entry" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--watch-dir") options.watchDir = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--source") options.source = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--compatibility-calibration") options.compatibilityCalibration = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const out = path.resolve(file);
  await mkdir(path.dirname(out), { recursive: true });
  const temp = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, out);
}

function sha256Short(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function buildRequest({ mode, matchSessionId, nowIso, source, compatibilityCalibration = false }) {
  const config = MODE_CONFIG[mode];
  const requestIdSuffix = `${Date.parse(nowIso) || Date.now()}-${sha256Short(`${mode}:${source}`)}`;
  return {
    schema: "jcc-runtime-visual-request-v1",
    request_id: `visual:${matchSessionId}:${mode}:${requestIdSuffix}`,
    mode,
    phase: mode,
    reason: config.reason,
    at: nowIso,
    queued_at: nowIso,
    visual_backend: "host_cli_multimodal",
    execution_target: "runtime_visual_service",
    worker_lifecycle: "host_cli_agent_current_frame",
    fields: normalizeFieldsForMode(mode, config.fields),
    attention_hint: config.attention_hint,
    target: config.target,
    persist_raw_frame: false,
    status: "requested",
    source,
    compatibility_calibration: compatibilityCalibration,
    capture_policy: {
      source,
      immediate_capture_delay_ms: 500,
      stable_capture_delay_ms: 1000,
      first_capture_delay_ms: 1000,
      refresh_capture_interval_ms: 750,
      max_capture_window_ms: 3000,
      max_frames: 3,
      trigger_reason: config.reason,
      force_new_burst: true,
      purpose: "capture current visible UI state for the active JCC runtime mode using the host multimodal model",
    },
    poll: {
      timeout_ms: 120000,
      interval_ms: 1200,
      stop_when: `${config.target}_observed`,
      provider: "host_cli_agent_native_multimodal_model",
    },
    state_policy: {
      replace_current_choice_set: false,
      keep_previous_choice_sets_as_history_only: true,
      do_not_promote_choice_candidates: mode !== "refresh_self_state",
      do_not_write_selected_augments_without_user_confirmation: true,
    },
    storage_policy: {
      persist_raw_frame: false,
      delete_transient_images_after_extraction: true,
      output_structured_json_only: true,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.watchDir) throw new Error(`Missing --watch-dir\n${usage()}`);
  if (!MODE_CONFIG[options.mode]) {
    throw new Error(`Unsupported --mode ${options.mode}. Supported: ${Object.keys(MODE_CONFIG).join(", ")}`);
  }
  if (options.mode !== "refresh_self_state" && !options.compatibilityCalibration) {
    throw new Error(`${options.mode} visual intake is calibration-only; active choice candidates require a current-match user report. Re-run with --compatibility-calibration only for an explicit calibration artifact.`);
  }
  const watchDir = path.resolve(options.watchDir);
  const summary = await readJson(path.join(watchDir, "summary.json"), {});
  const pendingFile = path.join(watchDir, "pending-visual-requests.json");
  const pending = await readJson(pendingFile, {
    schema: "jcc-runtime-pending-visual-requests-v1",
    pending: [],
  });
  const nowIso = new Date().toISOString();
  const request = buildRequest({
    mode: options.mode,
    matchSessionId: pending.match_session_id || summary.match_session_id || "unknown-match",
    nowIso,
    source: options.source,
    compatibilityCalibration: options.compatibilityCalibration === true,
  });
  const nextPending = {
    ...pending,
    schema: pending.schema || "jcc-runtime-pending-visual-requests-v1",
    generated_at: nowIso,
    pending: [...(Array.isArray(pending.pending) ? pending.pending : []), request],
    latest: request,
  };
  await writeJsonAtomic(pendingFile, nextPending);
  const result = {
    ok: true,
    schema: "jcc-choice-visual-refresh-request-result-v1",
    watch_dir: watchDir,
    request,
    visual_requests: {
      queue: [request],
    },
    pending_visual_requests_file: pendingFile,
  };
  if (options.out) await writeJsonAtomic(options.out, result);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
