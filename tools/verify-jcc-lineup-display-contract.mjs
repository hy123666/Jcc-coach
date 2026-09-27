import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderJccLineupTextBoard } from "./render-jcc-lineup-text-board.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

const contractPath = "data/runtime/jcc/lineup-display-contract.json";
const contract = await readJson(contractPath);
assert(contract.schema === "jcc-lineup-display-contract-v1", "contract schema mismatch");
assert(contract.external_code_paths?.enabled === false, "external code paths must be disabled");
assert(contract.output_slots?.target?.label === "目标阵容", "target label mismatch");
assert(contract.output_slots?.transition?.label === "当前过渡阵容", "transition label mismatch");
assert(contract.output_slots?.next_pivot?.label === "下一阶段变阵", "next pivot label mismatch");
assert(contract.output_slots?.positioning?.label === "己方站位调整", "positioning label mismatch");
assert(contract.lineup_plan_contract?.rows === 4, "lineup display must use 4 rows");
assert(contract.lineup_plan_contract?.columns === 7, "lineup display must use 7 columns");
assert(contract.cli_display_policy?.use_icons === false, "CLI display must not require icons");
assert(contract.cli_display_policy?.primary_format === "compact_staggered_hex_text_board", "CLI display must use compact staggered hex board");
assert(contract.cli_display_policy?.cell_inner_width === 8, "cell width policy mismatch");
assert(contract.mechanical_rendering_policy?.do_not_hand_draw_board_in_model === true, "mechanical rendering policy must forbid hand-drawn model boards");
assert(contract.mechanical_rendering_policy?.applies_to?.includes("lineup_display_slots.target"), "target slot must use mechanical lineup display");
assert(contract.mechanical_rendering_policy?.applies_to?.includes("lineup_display_slots.transition"), "transition slot must use mechanical lineup display");
assert(contract.mechanical_rendering_policy?.applies_to?.includes("lineup_display_slots.next_pivot"), "next pivot slot must use mechanical lineup display");
assert(contract.mechanical_rendering_policy?.applies_to?.includes("lineup_display_slots.positioning"), "positioning slot must use mechanical lineup display");
assert(contract.state_policy?.do_not_claim_external_code_ready === true, "must not claim external code readiness");

const plan = {
  title: "己方站位调整建议",
  summary: "只改关键英雄。",
  units: [
    { name: "黛安娜", star: 3, row: 3, col: 7, items: ["鬼索的狂暴之刃", "汲取剑", "泰坦的坚决"] },
    { name: "阿萝拉", star: 2, row: 4, col: 4, items: ["虚空之杖", "朔极之矛", "班克斯的魔法帽"] },
    { name: "莫甘娜", row: 1, col: 4, items: ["圣盾使的誓约", "冕卫", "日炎斗篷"] },
  ],
  recommended_moves: [
    {
      unit: "黛安娜",
      from: "第3行右1",
      to: "第3行左1",
      reason: "避开对手主控方向，同时保持切入后排。",
    },
  ],
};

const rendered = renderJccLineupTextBoard(plan);
assert(rendered.includes("【己方站位调整建议】"), "title missing");
assert(rendered.includes("列"), "column ruler missing");
assert(rendered.includes("╱────────╲"), "hex cell top border missing");
assert(rendered.includes("╲────────╱"), "hex cell bottom border missing");
assert(rendered.includes("     ╱────────╲"), "staggered row indent missing");
assert(rendered.split("单位与装备：")[0].includes("黛安娜"), "Diana cell missing from board");
assert(rendered.split("单位与装备：")[0].includes("阿萝拉"), "Aurora cell missing from board");
assert(!rendered.split("单位与装备：")[0].includes("3星"), "board cell should only show unit name");
assert(rendered.includes("第3行右1"), "right-side position word missing");
assert(rendered.includes("鬼索的狂暴之刃 / 汲取剑 / 泰坦的坚决"), "items missing");
assert(rendered.includes("建议改动："), "moves section missing");
assert(rendered.includes("避开对手主控方向"), "move reason missing");
const blockedRouteTerms = [
  "阵容码",
  "导入码",
  "OpenCLI",
  "official web",
  "Lineup Data",
];
assert(!blockedRouteTerms.some((term) => rendered.toLowerCase().includes(term.toLowerCase())), "external code route leaked into rendered plan");

const tmp = await mkdtemp(path.join(tmpdir(), "jcc-lineup-display-"));
await writeFile(path.join(tmp, "rendered.txt"), rendered, "utf8");

console.log(JSON.stringify({
  ok: true,
  checked: {
    contract_schema: contract.schema,
    external_code_paths_enabled: contract.external_code_paths.enabled,
    output_slots: Object.keys(contract.output_slots),
    rendered_preview: rendered.split("\n").slice(0, 11),
  },
}, null, 2));
