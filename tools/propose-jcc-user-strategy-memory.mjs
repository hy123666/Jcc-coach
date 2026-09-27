import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";

function usage() {
  return [
    "Usage:",
    "  node tools/propose-jcc-user-strategy-memory.mjs --message <text> [--mode daily_chat|postgame_review]",
    "  node tools/propose-jcc-user-strategy-memory.mjs --message-file <file> [--mode daily_chat|postgame_review]",
    "",
    "Builds user-confirmation proposals for custom strategy rows. It never writes memory by itself.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { mode: "daily_chat" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--message") options.message = argv[++index];
    else if (arg === "--message-file") options.messageFile = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readMessage(options) {
  if (options.message !== undefined) return String(options.message);
  if (options.messageFile) return readFile(options.messageFile, "utf8");
  throw new Error("--message or --message-file is required");
}

function hasAny(text, needles) {
  const lower = String(text || "").toLowerCase();
  return needles.some((needle) => lower.includes(String(needle).toLowerCase()));
}

function inferTags(message) {
  const tags = [];
  if (hasAny(message, ["稳前四", "保前四", "吃分", "top4", "top four"])) tags.push("safe_top_four");
  if (hasAny(message, ["冲吃鸡", "吃鸡", "上限", "first", "高上限"])) tags.push("play_for_first");
  if (hasAny(message, ["少d", "少 d", "别乱d", "不乱d", "多运营", "运营", "经济"])) tags.push("economy_bias");
  if (hasAny(message, ["保血", "稳血", "连胜", "节奏"])) tags.push("tempo_bias");
  if (hasAny(message, ["连败", "空城"])) tags.push("lose_streak_bias");
  if (hasAny(message, ["提前", "手速慢", "一回合", "来不及"])) tags.push("early_notice");
  if (hasAny(message, ["不喜欢赌", "别赌", "少赌"])) tags.push("avoid_reroll");
  if (hasAny(message, ["喜欢赌", "慢d", "慢 d", "赌狗"])) tags.push("reroll_comfort");
  return [...new Set(tags)];
}

function shouldProposeStrategy(message, tags) {
  if (tags.length) return true;
  return hasAny(message, ["以后", "以后都", "我习惯", "我喜欢", "我不喜欢", "默认", "策略", "打法"]);
}

function shortText(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function buildProposal(message, mode = "daily_chat") {
  const text = shortText(message);
  const tags = inferTags(text);
  const shouldPropose = shouldProposeStrategy(text, tags);
  const hash = crypto.createHash("sha1").update(`${mode}:${text}`).digest("hex").slice(0, 12);
  return {
    schema: "jcc-user-strategy-memory-proposal-v1",
    mode,
    should_propose: shouldPropose,
    proposal: shouldPropose
      ? {
          id: `strategy_row_${hash}`,
          kind: "custom_strategy_row",
          text,
          tags,
          weight: 1,
          source: `${mode}_agent_proposed_user_confirmed_required`,
          enabled: true,
          approved: false,
          write_target: "user_memory.strategy_rows",
          confirmation_prompt: `是否记住这条策略：${text}`,
        }
      : null,
    write_policy: {
      requires_user_approval: true,
      agent_may_write_without_confirmation: false,
      fixed_settings_not_inferred_here: ["default_goal", "rank_tier", "operation_speed"],
      rationale: "Default goal, rank, and operation speed are explicit menu settings. Chat can only propose custom strategy rows for confirmation.",
    },
  };
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
  const message = await readMessage(options);
  process.stdout.write(`${JSON.stringify(buildProposal(message, options.mode), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export { buildProposal, inferTags };
