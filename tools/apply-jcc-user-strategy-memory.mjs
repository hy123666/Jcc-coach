import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";

function usage() {
  return [
    "Usage:",
    "  node tools/apply-jcc-user-strategy-memory.mjs --user-memory <json> --proposal <proposal-json-file> [--out <json>] [--now <iso>]",
    "  node tools/apply-jcc-user-strategy-memory.mjs --user-memory <json> --row-json <json> [--out <json>] [--now <iso>]",
    "",
    "Confirms a custom strategy row, writes it to user_memory.strategy_rows, scans all rows for conflicts, and emits agent notices.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--user-memory") options.userMemory = argv[++index];
    else if (arg === "--proposal") options.proposal = argv[++index];
    else if (arg === "--row-json") options.rowJson = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--now") options.now = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file, fallback = {}) {
  if (!file || !existsSync(file)) return fallback;
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hashId(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex").slice(0, 12);
}

function hasAny(text, needles) {
  const lower = String(text || "").toLowerCase();
  return needles.some((needle) => lower.includes(String(needle).toLowerCase()));
}

function inferTags(text, tags = []) {
  const inferred = [...asArray(tags).map((tag) => String(tag).trim()).filter(Boolean)];
  if (hasAny(text, ["safe_top_four", "top4", "top four", "稳前四", "保前四", "吃分"])) inferred.push("safe_top_four");
  if (hasAny(text, ["play_for_first", "first", "high_cap", "冲吃鸡", "吃鸡", "高上限"])) inferred.push("play_for_first");
  if (hasAny(text, ["economy_bias", "econ", "少 d", "少d", "多运营", "经济"])) inferred.push("economy_bias");
  if (hasAny(text, ["tempo_bias", "tempo", "保血", "稳血", "连胜", "节奏"])) inferred.push("tempo_bias");
  if (hasAny(text, ["lose_streak_bias", "open_fort", "连败", "空城"])) inferred.push("lose_streak_bias");
  if (hasAny(text, ["early_notice", "提前", "手速慢", "一回合"])) inferred.push("early_notice");
  if (hasAny(text, ["avoid_reroll", "不喜欢赌", "别赌", "少赌", "别乱d", "不乱d"])) inferred.push("avoid_reroll");
  if (hasAny(text, ["reroll_comfort", "slow_roll", "喜欢赌", "慢 d", "慢d", "赌狗"])) inferred.push("reroll_comfort");
  return [...new Set(inferred)];
}

function normalizeRow(row, now) {
  const text = String(row?.text || row?.value || row?.strategy || row?.note || "").replace(/\s+/g, " ").trim();
  const tags = inferTags(text, row?.tags);
  if (!text && !tags.length) throw new Error("Strategy row must have text or tags");
  return {
    id: String(row?.id || row?.key || `strategy_row_${hashId(`${text}:${tags.join(",")}`)}`),
    kind: "custom_strategy_row",
    text,
    tags,
    weight: Math.max(0.1, Math.min(2, Number(row?.weight || 1))),
    source: row?.source || "user_confirmed_strategy_row",
    enabled: row?.enabled !== false,
    approved: true,
    approved_at: row?.approved_at || now,
    updated_at: now,
  };
}

async function readConfirmedRow(options, now) {
  if (options.rowJson) return normalizeRow(JSON.parse(options.rowJson), now);
  if (!options.proposal) throw new Error("--proposal or --row-json is required");
  const proposalEnvelope = await readJson(options.proposal);
  const proposal = proposalEnvelope.proposal || proposalEnvelope;
  if (!proposal) throw new Error("Proposal file does not contain a proposal");
  if (proposal.write_target && proposal.write_target !== "user_memory.strategy_rows") {
    throw new Error(`Unsupported write target: ${proposal.write_target}`);
  }
  return normalizeRow({
    ...proposal,
    source: String(proposal.source || "agent_proposed_user_confirmed").replace("_required", ""),
  }, now);
}

function activeStrategyRows(memory) {
  return asArray(memory.strategy_rows)
    .filter((row) => row && row.enabled !== false && row.approved !== false && row.status !== "rejected")
    .map((row) => normalizeRow(row, row.updated_at || row.approved_at || new Date().toISOString()));
}

const CONFLICT_RULES = [
  {
    id: "safe_top_four_vs_play_for_first",
    left: ["safe_top_four"],
    right: ["play_for_first"],
    summary: "Stable top-four bias conflicts with first-place/high-cap bias.",
  },
  {
    id: "economy_vs_reroll",
    left: ["economy_bias", "avoid_reroll"],
    right: ["reroll_comfort"],
    summary: "Economy/avoid-reroll bias conflicts with reroll comfort.",
  },
  {
    id: "tempo_vs_lose_streak",
    left: ["tempo_bias"],
    right: ["lose_streak_bias"],
    summary: "Tempo/HP preservation bias conflicts with intentional lose-streak bias.",
  },
  {
    id: "avoid_reroll_vs_reroll",
    left: ["avoid_reroll"],
    right: ["reroll_comfort"],
    summary: "Avoid-reroll bias conflicts with reroll comfort.",
  },
];

function hasTag(row, tags) {
  return tags.some((tag) => asArray(row.tags).includes(tag));
}

function detectStrategyConflicts(rows, newestRow, now) {
  const conflicts = [];
  for (const rule of CONFLICT_RULES) {
    const leftRows = rows.filter((row) => hasTag(row, rule.left));
    const rightRows = rows.filter((row) => hasTag(row, rule.right));
    if (!leftRows.length || !rightRows.length) continue;
    for (const left of leftRows) {
      for (const right of rightRows) {
        if (left.id === right.id) continue;
        const involvesNewest = left.id === newestRow.id || right.id === newestRow.id;
        conflicts.push({
          id: `strategy_conflict_${rule.id}_${hashId(`${left.id}:${right.id}`)}`,
          rule_id: rule.id,
          severity: involvesNewest ? "needs_user_attention" : "background_conflict",
          summary: rule.summary,
          newest_strategy_row_id: newestRow.id,
          latest_wins_for_now: true,
          rows: [
            { id: left.id, text: left.text, tags: left.tags, approved_at: left.approved_at || null },
            { id: right.id, text: right.text, tags: right.tags, approved_at: right.approved_at || null },
          ],
          agent_notice: involvesNewest
            ? `Strategy conflict: your newest strategy "${newestRow.text || newestRow.tags.join("/")}" conflicts with "${left.id === newestRow.id ? right.text : left.text}". I will keep the newest strategy active for now, but you may want to resolve this later.`
            : null,
          detected_at: now,
        });
      }
    }
  }
  const seen = new Set();
  return conflicts.filter((conflict) => {
    const key = `${conflict.rule_id}:${conflict.rows.map((row) => row.id).sort().join(":")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function upsertRow(rows, row) {
  const next = rows.filter((entry) => entry.id !== row.id);
  next.push(row);
  return next;
}

export function applyConfirmedStrategyMemory(memoryInput, rowInput, options = {}) {
  const now = options.now || new Date().toISOString();
  const memory = memoryInput && typeof memoryInput === "object" && !Array.isArray(memoryInput)
    ? structuredClone(memoryInput)
    : { schema: "jcc-runtime-user-memory-v1" };
  const confirmedRow = normalizeRow(rowInput, now);
  const rows = upsertRow(activeStrategyRows(memory), confirmedRow);
  const conflicts = detectStrategyConflicts(rows, confirmedRow, now);
  const agentNoticeEvents = conflicts
    .filter((conflict) => conflict.severity === "needs_user_attention" && conflict.agent_notice)
    .map((conflict) => ({
      type: "strategy_conflict_notice",
      conflict_id: conflict.id,
      user_visible_text: conflict.agent_notice,
      newest_strategy_row_id: confirmedRow.id,
      observed_at: now,
    }));
  const updatedMemory = {
    ...memory,
    schema: memory.schema || "jcc-runtime-user-memory-v1",
    updated_at: now,
    strategy_rows: rows,
    strategy_conflict_notices: [
      ...asArray(memory.strategy_conflict_notices),
      ...conflicts,
    ].slice(-50),
  };
  return {
    updated_memory: updatedMemory,
    result: {
      schema: "jcc-user-strategy-memory-apply-result-v1",
      ok: true,
      confirmed_strategy_row: confirmedRow,
      conflict_count: conflicts.length,
      conflicts,
      agent_notice_events: agentNoticeEvents,
      policy: {
        newest_confirmed_strategy_wins_for_now: true,
        conflicts_do_not_block_write: true,
        user_can_resolve_later: true,
      },
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.userMemory) throw new Error("--user-memory is required");
  const now = options.now || new Date().toISOString();
  const memory = await readJson(options.userMemory, { schema: "jcc-runtime-user-memory-v1" });
  const confirmedRow = await readConfirmedRow(options, now);
  const applied = applyConfirmedStrategyMemory(memory, confirmedRow, { now });
  const updatedMemory = applied.updated_memory;
  const outPath = path.resolve(options.out || options.userMemory);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(updatedMemory, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ...applied.result,
    written_to: outPath,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export { detectStrategyConflicts, inferTags, normalizeRow };
