const { contextBridge, ipcRenderer } = require("electron");

const actions = new Set([
  "bootstrap",
  "discoverHostCliAgents",
  "detectHostCli",
  "connectMumu",
  "startMatch",
  "stopMatch",
  "setMode",
  "sendMessage",
  "sendCruiseHardDataQuery",
  "sendDailyCoreTheoryQuery",
  "sendCruisePopularRecipeQuery",
  "stopResponse",
  "getDecisionInputOptions",
  "captureDecisionInputOcrDraft",
  "submitDecisionInput",
  "confirmDecisionSelection",
  "observeRuntimeTick",
  "deliverReadyResponse",
  "ackDeliveredResponse",
  "getManualVariableOptions",
  "saveManualVariables",
  "saveUserPreferences",
  "saveRuntimeSettings",
  "saveStrategyMemory",
  "buildWikiCurationRequest",
  "getStrategyWikiStatus",
  "updateRankings",
  "pollCruiseAdvice",
  "resetDailySession",
  "restartRuntimeDaemon",
  "getState",
  "minimizeWindow",
  "closeWindow",
]);

function invoke(action, payload = {}) {
  if (!actions.has(action)) throw new Error(`Unknown runtime action: ${action}`);
  return ipcRenderer.invoke("jcc-runtime:action", action, payload);
}

contextBridge.exposeInMainWorld("jccRuntime", {
  bootstrap: () => invoke("bootstrap"),
  discoverHostCliAgents: (payload) => invoke("discoverHostCliAgents", payload),
  detectHostCli: (payload) => invoke("detectHostCli", payload),
  connectMumu: () => invoke("connectMumu"),
  startMatch: () => invoke("startMatch"),
  stopMatch: () => invoke("stopMatch"),
  setMode: (mode) => invoke("setMode", { mode }),
  sendMessage: (payload) => invoke("sendMessage", payload),
  sendCruiseHardDataQuery: (text) => invoke("sendCruiseHardDataQuery", { text }),
  sendDailyCoreTheoryQuery: (text) => invoke("sendDailyCoreTheoryQuery", { text }),
  sendCruisePopularRecipeQuery: (text) => invoke("sendCruisePopularRecipeQuery", { text }),
  stopResponse: (payload) => invoke("stopResponse", payload),
  getDecisionInputOptions: (payload) => invoke("getDecisionInputOptions", payload),
  captureDecisionInputOcrDraft: (payload) => invoke("captureDecisionInputOcrDraft", payload),
  submitDecisionInput: (payload) => invoke("submitDecisionInput", payload),
  confirmDecisionSelection: (payload) => invoke("confirmDecisionSelection", payload),
  observeRuntimeTick: () => invoke("observeRuntimeTick"),
  deliverReadyResponse: () => invoke("deliverReadyResponse"),
  ackDeliveredResponse: (payload) => invoke("ackDeliveredResponse", payload),
  getManualVariableOptions: () => invoke("getManualVariableOptions"),
  saveManualVariables: (payload) => invoke("saveManualVariables", payload),
  saveUserPreferences: (payload) => invoke("saveUserPreferences", payload),
  saveRuntimeSettings: (payload) => invoke("saveRuntimeSettings", payload),
  saveStrategyMemory: (payload) => invoke("saveStrategyMemory", payload),
  buildWikiCurationRequest: (payload) => invoke("buildWikiCurationRequest", payload),
  getStrategyWikiStatus: () => invoke("getStrategyWikiStatus"),
  updateRankings: () => invoke("updateRankings"),
  pollCruiseAdvice: () => invoke("pollCruiseAdvice"),
  resetDailySession: () => invoke("resetDailySession"),
  restartRuntimeDaemon: () => invoke("restartRuntimeDaemon"),
  getState: () => invoke("getState"),
  minimizeWindow: () => invoke("minimizeWindow"),
  closeWindow: () => invoke("closeWindow"),
  onRuntimeEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, runtimeEvent) => callback(runtimeEvent);
    ipcRenderer.on("jcc-runtime:event", handler);
    return () => ipcRenderer.removeListener("jcc-runtime:event", handler);
  },
});
