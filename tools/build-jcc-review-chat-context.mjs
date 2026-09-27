import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-review-chat-context.mjs --mode <daily_chat|postgame_review>",
    "    [--user-settings <json>] [--user-memory <json>] [--recent-matches-dir <dir>]",
    "",
    "Builds no-active-match chat/review context from settings, approved memory, and bounded recent match summaries.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { mode: "daily_chat" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--user-settings") options.userSettings = argv[++index];
    else if (arg === "--user-memory") options.userMemory = argv[++index];
    else if (arg === "--recent-matches-dir") options.recentMatchesDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file, fallback = {}) {
  if (!file || !existsSync(file)) return fallback;
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function readRecentSummaries(dir, max = 20) {
  if (!dir || !existsSync(dir)) return [];
  const root = path.resolve(dir);
  const files = (await readdir(root))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .slice(-max);
  const summaries = [];
  for (const file of files) {
    const summary = await readJson(path.join(root, file), null);
    if (!summary) continue;
    summaries.push({
      match_session_id: summary.match_session_id || null,
      ended_at: summary.ended_at || null,
      result_rank: summary.result_rank ?? null,
      review_tags: summary.review_tags || [],
      advice_task_count: Array.isArray(summary.advice_tasks) ? summary.advice_tasks.length : 0,
      missed_information: summary.missed_information || [],
      economy_milestones: summary.economy_milestones || {},
      target_plan_history: summary.target_plan_history || [],
      manual_scouting_note_count: Array.isArray(summary.manual_scouting_notes) ? summary.manual_scouting_notes.length : 0,
    });
  }
  return summaries;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function summarizeStrategyRows(userMemory) {
  return [
    ...asArray(userMemory.strategy_rows),
    ...asArray(userMemory.custom_strategy_rows),
    ...asArray(userMemory.approved_strategy_rows),
  ]
    .filter((row) => row && row.enabled !== false && row.approved !== false && row.status !== "rejected")
    .map((row, index) => ({
      id: row.id || row.key || `strategy_row_${index + 1}`,
      text: row.text || row.value || row.strategy || row.note || "",
      tags: asArray(row.tags),
      weight: row.weight ?? 1,
      source: row.source || "user_confirmed_strategy_row",
    }))
    .filter((row) => row.text || row.tags.length)
    .slice(0, 50);
}

function summarizeStrategyConflicts(userMemory) {
  return asArray(userMemory.strategy_conflict_notices)
    .slice(-20)
    .map((conflict) => ({
      id: conflict.id || null,
      rule_id: conflict.rule_id || null,
      severity: conflict.severity || null,
      summary: conflict.summary || "",
      latest_wins_for_now: conflict.latest_wins_for_now === true,
      newest_strategy_row_id: conflict.newest_strategy_row_id || null,
      rows: asArray(conflict.rows).map((row) => ({
        id: row.id || null,
        text: row.text || "",
        tags: asArray(row.tags),
      })),
    }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!["daily_chat", "postgame_review"].includes(options.mode)) {
    throw new Error("--mode must be daily_chat or postgame_review");
  }
  const runtimeUserSettings = await readJson(options.userSettings, {});
  const userMemory = await readJson(options.userMemory, {});
  const recentMatchSummaries = await readRecentSummaries(options.recentMatchesDir, 20);
  const strategyRows = summarizeStrategyRows(userMemory);
  const strategyConflicts = summarizeStrategyConflicts(userMemory);
  const context = {
    schema: "jcc-review-chat-context-v1",
    mode: options.mode,
    can_open_during_active_match: false,
    runtime_user_settings: runtimeUserSettings,
    user_memory: userMemory,
    user_strategy_rows: strategyRows,
    user_strategy_conflicts: strategyConflicts,
    recent_match_summaries: recentMatchSummaries,
    memory_write_policy: {
      requires_user_approval: true,
      allowed_writes: ["strategy_rows", "preferences", "habits", "review_notes"],
      forbidden_writes: ["current_match_facts_from_old_sessions", "raw_screenshots", "full_raw_logs"],
      fixed_menu_settings: {
        default_goal: "menu_only_not_chat_inferred",
        rank_tier: "menu_only_not_chat_inferred",
        operation_speed: "menu_only_not_chat_inferred",
      },
      chat_can_propose_custom_strategy_rows: true,
      chat_proposal_requires_user_confirmation: true,
      chat_strategy_row_flow: [
        "agent_detects_possible_long_term_strategy",
        "agent_proposes_strategy_row",
        "user_confirms",
        "confirmed_row_is_written_to_user_memory.strategy_rows",
        "all_strategy_rows_are_scanned_for_conflicts",
        "newest_confirmed_strategy_wins_for_now",
        "agent_emits_strategy_conflict_notice_if_needed",
        "cruise_scorer_reads_strategy_rows_as_soft_bias",
      ],
    },
    source_policy: {
      strategy_inputs: ["hard_data", "daily_big_data", "recent_match_summaries", "user_memory"],
      pollution_guard: "Do not copy previous-match concrete board/shop/economy facts into a new match live_state.",
    },
    review_focus: options.mode === "postgame_review"
      ? ["mistake_attribution", "next_match_focus", "memory_update_suggestion"]
      : ["version_strategy", "preference_proposal", "recent_pattern_summary"],
  };
  process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export { readRecentSummaries };
