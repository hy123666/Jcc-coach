import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JCC_CODEX_DYNAMIC_TOOL_SPECS,
  JCC_HOST_READONLY_TOOL_CONTRACT_VERSION,
} from "./host-readonly-tool-broker.js";
import { terminateProcessTree } from "../../tools/jcc_process_runner.mjs";
import { decodeHostJsonObject } from "./host-response-json.js";
import { resolveCodexTurnDelivery } from "./host-turn-delivery.js";
import { createKimiReadonlyMcpTransport, KIMI_MCP_MAX_RESULT_BYTES } from "./kimi-readonly-mcp-transport.js";

const defaultHostCwd = path.join(os.tmpdir(), "jcc-runtime-host-cli-cwd");
const activeHostProcesses = new Map();
const codexSessionHomes = new Map();
const persistentHostSessions = new Map();
const persistentHostSessionStarts = new Map();
const persistentHostSessionStartTransports = new Map();
const persistentHostSessionStartTransportClosures = new Map();
const persistentHostSessionStartBlocks = new Set();
const persistentHostSessionClosures = new Map();
const persistentHostSessionEpochs = new Map();
let cachedNodeCommand = null;

export function assertProviderOutputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("invalid_json_schema: output schema must be an object");
  }
  const errors = [];
  const visit = (node, at) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const types = Array.isArray(node.type) ? node.type : [node.type].filter(Boolean);
    if (types.includes("object") || node.properties) {
      const properties = node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)
        ? node.properties
        : {};
      const propertyNames = Object.keys(properties).sort();
      const required = Array.isArray(node.required) ? [...new Set(node.required)].sort() : null;
      if (node.additionalProperties !== false) errors.push(`${at}.additionalProperties must be false`);
      if (!required) {
        errors.push(`${at}.required must be an array containing every property`);
      } else {
        const missing = propertyNames.filter((name) => !required.includes(name));
        const unknown = required.filter((name) => !Object.hasOwn(properties, name));
        if (missing.length) errors.push(`${at}.required is missing ${missing.join(", ")}`);
        if (unknown.length) errors.push(`${at}.required contains unknown ${unknown.join(", ")}`);
      }
      for (const [name, child] of Object.entries(properties)) visit(child, `${at}.properties.${name}`);
    }
    if (node.items) visit(node.items, `${at}.items`);
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(node[keyword])) node[keyword].forEach((child, index) => visit(child, `${at}.${keyword}[${index}]`));
    }
  };
  visit(schema, "$");
  if (errors.length) throw new Error(`invalid_json_schema: ${errors.join("; ")}`);
  return schema;
}

function hostProcessTaskId(options = {}) {
  const explicit = String(options.taskId || options.response_task_id || "").trim();
  if (explicit) return explicit;
  return `host-task-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function registerHostProcess(taskId, handle) {
  const existing = activeHostProcesses.get(taskId);
  if (existing && existing !== handle) {
    throw new Error(`Host task id ${taskId} is already registered.`);
  }
  activeHostProcesses.set(taskId, handle);
}

function unregisterHostProcess(taskId, handle) {
  const current = activeHostProcesses.get(taskId);
  if (!current || current !== handle) return;
  activeHostProcesses.delete(taskId);
}

function cancelHostProcessHandle(handle) {
  if (handle?.abort) {
    const result = handle.abort();
    if (result && typeof result === "object") {
      return {
        accepted: result.accepted !== false,
        provider_acknowledged: result.provider_acknowledged === true,
        release_handle: result.release_handle === true,
        state: result.state || null,
      };
    }
    return {
      accepted: result !== false,
      provider_acknowledged: false,
      release_handle: result !== false,
      state: result !== false ? "cancelled" : "not_cancelled",
    };
  }
  if (!handle?.pid) {
    return {
      accepted: false,
      provider_acknowledged: false,
      release_handle: false,
      state: "not_targetable",
    };
  }
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(handle.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    }).on("error", () => {});
  } else {
    handle.kill("SIGTERM");
  }
  return {
    accepted: true,
    provider_acknowledged: false,
    release_handle: true,
    state: "process_termination_requested",
  };
}

function isTransientWindowsFileLock(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(code)
    || /operation not permitted|directory not empty|resource busy|access is denied/i.test(message);
}

async function retryTransientFileOperation(operation, { attempts = 6, delayMs = 80 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsFileLock(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

async function removeRuntimePath(target) {
  await retryTransientFileOperation(() => rm(target, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 80,
  })).catch((error) => {
    if (!isTransientWindowsFileLock(error)) throw error;
  });
}

const defaultModelOption = { value: "default", label: "\u8ddf\u968f CLI \u9ed8\u8ba4", native: true };
const reasoningEffortOptionCatalog = {
  default: defaultModelOption,
  low: { value: "low", label: "\u4f4e\uff1a\u66f4\u5feb", native: true },
  medium: { value: "medium", label: "\u4e2d\uff1a\u5747\u8861", native: true },
  high: { value: "high", label: "\u9ad8\uff1a\u590d\u6742\u5c40\u9762", native: true },
  xhigh: { value: "xhigh", label: "\u8d85\u9ad8\uff1a\u6df1\u5ea6\u5c40\u9762/\u590d\u76d8", native: true },
  max: { value: "max", label: "\u6700\u9ad8\uff1a\u91cd\u8981\u7b56\u7565\u51b3\u7b56", native: true },
  ultra: { value: "ultra", label: "Ultra\uff1a\u6700\u5f3a\u601d\u8003\uff08\u6162\uff09", native: true },
};
function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeModelId(model) {
  const value = String(model || "").trim();
  return value && value !== "default" ? value : null;
}

function selectKnownModelAlias(model, modelOptions = []) {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  return modelOptions.some((option) => option?.value === normalized) ? normalized : null;
}

function selectedModelOption(model, modelOptions = []) {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  return modelOptions.find((option) => option?.value === normalized) || null;
}

function reasoningEffortOptionsFromLevels(levels) {
  const normalized = uniqueStrings(levels);
  if (!normalized.length) return [reasoningEffortOptionCatalog.default];
  return [
    reasoningEffortOptionCatalog.default,
    ...normalized
      .map((level) => reasoningEffortOptionCatalog[level])
      .filter(Boolean),
  ];
}

export function reasoningEffortOptionsForModel(model, modelOptions = []) {
  const option = selectedModelOption(model, modelOptions);
  const catalogLevels = Array.isArray(option?.supported_reasoning_levels)
    ? option.supported_reasoning_levels
    : [];
  return reasoningEffortOptionsFromLevels(catalogLevels);
}

export function normalizeReasoningEffort(model, effort, modelOptions = []) {
  const value = String(effort || "").trim();
  if (!value || value === "default") return null;
  const allowed = new Set(reasoningEffortOptionsForModel(model, modelOptions).map((option) => option.value));
  return allowed.has(value) ? value : null;
}

export function hostCliCapabilities(provider, model, modelOptions = []) {
  const selectedModel = normalizeModelId(model);
  if (provider === "kimi") {
    const option = selectedModelOption(selectedModel, modelOptions);
    const hasCatalogLevels = Array.isArray(option?.supported_reasoning_levels) && option.supported_reasoning_levels.length > 0;
    return {
      schema: "jcc-host-cli-capabilities-v1",
      provider: "kimi",
      selected_model: selectedModel,
      reasoning_effort_source: hasCatalogLevels ? "kimi_provider_list_support_efforts" : (selectedModel ? "selected_model_has_no_catalog_reasoning_levels" : "cli_default_unknown_model"),
      reasoning_effort_options: reasoningEffortOptionsForModel(selectedModel, modelOptions),
      prompt_transport: "acp-session-prompt-content-blocks",
      image_transport: "acp-session-prompt-image-base64",
      readonly_strategy_tools: {
        mode: "prefetch_complete",
        contract_version: JCC_HOST_READONLY_TOOL_CONTRACT_VERSION,
        tools: [],
        reason: "Persistent Kimi sessions verify the isolated MCP initialize/tools/list handshake before advertising native_dynamic_tools. Discovery alone is not verification.",
      },
      model_capability_note: "Kimi ACP advertises promptCapabilities.image and accepts image content blocks; JCC sends transient screenshots as ACP image blocks. Model speed is selected through the Kimi model alias when exposed.",
      policy: "Kimi adapter keeps runtime state outside the host CLI and uses ACP session/prompt content blocks for text and image selected context.",
    };
  }
  if (provider !== "codex") throw new Error(`Unsupported host provider: ${provider}`);
  const option = selectedModelOption(selectedModel, modelOptions);
  const hasCatalogLevels = Array.isArray(option?.supported_reasoning_levels) && option.supported_reasoning_levels.length > 0;
  return {
    schema: "jcc-host-cli-capabilities-v1",
    provider: "codex",
    selected_model: selectedModel,
    reasoning_effort_source: hasCatalogLevels ? "codex_debug_models_supported_reasoning_levels" : (selectedModel ? "selected_model_has_no_catalog_reasoning_levels" : "cli_default_unknown_model"),
    reasoning_effort_options: reasoningEffortOptionsForModel(selectedModel, modelOptions),
    readonly_strategy_tools: {
      mode: "native_dynamic_tools",
      contract_version: JCC_HOST_READONLY_TOOL_CONTRACT_VERSION,
      tools: ["jcc.query_knowledge", "jcc.calculate"],
      tool_surface_policy: "jcc_native_dynamic_tools_only",
    },
    policy: "Runtime passes the selected value through to the host CLI only when the adapter supports it; Codex JCC sessions disable the generic shell surface.",
  };
}

function defaultModelOptionFor(defaultLabel = null) {
  const cleanLabel = String(defaultLabel || "").trim();
  if (!cleanLabel) return defaultModelOption;
  return {
    ...defaultModelOption,
    label: `\u8ddf\u968f CLI \u9ed8\u8ba4\uff08${cleanLabel}\uff09`,
    default_model_label: cleanLabel,
  };
}

function normalizeModelOptions(options, defaultOption = defaultModelOption) {
  const seen = new Set();
  return [defaultOption, ...options]
    .filter((option) => option?.value)
    .filter((option) => {
      if (seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
}

function parseKimiProviderModels(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || "").trim() || "{}");
    return Object.entries(parsed.models || {}).map(([model, meta]) => ({
      value: model,
      label: meta?.displayName ? `${meta.displayName} (${model})` : model,
      native: true,
      display_name: meta?.displayName || null,
      provider: meta?.provider || null,
      capabilities: Array.isArray(meta?.capabilities) ? meta.capabilities : [],
      supported_reasoning_levels: Array.isArray(meta?.supportEfforts)
        ? meta.supportEfforts.map((effort) => String(effort || "").trim()).filter(Boolean)
        : [],
      default_reasoning_level: String(meta?.defaultEffort || "").trim() || null,
    }));
  } catch {
    return [];
  }
}

function parseCodexDebugModels(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || "").trim() || "{}");
    return (Array.isArray(parsed.models) ? parsed.models : [])
      .filter((model) => model?.slug && model.visibility !== "hidden")
      .map((model) => ({
        value: model.slug,
        label: model.display_name ? `${model.display_name} (${model.slug})` : model.slug,
        native: true,
        display_name: model.display_name || null,
        description: model.description || null,
        supported_reasoning_levels: Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels.map((entry) => entry?.effort).filter(Boolean)
          : [],
        default_reasoning_level: model.default_reasoning_level || null,
        capabilities: model.input_modalities || null,
      }));
  } catch {
    return [];
  }
}

function parseTomlStringValue(raw, key) {
  const escaped = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(raw || "").match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]+)"`, "m"));
  return match?.[1]?.trim() || null;
}

function parseCodexConfigModels(raw) {
  const defaultModel = parseTomlStringValue(raw, "model");
  const defaultProvider = parseTomlStringValue(raw, "model_provider");
  const models = [];
  if (defaultModel) {
    models.push({
      value: defaultModel,
      label: defaultProvider ? `${defaultModel} (${defaultProvider})` : defaultModel,
      native: true,
      display_name: defaultModel,
      provider: defaultProvider || null,
      source: "codex_config",
    });
  }
  return {
    default_model: defaultModel,
    default_model_label: defaultModel,
    default_provider: defaultProvider,
    models,
  };
}

async function readKimiDefaultModel(command) {
  try {
    const configPath = path.join(sourceKimiHome(null, command), "config.toml");
    const raw = await readFile(configPath, "utf8");
    const match = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

async function readCodexConfigModelInfo() {
  try {
    const raw = await readFile(path.join(sourceCodexHome(), "config.toml"), "utf8");
    return parseCodexConfigModels(raw);
  } catch {
    return {
      default_model: null,
      default_model_label: null,
      default_provider: null,
      models: [],
    };
  }
}

function isWindowsCommandShim(command) {
  const lower = String(command || "").toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

function looksLikeNodeExecutable(command) {
  const base = path.basename(String(command || "")).toLowerCase();
  return base === "node" || base === "node.exe";
}

function runProcess(command, args, options = {}) {
  const { timeoutMs = 15000, input = null, cwd = process.cwd(), env = {} } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: `${error.message || String(error)}\ncommand=${command}\nargs=${args.join(" ")}`.trim() });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      timedOut = true;
      await terminateProcessTree(child);
      if (settled) return;
      settled = true;
      resolve({
        code: 124,
        stdout,
        stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(),
        user_error: `Timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled || timedOut) return;
      clearTimeout(timer);
      settled = true;
      resolve({ code: 1, stdout, stderr: `${error.message || String(error)}\ncommand=${command}\nargs=${args.join(" ")}`.trim() });
    });
    child.on("close", (code) => {
      if (settled || timedOut) return;
      clearTimeout(timer);
      settled = true;
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

function nodeCommandCandidates() {
  const candidates = [process.env.JCC_NODE];
  if (looksLikeNodeExecutable(process.execPath)) candidates.push(process.execPath);
  if (process.env.npm_node_execpath && !/Claude CLI/i.test(process.env.npm_node_execpath)) candidates.push(process.env.npm_node_execpath);
  if (process.env.NODE && !/Claude CLI/i.test(process.env.NODE)) candidates.push(process.env.NODE);
  candidates.push("C:\\Program Files\\nodejs\\node.exe");
  candidates.push("node");
  return uniqueStrings(candidates);
}

async function getNodeCommand() {
  if (cachedNodeCommand) return cachedNodeCommand;
  for (const command of nodeCommandCandidates()) {
    if (!process.env.JCC_NODE && /Claude CLI/i.test(command)) continue;
    const result = await runProcess(command, ["--version"], { timeoutMs: 5000 });
    if (result.code === 0 && /^v\d+\./.test(result.stdout.trim())) {
      cachedNodeCommand = command;
      return command;
    }
  }
  return "node";
}

async function codexJsEntrypointForShim(command) {
  if (!isWindowsCommandShim(command)) return null;
  try {
    const raw = await readFile(command, "utf8");
    const linked = raw.match(/call\s+"([^"]+codex\.cmd)"/i);
    const scriptShim = linked ? linked[1] : command;
    const scriptRaw = await readFile(scriptShim, "utf8");
    const scriptMatch = scriptRaw.match(/node\s+"%SCRIPT_DIR%([^"]+codex\.js)"/i);
    if (!scriptMatch) return null;
    return path.join(path.dirname(scriptShim), scriptMatch[1]);
  } catch {
    return null;
  }
}

function commandShimSpec(command, args) {
  if (process.platform === "win32" && isWindowsCommandShim(command)) {
    return { command: "cmd.exe", args: ["/d", "/c", command, ...args] };
  }
  return { command, args };
}

async function whereCandidates(bin, envName) {
  const fromEnv = process.env[envName];
  if (process.platform !== "win32") return uniqueStrings([fromEnv, bin]);
  const result = await runProcess("where.exe", [bin], { timeoutMs: 5000 });
  const paths = result.code === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  return uniqueStrings([fromEnv, ...paths].filter((command) => commandLooksLikeCli(command, bin)).concat(bin));
}

function commandNamesForBin(bin) {
  if (process.platform === "win32") return [`${bin}.cmd`, `${bin}.exe`, bin];
  return [bin];
}

function commandBasenameStem(command) {
  const base = path.basename(String(command || "")).toLowerCase();
  return base.replace(/\.(cmd|exe|ps1|bat)$/i, "");
}

function commandLooksLikeCli(command, bin) {
  if (!command) return false;
  return commandBasenameStem(command) === String(bin || "").toLowerCase();
}

function outputLooksLikeCliVersion(output, bin) {
  const normalized = String(output || "").toLowerCase();
  const expected = String(bin || "").toLowerCase();
  if (!normalized) return false;
  if (expected === "codex") return /\bcodex(?:-cli)?\b/.test(normalized);
  if (expected === "kimi") return !/\bcodex(?:-cli)?\b/.test(normalized)
    && (/\bkimi(?:\s+code|-code)?\b/.test(normalized) || /^\s*v?\d+\.\d+\.\d+/.test(normalized));
  return normalized.includes(expected);
}

function discoveryFailureDetails(attempts, fallback) {
  const attempt = [...attempts].reverse().find((entry) => entry.command_exists) || attempts.at(-1) || null;
  return {
    command: attempt?.command_exists ? attempt.command : null,
    error: attempt?.stderr || attempt?.stdout || fallback,
  };
}

function providerOwnedCommandCandidates(payload = {}, bin) {
  return uniqueStrings([
    payload.command,
    payload.last_successful_command,
    payload.lastSuccessfulCommand,
  ].filter((command) => commandLooksLikeCli(command, bin)));
}

function binCandidatesFromDir(dir, bin) {
  if (!dir) return [];
  return commandNamesForBin(bin).map((name) => path.join(dir, name));
}

function inferKimiHomeFromCommand(command) {
  if (!command) return null;
  const resolved = path.resolve(String(command));
  const segments = resolved.split(/[\\/]+/);
  const kimiCliIndex = segments.findIndex((segment) => segment.toLowerCase() === "kimi cli");
  if (kimiCliIndex >= 0) {
    return path.join(segments.slice(0, kimiCliIndex + 1).join(path.sep), ".kimi-code");
  }
  const launcherIndex = segments.findIndex((segment) => segment.toLowerCase() === "cli launchers");
  if (launcherIndex >= 0) {
    return path.join(segments.slice(0, launcherIndex).join(path.sep), "KIMI CLI", ".kimi-code");
  }
  return null;
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function normalizePathList(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  return String(value || "")
    .split(path.delimiter)
    .flatMap((entry) => entry.split(/[;\n]/))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function globalPackageManagerBinDirs() {
  const commands = [
    ["npm", ["config", "get", "prefix"], (stdout) => {
      const prefix = stdout.trim();
      return process.platform === "win32" ? prefix : path.join(prefix, "bin");
    }],
    ["pnpm", ["bin", "-g"], (stdout) => stdout.trim()],
    ["yarn", ["global", "bin"], (stdout) => stdout.trim()],
    ["bun", ["pm", "bin", "-g"], (stdout) => stdout.trim()],
  ];
  const dirs = [];
  for (const [command, args, parse] of commands) {
    const candidates = process.platform === "win32"
      ? uniqueStrings([`${command}.cmd`, command])
      : [command];
    for (const candidate of candidates) {
      const result = await runProcess(candidate, args, { timeoutMs: 3000 });
      if (result.code === 0) {
        dirs.push(parse(result.stdout));
        break;
      }
    }
  }
  return uniqueStrings(dirs);
}

function windowsDriveRoots() {
  if (process.platform !== "win32") return [];
  return Array.from({ length: 24 }, (_, index) => `${String.fromCharCode(67 + index)}:\\`);
}

function commonWindowsCliSearchRoots() {
  if (process.platform !== "win32") return [];
  const suffixes = [
    "OneDrive",
    "000-AI",
    path.join("000-AI", "000-001-VIBE-CODE"),
    "AI",
    "Tools",
    "Dev",
    "Code",
  ];
  return windowsDriveRoots().flatMap((root) => suffixes.map((suffix) => path.join(root, suffix)));
}

function configuredKimiInstallCandidates(payload = {}) {
  const dirs = uniqueStrings([
    payload.install_dir,
    payload.installDir,
    payload.last_successful_command ? path.dirname(payload.last_successful_command) : null,
    payload.lastSuccessfulCommand ? path.dirname(payload.lastSuccessfulCommand) : null,
    process.env.JCC_KIMI_HOME,
    process.env.KIMI_HOME,
    ...(String(process.env.JCC_KIMI_CANDIDATE_DIRS || "")
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)),
  ]);
  return dirs.flatMap((dir) => [
    ...binCandidatesFromDir(dir, "kimi"),
    ...binCandidatesFromDir(path.join(String(dir || ""), "node_modules", ".bin"), "kimi"),
  ]);
}

function configuredCliSearchRoots(bin, payload = {}, options = {}) {
  const { includeExplicit = true, includeDefaults = true } = options;
  const upperBin = String(bin || "").toUpperCase();
  const explicitRoots = [
    ...normalizePathList(payload.search_root || payload.searchRoot),
    ...normalizePathList(payload.search_roots || payload.searchRoots),
    ...normalizePathList(process.env[`JCC_${upperBin}_SEARCH_ROOTS`]),
  ];
  const winRoots = process.platform === "win32"
    ? [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "pnpm") : null,
        process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        path.join(os.homedir(), ".bun", "bin"),
        path.join(os.homedir(), ".volta", "bin"),
        path.join(os.homedir(), "scoop", "shims"),
        ...commonWindowsCliSearchRoots(),
      ]
    : [
        path.join(os.homedir(), ".local", "bin"),
        path.join(os.homedir(), ".bun", "bin"),
        path.join(os.homedir(), ".volta", "bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin",
      ];
  return uniqueStrings([
    ...(includeExplicit ? explicitRoots : []),
    ...(includeDefaults ? winRoots : []),
  ]);
}

async function boundedCliSearchCandidates(bin, payload = {}, options = {}) {
  const roots = configuredCliSearchRoots(bin, payload, options);
  const names = new Set(commandNamesForBin(bin).map((name) => name.toLowerCase()));
  const broadSearch = options.includeExplicit === true && options.includeDefaults === false;
  const upperBin = String(bin || "").toUpperCase();
  const maxDepth = Math.max(1, Number(payload.search_max_depth || payload.searchMaxDepth || process.env[`JCC_${upperBin}_SEARCH_MAX_DEPTH`] || 4));
  const maxEntries = Math.max(100, Number(payload.search_max_entries || payload.searchMaxEntries || process.env[`JCC_${upperBin}_SEARCH_MAX_ENTRIES`] || 2500));
  const candidates = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    candidates.push(...binCandidatesFromDir(root, bin));
    candidates.push(...binCandidatesFromDir(path.join(root, "node_modules", ".bin"), bin));

    let visited = 0;
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length && visited < maxEntries) {
      const { dir, depth } = queue.shift();
      visited += 1;
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const lower = entry.name.toLowerCase();
        if (entry.isFile() && names.has(lower)) {
          candidates.push(full);
          continue;
        }
        if (!entry.isDirectory() || depth >= maxDepth) continue;
        const dirName = lower;
        const likely = broadSearch ||
          dirName.includes(String(bin).toLowerCase()) ||
          dirName === "bin" ||
          dirName === ".bin" ||
          dirName === "node_modules" ||
          dirName === "packages" ||
          dirName === "app" ||
          dirName === "resources" ||
          dirName === "cli";
        if (likely) queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return uniqueStrings(candidates);
}

async function boundedKimiSearchCandidates(payload = {}, options = {}) {
  return boundedCliSearchCandidates("kimi", payload, options);
}

function commonUserKimiCliCandidates() {
  if (process.platform !== "win32") return [];
  return [
    path.join(os.homedir(), "AppData", "Roaming", "npm"),
    path.join(os.homedir(), "AppData", "Local", "pnpm"),
    path.join(os.homedir(), "AppData", "Local", "Yarn", "bin"),
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".volta", "bin"),
    path.join(os.homedir(), "scoop", "shims"),
  ].flatMap((dir) => binCandidatesFromDir(dir, "kimi"));
}

function repoNearbyKimiCliCandidates(repoRoot = null) {
  const roots = [];
  let current = path.resolve(repoRoot || process.env.JCC_RUNTIME_REPO_ROOT || process.cwd());
  for (let i = 0; i < 5; i += 1) {
    roots.push(current);
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return roots.flatMap((root) => [
    path.join(root, "000-001-VIBE-CODE", "CLI Launchers", process.platform === "win32" ? "kimi.cmd" : "kimi"),
    path.join(root, "KIMI CLI", "node_modules", ".bin", process.platform === "win32" ? "kimi.cmd" : "kimi"),
    path.join(root, "000-001-VIBE-CODE", "KIMI CLI", "node_modules", ".bin", process.platform === "win32" ? "kimi.cmd" : "kimi"),
  ]);
}

function commonUserCodexCliCandidates() {
  if (process.platform !== "win32") return [];
  return [
    path.join(os.homedir(), "AppData", "Roaming", "npm"),
    path.join(os.homedir(), "AppData", "Local", "pnpm"),
    path.join(os.homedir(), "AppData", "Local", "Yarn", "bin"),
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".volta", "bin"),
    path.join(os.homedir(), "scoop", "shims"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "omx-cli-bin") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "cli-link") : null,
  ].flatMap((dir) => binCandidatesFromDir(dir, "codex"));
}

function repoNearbyCodexCliCandidates(repoRoot = null) {
  const roots = [];
  let current = path.resolve(repoRoot || process.env.JCC_RUNTIME_REPO_ROOT || process.cwd());
  for (let i = 0; i < 5; i += 1) {
    roots.push(current);
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return roots.flatMap((root) => [
    path.join(root, "Codex cli", process.platform === "win32" ? "codex.cmd" : "codex"),
  ]);
}

async function codexCliCandidates(payload = {}) {
  const globalBinDirs = await globalPackageManagerBinDirs();
  return uniqueStrings([
    ...providerOwnedCommandCandidates(payload, "codex"),
    ...(await boundedCliSearchCandidates("codex", payload, { includeExplicit: true, includeDefaults: false })),
    ...globalBinDirs.flatMap((dir) => binCandidatesFromDir(dir, "codex")),
    ...commonUserCodexCliCandidates(),
    ...repoNearbyCodexCliCandidates(payload.repoRoot),
    ...(await whereCandidates("codex", "JCC_CODEX")),
    ...(await boundedCliSearchCandidates("codex", payload, { includeExplicit: false, includeDefaults: true })),
    "codex",
  ].filter((command) => commandLooksLikeCli(command, "codex")));
}

async function kimiCliCandidates(payload = {}) {
  const globalBinDirs = await globalPackageManagerBinDirs();
  return uniqueStrings([
    ...providerOwnedCommandCandidates(payload, "kimi"),
    ...configuredKimiInstallCandidates(payload),
    ...(await boundedKimiSearchCandidates(payload, { includeExplicit: true, includeDefaults: false })),
    ...(await whereCandidates("kimi", "KIMI_BIN")),
    ...globalBinDirs.flatMap((dir) => binCandidatesFromDir(dir, "kimi")),
    ...commonUserKimiCliCandidates(),
    ...repoNearbyKimiCliCandidates(payload.repoRoot),
    ...(await boundedKimiSearchCandidates(payload, { includeExplicit: false, includeDefaults: true })),
    "kimi",
  ].filter((command) => commandLooksLikeCli(command, "kimi")));
}

async function canonicalHostAgentsContent(repoRoot = process.cwd()) {
  const candidates = uniqueStrings([
    path.join(path.resolve(repoRoot || process.cwd()), "AGENTS.md"),
    path.join(process.cwd(), "AGENTS.md"),
  ]);
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf8");
      if (content.includes("## Runtime Host CLI Context") || content.includes("# JCC Runtime Host CLI Context")) return content;
    } catch {}
  }
  throw new Error("JCC Runtime canonical AGENTS.md is unavailable for Host workspace initialization.");
}

async function ensureHostCwd(dir = defaultHostCwd, repoRoot = process.cwd()) {
  await mkdir(dir, { recursive: true });
  const agentsFile = path.join(dir, "AGENTS.md");
  const content = await canonicalHostAgentsContent(repoRoot);
  try {
    const existing = await readFile(agentsFile, "utf8");
    if (existing === content) return dir;
  } catch {}
  await writeFile(agentsFile, content, "utf8");
  return dir;
}

function defaultRuntimeDataRoot(repoRoot) {
  return path.join(path.resolve(repoRoot || process.cwd()), ".jcc-runtime-data");
}

function sourceCodexHome() {
  return path.resolve(process.env.JCC_SOURCE_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceKimiHome(homeOverride = null, command = null) {
  return path.resolve(
    homeOverride
      || process.env.JCC_KIMI_RUNTIME_HOME
      || process.env.JCC_SOURCE_KIMI_HOME
      || process.env.KIMI_CODE_HOME
      || process.env.KIMI_HOME
      || inferKimiHomeFromCommand(command)
      || path.join(os.homedir(), ".kimi-code"),
  );
}

async function prepareKimiRuntimeEnv(repoRoot, homeOverride = null, command = null) {
  const kimiHome = sourceKimiHome(homeOverride, command);
  await mkdir(kimiHome, { recursive: true });
  return {
    home: kimiHome,
    env: {
      KIMI_CODE_HOME: kimiHome,
      KIMI_HOME: kimiHome,
      JCC_HOST_CLI_SELECTED_CONTEXT_MODE: "1",
      JCC_HOST_CLI_RUNTIME_HOME_KIND: "kimi-code-home",
    },
  };
}

export function sanitizeKimiConfigForRuntime(rawConfig) {
  const output = ["merge_all_available_skills = false"];
  let include = false;
  let inTable = false;
  for (const line of String(rawConfig || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inTable = true;
      include = /^\s*\[(?:providers\.|models\.|thinking\s*\])/.test(line);
    }
    if (inTable ? include : /^\s*default_model\s*=/.test(line)) output.push(line);
  }
  return `${output.join("\n")}\n`;
}

async function prepareKimiReadonlySession(adapterState, options) {
  const sourceHome = sourceKimiHome(adapterState.kimi_home, adapterState.command);
  const identity = crypto.createHash("sha256").update(JSON.stringify([
    options.repoRoot || process.cwd(), options.hostSessionKey, sourceHome, adapterState.command,
  ])).digest("hex");
  const root = path.join(os.tmpdir(), "jcc-kimi-readonly", identity);
  const home = path.join(root, "home");
  // Native history survives recovery; executable configuration does not.
  for (const entry of ["mcp.json", "plugins", "skills", ".agents", ".kimi-code", ".claude", ".codex", "AGENTS.md", "agents.md", "CLAUDE.md"]) {
    const target = path.join(home, entry);
    await removeRuntimePath(target);
    if (await pathExists(target)) throw new Error(`Kimi isolated configuration cleanup incomplete: ${entry}`);
  }
  await removeRuntimePath(path.join(root, "workspace"));
  if (await pathExists(path.join(root, "workspace"))) throw new Error("Kimi isolated workspace cleanup incomplete");
  const hostCwd = await ensureHostCwd(path.join(root, "workspace"), options.repoRoot);
  await mkdir(home, { recursive: true });
  const config = await readFile(path.join(sourceHome, "config.toml"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const permissionRules = [
    { decision: "deny", pattern: "!{mcp__jcc__query_knowledge,mcp__jcc__calculate}" },
    ...["mcp__jcc__query_knowledge", "mcp__jcc__calculate"].map((pattern) => ({ decision: "allow", pattern })),
  ];
  const permissions = permissionRules.map((rule) => `[[permission.rules]]\nscope = "user"\ndecision = ${JSON.stringify(rule.decision)}\npattern = ${JSON.stringify(rule.pattern)}\n`).join("\n");
  await writeFile(path.join(home, "config.toml"), `${sanitizeKimiConfigForRuntime(config)}\n${permissions}`, "utf8");
  await mkdir(path.join(home, "credentials"), { recursive: true });
  await copyCodexRuntimeCredential(sourceHome, home, path.join("credentials", "kimi-code.json"));
  let command = adapterState.command || "kimi";
  let prefix = [];
  if (isWindowsCommandShim(command)) {
    const shim = await readFile(command, "utf8").catch(() => "");
    if (/set\s+"?KIMI_CODE_HOME\s*=/i.test(shim)) {
      const entry = path.join(path.dirname(inferKimiHomeFromCommand(command) || sourceHome), "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs");
      if (!await pathExists(entry)) throw new Error("Kimi launcher overrides Runtime home and its native entrypoint is unavailable");
      command = process.execPath;
      prefix = [entry];
    }
  }
  const baseArgs = adapterState.build_args?.length ? adapterState.build_args : ["acp"];
  const model = normalizeModelId(effectiveHostModel(adapterState));
  return {
    ...commandShimSpec(command, [...prefix,
      ...(model ? ["--model", model] : []), ...baseArgs]),
    home, hostCwd, cleanup: () => removeRuntimePath(root),
    env: { HOME: home, USERPROFILE: home, KIMI_CODE_HOME: home, KIMI_HOME: home,
      KIMI_CODE_EXPERIMENTAL_FLAG: "0", KIMI_CODE_EXPERIMENTAL_TOOL_SELECT: "0", KIMI_MCP_TOOL_TIMEOUT_MS: "300000",
      JCC_HOST_CLI_SELECTED_CONTEXT_MODE: "1", JCC_HOST_CLI_RUNTIME_HOME_KIND: "kimi-readonly-session-home" },
  };
}

async function copyCodexRuntimeCredential(sourceHome, targetHome, fileName) {
  const source = path.join(sourceHome, fileName);
  if (!(await pathExists(source))) return false;
  await copyFile(source, path.join(targetHome, fileName));
  return true;
}

const codexRuntimeConfigTopLevelKeys = new Set([
  "model_provider",
  "model",
  "model_reasoning_effort",
  "model_context_window",
  "model_auto_compact_token_limit",
  "network_access",
  "disable_response_storage",
]);

export function sanitizeCodexConfigForRuntime(rawConfig) {
  const output = [
    "# JCC Runtime clean Codex home.",
    "# Contains only model/provider settings needed by host CLI calls.",
    "# User skills/hooks/plugins/MCP/agents/prompts stay outside this runtime home.",
    "model_context_window = 1000000",
    "model_auto_compact_token_limit = 500000",
    // Codex estimates four bytes/token; preserve the broker's <= 1 MiB atomic result.
    "tool_output_token_limit = 262144",
    "",
  ];
  const lines = String(rawConfig || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let includeCurrentTable = false;
  let inTable = false;
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (table) {
      inTable = true;
      const tableName = table[1].trim();
      includeCurrentTable = tableName.startsWith("model_providers.");
      if (includeCurrentTable) output.push("", line);
      continue;
    }
    if (inTable) {
      if (includeCurrentTable) output.push(line);
      continue;
    }
    const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1];
    if (key && codexRuntimeConfigTopLevelKeys.has(key)
      && !["model_context_window", "model_auto_compact_token_limit"].includes(key)) output.push(line);
  }
  output.push("");
  return output.join("\n");
}

function safeHostSessionKey(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || null;
}

async function prepareCodexRuntimeHome(repoRoot, hostSessionKey = null) {
  const explicitHome = process.env.JCC_CODEX_RUNTIME_HOME;
  const runtimeRoot = process.env.JCC_RUNTIME_DATA_DIR || defaultRuntimeDataRoot(repoRoot);
  const baseHome = path.resolve(explicitHome || path.join(runtimeRoot, "host-cli", "codex-home"));
  const safeSessionKey = safeHostSessionKey(hostSessionKey);
  const targetHome = safeSessionKey
    ? path.join(baseHome, "sessions", safeSessionKey)
    : path.join(baseHome, "runs", `run-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(targetHome, { recursive: true });

  for (const dirName of ["skills", "hooks", "plugins", "prompts", "agents", "rules"]) {
    await removeRuntimePath(path.join(targetHome, dirName));
  }

  const sourceHome = sourceCodexHome();
  if (path.resolve(sourceHome) !== targetHome) {
    await copyCodexRuntimeCredential(sourceHome, targetHome, "auth.json");
    await copyCodexRuntimeCredential(sourceHome, targetHome, "installation_id");
  }

  const sourceConfig = path.join(sourceHome, "config.toml");
  const sanitizedConfig = (await pathExists(sourceConfig))
    ? sanitizeCodexConfigForRuntime(await readFile(sourceConfig, "utf8"))
    : sanitizeCodexConfigForRuntime("");
  await writeFile(path.join(targetHome, "config.toml"), `${sanitizedConfig.trimEnd()}\n\nsandbox_mode = "read-only"\napproval_policy = "never"\n`, "utf8");
  if (safeSessionKey) codexSessionHomes.set(String(hostSessionKey), targetHome);
  return {
    home: targetHome,
    persistent: Boolean(safeSessionKey),
    cleanup: safeSessionKey ? async () => {} : async () => removeRuntimePath(targetHome).catch(() => {}),
  };
}

async function codexModelInfo(command, spawnSpec = null) {
  const configInfo = await readCodexConfigModelInfo();
  const defaultLabel = configInfo.default_model_label || configInfo.default_model || null;
  const fallback = {
    model_options: normalizeModelOptions(configInfo.models, defaultModelOptionFor(defaultLabel)),
    default_model: configInfo.default_model,
    default_model_label: defaultLabel,
    model_options_error: null,
  };
  if (!command) return fallback;
  const spec = spawnSpec || commandShimSpec(command, ["debug", "models"]);
  const result = await runProcess(spec.command, [...(spec.args || []), ...(spawnSpec ? ["debug", "models"] : [])], { timeoutMs: 12000 });
  if (result.code !== 0) {
    return {
      ...fallback,
      model_options_error: result.stderr?.trim() || result.stdout?.trim() || "codex debug models failed",
    };
  }
  const nativeModels = parseCodexDebugModels(result.stdout);
  const defaultMeta = nativeModels.find((option) => option.value === configInfo.default_model) || null;
  const resolvedDefaultLabel = defaultMeta?.display_name || defaultLabel || null;
  const exposedModels = nativeModels.length ? nativeModels : configInfo.models;
  return {
    model_options: normalizeModelOptions(exposedModels, defaultModelOptionFor(resolvedDefaultLabel)),
    default_model: configInfo.default_model,
    default_model_label: resolvedDefaultLabel,
    model_options_error: nativeModels.length ? null : "codex debug models returned no visible models; using config default only",
  };
}

async function detectCodexAdapter(payload = {}) {
  const candidates = await codexCliCandidates(payload);
  const attempts = [];
  for (const command of candidates) {
    const jsEntrypoint = await codexJsEntrypointForShim(command);
    const spec = jsEntrypoint
      ? { command: await getNodeCommand(), args: [jsEntrypoint, "--version"] }
      : commandShimSpec(command, ["--version"]);
    const result = await runProcess(spec.command, spec.args, { timeoutMs: 8000 });
    attempts.push({ command, command_exists: await pathExists(command), code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
    if (result.code === 0 && outputLooksLikeCliVersion(result.stdout || result.stderr, "codex")) {
      const modelInfo = await codexModelInfo(command, jsEntrypoint ? { command: await getNodeCommand(), args: [jsEntrypoint] } : null);
      const requestedModelValue = normalizeModelId(payload.model);
      const requestedModel = selectKnownModelAlias(payload.model, modelInfo.model_options);
      const modelSelectionError = requestedModelValue && !requestedModel
        ? `Requested model ${requestedModelValue} is not advertised by the selected Codex CLI; using CLI default.`
        : null;
      const requestedReasoning = normalizeReasoningEffort(requestedModel, payload.reasoning_effort, modelInfo.model_options);
      return {
        provider: "codex",
        display_name: "Codex CLI",
        available: true,
        command,
        spawn_command: spec.command,
        spawn_prefix_args: jsEntrypoint ? [jsEntrypoint] : null,
        version: result.stdout.trim(),
        default_model: modelInfo.default_model,
        default_model_label: modelInfo.default_model_label,
        selected_model: requestedModel,
        reasoning_effort: requestedReasoning,
        capabilities: hostCliCapabilities("codex", requestedModel, modelInfo.model_options),
        model_options: modelInfo.model_options,
        model_options_error: modelInfo.model_options_error || modelSelectionError,
        attempts,
        error: null,
      };
    }
  }
  const modelInfo = await codexModelInfo(null);
  const requestedModelValue = normalizeModelId(payload.model);
  const requestedModel = selectKnownModelAlias(payload.model, modelInfo.model_options);
  const modelSelectionError = requestedModelValue && !requestedModel
    ? `Requested model ${requestedModelValue} is not advertised by the selected Codex CLI; using CLI default.`
    : null;
  const requestedReasoning = normalizeReasoningEffort(requestedModel, payload.reasoning_effort, modelInfo.model_options);
  const failure = discoveryFailureDetails(attempts, "codex not found");
  return {
    provider: "codex",
    display_name: "Codex CLI",
    available: false,
    discovery_status: attempts.some((attempt) => attempt.command_exists) ? "probe_failed" : "not_found",
    command: failure.command,
    version: null,
    default_model: modelInfo.default_model,
    default_model_label: modelInfo.default_model_label,
    selected_model: requestedModel,
    reasoning_effort: requestedReasoning,
    capabilities: hostCliCapabilities("codex", requestedModel, modelInfo.model_options),
    model_options: modelInfo.model_options,
    model_options_error: modelInfo.model_options_error || modelSelectionError,
    attempts,
    error: failure.error,
  };
}

async function kimiModelInfo(command) {
  if (!command) {
    return {
      model_options: [defaultModelOption],
      default_model: null,
      default_model_label: null,
      model_options_error: null,
    };
  }
  const spec = commandShimSpec(command, ["provider", "list", "--json"]);
  const kimiRuntime = await prepareKimiRuntimeEnv(process.cwd(), null, command);
  const result = await runProcess(spec.command, spec.args, { timeoutMs: 8000, env: kimiRuntime.env });
  if (result.code !== 0) {
    return {
      model_options: [defaultModelOption],
      default_model: null,
      default_model_label: null,
      model_options_error: result.stderr?.trim() || result.stdout?.trim() || "kimi provider list failed",
    };
  }
  const providerModels = parseKimiProviderModels(result.stdout);
  const defaultModel = await readKimiDefaultModel(command);
  const defaultMeta = providerModels.find((option) => option.value === defaultModel) || null;
  const defaultLabel = defaultMeta?.display_name || defaultModel || null;
  return {
    model_options: normalizeModelOptions(providerModels, defaultModelOptionFor(defaultLabel)),
    default_model: defaultModel,
    default_model_label: defaultLabel,
    model_options_error: null,
  };
}

async function kimiModelOptions(command) {
  return (await kimiModelInfo(command)).model_options;
}

async function detectKimiAdapter(payload = {}) {
  const candidates = await kimiCliCandidates(payload);
  const attempts = [];
  for (const command of candidates) {
    const spec = commandShimSpec(command, ["--version"]);
    const result = await runProcess(spec.command, spec.args, { timeoutMs: 8000 });
    attempts.push({ command, command_exists: await pathExists(command), code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
    if (result.code === 0 && outputLooksLikeCliVersion(result.stdout || result.stderr, "kimi")) {
      const modelInfo = await kimiModelInfo(command);
      const modelOptions = modelInfo.model_options;
      const requestedModelValue = normalizeModelId(payload.model);
      const requestedModel = selectKnownModelAlias(payload.model, modelOptions);
      const modelSelectionError = requestedModelValue && !requestedModel
        ? `Requested model ${requestedModelValue} is not advertised by the selected Kimi CLI; using CLI default.`
        : null;
      const requestedReasoning = normalizeReasoningEffort(requestedModel, payload.reasoning_effort, modelOptions);
      return {
        provider: "kimi",
        display_name: "Kimi CLI",
        available: true,
        command,
        kimi_home: sourceKimiHome(null, command),
        version: result.stdout.trim(),
        default_model: modelInfo.default_model,
        default_model_label: modelInfo.default_model_label,
        selected_model: requestedModel,
        reasoning_effort: requestedReasoning,
        capabilities: hostCliCapabilities("kimi", requestedModel, modelOptions),
        model_options: modelOptions,
        model_options_error: modelInfo.model_options_error || modelSelectionError,
        protocol: "acp-json-rpc",
        build_args: ["acp"],
        attempts,
        error: null,
      };
    }
  }
  const failure = discoveryFailureDetails(attempts, "kimi not found");
  return {
    provider: "kimi",
    display_name: "Kimi CLI",
    available: false,
    discovery_status: attempts.some((attempt) => attempt.command_exists) ? "probe_failed" : "not_found",
    command: failure.command,
    kimi_home: sourceKimiHome(),
    version: null,
    default_model: null,
    default_model_label: null,
    selected_model: null,
    reasoning_effort: null,
    capabilities: hostCliCapabilities("kimi", null, [defaultModelOption]),
    model_options: [defaultModelOption],
    model_options_error: null,
    protocol: "acp-json-rpc",
    build_args: ["acp"],
    attempts,
    error: failure.error,
  };
}

export async function detectHostAgent(payload = {}) {
  const provider = String(payload.provider || payload.preferred || "codex").toLowerCase();
  if (provider === "kimi") return detectKimiAdapter(payload);
  if (provider === "codex") return detectCodexAdapter(payload);
  return {
    provider,
    display_name: "Unsupported Host CLI Agent",
    available: false,
    command: null,
    version: null,
    capabilities: null,
    attempts: [],
    error: `Unsupported host provider: ${provider}`,
  };
}

export async function discoverHostAgents(payload = {}) {
  const providers = ["codex", "kimi"];
  const agents = [];
  for (const provider of providers) {
    const detected = await detectHostAgent({ ...payload, provider });
    agents.push({
      provider,
      display_name: detected.display_name || (provider === "kimi" ? "Kimi CLI" : "Codex CLI"),
      available: Boolean(detected.available),
      discovery_status: detected.available ? "available" : (detected.discovery_status || "not_found"),
      command: detected.command || null,
      version: detected.version || null,
      default_model: detected.default_model || null,
      default_model_label: detected.default_model_label || null,
      error: detected.error || null,
      protocol: detected.protocol || (provider === "kimi" ? "acp-json-rpc" : "codex-json-event-stream"),
      build_args: detected.build_args || null,
      capabilities: detected.capabilities || hostCliCapabilities(provider, payload.model, detected.model_options || []),
      model_options: detected.model_options || [defaultModelOption],
      model_options_error: detected.model_options_error || null,
      attempts: detected.attempts || [],
      login_status: provider === "kimi" && detected.available ? "unknown_until_live_check" : null,
      selected_model: detected.selected_model || null,
      reasoning_effort: detected.reasoning_effort || null,
    });
  }
  return {
    ok: agents.some((agent) => agent.available),
    schema: "jcc-host-cli-agent-discovery-v1",
    agents,
  };
}

function parseCodexJsonEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function extractJsonFromModelText(text, options = {}) {
  const responseKind = options.jsonResponseKind || "coach";
  if (responseKind === "raw") {
    return decodeHostJsonObject(text, { ...options, isCandidate: () => true });
  }
  if (responseKind === "coach") return decodeHostJsonObject(text);
  if (responseKind === "session_warmup") {
    return decodeHostJsonObject(text, {
      isCandidate: (value) => value?.schema === "jcc-host-session-bootstrap-ack-v1",
    });
  }
  if (responseKind === "wiki") {
    return decodeHostJsonObject(text, {
      isCandidate: (value) => value?.schema === "jcc-wiki-curation-host-response-v1",
    });
  }
  if (responseKind === "ranking_maintenance") {
    return decodeHostJsonObject(text, {
      isCandidate: (value) => value?.schema === "jcc-ranking-maintenance-response-v1",
    });
  }
  if (responseKind === "visual") {
    return decodeHostJsonObject(text, {
      isCandidate: (value) => Object.prototype.hasOwnProperty.call(value || {}, "observations")
        && Object.prototype.hasOwnProperty.call(value || {}, "confidence"),
    });
  }
  throw new Error(`Unsupported JSON response kind: ${responseKind}`);
}

function hostTransportDiagnostics(decoded) {
  if (!decoded?.prefix && !decoded?.trailing) return null;
  return {
    category: "host_transport_non_contract_text",
    prefix: decoded.prefix ? String(decoded.prefix).slice(0, 500) : null,
    trailing: decoded.trailing ? String(decoded.trailing).slice(0, 500) : null,
  };
}

function parseJsonRpcLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function collectTextFragments(value, fragments = []) {
  if (value === null || value === undefined) return fragments;
  if (typeof value === "string") {
    fragments.push(value);
    return fragments;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextFragments(item, fragments);
    return fragments;
  }
  if (typeof value !== "object") return fragments;
  for (const key of ["text", "final_text", "finalText", "message", "delta", "content", "output"]) {
    if (Object.hasOwn(value, key)) collectTextFragments(value[key], fragments);
  }
  return fragments;
}

function collectAcpAgentMessageFragments(message) {
  if (message?.method !== "session/update") return [];
  const update = message.params?.update;
  if (update?.sessionUpdate !== "agent_message_chunk") return [];
  return collectTextFragments(update.content, []);
}

function providerFirstTokenObserver(options, provider, providerSessionId) {
  let observed = false;
  return (text, turnId = null, at = Date.now()) => {
    if (observed || typeof text !== "string" || !text.length) return;
    observed = true;
    if (typeof options.onProviderFirstToken !== "function") return;
    // Observer time is local receipt time, not a provider-generated timestamp.
    try {
      Promise.resolve(options.onProviderFirstToken({
        provider, provider_session_id: providerSessionId,
        turn_id: typeof turnId === "string" && turnId ? turnId : null,
        at, date: new Date(at).toISOString(),
      })).catch(() => {});
    } catch {}
  };
}

function notifyProviderTurnDispatched(options, provider, providerSessionId) {
  const at = Date.now();
  try {
    Promise.resolve(options.onProviderTurnDispatched?.({
      provider, provider_session_id: providerSessionId, turn_id: null,
      at, date: new Date(at).toISOString(),
    })).catch(() => {});
  } catch {}
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function sanitizeHostCliDiagnostics(text) {
  return stripAnsi(text)
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim();
      if (!normalized) return false;
      if (/codex_core::session::session:.*failed to load skill/i.test(normalized)) return false;
      if (/missing YAML frontmatter delimited by ---/i.test(normalized)) return false;
      if (/codex_core::shell_snapshot:.*Shell snapshot not supported yet for PowerShell/i.test(normalized)) return false;
      if (/Failed to create shell snapshot for powershell/i.test(normalized)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function sanitizeHostCliUserError(error, fallback) {
  const cleaned = sanitizeHostCliDiagnostics(error);
  return cleaned || fallback;
}

export function codexStreamFailureDiagnostic({ events = [], stdout = "", stderr = "", code } = {}) {
  const parsed = [...events, ...String(stdout).split(/\r?\n/).map(parseCodexJsonEvent).filter(Boolean)];
  const failures = parsed.filter((event) => event.type === "turn.failed" || event.type === "error"
    || (event.type === "item.completed" && event.item?.type === "error"));
  const messages = [...new Set(failures.map((event) => {
    const error = event.error || event.item || event;
    return [error.code ?? error.status, error.message || error.error?.message]
      .filter((value) => value != null).join(": ");
  }).filter(Boolean))];
  const detail = messages.length ? messages.slice(-3).join("\n") : stderr;
  return sanitizeHostCliUserError(detail, `Host CLI exited ${code}`);
}

function looksLikeJsonRpcOnlyDiagnostics(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) => {
    const parsed = parseJsonRpcLine(line);
    return Boolean(parsed && parsed.jsonrpc === "2.0");
  });
}

function trimLogTail(text, maxChars = 2400) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

function extractKimiProviderErrorFromLog(logText) {
  const text = String(logText || "");
  const errorMessageMatch = text.match(/errorMessage="([^"]+)"/);
  if (errorMessageMatch?.[1]) return `Kimi CLI provider error: ${errorMessageMatch[1]}`;
  const jsonMessageMatch = text.match(/\\"message\\":\\"([^"]+)\\"/);
  if (jsonMessageMatch?.[1]) return `Kimi CLI provider error: ${jsonMessageMatch[1].replace(/\\"/g, "\"")}`;
  const lines = text.split(/\r?\n/);
  const interesting = [];
  for (const line of lines) {
    if (/APIStatusError|provider\.api_error|usage limit|quota|auth|login|required|403|401|429/i.test(line)) {
      interesting.push(line.trim());
    }
  }
  return trimLogTail(interesting.join("\n") || logText);
}

function extractKimiProviderErrorFromEvents(events = []) {
  const interesting = [];
  for (const event of events || []) {
    const error = event?.error || event?.params?.error || event?.result?.error || null;
    const serialized = JSON.stringify(error || event || {});
    if (/APIStatusError|provider\.api_error|usage limit|quota|auth|login|required|403|401|429|503|forbidden|unauthorized|rate limit/i.test(serialized)) {
      if (error) {
        const code = error.code ?? error.status ?? error.statusCode ?? error.data?.status ?? null;
        const message = error.message || error.data?.message || error.data?.error || serialized;
        interesting.push([code ? `code=${code}` : null, message, error.data ? JSON.stringify(error.data) : null].filter(Boolean).join(" "));
      } else {
        interesting.push(serialized);
      }
    }
  }
  return trimLogTail(interesting.join("\n"));
}

function hasSpecificKimiProviderDiagnostic(text) {
  return /Kimi CLI provider error:|provider\.(?:api|auth)_error|APIStatusError|\b(?:401|403|429|503)\b|subscription|Allegretto|usage limit|rate limit/i.test(String(text || ""));
}

function acpJsonRpcErrorMessage(error) {
  if (!error) return "ACP request failed";
  const code = error.code ?? error.status ?? error.statusCode ?? error.data?.status ?? null;
  const message = error.message || error.data?.message || error.data?.error || JSON.stringify(error);
  const data = error.data ? JSON.stringify(error.data) : "";
  return [code ? `code=${code}` : null, message, data].filter(Boolean).join(" ");
}

async function readKimiSessionLog(kimiHome, sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return "";
  const sessionsRoot = path.join(kimiHome, "sessions");
  let workspaces = [];
  try {
    workspaces = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const logPath = path.join(sessionsRoot, workspace.name, normalizedSessionId, "logs", "kimi-code.log");
    try {
      return await readFile(logPath, "utf8");
    } catch {}
  }
  return "";
}

async function kimiEmptyResponseError(kimiHome, sessionId, stderr, stdout, events = []) {
  const sessionLog = await readKimiSessionLog(kimiHome, sessionId);
  const providerError = extractKimiProviderErrorFromLog(sessionLog);
  if (providerError) {
    return sanitizeHostCliUserError(
      providerError,
      "Kimi CLI returned no assistant text; provider diagnostics were empty.",
    );
  }
  const eventError = extractKimiProviderErrorFromEvents(events);
  if (eventError) {
    return sanitizeHostCliUserError(
      `Kimi CLI provider error: ${eventError}`,
      "Kimi CLI returned no assistant text; provider diagnostics were empty.",
    );
  }
  const processDiagnostics = sanitizeHostCliDiagnostics(stderr || stdout);
  if (processDiagnostics && !looksLikeJsonRpcOnlyDiagnostics(processDiagnostics)) {
    return processDiagnostics;
  }
  const sessionPart = sessionId ? ` session_id=${sessionId}.` : "";
  return `Kimi CLI returned no assistant text.${sessionPart} The ACP turn ended without an agent_message_chunk; check Kimi login/quota/provider status.`;
}

function codexEmptyResponseError({ adapterState = {}, spec = {}, stderr = "", stdout = "", events = [] } = {}) {
  const processDiagnostics = sanitizeHostCliDiagnostics(stderr || stdout);
  if (processDiagnostics) return processDiagnostics;
  const errorEvents = (events || []).filter((event) => {
    const text = JSON.stringify(event || {});
    return /error|failed|failure|denied|unauthorized|forbidden|quota|usage limit|rate limit|429|403|401|503/i.test(text);
  });
  if (errorEvents.length) {
    return sanitizeHostCliUserError(
      errorEvents.map((event) => JSON.stringify(event)).join("\n"),
      "Codex CLI returned no assistant text; error events were not readable.",
    );
  }
  const eventTypes = uniqueStrings((events || []).map((event) => event?.type).filter(Boolean)).slice(0, 12).join(", ");
  const command = spec.command || adapterState.command || "codex";
  const args = Array.isArray(spec.args) ? spec.args.join(" ") : "";
  return [
    "Codex CLI returned no assistant text. The JSON stream ended without item.completed agent_message.",
    eventTypes ? `events=${eventTypes}` : null,
    `command=${command}`,
    args ? `args=${args}` : null,
  ].filter(Boolean).join("\n");
}

function acpRunSpec(adapterState) {
  const baseArgs = Array.isArray(adapterState.build_args) && adapterState.build_args.length
    ? adapterState.build_args
    : ["acp"];
  const selectedModel = normalizeModelId(adapterState.selected_model);
  const args = selectedModel ? ["--model", selectedModel, ...baseArgs] : baseArgs;
  return commandShimSpec(adapterState.command || "kimi", args);
}

function imageMimeTypeForPath(imagePath) {
  const ext = path.extname(String(imagePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

async function buildKimiPromptContentBlocks(prompt, imagePaths = []) {
  const blocks = [{ type: "text", text: prompt }];
  for (const imagePath of imagePaths || []) {
    if (!imagePath) continue;
    const buffer = await readFile(imagePath);
    blocks.push({
      type: "image",
      mimeType: imageMimeTypeForPath(imagePath),
      data: buffer.toString("base64"),
    });
  }
  return blocks;
}

export async function handleAcpHostRequest(message, options) {
  const id = message.id;
  const method = String(message.method || "");
  if (method === "fs/read_text_file") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32004,
        message: "JCC Runtime ACP sessions do not expose filesystem reads; use the supplied prefetch context.",
      },
    };
  }
  if (method === "fs/write_text_file") {
    return { jsonrpc: "2.0", id, error: { code: -32003, message: "JCC Runtime host adapter is read-only for ACP file writes." } };
  }
  if (method === "session/request_permission") {
    return { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported ACP request from host CLI: ${method}` } };
}

function codexRunSpec(adapterState, prompt, options) {
  const resumeSessionId = String(options.hostSessionId || "").trim();
  const persistentSession = Boolean(options.hostSessionKey);
  const args = resumeSessionId
    ? [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "--disable", "hooks",
        "--disable", "plugins",
        "--disable", "shell_tool",
        "--disable", "unified_exec",
      ]
    : [
        "exec",
        "--json",
        "--skip-git-repo-check",
        ...(persistentSession ? [] : ["--ephemeral"]),
        "--disable", "hooks",
        "--disable", "plugins",
        "--disable", "shell_tool",
        "--disable", "unified_exec",
        "--sandbox", "read-only",
        "--cd", options.hostCwd,
      ];
  if (adapterState.selected_model) args.push("--model", adapterState.selected_model);
  if (adapterState.reasoning_effort) args.push("-c", `model_reasoning_effort="${adapterState.reasoning_effort}"`);
  if (options.outputSchemaPath) args.push("--output-schema", path.resolve(options.outputSchemaPath));
  for (const imagePath of options.imagePaths || []) {
    if (imagePath) args.push("--image", imagePath);
  }
  if (resumeSessionId) args.push(resumeSessionId);
  args.push("-");

  if (Array.isArray(adapterState.spawn_prefix_args) && adapterState.spawn_command) {
    return { command: adapterState.spawn_command, args: [...adapterState.spawn_prefix_args, ...args], prompt, env: options.env || {} };
  }
  return { ...commandShimSpec(adapterState.command || "codex", args), prompt, env: options.env || {} };
}

async function runCodexStream(adapterState, prompt, options) {
  const hostCwd = await ensureHostCwd(options.hostCwd || defaultHostCwd, options.repoRoot);
  const codexRuntime = await prepareCodexRuntimeHome(
    options.repoRoot || process.cwd(),
    options.hostSessionKey || null,
  );
  const taskId = hostProcessTaskId(options);
  let outputSchemaPath = options.outputSchemaPath || null;
  if (!outputSchemaPath && options.outputSchema && typeof options.outputSchema === "object") {
    assertProviderOutputSchema(options.outputSchema);
    const schemaHash = crypto.createHash("sha256")
      .update(JSON.stringify(options.outputSchema))
      .digest("hex")
      .slice(0, 16);
    outputSchemaPath = path.join(codexRuntime.home, `output-schema-${schemaHash}.json`);
    await writeFile(outputSchemaPath, `${JSON.stringify(options.outputSchema)}\n`, "utf8");
  }
  const spec = codexRunSpec(adapterState, prompt, {
    ...options,
    outputSchemaPath,
    hostCwd,
    env: {
      CODEX_HOME: codexRuntime.home,
      JCC_HOST_CLI_CLEAN_CODEX_HOME: "1",
      JCC_HOST_CLI_SELECTED_CONTEXT_MODE: "1",
    },
  });
  const timeoutMs = Number(options.timeoutMs || process.env.JCC_UI_HOST_AGENT_TIMEOUT_MS || 300000);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: options.repoRoot || process.cwd(),
        env: { ...process.env, ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolve({ ok: false, error: `${error.message || String(error)}\ncommand=${spec.command}\nargs=${spec.args.join(" ")}`.trim() });
      return;
    }
    registerHostProcess(taskId, child);
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let finalText = "";
    let threadId = String(options.hostSessionId || "").trim() || null;
    const events = [];
    let settled = false;
    const finish = async (payload, options = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.terminate && child.exitCode === null) await terminateProcessTree(child);
      unregisterHostProcess(taskId, child);
      await codexRuntime.cleanup?.();
      resolve(payload);
    };
    const finishSuccessFromText = (text, completionTrigger, optionsOverride = {}) => {
      const cleanText = String(text || "").trim();
      if (!cleanText) return false;
      try {
        const decoded = options.parseJson ? extractJsonFromModelText(cleanText, options) : null;
        const transportDiagnostics = hostTransportDiagnostics(decoded);
        finish({
          ok: true,
          response: decoded ? decoded.value : cleanText,
          text: cleanText,
          ...(transportDiagnostics ? { host_transport_diagnostics: transportDiagnostics } : {}),
          stdout,
          stderr,
          events,
          thread_id: threadId,
          completed_from: "json_event_stream",
          completion_trigger: completionTrigger,
          native_output_schema_applied: Boolean(outputSchemaPath),
        }, { terminate: true });
      } catch (error) {
        finish({ ok: false, error: error.message || String(error), stdout, stderr, events, thread_id: threadId }, { terminate: true });
      }
      return true;
    };
    const timer = setTimeout(() => {
      if (finishSuccessFromText(finalText, "timeout_recovered_final_text")) return;
      finish({
        ok: false,
        error: `Host CLI response timed out after ${timeoutMs}ms\ncommand=${spec.command}\nargs=${spec.args.join(" ")}`,
        stdout,
        stderr,
      }, { terminate: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseCodexJsonEvent(line);
        if (!event) continue;
        events.push(event);
        if (event.type === "thread.started") threadId = event.thread_id || threadId;
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          finalText = String(event.item.text || "");
          if (!options.hostSessionKey) {
            finishSuccessFromText(finalText, "item.completed.agent_message");
            if (settled) break;
          }
        }
        if (event.type === "turn.completed" && finalText) {
          finishSuccessFromText(finalText, "turn.completed");
          if (settled) break;
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: `${error.message || String(error)}\ncommand=${spec.command}\nargs=${spec.args.join(" ")}`.trim(), stdout, stderr }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          ok: false,
          error: codexStreamFailureDiagnostic({ events, stdout, stderr, code }),
          stdout,
          stderr,
          events,
          thread_id: threadId,
        });
        return;
      }
      try {
        if (finishSuccessFromText(finalText, "process_close")) return;
        if (!String(finalText || "").trim()) {
          finish({
            ok: false,
            error: codexEmptyResponseError({ adapterState, spec, stderr, stdout, events }),
            stdout,
            stderr,
            events,
            thread_id: threadId,
          });
          return;
        }
        finishSuccessFromText(finalText, "process_close");
      } catch (error) {
        finish({ ok: false, error: error.message || String(error), stdout, stderr, events, thread_id: threadId });
      }
    });
    child.stdin.end(spec.prompt);
  });
}

async function runKimiAcp(adapterState, prompt, options = {}) {
  if (!adapterState?.available || !adapterState?.command) {
    return {
      ok: false,
      error: "Kimi CLI is not installed or not discoverable. Install Kimi CLI, set KIMI_BIN, choose a command in settings, or add the Kimi CLI bin directory to PATH.",
    };
  }
  const hostCwd = await ensureHostCwd(options.hostCwd || defaultHostCwd, options.repoRoot);
  const spec = acpRunSpec(adapterState);
  const taskId = hostProcessTaskId(options);
  const timeoutMs = Number(options.timeoutMs || process.env.JCC_UI_HOST_AGENT_TIMEOUT_MS || 300000);
  const kimiRuntime = await prepareKimiRuntimeEnv(options.repoRoot || process.cwd(), adapterState.kimi_home, adapterState.command);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: hostCwd,
        env: {
          ...process.env,
          ...kimiRuntime.env,
          ...(adapterState.reasoning_effort ? { KIMI_MODEL_THINKING_EFFORT: adapterState.reasoning_effort } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolve({ ok: false, error: `${error.message || String(error)}\ncommand=${spec.command}\nargs=${spec.args.join(" ")}`.trim() });
      return;
    }
    registerHostProcess(taskId, child);
    let requestId = 0;
    const pending = new Map();
    const events = [];
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let sessionId = null;
    let streamText = "";
    let promptResultText = "";
    let streamOwnsCompletion = false;
    let settled = false;

    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method, params = {}) => {
      const id = ++requestId;
      send({ jsonrpc: "2.0", id, method, params });
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      });
    };
    let streamCompletionTimer = null;
    const finish = async (payload, options = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (streamCompletionTimer) clearTimeout(streamCompletionTimer);
      if (options.terminate && child.exitCode === null) await terminateProcessTree(child);
      unregisterHostProcess(taskId, child);
      for (const pendingRequest of pending.values()) pendingRequest.reject(new Error("ACP run finished"));
      pending.clear();
      resolve(payload);
    };
    const transportDiagnosticsFor = (decoded, processExitCode = null) => {
      const decodedDiagnostics = hostTransportDiagnostics(decoded);
      if (!Number.isInteger(processExitCode) || processExitCode === 0) return decodedDiagnostics;
      return {
        category: "host_transport_nonzero_exit_after_valid_response",
        prefix: decodedDiagnostics?.prefix || "",
        trailing: [
          decodedDiagnostics?.trailing,
          `Kimi ACP exited ${processExitCode} after emitting a valid response.`,
        ].filter(Boolean).join("\n"),
      };
    };
    const finishSuccessFromText = (text, completionTrigger, optionsOverride = {}) => {
      const cleanText = String(text || "").trim();
      if (!cleanText) return false;
      try {
        const decoded = options.parseJson ? extractJsonFromModelText(cleanText, options) : null;
        const transportDiagnostics = transportDiagnosticsFor(decoded, optionsOverride.processExitCode);
        finish({
          ok: true,
          response: decoded ? decoded.value : cleanText,
          text: cleanText,
          ...(transportDiagnostics ? { host_transport_diagnostics: transportDiagnostics } : {}),
          stdout,
          stderr,
          events,
          session_id: sessionId,
          completed_from: "acp_json_rpc",
          completion_trigger: completionTrigger,
        }, { terminate: true });
      } catch (error) {
        if (optionsOverride.allowIncomplete) return false;
        finish({
          ok: false,
          error: `Kimi ACP returned assistant text but it could not be parsed as the required JSON: ${error?.message || String(error)}`,
          text: cleanText,
          stdout,
          stderr,
          events,
          session_id: sessionId,
          completed_from: "acp_json_rpc",
          completion_trigger: completionTrigger,
        }, { terminate: true });
      }
      return true;
    };
    const finishFirstValidText = ({
      streamTrigger,
      promptResultTrigger,
      processExitCode = null,
    }) => {
      const candidateOptions = {
        allowIncomplete: true,
        processExitCode,
      };
      if (finishSuccessFromText(streamText, streamTrigger, candidateOptions)) return true;
      if (finishSuccessFromText(promptResultText, promptResultTrigger, candidateOptions)) return true;
      return false;
    };
    const scheduleStreamCompletionCheck = () => {
      if (!options.parseJson || settled) return;
      if (streamCompletionTimer) clearTimeout(streamCompletionTimer);
      streamCompletionTimer = setTimeout(() => {
        streamCompletionTimer = null;
        const cleanText = String(streamText || "").trim();
        if (!cleanText) return;
        try {
          extractJsonFromModelText(cleanText, options);
        } catch {
          scheduleStreamCompletionCheck();
          return;
        }
        finishSuccessFromText(cleanText, "agent_message_chunk_parseable");
      }, Number(process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS || 250));
    };
    const timer = setTimeout(() => {
      if (finishFirstValidText({
        streamTrigger: "timeout_recovered_stream_text",
        promptResultTrigger: "timeout_recovered_prompt_result",
      })) return;
      const invalidText = String(streamText || "").trim()
        ? streamText
        : promptResultText;
      if (String(invalidText || "").trim()
        && finishSuccessFromText(invalidText, "timeout_invalid_response")) return;
      finish({
        ok: false,
        error: `Kimi ACP response timed out after ${timeoutMs}ms\ncommand=${spec.command}\nargs=${spec.args.join(" ")}`,
        stdout,
        stderr,
        events,
        session_id: sessionId,
      }, { terminate: true });
    }, timeoutMs);

    child.stdout.on("data", async (chunk) => {
      const text = String(chunk);
      stdout += text;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = parseJsonRpcLine(line);
        if (!message) continue;
        events.push(message);
        if (Object.hasOwn(message, "id") && pending.has(message.id)) {
          const pendingRequest = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) pendingRequest.reject(new Error(acpJsonRpcErrorMessage(message.error)));
          else pendingRequest.resolve(message.result);
          continue;
        }
        const agentFragments = collectAcpAgentMessageFragments(message);
        if (agentFragments.length) {
          streamOwnsCompletion = true;
          streamText += agentFragments.join("");
          scheduleStreamCompletionCheck();
        }
        if (message.method && Object.hasOwn(message, "id")) {
          const response = await handleAcpHostRequest(message, { ...options, hostCwd });
          send(response);
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: `${error.message || String(error)}\ncommand=${spec.command}\nargs=${spec.args.join(" ")}`.trim(), stdout, stderr, events, session_id: sessionId }));
    child.on("close", async (code) => {
      if (settled) return;
      if (finishFirstValidText({
        streamTrigger: "process_close_stream_text",
        promptResultTrigger: "process_close_prompt_result",
        processExitCode: code,
      })) return;
      if (code !== 0) {
        const providerError = await kimiEmptyResponseError(kimiRuntime.home, sessionId, stderr, stdout, events);
        const fallbackError = `Kimi ACP exited ${code}`;
        const error = /returned no assistant text/i.test(providerError || "")
          ? fallbackError
          : providerError;
        finish({
          ok: false,
          error: sanitizeHostCliUserError(error, fallbackError),
          stdout,
          stderr,
          events,
          session_id: sessionId,
        });
        return;
      }
      try {
        const preferredText = String(streamText || "").trim()
          ? streamText
          : promptResultText;
        const completionTrigger = String(streamText || "").trim()
          ? "process_close_stream_text"
          : "process_close_prompt_result";
        if (!String(preferredText || "").trim()) {
          finish({
            ok: false,
            error: await kimiEmptyResponseError(kimiRuntime.home, sessionId, stderr, stdout, events),
            stdout,
            stderr,
            events,
            session_id: sessionId,
          });
          return;
        }
        finishSuccessFromText(preferredText, completionTrigger);
      } catch (error) {
        finish({ ok: false, error: error.message || String(error), stdout, stderr, events, session_id: sessionId });
      }
    });

    (async () => {
      try {
        const initialized = await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            auth: { terminal: false },
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "jcc-runtime", version: "1" },
        });
        const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths.filter(Boolean) : [];
        const supportsImagePrompt = initialized?.agentCapabilities?.promptCapabilities?.image === true;
        if (imagePaths.length && !supportsImagePrompt) {
          throw new Error("Kimi ACP did not advertise image prompt capability for this session.");
        }
        const requestedSessionId = String(options.hostSessionId || "").trim();
        const created = requestedSessionId
          ? await request(
              initialized?.agentCapabilities?.sessionCapabilities?.resume
                ? "session/resume"
                : "session/load",
              {
                sessionId: requestedSessionId,
                cwd: hostCwd,
                mcpServers: [],
              },
            )
          : await request("session/new", {
              cwd: hostCwd,
              mcpServers: [],
            });
        sessionId = requestedSessionId || created?.sessionId || created?.session_id || created?.id || null;
        const selectedModel = normalizeModelId(adapterState.selected_model);
        if (selectedModel) {
          const modelOption = Array.isArray(created?.configOptions)
            ? created.configOptions.find((option) => option?.id === "model")
            : null;
          const advertisedModels = Array.isArray(modelOption?.options)
            ? modelOption.options.map((option) => String(option?.value || "").trim()).filter(Boolean)
            : [];
          if (advertisedModels.length && !advertisedModels.includes(selectedModel)) {
            throw new Error(`Kimi ACP does not advertise the selected model: ${selectedModel}`);
          }
          const configured = await request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: selectedModel,
          });
          const configuredModel = Array.isArray(configured?.configOptions)
            ? configured.configOptions.find((option) => option?.id === "model")
            : null;
          const configuredValue = String(configuredModel?.currentValue || "").trim();
          if (!configuredValue) {
            throw new Error(`Kimi ACP did not confirm selected session model: ${selectedModel}`);
          }
          if (configuredValue !== selectedModel) {
            throw new Error(`Kimi ACP kept ${configuredValue} instead of selected model ${selectedModel}`);
          }
        }
        const promptBlocks = await buildKimiPromptContentBlocks(prompt, imagePaths);
        const result = await request("session/prompt", {
          sessionId,
          prompt: promptBlocks,
        });
        const fragments = collectTextFragments(result);
        if (fragments.length) {
          promptResultText = fragments.join("\n").trim();
        }
        if (finishFirstValidText({
          streamTrigger: "session_prompt_completed_after_stream",
          promptResultTrigger: streamOwnsCompletion
            ? "session_prompt_result_after_invalid_stream"
            : "session_prompt_result",
        })) return;
        child.stdin.end();
      } catch (error) {
        const rawError = error?.message || String(error);
        const providerDiagnostic = await kimiEmptyResponseError(kimiRuntime.home, sessionId, stderr, stdout, events);
        finish({
          ok: false,
          error: sanitizeHostCliUserError(
            hasSpecificKimiProviderDiagnostic(providerDiagnostic) ? providerDiagnostic : rawError,
            rawError,
          ),
          stdout,
          stderr,
          events,
          session_id: sessionId,
        }, { terminate: true });
      }
    })();
  });
}

function persistentSessionIdentity(adapterState) {
  return JSON.stringify({
    provider: String(adapterState?.provider || "codex").toLowerCase(),
    command: adapterState?.command || null,
    spawn_command: adapterState?.spawn_command || null,
    spawn_prefix_args: adapterState?.spawn_prefix_args || null,
    version: adapterState?.version || null,
    build_args: adapterState?.build_args || null,
    kimi_home: adapterState?.kimi_home || null,
    readonly_tool_contract_version: JCC_HOST_READONLY_TOOL_CONTRACT_VERSION,
    tool_surface_policy: String(adapterState?.provider || "codex").toLowerCase() === "codex"
      ? "jcc_native_dynamic_tools_only"
      : "provider_native_tools_or_prefetch",
  });
}

function readonlyToolCallResponse(message, success, payload) {
  return {
    jsonrpc: "2.0",
    id: message?.id,
    result: {
      success,
      contentItems: [{ type: "inputText", text: JSON.stringify(payload) }],
    },
  };
}

export async function handleCodexDynamicToolRequest(message, sessionState = null) {
  if (message?.method !== "item/tool/call") return null;
  const resolveSessionState = typeof sessionState === "function" ? sessionState : () => sessionState;
  const before = resolveSessionState() || {};
  const activeTurn = before.activeTurn || null;
  const params = message?.params || {};
  const bound = Boolean(
    params.callId
    && params.threadId
    && params.turnId
    && before.providerSessionId
    && params.threadId === before.providerSessionId
    && activeTurn?.turnId
    && params.turnId === activeTurn.turnId
    && before.readonlyToolMode === "native_dynamic_tools"
    && activeTurn.acceptsReadonlyTools !== false
    && activeTurn.cancelled !== true
  );
  if (!bound) {
    return readonlyToolCallResponse(message, false, {
      schema: "jcc-readonly-tool-error-v1",
      error: activeTurn ? "readonly_tool_stale_or_unbound_turn" : "readonly_tool_unavailable_for_this_turn",
    });
  }
  activeTurn.readonlyToolCallObserved = true;
  const handler = activeTurn.readonlyToolHandler;
  if (typeof handler !== "function") {
    return readonlyToolCallResponse(message, false, {
      schema: "jcc-readonly-tool-error-v1",
      error: "readonly_tool_unavailable_for_this_turn",
    });
  }
  try {
    const toolName = params.namespace ? `${params.namespace}.${params.tool}` : params.tool;
    const result = await handler(toolName, params.arguments || {});
    const after = resolveSessionState() || {};
    if (
      after.providerSessionId !== before.providerSessionId
      || activeTurn.acceptsReadonlyTools === false
      || activeTurn.cancelled === true
      || after.activeTurn?.turnId !== params.turnId
      || after.activeTurn?.acceptsReadonlyTools === false
      || after.activeTurn?.cancelled === true
    ) {
      return readonlyToolCallResponse(message, false, {
        schema: "jcc-readonly-tool-error-v1",
        error: "readonly_tool_turn_expired_during_call",
      });
    }
    if (after.capabilityReceipt) {
      after.capabilityReceipt.observed_tool_calls = [...new Set([
        ...(after.capabilityReceipt.observed_tool_calls || []), toolName,
      ])];
      after.capabilityReceipt.last_tool_call_at = new Date().toISOString();
    }
    return readonlyToolCallResponse(message, true, result);
  } catch (error) {
    return readonlyToolCallResponse(message, false, {
      schema: "jcc-readonly-tool-error-v1",
      error: error?.message || String(error),
    });
  }
}

function codexDynamicToolsUnsupported(error) {
  return /dynamictools|dynamic tools|unknown (?:field|parameter)|invalid params|unsupported.{0,80}(?:tool|experimental)/i
    .test(String(error?.message || error || ""));
}

function codexThreadHasRegisteredReadonlyTools(threadResult) {
  const declared = threadResult?.thread?.dynamicTools;
  if (!Array.isArray(declared)) return false;
  const names = new Set();
  for (const entry of declared) {
    const namespace = String(entry?.name || "").trim();
    if (namespace) names.add(namespace);
    for (const tool of Array.isArray(entry?.tools) ? entry.tools : []) {
      const toolName = String(tool?.name || "").trim();
      if (!toolName) continue;
      names.add(toolName);
      if (namespace) names.add(`${namespace}.${toolName}`);
    }
  }
  return JCC_CODEX_DYNAMIC_TOOL_SPECS.every((spec) => {
    if (Array.isArray(spec.tools) && spec.tools.length) {
      return spec.tools.every((tool) => names.has(`${spec.name}.${tool.name}`) || names.has(tool.name));
    }
    return names.has(spec.name);
  });
}

function codexFreshThreadCapabilityConfirmed(threadResult) {
  // Current app-server accepts dynamicTools in ThreadStartParams but does not
  // echo them in Thread. Successful creation acknowledges our registration.
  // An explicit declaration, when provided, must still contain both tools.
  // This rule never applies to resume: its registration was not sent by us.
  const declared = threadResult?.thread?.dynamicTools;
  return Boolean(threadResult?.thread?.id)
    && (declared === undefined || codexThreadHasRegisteredReadonlyTools(threadResult));
}

function effectiveHostModel(adapterState) {
  return adapterState?.selected_model || adapterState?.default_model || null;
}

function effectiveHostReasoningEffort(adapterState) {
  if (adapterState?.reasoning_effort) return adapterState.reasoning_effort;
  const model = effectiveHostModel(adapterState);
  const option = Array.isArray(adapterState?.model_options)
    ? adapterState.model_options.find((entry) => entry?.value === model)
    : null;
  return option?.default_reasoning_level || null;
}

function appendBoundedText(current, incoming, max = 200_000) {
  const combined = `${current || ""}${incoming || ""}`;
  return combined.length > max ? combined.slice(-max) : combined;
}

function createPersistentJsonRpcConnection({ command, args, cwd, env, onServerRequest = null }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const pending = new Map();
  const notificationListeners = new Set();
  let requestId = 0;
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let closed = false;
  let closeError = null;
  let closePromise = null;

  const send = (message) => {
    if (closed || child.exitCode !== null || child.stdin.destroyed) {
      throw new Error(closeError || "persistent host transport is closed");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const safeSend = (message) => {
    try {
      send(message);
      return true;
    } catch {
      return false;
    }
  };
  const request = (method, params = {}, options = {}) => {
    const id = ++requestId;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timeoutMs = Number(options.timeoutMs || 0);
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      pending.set(id, {
        method,
        resolve(value) {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
    });
  };
  const notify = (method, params = {}) => send({ jsonrpc: "2.0", method, params });
  const emitNotification = (message) => {
    for (const listener of notificationListeners) {
      try {
        listener(message);
      } catch {
        // A turn listener must not break the shared transport parser.
      }
    }
  };
  const failConnection = (error) => {
    if (closed) return;
    closed = true;
    closeError = error?.message || String(error || "persistent host transport closed");
    for (const entry of pending.values()) entry.reject(new Error(closeError));
    pending.clear();
    emitNotification({ method: "jcc/transportClosed", params: { error: closeError } });
  };

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout = appendBoundedText(stdout, text);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (Object.hasOwn(message, "id") && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(acpJsonRpcErrorMessage(message.error)));
        else entry.resolve(message.result);
        continue;
      }
      if (message.method && Object.hasOwn(message, "id")) {
        Promise.resolve(onServerRequest ? onServerRequest(message) : null)
          .then((response) => {
            safeSend(response || {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: `Unsupported host request: ${message.method}` },
            });
          })
          .catch((error) => {
            safeSend({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: error?.message || String(error) },
            });
          });
        continue;
      }
      if (message.method) emitNotification(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBoundedText(stderr, String(chunk));
  });
  child.on("error", failConnection);
  child.on("close", (code) => failConnection(new Error(`persistent host transport exited ${code}`)));

  return {
    child,
    request,
    notify,
    subscribe(listener) {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    stdout: () => stdout,
    stderr: () => stderr,
    isAlive: () => !closed && child.exitCode === null,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const pid = Number(child.pid || 0) || null;
        if (closed && child.exitCode !== null) {
          return { stopped: true, pid, exit_code: child.exitCode, error: null };
        }
        closed = true;
        for (const entry of pending.values()) entry.reject(new Error("persistent host transport closed"));
        pending.clear();
        let error = null;
        let stopped = child.exitCode !== null;
        if (!stopped) {
          try {
            stopped = await terminateProcessTree(child);
          } catch (closeError) {
            error = closeError?.message || String(closeError);
            stopped = child.exitCode !== null;
          }
        }
        if (!stopped && !error) error = `persistent host transport process ${pid || "unknown"} did not exit`;
        return {
          stopped,
          pid,
          exit_code: child.exitCode,
          error,
        };
      })();
      return closePromise;
    },
  };
}

function persistentTurnResult(text, session, events, options, extra = {}) {
  const cleanText = String(text || "").trim();
  const transportPid = Number(session?.connection?.child?.pid || 0) || null;
  const sessionLifecycle = session?.replacedProviderSessionId
    ? {
        provider_session_replaced: true,
        replaced_provider_session_id: session.replacedProviderSessionId,
      }
    : {};
  if (extra.force_failure === true) {
    return {
      ok: false,
      error: extra.error || "Host CLI turn did not complete.",
      text: cleanText || null,
      stdout: session.connection.stdout(),
      stderr: session.connection.stderr(),
      events,
      thread_id: session.providerSessionId || null,
      session_id: session.providerSessionId || null,
      transport_pid: transportPid,
      readonly_tool_mode: session?.readonlyToolMode || "prefetch_complete",
      capability_receipt: session?.capabilityReceipt || null,
      ...sessionLifecycle,
    };
  }
  if (!cleanText) {
    return {
      ok: false,
      error: extra.error || "Host CLI returned no assistant text for the completed turn.",
      empty_completion: extra.empty_completion === true,
      stdout: session.connection.stdout(),
      stderr: session.connection.stderr(),
      events,
      thread_id: session.providerSessionId || null,
      session_id: session.providerSessionId || null,
      transport_pid: transportPid,
      readonly_tool_mode: session?.readonlyToolMode || "prefetch_complete",
      capability_receipt: session?.capabilityReceipt || null,
      ...sessionLifecycle,
    };
  }
  try {
    const decoded = options.parseJson ? extractJsonFromModelText(cleanText, options) : null;
    const transportDiagnostics = hostTransportDiagnostics(decoded);
    const result = {
      ok: true,
      response: decoded ? decoded.value : cleanText,
      text: cleanText,
      ...(transportDiagnostics ? { host_transport_diagnostics: transportDiagnostics } : {}),
      stdout: session.connection.stdout(),
      stderr: session.connection.stderr(),
      events,
      thread_id: session.providerSessionId || null,
      session_id: session.providerSessionId || null,
      transport_pid: transportPid,
      readonly_tool_mode: session?.readonlyToolMode || "prefetch_complete",
      capability_receipt: session?.capabilityReceipt || null,
      completed_from: session.provider === "codex" ? "codex_app_server" : "kimi_persistent_acp",
      native_output_schema_applied: session.provider === "codex" && Boolean(options.outputSchema),
      ...sessionLifecycle,
      ...extra,
    };
    if (options.providerSessionBootstrap === true
      && decoded?.value?.schema === "jcc-host-session-bootstrap-ack-v1"
      && decoded.value.accepted === true
      && decoded.value.capsule_id === options.bootstrapCapsuleId) {
      session.replacedProviderSessionId = null;
    }
    return result;
  } catch (error) {
    if (options.jsonResponseKind === "coach") {
      return {
        ok: true,
        response: {
          schema: "jcc-host-cli-coach-response-v1",
          generated_by: "current_cli_agent_main_model",
          final_text: cleanText,
          recommended_action: null,
          confidence: "low",
          followup_question: null,
        },
        text: cleanText,
        host_transport_diagnostics: {
          category: "coach_transport_envelope_recovered_as_text",
          decode_error: error?.message || String(error),
        },
        stdout: session.connection.stdout(),
        stderr: session.connection.stderr(),
        events,
        thread_id: session.providerSessionId || null,
        session_id: session.providerSessionId || null,
        transport_pid: transportPid,
        readonly_tool_mode: session?.readonlyToolMode || "prefetch_complete",
        capability_receipt: session?.capabilityReceipt || null,
        completed_from: session.provider === "codex" ? "codex_app_server" : "kimi_persistent_acp",
        native_output_schema_applied: session.provider === "codex" && Boolean(options.outputSchema),
        ...sessionLifecycle,
        ...extra,
      };
    }
    return {
      ok: false,
      error: error?.message || String(error),
      text: cleanText,
      stdout: session.connection.stdout(),
      stderr: session.connection.stderr(),
      events,
      thread_id: session.providerSessionId || null,
      session_id: session.providerSessionId || null,
      transport_pid: transportPid,
      readonly_tool_mode: session?.readonlyToolMode || "prefetch_complete",
      capability_receipt: session?.capabilityReceipt || null,
      ...sessionLifecycle,
    };
  }
}

function enqueuePersistentTurn(session, taskId, turnOptions, task) {
  if (activeHostProcesses.has(taskId)) {
    return Promise.resolve(persistentTurnResult("", session, [], turnOptions, {
      force_failure: true,
      error: `A Host CLI turn with task id ${taskId} is already active or queued.`,
    }));
  }
  const queued = { cancelled: false, started: false, reason: null, activeHandle: null };
  const queuedHandle = {
    abort: () => {
      if (queued.activeHandle) return cancelHostProcessHandle(queued.activeHandle);
      if (queued.cancelled) {
        return {
          accepted: true,
          provider_acknowledged: queued.started === false,
          release_handle: queued.started === false,
          state: queued.started ? "queued_turn_starting_cancelled" : "queued_turn_cancelled",
        };
      }
      queued.cancelled = true;
      queued.reason = "cancelled_by_user_before_provider_start";
      return {
        accepted: true,
        provider_acknowledged: queued.started === false,
        release_handle: queued.started === false,
        state: queued.started ? "queued_turn_starting_cancelled" : "queued_turn_cancelled",
      };
    },
  };
  registerHostProcess(taskId, queuedHandle);
  const run = async () => {
    queued.started = true;
    if (queued.cancelled) {
      return persistentTurnResult("", session, [], turnOptions, {
        force_failure: true,
        cancelled: true,
        error: "Host CLI turn was cancelled before it reached the provider.",
      });
    }
    return task(queued);
  };
  const scheduled = session.turnQueue.then(run, run).finally(() => {
    unregisterHostProcess(taskId, queuedHandle);
  });
  session.turnQueue = scheduled.catch(() => {});
  return scheduled;
}

function persistentTurnCancellation() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, cancel: (reason = "cancelled") => resolve({ kind: "cancelled", reason }) };
}

async function createPersistentCodexSession(adapterState, options) {
  const routeKey = String(options.hostSessionKey);
  const hostCwd = await ensureHostCwd(options.hostCwd || defaultHostCwd, options.repoRoot);
  const codexRuntime = await prepareCodexRuntimeHome(options.repoRoot || process.cwd(), routeKey);
  const baseArgs = [
    "app-server",
    "--stdio",
    "--disable", "hooks",
    "--disable", "plugins",
    // JCC knowledge is exposed only through the registered native namespace.
    // Removing the generic shell prevents the model from routing knowledge
    // calls through a lossy exec wrapper.
    "--disable", "shell_tool",
    "--disable", "unified_exec",
  ];
  const spec = Array.isArray(adapterState.spawn_prefix_args) && adapterState.spawn_command
    ? { command: adapterState.spawn_command, args: [...adapterState.spawn_prefix_args, ...baseArgs] }
    : commandShimSpec(adapterState.command || "codex", baseArgs);
  let sessionRef = null;
  const connection = createPersistentJsonRpcConnection({
    ...spec,
    cwd: hostCwd,
    env: {
      CODEX_HOME: codexRuntime.home,
      JCC_HOST_CLI_CLEAN_CODEX_HOME: "1",
      JCC_HOST_CLI_SELECTED_CONTEXT_MODE: "1",
    },
    onServerRequest: (message) => handleCodexDynamicToolRequest(message, () => ({
      providerSessionId: sessionRef?.providerSessionId || null,
      readonlyToolMode: sessionRef?.readonlyToolMode || "prefetch_complete",
      activeTurn: sessionRef?.activeTurn || null,
      capabilityReceipt: sessionRef?.capabilityReceipt || null,
    })),
  });
  persistentHostSessionStartTransports.set(routeKey, connection);
  if (
    Number(persistentHostSessionEpochs.get(routeKey) || 0) !== Number(options.hostSessionEpoch || 0)
    || persistentHostSessionClosures.has(routeKey)
  ) {
    if (persistentHostSessionStartTransports.get(routeKey) === connection) {
      persistentHostSessionStartTransports.delete(routeKey);
    }
    await connection.close().catch(() => {});
    throw new Error(`Host CLI session route closed during bootstrap: ${routeKey}`);
  }
  try {
    const lifecycleTimeoutMs = Number(options.timeoutMs || process.env.JCC_UI_HOST_SESSION_WARMUP_TIMEOUT_MS || 300000);
    await connection.request("initialize", {
      clientInfo: { name: "jcc-runtime", title: "JCC Runtime", version: "1" },
      capabilities: { experimentalApi: true },
    }, { timeoutMs: lifecycleTimeoutMs });
    connection.notify("initialized", {});
    const requestedSessionId = String(options.hostSessionId || "").trim();
    let readonlyToolMode = "prefetch_complete";
    let fallbackReason = null;
    let threadResult;
    const startParams = {
      config: { tool_output_token_limit: 262144, "features.code_mode.direct_only_tool_namespaces": ["jcc"] },
      cwd: hostCwd,
      model: effectiveHostModel(adapterState),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      serviceName: "jcc-runtime",
    };
    const startNativeThread = async () => connection.request("thread/start", {
      ...startParams,
      dynamicTools: JCC_CODEX_DYNAMIC_TOOL_SPECS,
    }, { timeoutMs: lifecycleTimeoutMs });
    const startPrefetchThread = async () => connection.request("thread/start", startParams, { timeoutMs: lifecycleTimeoutMs });
    if (requestedSessionId) {
      threadResult = await connection.request("thread/resume", {
        config: { tool_output_token_limit: 262144, "features.code_mode.direct_only_tool_namespaces": ["jcc"] },
        threadId: requestedSessionId,
        cwd: hostCwd,
        model: effectiveHostModel(adapterState),
        approvalPolicy: "never",
        sandbox: "read-only",
      }, { timeoutMs: lifecycleTimeoutMs });
      if (codexThreadHasRegisteredReadonlyTools(threadResult)) {
        readonlyToolMode = "native_dynamic_tools";
      } else {
        // A resumed thread without an explicit capability declaration is not
        // safe to reuse for a native-tool turn. Start one clean thread on the
        // same transport instead of teaching the model an opaque fallback.
        try {
          const resumedThreadId = threadResult?.thread?.id || requestedSessionId;
          const replacement = await startNativeThread();
          const replacementThreadId = replacement?.thread?.id || null;
          if (resumedThreadId && replacementThreadId && resumedThreadId !== replacementThreadId) {
            await connection.request("thread/delete", { threadId: resumedThreadId }, { timeoutMs: 3000 }).catch(() => {});
          }
          if (codexFreshThreadCapabilityConfirmed(replacement)) {
            threadResult = replacement;
            readonlyToolMode = "native_dynamic_tools";
          } else {
            fallbackReason = "explicit_native_registration_incomplete";
            const prefetchReplacement = await startPrefetchThread();
            const partialThreadId = replacement?.thread?.id || null;
            const prefetchThreadId = prefetchReplacement?.thread?.id || null;
            if (partialThreadId && prefetchThreadId && partialThreadId !== prefetchThreadId) {
              await connection.request("thread/delete", { threadId: partialThreadId }, { timeoutMs: 3000 }).catch(() => {});
            }
            threadResult = prefetchReplacement;
            readonlyToolMode = "prefetch_complete";
          }
        } catch (error) {
          if (!codexDynamicToolsUnsupported(error)) throw error;
          fallbackReason = String(error?.message || error).slice(0, 500);
          const resumedThreadId = threadResult?.thread?.id || requestedSessionId;
          threadResult = await startPrefetchThread();
          const prefetchThreadId = threadResult?.thread?.id || null;
          if (resumedThreadId && prefetchThreadId && resumedThreadId !== prefetchThreadId) {
            await connection.request("thread/delete", { threadId: resumedThreadId }, { timeoutMs: 3000 }).catch(() => {});
          }
          readonlyToolMode = "prefetch_complete";
        }
      }
    } else {
      try {
        threadResult = await startNativeThread();
        if (codexFreshThreadCapabilityConfirmed(threadResult)) {
          readonlyToolMode = "native_dynamic_tools";
        } else {
          fallbackReason = "explicit_native_registration_incomplete";
          const partialThreadId = threadResult?.thread?.id || null;
          const prefetchReplacement = await startPrefetchThread();
          const prefetchThreadId = prefetchReplacement?.thread?.id || null;
          if (partialThreadId && prefetchThreadId && partialThreadId !== prefetchThreadId) {
            await connection.request("thread/delete", { threadId: partialThreadId }, { timeoutMs: 3000 }).catch(() => {});
          }
          threadResult = prefetchReplacement;
          readonlyToolMode = "prefetch_complete";
        }
      } catch (error) {
        if (!codexDynamicToolsUnsupported(error)) throw error;
        fallbackReason = String(error?.message || error).slice(0, 500);
        threadResult = await connection.request("thread/start", startParams, { timeoutMs: lifecycleTimeoutMs });
        readonlyToolMode = "prefetch_complete";
      }
    }
    const providerSessionId = threadResult?.thread?.id || requestedSessionId || null;
    if (!providerSessionId) throw new Error("Codex app-server did not return a thread id");
    const capabilityReceipt = {
      schema: "jcc-host-session-capability-receipt-v1",
      provider: "codex",
      route_key: routeKey,
      session_id: threadResult?.thread?.id || requestedSessionId || null,
      readonly_tool_mode: readonlyToolMode,
      declared_tools: readonlyToolMode === "native_dynamic_tools"
        ? JCC_CODEX_DYNAMIC_TOOL_SPECS.flatMap((spec) => spec.tools
          ? spec.tools.map((tool) => `${spec.name}.${tool.name}`) : [spec.name])
        : [],
      registration_status: readonlyToolMode === "native_dynamic_tools" ? "accepted" : "unavailable",
      verification_basis: readonlyToolMode === "native_dynamic_tools" ? "thread_start_rpc_accepted_or_explicit_resume_declaration" : null,
      observed_tool_calls: [],
      fallback_reason: fallbackReason,
      fallback: readonlyToolMode !== "native_dynamic_tools",
      checked_at: new Date().toISOString(),
    };
    const session = {
    provider: "codex",
    identity: persistentSessionIdentity(adapterState),
    adapterState: { ...adapterState },
    routeKey,
    providerSessionId,
    replacedProviderSessionId: requestedSessionId && providerSessionId !== requestedSessionId
      ? requestedSessionId
      : null,
    readonlyToolMode,
    capabilityReceipt,
    connection,
    codexHome: codexRuntime.home,
    hostCwd,
    turnQueue: Promise.resolve(),
    activeTurn: null,
    updateConfiguration(nextAdapterState) {
      this.adapterState = { ...nextAdapterState };
    },
    async interruptActiveTurn(active) {
      if (!active?.turnId) return false;
      if (active.interruptAcknowledged) return true;
      if (active.interruptSettlement) return active.interruptSettlement;
      active.interruptSent = true;
      const settlement = connection.request("turn/interrupt", {
          threadId: providerSessionId,
          turnId: active.turnId,
        }, { timeoutMs: 3000 })
        .then((result) => {
          if (result?.accepted === false) throw new Error("Provider rejected turn interruption");
          active.interruptAcknowledged = true;
          active.cancellation.cancel("cancelled_by_user");
          return true;
        })
        .catch(() => {
          if (!connection.isAlive()) {
            active.cancellation.cancel("provider_transport_closed");
            return true;
          }
          active.interruptSent = false;
          return false;
        })
        .finally(() => {
          if (active.interruptSettlement === settlement) active.interruptSettlement = null;
        });
      active.interruptSettlement = settlement;
      return settlement;
    },
    async cancelTask(taskId) {
      const active = this.activeTurn;
      if (!active || active.taskId !== taskId) return false;
      if (!active.turnId) return false;
      active.cancelled = true;
      active.acceptsReadonlyTools = false;
      return this.interruptActiveTurn(active);
    },
    async runTurn(prompt, turnOptions) {
      const taskId = hostProcessTaskId(turnOptions);
      return enqueuePersistentTurn(this, taskId, turnOptions, async (queued) => {
        if (!connection.isAlive()) throw new Error("Codex app-server session is not alive");
        if (queued.cancelled) {
          return persistentTurnResult("", this, [], turnOptions, {
            force_failure: true,
            cancelled: true,
            error: "Host CLI turn was cancelled before it reached the provider.",
          });
        }
        const events = [];
        let finalText = "";
        let completeTurn = null;
        let answerTimer;
        let answerTimeoutResolve;
        let answerTimeoutSettled = false;
        const clearAnswerTimer = () => {
          if (answerTimer) clearTimeout(answerTimer);
          answerTimer = null;
        };
        const renewAnswerLease = () => {
          if (!answerTimeoutResolve || answerTimeoutSettled) return;
          clearAnswerTimer();
          answerTimer = setTimeout(() => {
            answerTimeoutSettled = true;
            answerTimeoutResolve({ kind: "timeout" });
          }, Number(turnOptions.timeoutMs || process.env.JCC_UI_HOST_AGENT_TIMEOUT_MS || 300000));
        };
        const observeFirstToken = providerFirstTokenObserver(turnOptions, "codex", providerSessionId);
        let completeResolve;
        const completion = new Promise((resolve) => { completeResolve = resolve; });
        const cancellation = persistentTurnCancellation();
        const active = {
          taskId,
          turnId: null,
          interruptSent: false,
          interruptAcknowledged: false,
          interruptSettlement: null,
          cancelled: false,
          acceptsReadonlyTools: readonlyToolMode === "native_dynamic_tools",
          cancellation,
          readonlyToolHandler: typeof turnOptions.onReadonlyToolCall === "function"
            ? turnOptions.onReadonlyToolCall
            : null,
        };
        this.activeTurn = active;
        const handle = {
          abort: () => {
            if (!active.turnId) return false;
            void this.cancelTask(taskId).catch(() => {});
            return {
              accepted: true,
              provider_acknowledged: false,
              release_handle: false,
              state: "provider_interrupt_requested",
            };
          },
        };
        queued.activeHandle = handle;
        const earlyEvents = [];
        const applyTurnEvent = (message, receivedAt) => {
          const params = message.params || {};
          const eventTurnId = params.turnId ?? params.turn?.id;
          if (params.threadId !== providerSessionId || !active.turnId || eventTurnId !== active.turnId) return;
          renewAnswerLease();
          events.push(message);
          if (message.method === "item/agentMessage/delta") {
            finalText += String(params.delta || "");
            if (!active.cancelled) observeFirstToken(params.delta, eventTurnId, receivedAt);
          }
          if (message.method === "item/completed" && params.item?.type === "agentMessage") {
            finalText = String(params.item.text || finalText);
          }
          if (message.method === "turn/completed") {
            completeTurn = params.turn || null;
            completeResolve({ kind: "completed" });
          }
        };
        const unsubscribe = connection.subscribe((message) => {
          if (message.method === "jcc/transportClosed") {
            completeResolve({ kind: "transport_closed", error: message.params?.error || "Codex app-server closed" });
            return;
          }
          const receivedAt = Date.now();
          if (message.params?.threadId !== providerSessionId) return;
          if (!active.turnId) {
            earlyEvents.push({ message, receivedAt });
            return;
          }
          applyTurnEvent(message, receivedAt);
        });
        const timeoutMs = Number(turnOptions.timeoutMs || process.env.JCC_UI_HOST_AGENT_TIMEOUT_MS || 300000);
        const providerStartTimeoutMs = Number(
          turnOptions.providerStartTimeoutMs
          || process.env.JCC_UI_HOST_PROVIDER_START_TIMEOUT_MS
          || 300000,
        );
        let providerStartTimer;
        const providerStartTimeout = new Promise((resolve) => {
          providerStartTimer = setTimeout(() => resolve({ kind: "timeout" }), providerStartTimeoutMs);
        });
        try {
          const turnAdapterState = { ...this.adapterState };
          if (turnOptions.outputSchema) assertProviderOutputSchema(turnOptions.outputSchema);
          notifyProviderTurnDispatched(turnOptions, "codex", providerSessionId);
          const startRequest = connection.request("turn/start", {
            threadId: providerSessionId,
            input: [
              { type: "text", text: prompt, text_elements: [] },
              ...(turnOptions.imagePaths || []).filter(Boolean).map((imagePath) => ({ type: "localImage", path: imagePath })),
            ],
            cwd: hostCwd,
            model: effectiveHostModel(turnAdapterState),
            effort: effectiveHostReasoningEffort(turnAdapterState),
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            ...(turnOptions.outputSchema ? { outputSchema: turnOptions.outputSchema } : {}),
          }, { timeoutMs: providerStartTimeoutMs }).then(
            (started) => ({ kind: "started", started, acceptedAt: new Date().toISOString() }),
            (error) => ({ kind: "start_failed", error }),
          );
          const startOutcome = await Promise.race([startRequest, providerStartTimeout, cancellation.promise]);
          clearTimeout(providerStartTimer);
          if (startOutcome.kind !== "started") {
            if (startOutcome.kind === "timeout") {
              const lateStart = await Promise.race([
                startRequest,
                new Promise((resolve) => setTimeout(() => resolve({ kind: "start_abandoned" }), 3000)),
              ]);
              const lateTurnId = lateStart.kind === "started" ? lateStart.started?.turn?.id || null : null;
              if (lateTurnId) {
                active.turnId = lateTurnId;
                active.cancelled = true;
                await this.interruptActiveTurn(active);
              } else if (lateStart.kind === "start_abandoned") {
                await connection.close().catch(() => {});
              }
            }
            return persistentTurnResult(finalText, this, events, turnOptions, {
              force_failure: true,
              error: startOutcome.kind === "timeout"
                ? `Host CLI provider start timed out after ${providerStartTimeoutMs}ms`
                : startOutcome.error?.message || startOutcome.reason || "Host CLI response cancelled",
            });
          }
          active.turnId = startOutcome.started?.turn?.id || null;
          for (const { message, receivedAt } of earlyEvents) applyTurnEvent(message, receivedAt);
          earlyEvents.length = 0;
          await Promise.resolve(turnOptions.onProviderTurnStarted?.({
            provider: "codex",
            provider_session_id: providerSessionId,
            turn_id: active.turnId,
            started_at: startOutcome.acceptedAt,
            accepted_at: startOutcome.acceptedAt,
          })).catch(() => {});
          const answerTimeout = new Promise((resolve) => {
            answerTimeoutResolve = resolve;
            renewAnswerLease();
          });
          const outcome = await Promise.race([completion, answerTimeout, cancellation.promise]);
          if (active.cancelled && outcome.kind === "completed") {
            return persistentTurnResult(finalText, this, events, turnOptions, {
              force_failure: true,
              cancelled: true,
              error: "Host CLI response cancelled",
            });
          }
          if (outcome.kind !== "completed") {
            active.cancelled = true;
            active.acceptsReadonlyTools = false;
            const interruptionSettled = await this.interruptActiveTurn(active);
            if (!interruptionSettled && connection.isAlive()) {
              await Promise.race([completion, cancellation.promise]);
            }
            return persistentTurnResult(finalText, this, events, turnOptions, {
              force_failure: true,
              error: outcome.kind === "timeout"
                ? `Host CLI response timed out after ${timeoutMs}ms`
                : outcome.error || "Host CLI response cancelled",
            });
          }
          const completedMessages = events
            .filter((event) => event.method === "item/completed" && event.params?.item)
            .map((event) => event.params.item);
          const delivery = resolveCodexTurnDelivery(completeTurn, completedMessages, {
            streamedText: finalText,
            hasNonUserActivity: active.readonlyToolCallObserved === true || events.some(event =>
              event.method === "item/started" && !["userMessage", "user_message"].includes(event.params?.item?.type)),
          });
          const turnError = completeTurn?.error?.message || completeTurn?.error || delivery.error || null;
          if (!delivery.text) {
            return persistentTurnResult("", this, events, turnOptions, {
              error: sanitizedHostFailure(turnError, "Codex app-server turn failed"),
              empty_completion: delivery.empty_completion,
            });
          }
          return persistentTurnResult(delivery.text, this, events, turnOptions, {
            completion_trigger: "turn/completed",
          });
        } finally {
          clearTimeout(providerStartTimer);
          answerTimeoutSettled = true;
          clearAnswerTimer();
          if (active.cancelled && active.turnId && !active.interruptAcknowledged
            && !completeTurn && connection.isAlive()) {
            await Promise.race([completion, cancellation.promise]);
          }
          unsubscribe();
          queued.activeHandle = null;
          active.acceptsReadonlyTools = false;
          if (this.activeTurn === active) this.activeTurn = null;
        }
      });
    },
    async close() {
      if (this.activeTurn) await this.cancelTask(this.activeTurn.taskId).catch(() => {});
      try {
        await connection.request("thread/delete", { threadId: providerSessionId }, { timeoutMs: 3000 });
      } catch {
        // A crashed transport throws synchronously before returning a Promise.
      }
      const transport = await connection.close();
      if (transport?.stopped) await codexRuntime.cleanup?.();
      return transport;
    },
    };
    sessionRef = session;
    return session;
  } catch (error) {
    await connection.close().catch(() => {});
    await codexRuntime.cleanup?.().catch(() => {});
    throw error;
  } finally {
    if (persistentHostSessionStartTransports.get(routeKey) === connection) {
      persistentHostSessionStartTransports.delete(routeKey);
    }
  }
}

function sanitizedHostFailure(value, fallback) {
  const raw = typeof value === "string" ? value : JSON.stringify(value || "");
  return sanitizeHostCliUserError(raw, fallback);
}

async function createPersistentKimiSession(adapterState, options) {
  const routeKey = String(options.hostSessionKey);
  const bootstrapStartedAt = Date.now();
  const kimiRuntime = await prepareKimiReadonlySession(adapterState, options);
  const { hostCwd } = kimiRuntime;
  const spec = { command: kimiRuntime.command, args: kimiRuntime.args };
  let readonlyBridge;
  let sessionRef = null;
  let sessionClosePromise;
  const connection = createPersistentJsonRpcConnection({
    ...spec,
    cwd: hostCwd,
    env: {
      ...kimiRuntime.env,
      ...(adapterState.reasoning_effort ? { KIMI_MODEL_THINKING_EFFORT: adapterState.reasoning_effort } : {}),
    },
    onServerRequest: (message) => handleAcpHostRequest(message, { ...options, hostCwd }),
  });
  connection.subscribe((message) => {
    if (message.method === "jcc/transportClosed") void readonlyBridge?.close();
  });
  const closeTransport = connection.close.bind(connection);
  connection.close = async () => {
    await readonlyBridge?.close();
    return closeTransport();
  };
  persistentHostSessionStartTransports.set(routeKey, connection);
  if (
    Number(persistentHostSessionEpochs.get(routeKey) || 0) !== Number(options.hostSessionEpoch || 0)
    || persistentHostSessionClosures.has(routeKey)
  ) {
    if (persistentHostSessionStartTransports.get(routeKey) === connection) {
      persistentHostSessionStartTransports.delete(routeKey);
    }
    await connection.close().catch(() => {});
    throw new Error(`Host CLI session route closed during bootstrap: ${routeKey}`);
  }
  try {
    const lifecycleTimeoutMs = Number(options.timeoutMs || process.env.JCC_UI_HOST_SESSION_WARMUP_TIMEOUT_MS || 300000);
    const initialized = await connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      auth: { terminal: false },
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "jcc-runtime", version: "1" },
    }, { timeoutMs: lifecycleTimeoutMs });
    const requestedSessionId = String(options.hostSessionId || "").trim();
    const supportsMcp = initialized?.agentCapabilities?.mcpCapabilities?.http === true;
    if (supportsMcp) readonlyBridge = await createKimiReadonlyMcpTransport({ specs: JCC_CODEX_DYNAMIC_TOOL_SPECS });
    const mcpServers = readonlyBridge ? [readonlyBridge.serverConfig] : [];
    const created = requestedSessionId
      ? await connection.request(
        initialized?.agentCapabilities?.sessionCapabilities?.resume ? "session/resume" : "session/load",
        { sessionId: requestedSessionId, cwd: hostCwd, mcpServers },
        { timeoutMs: lifecycleTimeoutMs },
      )
      : await connection.request("session/new", { cwd: hostCwd, mcpServers }, { timeoutMs: lifecycleTimeoutMs });
    const providerSessionId = created?.sessionId || created?.session_id || created?.id || requestedSessionId || null;
    if (!providerSessionId) throw new Error("Kimi ACP did not return a session id");
    sessionRef = providerSessionId;
    if (readonlyBridge) await readonlyBridge.waitUntilVerified(lifecycleTimeoutMs - (Date.now() - bootstrapStartedAt));
    const readonlyToolMode = readonlyBridge?.verified ? "native_dynamic_tools" : "prefetch_complete";
    if (readonlyBridge && !readonlyBridge.verified) await readonlyBridge.close();
    const capabilityReceipt = {
      schema: "jcc-host-session-capability-receipt-v1", provider: "kimi",
      route_key: routeKey, session_id: providerSessionId, readonly_tool_mode: readonlyToolMode,
      declared_tools: readonlyBridge?.verified ? ["jcc.query_knowledge", "jcc.calculate"] : [],
      registration_status: readonlyBridge?.verified ? "accepted" : "unavailable",
      verification_basis: readonlyBridge?.verified ? "mcp_initialize_initialized_tools_list_observed" : null,
      fallback: !readonlyBridge?.verified,
      fallback_reason: readonlyBridge?.verified ? null : "mcp_http_not_supported_or_handshake_incomplete",
      max_result_bytes: KIMI_MCP_MAX_RESULT_BYTES,
      tool_surface_policy: "stock_acp_builtin_schemas_visible_execution_denied",
      observed_tool_calls: [], checked_at: new Date().toISOString(),
    };
    const advertisedConfigIds = new Set(
      (Array.isArray(created?.configOptions) ? created.configOptions : [])
        .map((entry) => String(entry?.id || "").trim())
        .filter(Boolean),
    );
    const appliedConfig = Object.fromEntries(
      (Array.isArray(created?.configOptions) ? created.configOptions : [])
        .map((entry) => [String(entry?.id || "").trim(), String(entry?.currentValue || "").trim()])
        .filter(([id]) => id),
    );
    const applyConfigOption = async (configId, value) => {
      const normalizedValue = String(value || "").trim();
      if (!normalizedValue) return false;
      if (!advertisedConfigIds.has(configId)) {
        throw new Error(`Kimi ACP session does not advertise in-place ${configId} configuration; the live session was preserved`);
      }
      if (appliedConfig[configId] === normalizedValue) return false;
      const configured = await connection.request("session/set_config_option", {
        sessionId: providerSessionId,
        configId,
        value: normalizedValue,
      }, { timeoutMs: lifecycleTimeoutMs });
      const confirmedOption = Array.isArray(configured?.configOptions)
        ? configured.configOptions.find((entry) => entry?.id === configId)
        : null;
      const confirmedValue = String(confirmedOption?.currentValue || normalizedValue).trim();
      if (confirmedOption && confirmedValue !== normalizedValue) {
        throw new Error(`Kimi ACP kept ${confirmedValue || "an unknown value"} instead of ${configId}=${normalizedValue}`);
      }
      appliedConfig[configId] = normalizedValue;
      return true;
    };
    await applyConfigOption("model", normalizeModelId(effectiveHostModel(adapterState)));
    await applyConfigOption("thinking", effectiveHostReasoningEffort(adapterState));
    const session = {
    provider: "kimi",
    identity: persistentSessionIdentity(adapterState),
    readonlyToolMode,
    capabilityReceipt,
    adapterState: { ...adapterState },
    routeKey,
    providerSessionId,
    connection,
    hostCwd,
    initialized,
    turnQueue: Promise.resolve(),
    activeTurn: null,
    pendingCancelledPrompt: null,
    updateConfiguration(nextAdapterState) {
      this.adapterState = { ...nextAdapterState };
    },
    async applyTurnConfiguration() {
      await applyConfigOption("model", normalizeModelId(effectiveHostModel(this.adapterState)));
      await applyConfigOption("thinking", effectiveHostReasoningEffort(this.adapterState));
    },
    cancelActivePrompt(active) {
      active?.readonlyBinding?.revoke();
      if (!active || active.cancelSent) return false;
      active.cancelSent = true;
      try { connection.notify("session/cancel", { sessionId: providerSessionId }); } catch {}
      return true;
    },
    async cancelTask(taskId) {
      const active = this.activeTurn;
      if (!active || active.taskId !== taskId) return false;
      active.cancellation.cancel("cancelled_by_user");
      this.cancelActivePrompt(active);
      return true;
    },
    async runTurn(prompt, turnOptions) {
      const taskId = hostProcessTaskId(turnOptions);
      return enqueuePersistentTurn(this, taskId, turnOptions, async (queued) => {
        if (!connection.isAlive()) throw new Error("Kimi ACP session is not alive");
        if (queued.cancelled) {
          return persistentTurnResult("", this, [], turnOptions, {
            force_failure: true,
            cancelled: true,
            error: "Host CLI turn was cancelled before it reached the provider.",
          });
        }
        await this.applyTurnConfiguration();
        if (this.pendingCancelledPrompt) {
          const pending = this.pendingCancelledPrompt;
          const settled = await Promise.race([
            pending.then(() => true, () => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
          ]);
          if (!settled) {
            return persistentTurnResult("", this, [], turnOptions, {
              force_failure: true,
              error: "The previous Kimi ACP prompt is still cancelling; the native session remains open.",
            });
          }
        }
        const imagePaths = Array.isArray(turnOptions.imagePaths) ? turnOptions.imagePaths.filter(Boolean) : [];
        const supportsImagePrompt = initialized?.agentCapabilities?.promptCapabilities?.image === true;
        if (imagePaths.length && !supportsImagePrompt) {
          return { ok: false, error: "Kimi ACP did not advertise image prompt capability for this session." };
        }
        if (queued.cancelled) {
          return persistentTurnResult("", this, [], turnOptions, {
            force_failure: true,
            cancelled: true,
            error: "Host CLI turn was cancelled before it reached the provider.",
          });
        }
        const events = [];
        let streamText = "";
        const observeFirstToken = providerFirstTokenObserver(turnOptions, "kimi", providerSessionId);
        const cancellation = persistentTurnCancellation();
        const active = { taskId, cancelSent: false, cancellation };
        active.readonlyBinding = readonlyBridge?.beginTurn({ providerSessionId, taskId, handler: turnOptions.onReadonlyToolCall });
        this.activeTurn = active;
        const handle = {
          abort: () => {
            if (active.cancelSent) {
              return {
                accepted: true,
                provider_acknowledged: false,
                release_handle: false,
                state: "provider_cancel_pending",
              };
            }
            active.cancellation.cancel("cancelled_by_user");
            this.cancelActivePrompt(active);
            return {
              accepted: true,
              provider_acknowledged: false,
              release_handle: false,
              state: "provider_cancel_requested",
            };
          },
        };
        queued.activeHandle = handle;
        const unsubscribe = connection.subscribe((message) => {
          if (message.params?.sessionId && message.params.sessionId !== providerSessionId) return;
          renewAnswerLease();
          events.push(message);
          const fragments = collectAcpAgentMessageFragments(message);
          if (fragments.length) streamText += fragments.join("");
          const update = message.params?.update;
          if (!active.cancelSent && message.method === "session/update"
            && update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
            observeFirstToken(update.content.text);
          }
          if (message.method === "jcc/transportClosed") cancellation.cancel(message.params?.error || "Kimi ACP closed");
        });
        const timeoutMs = Number(turnOptions.timeoutMs || process.env.JCC_UI_HOST_AGENT_TIMEOUT_MS || 300000);
        const providerStartTimeoutMs = Number(
          turnOptions.providerStartTimeoutMs
          || process.env.JCC_UI_HOST_PROVIDER_START_TIMEOUT_MS
          || 300000,
        );
        let providerStartTimer;
        let answerTimer;
        let answerTimeoutResolve;
        let answerTimeoutSettled = false;
        const clearAnswerTimer = () => {
          if (answerTimer) clearTimeout(answerTimer);
          answerTimer = null;
        };
        const renewAnswerLease = () => {
          if (!answerTimeoutResolve || answerTimeoutSettled) return;
          clearAnswerTimer();
          answerTimer = setTimeout(() => {
            answerTimeoutSettled = true;
            answerTimeoutResolve({ kind: "timeout" });
          }, timeoutMs);
        };
        const providerStartTimeout = new Promise((resolve) => {
          providerStartTimer = setTimeout(() => resolve({ kind: "timeout" }), providerStartTimeoutMs);
        });
        try {
          const boundPrompt = active.readonlyBinding ? `${prompt}\n\n${active.readonlyBinding.promptText}` : prompt;
          const promptPreparation = buildKimiPromptContentBlocks(boundPrompt, imagePaths).then(
            (promptBlocks) => ({ kind: "prepared", promptBlocks }),
            (error) => ({ kind: "prepare_failed", error }),
          );
          const preparationOutcome = await Promise.race([
            promptPreparation,
            providerStartTimeout,
            cancellation.promise,
          ]);
          clearTimeout(providerStartTimer);
          if (preparationOutcome.kind !== "prepared") {
            return persistentTurnResult(streamText, this, events, turnOptions, {
              force_failure: true,
              error: preparationOutcome.kind === "timeout"
                ? `Kimi ACP provider start timed out after ${providerStartTimeoutMs}ms`
                : preparationOutcome.error?.message || preparationOutcome.reason || "Kimi ACP response cancelled",
            });
          }
          await Promise.resolve(turnOptions.onProviderTurnStarted?.({
            provider: "kimi",
            provider_session_id: providerSessionId,
            turn_id: active.readonlyBinding?.turnId || null,
            started_at: new Date().toISOString(),
            accepted_at: null,
          })).catch(() => {});
          notifyProviderTurnDispatched(turnOptions, "kimi", providerSessionId);
          if (active.cancelSent) throw new Error("Kimi ACP response cancelled before dispatch");
          const promptRun = connection.request("session/prompt", {
            sessionId: providerSessionId,
            prompt: preparationOutcome.promptBlocks,
          }).then((result) => ({ kind: "completed", result }), (error) => ({ kind: "failed", error }));
          const answerTimeout = new Promise((resolve) => {
            answerTimeoutResolve = resolve;
            renewAnswerLease();
          });
          const outcome = await Promise.race([promptRun, answerTimeout, cancellation.promise]);
          if (outcome.kind !== "completed") {
            this.cancelActivePrompt(active);
            if (outcome.kind === "cancelled") {
              const pendingCancelledPrompt = promptRun.finally(() => {
                if (this.pendingCancelledPrompt === pendingCancelledPrompt) this.pendingCancelledPrompt = null;
              });
              this.pendingCancelledPrompt = pendingCancelledPrompt;
            } else if (outcome.kind === "timeout") {
              const cancelledPromptSettled = await Promise.race([
                promptRun.then(() => true, () => true),
                new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
              ]);
              if (!cancelledPromptSettled) await connection.close().catch(() => {});
            }
            return persistentTurnResult(streamText, this, events, turnOptions, {
              force_failure: true,
              error: outcome.kind === "timeout"
                ? `Kimi ACP response timed out after ${timeoutMs}ms`
                : outcome.error?.message || outcome.reason || "Kimi ACP response cancelled",
            });
          }
          const resultText = collectTextFragments(outcome.result).join("\n").trim();
          capabilityReceipt.observed_tool_calls = readonlyBridge?.observedToolCalls || [];
          return persistentTurnResult(streamText.trim() || resultText, this, events, turnOptions, {
            completion_trigger: streamText.trim() ? "persistent_acp_stream" : "session_prompt_result",
          });
        } finally {
          active.readonlyBinding?.revoke();
          clearTimeout(providerStartTimer);
          answerTimeoutSettled = true;
          clearAnswerTimer();
          unsubscribe();
          queued.activeHandle = null;
          if (this.activeTurn === active) this.activeTurn = null;
        }
      });
    },
    async close({ preserveHistory = false } = {}) {
      if (sessionClosePromise) return sessionClosePromise;
      sessionClosePromise = (async () => {
        if (this.activeTurn) await this.cancelTask(this.activeTurn.taskId).catch(() => {});
        if (sessionRef) {
          try { connection.notify("session/cancel", { sessionId: sessionRef }); } catch {}
        }
        await readonlyBridge?.close();
        const stopped = await connection.close();
        if (stopped?.stopped && !preserveHistory) await kimiRuntime.cleanup();
        return stopped;
      })();
      try {
        const result = await sessionClosePromise;
        if (!result?.stopped) sessionClosePromise = null;
        return result;
      } catch (error) {
        sessionClosePromise = null;
        throw error;
      }
    },
    };
    return session;
  } catch (error) {
    await readonlyBridge?.close();
    const stopped = await connection.close().catch(() => null);
    if (stopped?.stopped && !options.hostSessionId) await kimiRuntime.cleanup().catch(() => {});
    throw error;
  } finally {
    if (persistentHostSessionStartTransports.get(routeKey) === connection) {
      persistentHostSessionStartTransports.delete(routeKey);
    }
  }
}

async function ensurePersistentHostSession(adapterState, options) {
  const routeKey = String(options.hostSessionKey || "").trim();
  if (!routeKey) throw new Error("persistent host session requires hostSessionKey");
  const closing = persistentHostSessionClosures.get(routeKey);
  if (closing) await closing;
  if (persistentHostSessionStartBlocks.has(routeKey)) {
    throw new Error(`Host CLI session route is stopping: ${routeKey}`);
  }
  const routeEpoch = Number(persistentHostSessionEpochs.get(routeKey) || 0);
  const starting = persistentHostSessionStarts.get(routeKey);
  if (starting) return starting;
  const identity = persistentSessionIdentity(adapterState);
  const existing = persistentHostSessions.get(routeKey);
  if (existing?.identity === identity && existing.connection.isAlive()) {
    const requestedId = String(options.hostSessionId || "").trim();
    if (!requestedId || requestedId === existing.providerSessionId) {
      existing.updateConfiguration?.(adapterState);
      return existing;
    }
  }
  const startOptions = { ...options, hostSessionEpoch: routeEpoch };
  // Register replacement ownership before closing the old transport.
  const start = Promise.resolve().then(async () => {
    if (existing) {
      const closeResult = await existing.close({ preserveHistory: existing.provider === "kimi" && !existing.connection.isAlive() }).catch((error) => ({
        stopped: false,
        error: error?.message || String(error),
      }));
      if (closeResult?.stopped !== true) {
        throw new Error(closeResult?.error || `Host CLI session route did not close: ${routeKey}`);
      }
      persistentHostSessions.delete(routeKey);
    }
    return (String(adapterState?.provider || "codex").toLowerCase() === "kimi"
      ? createPersistentKimiSession(adapterState, startOptions)
      : createPersistentCodexSession(adapterState, startOptions));
  })
    .then(async (session) => {
      const currentEpoch = Number(persistentHostSessionEpochs.get(routeKey) || 0);
      if (currentEpoch !== routeEpoch || persistentHostSessionClosures.has(routeKey)) {
        const closeResult = await session.close().catch((error) => ({
          stopped: false,
          error: error?.message || String(error),
        }));
        if (closeResult?.stopped !== true) persistentHostSessions.set(routeKey, session);
        throw new Error(`Host CLI session route closed during bootstrap: ${routeKey}`);
      }
      persistentHostSessions.set(routeKey, session);
      return session;
    })
    .finally(() => persistentHostSessionStarts.delete(routeKey));
  persistentHostSessionStarts.set(routeKey, start);
  return start;
}

async function runPersistentHostSession(adapterState, prompt, options) {
  try {
    const session = await ensurePersistentHostSession(adapterState, options);
    if (session.replacedProviderSessionId && options.providerSessionBootstrap !== true) {
      return {
        ok: false,
        requires_bootstrap: true,
        provider_session_replaced: true,
        replaced_provider_session_id: session.replacedProviderSessionId,
        thread_id: session.providerSessionId,
        session_id: session.providerSessionId,
        readonly_tool_mode: session.readonlyToolMode,
        error: "Replacement provider session requires a complete static bootstrap.",
      };
    }
    return await session.runTurn(prompt, options);
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      thread_id: options.hostSessionId || null,
      session_id: options.hostSessionId || null,
    };
  }
}

export function hostAgentSessionReadonlyToolMode(hostSessionKey) {
  const normalizedKey = String(hostSessionKey || "").trim();
  if (!normalizedKey) return null;
  return persistentHostSessions.get(normalizedKey)?.readonlyToolMode || null;
}

export async function runHostAgentRequest(adapterState, prompt, options = {}) {
  const provider = String(adapterState?.provider || "codex").toLowerCase();
  if (options.hostSessionKey) return runPersistentHostSession(adapterState, prompt, options);
  if (provider === "kimi") return runKimiAcp(adapterState, prompt, options);
  if (provider === "codex") return runCodexStream(adapterState || { provider: "codex", command: "codex" }, prompt, options);
  return { ok: false, error: `Unsupported host provider: ${provider}` };
}

export function cancelHostAgentRunDetailed(taskId = null) {
  const normalizedTaskId = String(taskId || "").trim();
  const matchedTaskIds = [];
  const cancelledTaskIds = [];
  const retainedTaskIds = [];
  const providerAcknowledgedTaskIds = [];
  const cancellationStates = {};
  if (normalizedTaskId) {
    const taskPrefix = `${normalizedTaskId}:`;
    for (const [activeTaskId, handle] of activeHostProcesses.entries()) {
      if (activeTaskId !== normalizedTaskId && !activeTaskId.startsWith(taskPrefix)) continue;
      matchedTaskIds.push(activeTaskId);
      const cancellation = cancelHostProcessHandle(handle);
      cancellationStates[activeTaskId] = cancellation.state;
      if (cancellation.accepted) {
        if (cancellation.release_handle) activeHostProcesses.delete(activeTaskId);
        else retainedTaskIds.push(activeTaskId);
        if (cancellation.provider_acknowledged) providerAcknowledgedTaskIds.push(activeTaskId);
        cancelledTaskIds.push(activeTaskId);
      }
    }
    return {
      accepted: cancelledTaskIds.length > 0,
      requested_task_id: normalizedTaskId,
      matched_task_ids: matchedTaskIds,
      cancelled_task_ids: cancelledTaskIds,
      retained_task_ids: retainedTaskIds,
      provider_acknowledged_task_ids: providerAcknowledgedTaskIds,
      cancellation_states: cancellationStates,
      matched_count: matchedTaskIds.length,
      cancelled_count: cancelledTaskIds.length,
      retained_count: retainedTaskIds.length,
      provider_acknowledged_count: providerAcknowledgedTaskIds.length,
    };
  }
  for (const [activeTaskId, handle] of activeHostProcesses.entries()) {
    matchedTaskIds.push(activeTaskId);
    const cancellation = cancelHostProcessHandle(handle);
    cancellationStates[activeTaskId] = cancellation.state;
    if (cancellation.accepted) {
      if (cancellation.release_handle) activeHostProcesses.delete(activeTaskId);
      else retainedTaskIds.push(activeTaskId);
      if (cancellation.provider_acknowledged) providerAcknowledgedTaskIds.push(activeTaskId);
      cancelledTaskIds.push(activeTaskId);
    }
  }
  return {
    accepted: cancelledTaskIds.length > 0,
    requested_task_id: null,
    matched_task_ids: matchedTaskIds,
    cancelled_task_ids: cancelledTaskIds,
    retained_task_ids: retainedTaskIds,
    provider_acknowledged_task_ids: providerAcknowledgedTaskIds,
    cancellation_states: cancellationStates,
    matched_count: matchedTaskIds.length,
    cancelled_count: cancelledTaskIds.length,
    retained_count: retainedTaskIds.length,
    provider_acknowledged_count: providerAcknowledgedTaskIds.length,
  };
}

export function cancelHostAgentRun(taskId = null) {
  return cancelHostAgentRunDetailed(taskId).accepted;
}

function closePendingHostSessionTransport(hostSessionKey, transport) {
  if (!transport) return null;
  const normalizedKey = String(hostSessionKey || "").trim();
  const existing = persistentHostSessionStartTransportClosures.get(normalizedKey);
  if (existing) return existing;
  const closure = Promise.resolve()
    .then(() => transport.close())
    .catch((error) => ({
      stopped: false,
      pid: Number(transport?.child?.pid || 0) || null,
      error: error?.message || String(error),
    }));
  persistentHostSessionStartTransportClosures.set(normalizedKey, closure);
  return closure;
}

export function preemptHostAgentSessionStart(hostSessionKey, { closeActiveTransport = false } = {}) {
  const normalizedKey = String(hostSessionKey || "").trim();
  if (!normalizedKey) {
    return {
      accepted: false,
      host_session_key: null,
      pending_start_found: false,
      transport_close_requested: false,
    };
  }
  const pendingStartFound = persistentHostSessionStarts.has(normalizedKey);
  const startTransport = persistentHostSessionStartTransports.get(normalizedKey)
    || (closeActiveTransport ? persistentHostSessions.get(normalizedKey)?.connection : null)
    || null;
  persistentHostSessionStartBlocks.add(normalizedKey);
  persistentHostSessionEpochs.set(normalizedKey, Number(persistentHostSessionEpochs.get(normalizedKey) || 0) + 1);
  if (startTransport) {
    void closePendingHostSessionTransport(normalizedKey, startTransport);
  }
  return {
    accepted: true,
    host_session_key: normalizedKey,
    route_start_blocked: true,
    pending_start_found: pendingStartFound,
    transport_close_requested: Boolean(startTransport),
  };
}

export async function closeHostAgentSession(hostSessionKey) {
  const normalizedKey = String(hostSessionKey || "").trim();
  if (!normalizedKey) return { accepted: false, host_session_key: null };
  const existingClosure = persistentHostSessionClosures.get(normalizedKey);
  if (existingClosure) return existingClosure;
  const startTransport = persistentHostSessionStartTransports.get(normalizedKey) || null;
  const startPreemption = preemptHostAgentSessionStart(normalizedKey);
  const closure = (async () => {
    const pendingStartTransportClose = startTransport
      ? closePendingHostSessionTransport(normalizedKey, startTransport)
      : persistentHostSessionStartTransportClosures.get(normalizedKey) || null;
    const startTransportClose = pendingStartTransportClose
      ? await pendingStartTransportClose
      : null;
    const starting = persistentHostSessionStarts.get(normalizedKey) || null;
    if (starting) await starting.catch(() => {});
    persistentHostSessionStarts.delete(normalizedKey);
    const persistentSession = persistentHostSessions.get(normalizedKey) || null;
    const transportClose = persistentSession
      ? await persistentSession.close().catch((error) => ({
          stopped: false,
          pid: Number(persistentSession?.connection?.child?.pid || 0) || null,
          error: error?.message || String(error),
        }))
      : null;
    const activeTransportStopped = !persistentSession || transportClose?.stopped === true;
    const startingTransportStopped = !pendingStartTransportClose || startTransportClose?.stopped === true;
    const closed = activeTransportStopped && startingTransportStopped;
    if (closed) persistentHostSessions.delete(normalizedKey);
    const codexHome = codexSessionHomes.get(normalizedKey) || null;
    if (closed) codexSessionHomes.delete(normalizedKey);
    if (closed && codexHome) await removeRuntimePath(codexHome).catch(() => {});
    return {
      accepted: Boolean(persistentSession || starting || codexHome || startPreemption.accepted),
      host_session_key: normalizedKey,
      closed,
      persistent_transport_closed: Boolean(persistentSession) && transportClose?.stopped === true,
      persistent_transport_close: transportClose,
      pending_start_reaped: Boolean(starting),
      pending_start_transport_closed: Boolean(pendingStartTransportClose) && startTransportClose?.stopped === true,
      pending_start_transport_close: startTransportClose,
      codex_home_removed: closed && Boolean(codexHome),
      ...(!closed ? {
        error: transportClose?.error || startTransportClose?.error || "Host CLI transport process did not confirm exit.",
      } : {}),
    };
  })().finally(() => {
    persistentHostSessionClosures.delete(normalizedKey);
    persistentHostSessionStartTransports.delete(normalizedKey);
    persistentHostSessionStartTransportClosures.delete(normalizedKey);
    persistentHostSessionStartBlocks.delete(normalizedKey);
    persistentHostSessionEpochs.delete(normalizedKey);
  });
  persistentHostSessionClosures.set(normalizedKey, closure);
  return closure;
}

export async function closeAllHostAgentSessions() {
  cancelHostAgentRun();
  const keys = new Set([
    ...persistentHostSessions.keys(),
    ...persistentHostSessionStarts.keys(),
    ...persistentHostSessionStartTransports.keys(),
    ...persistentHostSessionStartBlocks.keys(),
    ...persistentHostSessionClosures.keys(),
    ...persistentHostSessionEpochs.keys(),
    ...codexSessionHomes.keys(),
  ]);
  const results = await Promise.all(Array.from(keys, (key) => closeHostAgentSession(key)));
  const failedSessionKeys = results
    .filter((result) => result?.closed === false)
    .map((result) => result.host_session_key)
    .filter(Boolean);
  return {
    accepted: results.some((result) => result.accepted),
    closed: failedSessionKeys.length === 0,
    session_count: results.length,
    failed_session_keys: failedSessionKeys,
    persistent_transports_closed: results.filter((result) => result.persistent_transport_closed).length,
    pending_starts_reaped: results.filter((result) => result.pending_start_reaped).length,
    codex_session_homes_removed: results.filter((result) => result.codex_home_removed).length,
    results,
  };
}

export async function reconcileHostAgentSessionHomes(repoRoot, { activeRouteKeys = [] } = {}) {
  const runtimeRoot = process.env.JCC_RUNTIME_DATA_DIR || defaultRuntimeDataRoot(repoRoot);
  const baseHome = path.resolve(process.env.JCC_CODEX_RUNTIME_HOME || path.join(runtimeRoot, "host-cli", "codex-home"));
  const sessionsDir = path.join(baseHome, "sessions");
  const retainedNames = new Set([
    ...activeRouteKeys,
    ...persistentHostSessions.keys(),
    ...persistentHostSessionStarts.keys(),
  ].map(safeHostSessionKey).filter(Boolean));
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const removed = [];
  const retained = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(sessionsDir, entry.name);
    if (retainedNames.has(entry.name)) {
      retained.push(target);
      continue;
    }
    await removeRuntimePath(target);
    removed.push(target);
  }
  return {
    schema: "jcc-host-session-home-reconciliation-v1",
    sessions_dir: sessionsDir,
    active_route_keys: Array.from(activeRouteKeys, (key) => String(key || "")).filter(Boolean),
    removed,
    retained,
  };
}

export const hostAdapterContract = {
  schema: "jcc-host-adapter-registry-v1",
  adapters: {
    codex: {
      protocol: "codex-app-server-json-rpc",
      prompt_transport: "app-server-turn-start",
      image_transport: "app-server-local-image-input",
      stream_parser: "app-server:item-agent-message-delta-or-completed",
      state_policy: "runtime_authoritative_persistent_provider_session",
      session_transport: "persistent-codex-app-server-thread-and-turns",
      readonly_strategy_tools: "codex-dynamicTools-and-item-tool-call-native-only-shell-disabled",
      stateless_fallback_transport: "codex-exec-json-event-stream",
    },
    kimi: {
      protocol: "acp-json-rpc",
      launch_args: ["acp"],
      prompt_transport: "acp-session-prompt-content-blocks",
      image_transport: "acp-session-prompt-image-base64",
      mcp_injection: "acp-merge",
      state_policy: "runtime_authoritative_persistent_provider_session",
      session_transport: "persistent-acp-process-session-and-prompts",
      readonly_strategy_tools: "native-dynamic-tools-after-verified-mcp-handshake-otherwise-prefetch-complete",
      tool_surface_policy: "stock-acp-builtin-schemas-visible-execution-denied",
      max_result_bytes: KIMI_MCP_MAX_RESULT_BYTES,
    },
  },
};
