import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CELL_INNER_WIDTH = 8;
const CELL_WIDTH = CELL_INNER_WIDTH + 2;
const HALF_CELL_INDENT = " ".repeat(Math.floor(CELL_WIDTH / 2));
const CELL_GAP = "";
const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  border: "\u001b[38;5;245m",
  title: "\u001b[38;5;229m",
  unit: "\u001b[38;5;117m",
  section: "\u001b[38;5;180m",
  move: "\u001b[38;5;150m",
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") args.plan = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--color") args.color = "always";
    else if (arg === "--color=always" || arg === "--color=never" || arg === "--color=auto") args.color = arg.split("=")[1];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node tools/render-jcc-lineup-text-board.mjs --plan lineup-plan.json [--out board.txt] [--color=auto|always|never]",
    "",
    "Renders a compact staggered 4x7 JCC board with unit names, items, and move notes.",
  ].join("\n");
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeUnit(unit) {
  const row = Number(unit.row);
  const col = Number(unit.col);
  const name = String(unit.name || unit.hero || unit.champion || "未知");
  if (!Number.isInteger(row) || row < 1 || row > 4) throw new Error(`Invalid unit row for ${name}: ${unit.row}`);
  if (!Number.isInteger(col) || col < 1 || col > 7) throw new Error(`Invalid unit col for ${name}: ${unit.col}`);
  return {
    name,
    row,
    col,
    star: unit.star == null ? null : Number(unit.star),
    items: asArray(unit.items).map(String).filter(Boolean),
    notes: unit.notes ? String(unit.notes) : "",
  };
}

function normalizePlan(plan) {
  const units = asArray(plan.units || plan.board_units).map(normalizeUnit);
  const occupied = new Set();
  for (const unit of units) {
    const key = `${unit.row}:${unit.col}`;
    if (occupied.has(key)) throw new Error(`Duplicate lineup coordinate ${key}`);
    occupied.add(key);
  }
  return {
    schema: "jcc-internal-lineup-plan-v1",
    title: String(plan.title || plan.name || "阵容方案"),
    slot: String(plan.slot || plan.stage || "lineup"),
    summary: plan.summary ? String(plan.summary) : "",
    units,
    recommended_moves: asArray(plan.recommended_moves || plan.moves).map((move) => ({
      unit: String(move.unit || move.name || "未知"),
      from: move.from || null,
      to: move.to || null,
      reason: move.reason ? String(move.reason) : "",
    })),
  };
}

function displayWidth(text) {
  return [...String(text)].reduce((sum, char) => sum + (/[^ -~]/.test(char) ? 2 : 1), 0);
}

function fitText(text, width) {
  let result = "";
  let used = 0;
  for (const char of String(text)) {
    const charWidth = /[^ -~]/.test(char) ? 2 : 1;
    if (used + charWidth > width) break;
    result += char;
    used += charWidth;
  }
  return { text: result, width: used };
}

function centerText(text, width) {
  const fitted = fitText(text, width);
  const left = Math.floor(Math.max(0, width - fitted.width) / 2);
  const right = Math.max(0, width - fitted.width - left);
  return `${" ".repeat(left)}${fitted.text}${" ".repeat(right)}`;
}

function positionWord(row, col) {
  const fromLeft = col;
  const fromRight = 8 - col;
  const side = fromLeft <= fromRight ? `左${fromLeft}` : `右${fromRight}`;
  return `第${row}行${side}`;
}

function cellText(unit) {
  if (!unit) return "";
  return unit.name;
}

function color(text, code, enabled) {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

function renderHexRow(rowUnits, rowNumber, colorize) {
  const indent = rowNumber % 2 === 0 ? HALF_CELL_INDENT : "";
  const top = rowUnits.map(() => color(`╱${"─".repeat(CELL_INNER_WIDTH)}╲`, ANSI.border, colorize)).join(CELL_GAP);
  const mid = rowUnits.map((unit) => {
    const content = unit ? color(centerText(cellText(unit), CELL_INNER_WIDTH), ANSI.unit, colorize) : centerText("", CELL_INNER_WIDTH);
    return `${color("│", ANSI.border, colorize)}${content}${color("│", ANSI.border, colorize)}`;
  }).join(CELL_GAP);
  const bot = rowUnits.map(() => color(`╲${"─".repeat(CELL_INNER_WIDTH)}╱`, ANSI.border, colorize)).join(CELL_GAP);
  return [indent + top, indent + mid, indent + bot];
}

function renderColumnRuler(colorize) {
  const labels = Array.from({ length: 7 }, (_, index) => centerText(String(index + 1), CELL_WIDTH - 2));
  return color("列  ", ANSI.dim, colorize) + labels.join(" ");
}

function renderHexBoard(grid, colorize) {
  const lines = [color("棋盘：", ANSI.section, colorize), renderColumnRuler(colorize)];
  for (let row = 1; row <= 4; row += 1) {
    lines.push(...renderHexRow(grid[row - 1], row, colorize));
  }
  return lines;
}

export function renderJccLineupTextBoard(rawPlan, options = {}) {
  const plan = normalizePlan(rawPlan);
  const colorize = Boolean(options.color);
  const grid = Array.from({ length: 4 }, () => Array.from({ length: 7 }, () => null));
  for (const unit of plan.units) {
    grid[unit.row - 1][unit.col - 1] = unit;
  }

  const lines = [];
  lines.push(color(`【${plan.title}】`, `${ANSI.bold}${ANSI.title}`, colorize) + (plan.summary ? ` ${plan.summary}` : ""));
  lines.push(...renderHexBoard(grid, colorize));

  const unitsWithDetails = [...plan.units].sort((a, b) => (a.row - b.row) || (a.col - b.col));
  if (unitsWithDetails.length) {
    lines.push("");
    lines.push(color("单位与装备：", ANSI.section, colorize));
    for (const unit of unitsWithDetails) {
      const items = unit.items.length ? unit.items.join(" / ") : "无装备";
      const star = unit.star ? `${unit.star}星` : "";
      const suffix = [star, unit.notes].filter(Boolean).join("，");
      lines.push(`- ${unit.name}${suffix ? `（${suffix}）` : ""}：${positionWord(unit.row, unit.col)}；装备：${items}`);
    }
  }

  if (plan.recommended_moves.length) {
    lines.push("");
    lines.push(color("建议改动：", ANSI.section, colorize));
    for (const move of plan.recommended_moves) {
      const from = move.from ? `从${move.from}` : "";
      const to = move.to ? `到${move.to}` : "";
      const arrow = from || to ? `${from}${from && to ? "移" : ""}${to}` : "调整站位";
      lines.push(`- ${color(move.unit, ANSI.move, colorize)}：${arrow}${move.reason ? `。原因：${move.reason}` : ""}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.plan) throw new Error("Provide --plan");
  const useColor = args.color === "always" || (args.color === "auto" && Boolean(process.stdout.isTTY));
  const text = renderJccLineupTextBoard(await readJson(args.plan), { color: useColor });
  if (args.out) await writeFile(path.resolve(args.out), text, "utf8");
  else process.stdout.write(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
