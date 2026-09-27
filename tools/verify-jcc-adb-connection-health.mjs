import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "../ui/node_modules/typescript/lib/typescript.js";
import { probeAdbConnection } from "../ui/electron/adb-connection-health.js";

for (const [error, output, expected] of [
  [null, "jcc_connection_ok\r\n", true],
  [new Error("offline"), "", false],
  [new Error("timeout"), "jcc_connection_ok", false],
  [null, "unauthorized", false],
]) {
  const result = await probeAdbConnection("adb", "selected-device", 2000, (command, args, options, callback) => {
    assert.deepEqual(args, ["-s", "selected-device", "shell", "echo", "jcc_connection_ok"]);
    assert.equal(options.timeout, 2000);
    assert.equal(options.windowsHide, true);
    callback(error, output);
  });
  assert.equal(result.connected, expected);
  assert(Number.isFinite(Date.parse(result.checked_at)));
}
const app = await readFile("ui/src/App.tsx", "utf8");
const source = app.slice(app.indexOf("function stateText("), app.indexOf("function formatRuntimeStamp("));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const stateText = Function(`${compiled};return stateText;`)();
const view = (status, age) => stateText({ device_connection: { status, ...(age === null ? {} : { checked_at: new Date(Date.now() - age).toISOString() }) } }).mumu;
assert.equal(view("connected", 1000), true);
assert.equal(view("connected", null), false, "persisted legacy connection is not proof of current connectivity");
assert.equal(view("connected", 60000), false, "expired heartbeat must not show green");
assert.equal(view("disconnected", 1000), false);
const service = await readFile("ui/electron/runtime-service.js", "utf8");
const refreshSource = service.match(/let adbHealthPending = null;[\s\S]*?async function refreshSelectedAdbConnection\(\) \{[\s\S]*?\n\}/)?.[0];
assert(refreshSource);
let calls = 0, finish;
const state = { device_connection: { adb_target: { serial: "selected-device" }, adb_path: "adb", discovered_at: "first" } };
const refresh = Function("state", "probeAdbConnection", "normalizeAdbTargetSerial", "persistState", `${refreshSource};return refreshSelectedAdbConnection;`)(
  state, () => { calls++; return new Promise(resolve => { finish = resolve; }); }, target => target?.serial,
  async () => {},
);
const first = refresh(), second = refresh();
assert.equal(calls, 1, "concurrent state refreshes share one probe");
state.device_connection = { ...state.device_connection, discovered_at: "second", status: "connected" };
finish({ connected: false, checked_at: new Date().toISOString() });
await Promise.all([first, second]);
assert.equal(state.device_connection.status, "connected", "old probe cannot overwrite newer explicit reconnect");
await refresh();
assert.equal(calls, 1, "frequent UI polling cannot create repeated ADB probes");
console.log("ADB bounded selected-device probe and truthful connection badge passed");

const daemon = await readFile("ui/electron/runtime-daemon.js", "utf8");
const persistence = daemon.match(/const connectionChanged = action === "getState"[\s\S]*?const persistedResult = [^;]+;/)?.[0];
assert(persistence);
const oldConnection = { status: "connected", checked_at: "old" };
let canonical = { device_connection: oldConnection };
let writes = 0;
const owner = {
  store: { getJson: () => canonical },
  persistResult(action, result) { writes++; canonical = result.state; return result; },
};
const applyRead = Function("action", "result", "readOnlyAction", `${persistence}; return persistedResult;`).bind(owner);
applyRead("getState", { state: { device_connection: { status: "connected", checked_at: "fresh" } } }, true);
assert.equal(writes, 1, "health probe must survive the next SQLite hydration");
applyRead("getState", { state: structuredClone(canonical) }, true);
assert.equal(writes, 1, "unchanged reads must remain read-only");
applyRead("getState", { state: { device_connection: { status: "disconnected", checked_at: "later" } } }, true);
assert.equal(canonical.device_connection.status, "disconnected");
console.log("ADB probe changes persist through the daemon read path; unchanged reads do not write");
