import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "../ui/node_modules/typescript/lib/typescript.js";

const source = await readFile(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
const start = source.indexOf("function selfStateRefreshView(");
const end = source.indexOf("\nfunction manualVariablesFromRuntime(", start);
assert(start >= 0 && end > start);
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const view = new Function("formatRuntimeStamp", `${compiled}; return selfStateRefreshView;`)(value => value || "-");
const connected = { status: "connected_to_live_match" };
const observed = { status: "completed_self_state_roi_ocr", last_stage_round: "2-2",
  last_economy: { hp: 100, gold: 6, level: 3, xp: { value: 4, to_next: 6 } }, last_missing_fields: [] };
assert.match(view(observed, connected).details, /HUD 已更新/);
assert.match(view({ ...observed, last_missing_fields: ["economy.hp"] }, connected).details, /部分更新/);
assert.match(view({ ...observed, status: "running" }, connected).details, /正在更新/);
assert.match(view({ ...observed, status: "failed", last_error: "timeout" }, connected).details, /观察失败/);
assert.match(view({ status: "completed", last_economy: { gold: 0 } }, connected).details, /HUD 已更新/);
assert.match(view({ status: "idle" }, connected).details, /未就绪/);
assert.equal(view({}, { status: "waiting_for_live_state" }).label, "等待进入对局");
console.log("HUD status view: canonical facts, partial, running, failure, zero and empty states passed");
