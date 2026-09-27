import { readFile } from "node:fs/promises";
import { renderJccLineupTextBoard } from "./render-jcc-lineup-text-board.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function buildLineupDisplayContext(lineupPlan) {
  return {
    schema: "jcc-lineup-display-context-v1",
    source: "mechanical_renderer",
    renderer: "tools/render-jcc-lineup-text-board.mjs",
    lineup_plan: lineupPlan,
    lineup_board_text: renderJccLineupTextBoard(lineupPlan, { color: false }).trimEnd(),
    render_policy: "When answering positioning or lineup display tasks, embed lineup_board_text verbatim. Do not redraw or reinterpret the board layout.",
  };
}

const outputLoopContract = await readJson("data/runtime/jcc/cruise-agent-output-loop-contract.json");
const displayPolicy = outputLoopContract.ai_native_output_policy?.rendering_layer?.lineup_display_policy;
assert(displayPolicy?.mechanical_renderer_required === true, "mechanical renderer policy missing");
assert(displayPolicy?.renderer_tool === "tools/render-jcc-lineup-text-board.mjs", "renderer tool policy mismatch");
assert(displayPolicy?.rendered_output_field === "context.lineup_display.lineup_board_text", "rendered field policy mismatch");
assert(displayPolicy?.applies_to?.some((entry) => /target lineup/i.test(entry)), "target lineup display policy missing");
assert(displayPolicy?.applies_to?.some((entry) => /transition lineup/i.test(entry)), "transition lineup display policy missing");
assert(displayPolicy?.applies_to?.some((entry) => /self-board placement/i.test(entry)), "self-board placement display policy missing");

const positioningLineupPlan = {
  title: "己方站位调整建议",
  summary: "只改关键英雄。",
  units: [
    { name: "慎", row: 1, col: 2, items: ["旅人纹章"] },
    { name: "布里茨", row: 1, col: 4, items: ["幻灵战队纹章", "珠光护手", "圣盾使的誓约"] },
    { name: "黛安娜", star: 3, row: 3, col: 7, items: ["鬼索的狂暴之刃", "泰坦的坚决", "汲取剑"] },
    { name: "阿萝拉", row: 4, col: 4, items: ["秘法手套", "红霸符", "朔极之矛"] },
  ],
  recommended_moves: [
    { unit: "黛安娜", from: "第3行右1", to: "第3行左1", reason: "避开对手主控方向。" },
  ],
};

const targetLineupPlan = {
  title: "大数据目标阵容",
  summary: "从掌盟/大数据阵容计划转成内部文字棋盘。",
  units: [
    { name: "蕾欧娜", row: 1, col: 2, items: ["石像鬼石板甲"] },
    { name: "黛安娜", star: 3, row: 3, col: 7, items: ["鬼索的狂暴之刃", "泰坦的坚决", "汲取剑"] },
    { name: "阿萝拉", row: 4, col: 4, items: ["红霸符", "朔极之矛"] },
  ],
};

const transitionLineupPlan = {
  title: "当前过渡阵容",
  summary: "Agent 主动写出的过渡方案也走同一个机械棋盘。",
  units: [
    { name: "内瑟斯", star: 2, row: 1, col: 3, items: ["日炎斗篷"] },
    { name: "金克丝", row: 4, col: 2, items: ["无尽之刃"] },
    { name: "提莫", row: 4, col: 5, items: [] },
  ],
};

const contexts = [
  buildLineupDisplayContext(positioningLineupPlan),
  buildLineupDisplayContext(targetLineupPlan),
  buildLineupDisplayContext(transitionLineupPlan),
];

for (const context of contexts) {
assert(context.source === "mechanical_renderer", "lineup display source must be mechanical renderer");
assert(context.lineup_board_text.includes("棋盘："), "rendered board missing heading");
assert(context.lineup_board_text.includes("单位与装备："), "rendered board missing detail section");
assert(!context.lineup_board_text.includes("阵容码"), "lineup board must not mention external import code");
}
assert(contexts[0].lineup_board_text.includes("慎"), "positioning board missing Shen");
assert(contexts[0].lineup_board_text.includes("布里茨"), "positioning board missing Blitzcrank");
assert(contexts[0].lineup_board_text.includes("建议改动："), "positioning board missing move section");
assert(contexts[1].lineup_board_text.includes("大数据目标阵容"), "target lineup board title missing");
assert(contexts[1].lineup_board_text.includes("蕾欧娜"), "target lineup board missing Leona");
assert(contexts[2].lineup_board_text.includes("当前过渡阵容"), "transition lineup board title missing");
assert(contexts[2].lineup_board_text.includes("金克丝"), "transition lineup board missing Jinx");

const hostCliAgentRequest = {
  schema: "jcc-host-cli-coach-response-request-v1",
  type: "host_cli_agent_coach_response_request",
  context: {
    mode: "lineup_card",
    lineup_display: contexts[0],
  },
  instructions: [
    "If context.lineup_display.lineup_board_text is present, embed that board text verbatim for target, transition, next-pivot, lineup, or positioning output.",
  ],
};

assert(hostCliAgentRequest.context.lineup_display.lineup_board_text === contexts[0].lineup_board_text, "host request must carry rendered board text");

const responseEvents = [
  {
    type: "advice_response_requested",
    trigger_id: "level_or_roll_timing",
    host_cli_agent_request: { context: {} },
  },
  {
    type: "advice_response_requested",
    trigger_id: "target_lineup_advice",
    host_cli_agent_request: { context: { lineup_display: contexts[1] } },
  },
];
const targetLineupEvent = responseEvents.find((event) => event.type === "advice_response_requested" && event.trigger_id === "target_lineup_advice");
assert(targetLineupEvent?.host_cli_agent_request?.context?.lineup_display?.lineup_board_text?.includes("大数据目标阵容"), "target lineup event must carry its own rendered board even when other advice events exist");

console.log(JSON.stringify({
  ok: true,
  checked: {
    contract_policy: displayPolicy,
    sources: contexts.map((context) => context.source),
    rendered_preview: contexts[0].lineup_board_text.split("\n").slice(0, 12),
    target_preview: contexts[1].lineup_board_text.split("\n").slice(0, 6),
    transition_preview: contexts[2].lineup_board_text.split("\n").slice(0, 6),
  },
}, null, 2));
