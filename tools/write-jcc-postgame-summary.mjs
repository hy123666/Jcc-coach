import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage:",
    "  node tools/write-jcc-postgame-summary.mjs --pipeline-result <json> --out-dir <dir> [--max 20]",
    "    [--match-session-id <id>] [--result-rank <n>] [--now <iso>]",
    "",
    "Writes a bounded structured postgame decision summary. No screenshots, full raw logs, or full live_state dumps are retained.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { max: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--pipeline-result") options.pipelineResult = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--max") options.max = Number(argv[++index]);
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--result-rank") options.resultRank = Number(argv[++index]);
    else if (arg === "--now") options.now = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeFilePart(value) {
  return String(value || "match")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "match";
}

function compactTask(task) {
  return {
    task_id: task.task_id || null,
    trigger_id: task.trigger_id || null,
    priority: task.priority || null,
    value_score: task.value_score ?? null,
    confidence: task.confidence ?? null,
    title: task.title || null,
    short_advice: task.short_advice || null,
    actions: asArray(task.actions).slice(0, 8),
    semantic_labels: asArray(task.semantic_labels).slice(0, 12),
  };
}

function buildSummary(pipeline, options) {
  const live = pipeline.standardized_live_state || {};
  const lifecycle = pipeline.lifecycle || {};
  const context = lifecycle.match_context || {};
  return {
    schema: "jcc-postgame-decision-summary-v1",
    match_session_id: options.matchSessionId || pipeline.match_session_id || live.match_session_id || null,
    started_at: pipeline.match_started_at || null,
    ended_at: options.now || new Date().toISOString(),
    result_rank: Number.isFinite(options.resultRank) ? options.resultRank : null,
    target_plan_history: [
      live.target_plan?.value,
      ...(asArray(context.target_plan_history)),
    ].filter(Boolean).slice(-8),
    augment_choices: asArray(live.augments?.selected_augments).map((entry) => ({
      id: entry.id || entry.entity_id || null,
      name: entry.name || entry.text || null,
      source: entry.provenance?.source || entry.source || null,
    })),
    item_choice_decisions: asArray(context.item_choice_decisions).slice(-20),
    item_slams: asArray(context.item_slams).slice(-20),
    economy_milestones: {
      gold: live.economy?.gold?.value ?? null,
      hp: live.economy?.hp?.value ?? null,
      level: live.economy?.level?.value ?? null,
      xp: live.economy?.xp?.value ?? null,
    },
    level_or_roll_decisions: asArray(lifecycle.confirmed_tasks)
      .filter((task) => /level|roll|tempo|stabilize/i.test(`${task.trigger_id || ""} ${task.title || ""}`))
      .map(compactTask)
      .slice(-20),
    shop_hold_sell_decisions: asArray(lifecycle.confirmed_tasks)
      .filter((task) => /shop|interest|bench|sell/i.test(`${task.trigger_id || ""} ${task.title || ""}`))
      .map(compactTask)
      .slice(-20),
    manual_scouting_notes: asArray(context.manual_scouting_notes).slice(-20),
    positioning_decisions: asArray(context.positioning_decisions).slice(-20),
    pivot_decisions: asArray(lifecycle.confirmed_tasks)
      .filter((task) => /pivot|direction|cap_gap|contest/i.test(`${task.trigger_id || ""} ${task.title || ""}`))
      .map(compactTask)
      .slice(-20),
    advice_tasks: [
      ...asArray(pipeline.score?.advice_tasks),
      ...asArray(lifecycle.confirmed_tasks),
      ...asArray(lifecycle.skipped_tasks),
    ].map(compactTask).slice(-80),
    user_confirmations: asArray(context.confirmed_actions).slice(-80),
    missed_information: asArray(pipeline.score?.advice_tasks)
      .flatMap((task) => asArray(task.actions).filter((action) => String(action).startsWith("visual_sensing_probe:")))
      .slice(-20),
    review_tags: [
      ...(Number.isFinite(options.resultRank) && options.resultRank <= 4 ? ["top_four"] : []),
      ...(Number.isFinite(options.resultRank) && options.resultRank > 4 ? ["bottom_four"] : []),
      ...new Set(asArray(pipeline.score?.advice_tasks).flatMap((task) => asArray(task.semantic_labels)).slice(0, 20)),
    ],
    storage_policy: {
      store_structured_decision_summary_only: true,
      store_raw_screenshots: false,
      store_full_raw_logs: false,
      store_full_live_state: false,
      max_recent_matches: options.max,
    },
  };
}

async function rotate(dir, max) {
  const files = (await readdir(dir))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const overflow = files.length - max;
  if (overflow <= 0) return;
  await Promise.all(files.slice(0, overflow).map((name) => rm(path.join(dir, name), { force: true })));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.pipelineResult) throw new Error("--pipeline-result is required");
  if (!options.outDir) throw new Error("--out-dir is required");
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const pipeline = await readJson(options.pipelineResult);
  const summary = buildSummary(pipeline, options);
  const timestamp = safeFilePart(options.now || summary.ended_at || new Date().toISOString());
  const matchId = safeFilePart(summary.match_session_id);
  const outFile = path.join(outDir, `${timestamp}-${matchId}.json`);
  await writeFile(outFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await rotate(outDir, Number.isFinite(options.max) ? options.max : 20);
  process.stdout.write(`${JSON.stringify({ ok: true, out_file: outFile, match_session_id: summary.match_session_id }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export { buildSummary };
