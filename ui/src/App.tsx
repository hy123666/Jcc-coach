import { useEffect, useMemo, useRef, useState } from "react";
import { buildRankingStatusViewModel } from "../electron/ranking-status-view-model.js";
import {
  ArrowDown,
  Bot,
  ChevronRight,
  CircleDot,
  Dumbbell,
  Eye,
  Gem,
  LayoutTemplate,
  Menu,
  Minus,
  Play,
  Plus,
  Send,
  Shield,
  Sparkles,
  Square,
  Swords,
  Terminal,
  Wifi,
  X,
  Trash2,
} from "lucide-react";
import {
  type CoachResponse,
  type DailyModeId,
  type DecisionCandidate,
  type DecisionEquipmentEntry,
  type DecisionInputOptions,
  type HostDiagnostics,
  type HostCliAgentCandidate,
  type ItemChoiceKind,
  type ManualVariableOptions,
  type ManualVariablesPayload,
  type ModelOption,
  type PinnedResultPayload,
  type ReasoningEffortOption,
    type RuntimeBridge,
    type RuntimeDailyCoreTheoryAction,
    type RuntimeDailyRankingRecommendationAction,
    type RuntimeDeliveryStream,
    type RuntimeMatchModeDescriptor,
    type RuntimeModeIconKey,
    type RuntimeModeId,
    type RuntimeUiModeDefinitions,
  type SeasonVariableField,
  type RuntimeReconcileRequest,
  type RuntimeResult,
  type RuntimeState,
  type StrategyWikiStatus,
  createRuntimeReconcileDrain,
  dailyDeliveryNeedsActiveMatchNotice,
  getRuntimeBridge,
  hostCliCandidateStatusLabel,
  lineupDeliveryGuardDecision,
  pinnedPanelShouldBeVisible,
  pinnedResultIsPublishable,
    preferredAvailableHostProvider,
    reconcileCanonicalRuntimeDelivery,
    resolveAvailableMatchModes,
    resolveDailyCoreTheoryAction,
    resolveDailyRankingRecommendationAction,
    responseTaskDeliveryDecision,
    runtimeResultGenerationIsCurrent,
    uiModeFromBackendMode,
    manualChoiceBackendMode,
    missingChoicePromptIsAvailable
} from "./runtimeBridge";
import { rememberBoundedDeliveryKey } from "./coachResponseDelivery";
import { createModeTransitionFence } from "./modeTransitionFence";
import {
  DecisionInputCard,
  type DecisionInputCardDrafts,
  type DecisionInputCardStages,
} from "./components/DecisionInputCard";
import { CatalogCombobox, type CatalogComboboxOption } from "./components/CatalogCombobox";

type ModeId = RuntimeModeId;
type PinnedView = "lineup" | "variables";
type DailyMode = Exclude<DailyModeId, "prefs">;
type MenuSection = "main" | "mumu" | "agent" | "data" | "diagnostics" | "wiki";
type MessageRole = "agent" | "user" | "status";
type LineupCardStatus = "idle" | "pending" | "published" | "failed" | "stale";
const MAX_RENDERER_MESSAGES_PER_STREAM = 400;

type Mode = RuntimeMatchModeDescriptor & {
  icon: typeof Bot;
};

type BoardUnit = {
  row: number;
  col: number;
  name: string;
  mark?: "move" | "danger" | "anchor";
};

type Loadout = {
  unit: string;
  items: string[];
  note?: string;
};

type ChatMessage = {
  id: string;
  role: MessageRole;
  text: string;
  evidence?: string;
};

type PinnedPlan = {
  title: string;
  summary?: string;
  units: BoardUnit[];
  loadouts: Loadout[];
  moves?: string[];
  degraded?: boolean;
  provenance?: Record<string, unknown>;
};

const itemChoiceKinds: Array<{ id: ItemChoiceKind; label: string }> = [
  { id: "basic_component_forge", label: "基础装备锻造器" },
  { id: "completed_item_forge", label: "装备锻造器" },
  { id: "artifact_forge", label: "神器锻造器" },
  { id: "radiant_item_choice", label: "光明装备选择" },
];

const ownedAugmentTextPanelPreset = "我已点开已拥有强化符文，读取这个强化";
const ownedAugmentTextPanelHint = "先在游戏里点开右侧“已拥有强化符文”面板";
const itemChoiceComposerPrompt = "请报候选装备/锻造器，并补当前装备、散件和持有人。";
const itemChoiceComposerHint = "请把候选装备/锻造器、当前装备、散件和持有人一起报出来。";
const lineupComposerPrompt = "把当前讨论的目标阵容整理到阵容图，并写清核心装备、站位、过渡和关键节点。";
const finalLineupCardPrompt = "确认最终阵容：";
const refreshReportComposerPrompt = "刷新后是：";

function composerPromptForMode(mode: Mode | undefined, itemChoiceKind: ItemChoiceKind) {
  if (!mode) return "";
  const reportPrompt = mode.userReportPrompt?.trim() || "";
  if (mode.id === "item") {
    const label = itemChoiceKinds.find((kind) => kind.id === itemChoiceKind)?.label || "装备锻造器";
    return `${reportPrompt || itemChoiceComposerPrompt} (${label})`;
  }
  if (reportPrompt) return reportPrompt;
  if (mode.id === "lineup") return lineupComposerPrompt;
  return mode.prompt || "";
}

function pinnedPlanFromResponse(payload?: PinnedResultPayload | null): PinnedPlan | null {
  if (!pinnedResultIsPublishable(payload)) return null;
  const value = payload as PinnedResultPayload;
  const units = Array.isArray(value.units)
    ? value.units
        .map((unit) => ({
          row: Number(unit.row),
          col: Number(unit.col),
          name: String(unit.name || "").trim(),
          mark: unit.mark,
        }))
        .filter((unit) => unit.name && unit.row >= 1 && unit.row <= 4 && unit.col >= 1 && unit.col <= 7)
    : [];
  const loadouts = Array.isArray(value.loadouts)
    ? value.loadouts
        .map((loadout) => ({
          unit: String(loadout.unit || "").trim(),
          items: Array.isArray(loadout.items) ? loadout.items.map((item) => String(item).trim()).filter(Boolean).slice(0, 3) : [],
          note: loadout.note ? String(loadout.note) : undefined,
        }))
        .filter((loadout) => loadout.unit)
    : [];
  const moves = Array.isArray(value.moves) ? value.moves.map((move) => String(move).trim()).filter(Boolean) : [];
  return {
    title: String(value.title || "Recommended lineup").trim(),
    ...(value.summary ? { summary: String(value.summary).trim() } : {}),
    units,
    loadouts,
    ...(moves.length ? { moves } : {}),
    ...(value.provenance && typeof value.provenance === "object" ? { provenance: value.provenance } : {}),
  };
}

function isManualMatchMode(mode: ModeId) {
  return mode !== "cruise";
}

function isInternalHostPendingTimeout(message?: string | null) {
  return /host_coach_response_(?:preparing|pending|running)_timeout/i.test(String(message || ""));
}

function isInternalRuntimeErrorText(message?: string | null) {
  const text = String(message || "");
  if (!text) return false;
  return /pipeline_failed|visual_refresh_failed|host_coach_response_(?:preparing|pending|running)_timeout|host_visual_request_stale_timeout|host_cli_json_parse_failed|host CLI coach response/i.test(text)
    || /(?:conflicting|stale) runtime transition|runtime transition revision gap/i.test(text)
    || /Host CLI exited|Kimi ACP exited|fetch failed|command=|args=|\.mjs|\.json/i.test(text)
    || /(?:[A-Za-z]:\\|ENOENT|EPERM|EACCES|EBUSY|ENOTEMPTY)/i.test(text);
}

function isGenericHostExitOnly(message?: string | null) {
  return /^(?:Host CLI|Kimi ACP) exited \d+$/i.test(String(message || "").trim());
}

function sanitizeRuntimeDiagnosticText(message: string) {
  return message
    .split(/\r?\n/u)
    .filter((line) => !/^\s*stderr\s*[:=]/iu.test(line))
    .join("\n")
    .replace(/\bstderr\s*[:=].*$/gimu, "[stderr redacted]")
    .replace(/("?(?:cookie|did)"?\s*[:=]\s*")[^"]*(")/giu, "$1<redacted>$2")
    .replace(/\b(?:cookie|did)\s*[:=]\s*[^\s,;]+/giu, "[redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "<redacted-ip>")
    .replace(/\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9:]{0,4}\b/giu, "<redacted-ip>")
    .slice(0, 240)
    .trim();
}

function userVisibleRuntimeErrorText(message?: string | null, fallback = "后台链路暂时失败；我会继续监听，你可以重试当前操作。") {
  const text = String(message || "").trim();
  if (!text) return fallback;
  if (text.includes("host_turn_missing_final_answer")) return "模型结束了本轮处理，但没有返回最终回答。可以重试当前问题。";
  if (/Authentication required|Run \/login|\/login|login required|not logged in|账号|登录/i.test(text) && !isInternalRuntimeErrorText(text)) {
    return text;
  }
  if (isInternalHostPendingTimeout(text)) return "宿主 CLI Agent 回答超时；我已释放这次卡住的回答，会继续用最新状态监听。";
  if (isInternalRuntimeErrorText(text)) return fallback;
  return sanitizeRuntimeDiagnosticText(text) || fallback;
}

const hostDiagnosticValueKey = /^(?:provider|reason|category|code|status|status_code|http_status|message|error|stderr|stdout|provider_error|auth|quota|rate_limit|rateLimit|detail|details)$/i;
const actionableHostDiagnosticText = /(?:\b(?:401|403|429|503)\b|quota|usage limit|rate[- ]?limit|auth|login|unauthori[sz]ed|forbidden|provider|service unavailable|temporarily unavailable)/i;

function collectHostDiagnosticLines(value: HostDiagnostics | undefined, key = "", depth = 0): string[] {
  if (value == null || depth > 4) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (key && !hostDiagnosticValueKey.test(key)) return [];
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectHostDiagnosticLines(entry, key, depth + 1));
  }
  return Object.entries(value).flatMap(([entryKey, entryValue]) =>
    collectHostDiagnosticLines(entryValue, entryKey, depth + 1)
  );
}

function sanitizeHostDiagnosticLine(line: string) {
  return line
    .replace(/("(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token)"\s*:\s*")[^"]*(")/gi, "$1<redacted>$2")
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, "Authorization: Bearer <redacted>")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/^(command|args)=.*$/i, "")
    .trim();
}

function userVisibleHostDiagnosticsText(diagnostics?: HostDiagnostics | null) {
  const visibleLines = collectHostDiagnosticLines(diagnostics ?? undefined)
    .flatMap((line) => String(line).split(/\r?\n/))
    .map(sanitizeHostDiagnosticLine)
    .filter(Boolean)
    .filter((line) => !/^\s*at\s+/i.test(line))
    .filter((line) => !/Traceback|node:internal|node_modules|(?:[A-Za-z]:\\|\.mjs\b|\.json\b|\\Codex\\|\\KIMI CLI\\|\\CLI Launchers\\)/i.test(line))
    .filter((line) => actionableHostDiagnosticText.test(line))
    .map((line) => line.slice(0, 240));
  return Array.from(new Set(visibleLines)).slice(0, 4).join("\n").trim();
}

function userVisibleHostCliFailureText(message?: string | null, diagnostics?: HostDiagnostics | null) {
  const text = String(message || "").trim();
  if (/host_cli_json_parse_failed/i.test(text)) return "宿主 CLI Agent 返回格式异常；本次回答已释放，请重试。";
  if (/request_id (?:does not match|mismatch)|request_hash (?:does not match|mismatch)|mode mismatch|request identity/i.test(text)) {
    return "宿主 CLI Agent 已返回回答，但与当前任务的身份核对未通过；本次未交付，请重试。";
  }
  if (/schema mismatch|generated_by mismatch/i.test(text)) {
    return "宿主 CLI Agent 返回的响应格式标识不符合要求；本次未交付，请重试。";
  }
  if (/conflicts with current game rules|violates game_rule_contract/i.test(text)) {
    return "宿主 CLI Agent 回答与当前阶段或规则冲突；本次回答已释放，请按最新状态重试。";
  }
  const fallback = "宿主 CLI Agent 回答失败；我会继续用最新状态监听。";
  if (!text) return fallback;
  if (isInternalHostPendingTimeout(text)) return userVisibleRuntimeErrorText(text, fallback);
  if (isInternalRuntimeErrorText(text)) return userVisibleRuntimeErrorText(text, fallback);
  if (isGenericHostExitOnly(text)) {
    const diagnosticText = userVisibleHostDiagnosticsText(diagnostics);
    if (diagnosticText) return diagnosticText;
  }
  const visibleLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(command|args)=/i.test(line))
    .filter((line) => !/(?:[A-Za-z]:\\|\.mjs\b|\.json\b|node_modules|\\Codex\\|\\KIMI CLI\\|\\CLI Launchers\\)/i.test(line));
  const visible = visibleLines.join("\n").trim();
  const genericExitOnly = isGenericHostExitOnly(visible);
  if (visible && !genericExitOnly) return visible;
  if (/403|401|429|503|quota|usage limit|rate limit|login|auth|unauthorized|forbidden|provider/i.test(text)) {
    return text.replace(/^(command|args)=.*$/gim, "").trim() || fallback;
  }
  return fallback;
}

const modeIcons: Record<RuntimeModeIconKey, typeof Bot> = {
  bot: Bot,
  sparkles: Sparkles,
  gem: Gem,
  dumbbell: Dumbbell,
  shield: Shield,
  eye: Eye,
};

function materializeMatchModes(descriptors: RuntimeMatchModeDescriptor[]): Mode[] {
  return descriptors.map((mode) => ({
    ...mode,
    icon: modeIcons[mode.iconKey] || Bot,
  }));
}

function sortMatchModesForDecisionRail(modes: Mode[]): Mode[] {
  return [...modes].sort((left, right) => {
    if (left.id === "item" && right.id !== "item") return 1;
    if (right.id === "item" && left.id !== "item") return -1;
    return 0;
  });
}

const emptyManualVariableOptions: ManualVariableOptions = {};

const baseReasoningEffortOptions: ReasoningEffortOption[] = [
  { value: "default", label: "跟随 CLI 默认", native: true },
  { value: "low", label: "低：更快", native: true },
  { value: "medium", label: "中：均衡", native: true },
  { value: "high", label: "高：复杂局面", native: true },
];

const extraReasoningEffortOptions: Record<string, ReasoningEffortOption> = {
  xhigh: { value: "xhigh", label: "超高：深度局面/复盘", native: true },
  max: { value: "max", label: "最高：重要策略决策", native: true },
  ultra: { value: "ultra", label: "Ultra：最强思考（慢）", native: true },
};

function reasoningEffortOptionsForSelectedModel(model: string, modelOptions: ModelOption[] = []): ReasoningEffortOption[] {
  const selected = modelOptions.find((option) => option.value === model);
  const levels = selected?.supported_reasoning_levels ?? [];
  if (!levels.length) return [baseReasoningEffortOptions[0]];
  return [
    baseReasoningEffortOptions[0],
    ...levels
      .map((level) => baseReasoningEffortOptions.find((option) => option.value === level) ?? extraReasoningEffortOptions[level])
      .filter((option): option is ReasoningEffortOption => Boolean(option)),
  ];
}

const defaultStrategyLines = [
  "默认目标偏稳前四，除非开局强化和装备明显胡。",
  "手速按正常处理，大变阵尽量提前一回合提醒。",
  "前期未定阵时优先保经济和强势过渡，不急着锁死目标阵容。",
];

const initialDailyMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "agent",
    text: "Runtime UI 已准备。Start Match 会新建本局 session，连接 MuMu 是单独菜单动作；巡航会持续监听，但只在有价值事件或你发消息时唤醒宿主 CLI 主模型。",
  }
];

const initialMatchMessages: ChatMessage[] = [
  {
    id: "match-welcome",
    role: "agent",
    text: "本局巡航已就绪。对局聊天和日常聊天已隔离；这里的消息只属于当前对局。",
  }
];

function messageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stateText(state: RuntimeState | null) {
  const match = state?.match_session?.status === "active"
    && state?.match_session?.ui_ready !== false;
  const adbCheckedAt = Date.parse(state?.device_connection?.checked_at || "");
  const adbCheckAge = Date.now() - adbCheckedAt;
  const mumu = state?.device_connection?.status === "connected"
    && Number.isFinite(adbCheckedAt) && adbCheckAge >= 0 && adbCheckAge <= 30000;
  return {
    match,
    mumu,
    sessionId: state?.match_session?.match_session_id ?? null,
    host: state?.host_cli?.version ?? state?.host_cli?.codex_version ?? (state?.host_cli?.available || state?.host_cli?.codex_available ? state?.host_cli?.display_name ?? "Host CLI Agent" : null),
  };
}

function formatRuntimeStamp(value?: string | null) {
  if (!value) return "-";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function safeShortStatus(value?: string | null) {
  const text = String(value || "").trim();
  return text
    ? text.replace(/[A-Za-z]:\\[^\s]+/g, "[redacted]").replace(/\b(?:token|api[_-]?key|authorization)=\S+/gi, "[redacted]").slice(0, 96)
    : "-";
}

function selfStateRefreshView(
  refresh?: RuntimeState["self_state_refresh"] | null,
  matchConnection?: RuntimeState["match_connection"] | null,
) {
  const status = String(refresh?.status || "idle");
  const waitingForMatch = /waiting_for_live_state|waiting_for_current_match_live_state|discovering/i.test(String(matchConnection?.status || ""));
  const waitingForGameAssist = matchConnection?.source_health?.structured_source_status === "waiting_for_gameassist_payload";
  const hasDetails = Boolean(refresh?.last_stage_round || refresh?.stage_round || refresh?.phase)
    || Object.values(refresh?.last_economy || {}).some(value => value != null)
    || refresh?.hp != null
    || refresh?.gold != null
    || refresh?.level != null
    || refresh?.xp != null;
  const failed = !waitingForMatch && (/fail|error|stale/i.test(status) || Boolean(refresh?.last_error || refresh?.error));
  const running = /running|started|queued|refresh/i.test(status) && !/completed|fail|error|stale/i.test(status);
  const waitingHost = /awaiting|host|ai_native|response_pending/i.test(status);
  const needsConfirm = /confirm|missing_choice/i.test(status);
  const label = waitingForMatch && !hasDetails
    ? "等待进入对局"
    : failed
    ? "失败可重试"
    : needsConfirm
      ? "需要确认"
      : waitingHost
        ? "等主模型"
        : running
          ? "观察中"
          : /completed|ready/i.test(status)
            ? "已观察"
            : "等待观察";
  const stamp = formatRuntimeStamp(refresh?.last_self_state_roi_completed_at || refresh?.last_completed_at || refresh?.last_started_at || refresh?.last_failed_at);
  return {
    label,
    details: hasDetails
      ? failed
        ? "本次 HUD 观察失败；已有记录保留，等待重新观察"
        : refresh?.last_missing_fields?.length
          ? "HUD 已部分更新；缺失信息仍待观察"
          : running
            ? "已有 HUD 记录，正在更新"
            : "HUD 已更新；策略回答会使用最新事实"
      : (waitingForGameAssist
      ? "ADB 已连接，等待 MuMu 局内数据；HUD 会继续独立观察"
      : waitingForMatch
        ? "请先在游戏里进入对局画面"
        : "HUD 状态未就绪"),
    stamp,
    tone: failed ? "failed" : running || waitingHost || waitingForMatch ? "running" : "idle",
  };
}

function manualVariablesFromRuntime(
  variables?: RuntimeState["manual_match_variables"] | null,
  seasonVariableFields: SeasonVariableField[] = [],
): ManualVariablesPayload | null {
  const values = variables?.values;
  if (!values) return null;
  const rawSeasonVariables = values.season_variables && typeof values.season_variables === "object"
    ? values.season_variables
    : Object.fromEntries(seasonVariableFields.map((field) => [field.key, values[field.key]]));
  const seasonVariables = Object.fromEntries(
    Object.entries(rawSeasonVariables)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
          : String(value || "").trim(),
      ])
      .filter(([, value]) => Array.isArray(value) ? value.length > 0 : Boolean(value)),
  );
  return {
    target: String(values.target_plan_text || ""),
    seasonVariables,
  };
}

function Board({ units }: { units: BoardUnit[] }) {
  return (
    <div className="board" aria-label="四行七格棋盘">
      {[1, 2, 3, 4].map((row) => (
        <div className={`board-row ${row % 2 === 0 ? "row-even" : "row-odd"}`} key={row}>
          {[1, 2, 3, 4, 5, 6, 7].map((col) => {
            const unit = units.find((item) => item.row === row && item.col === col);
            return (
              <div className={`board-cell ${unit?.mark ? `cell-${unit.mark}` : ""}`} key={`${row}-${col}`}>
                <span>{unit?.name ?? ""}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function TopBar({
  menuOpen,
  matchActive,
  mumuConnected,
  onToggleMenu,
  onStart,
  onStop,
  onMinimize,
  onClose
}: {
  menuOpen: boolean;
  matchActive: boolean;
  mumuConnected: boolean;
  onToggleMenu: () => void;
  onStart: () => void;
  onStop: () => void;
  onMinimize: () => void;
  onClose: () => void;
}) {
  return (
    <header className="topbar">
      <div className="connection">
        <span className={`status-dot ${mumuConnected ? "" : "status-idle"}`} />
        <Wifi size={15} />
        <span>{mumuConnected ? "MuMu ADB 已验证连接" : "MuMu ADB 未连接或待验证"}</span>
        <em>{matchActive ? "对局中" : "日常"}</em>
      </div>
      <div className="window-actions">
        <button className={`icon-button ${menuOpen ? "button-active" : ""}`} type="button" aria-label="菜单" aria-pressed={menuOpen} onClick={onToggleMenu}>
          <Menu size={15} />
        </button>
        <button className="top-action primary" type="button" aria-label="开始对局" onClick={onStart} disabled={matchActive}>
          <Play size={13} />
          <span>开局</span>
        </button>
        <button className="top-action" type="button" aria-label="停止对局" onClick={onStop} disabled={!matchActive}>
          <Square size={12} />
          <span>停止</span>
        </button>
        <button className="icon-button" type="button" aria-label="缩小 Runtime UI" onClick={onMinimize}>
          <Minus size={14} />
        </button>
        <button className="icon-button" type="button" aria-label="关闭 Runtime UI" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
    </header>
  );
}

function ModeRail({ modes, activeMode, onModeChange }: {
  modes: Mode[];
  activeMode: ModeId;
  onModeChange: (mode: ModeId) => void;
}) {
  return (
    <nav className="mode-grid" aria-label="运行模式">
      {modes.map((mode) => {
        const Icon = mode.icon;
        return (
          <button
            className={`mode-button ${activeMode === mode.id ? "mode-active" : ""} ${mode.secondary ? "mode-secondary" : "mode-primary"}`}
            key={mode.id}
            type="button"
            aria-pressed={activeMode === mode.id}
            aria-current={activeMode === mode.id ? "page" : undefined}
            onClick={() => onModeChange(mode.id)}
          >
            <Icon size={16} />
            <span>{mode.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function SelfStateStrip({ refresh, matchConnection }: {
  refresh?: RuntimeState["self_state_refresh"] | null;
  matchConnection?: RuntimeState["match_connection"] | null;
}) {
  const view = selfStateRefreshView(refresh, matchConnection);
  return (
    <section className={`self-state-strip self-state-${view.tone}`} aria-label="实时自我状态" aria-live="polite">
      <span>{view.label}</span>
      <strong>{view.details}</strong>
      <em>{view.stamp}</em>
    </section>
  );
}

function MenuPanel({
  section,
  runtimeState,
  onSectionChange,
  onConnectMumu,
  onDiscoverHostCliAgents,
  onDetectHostCli,
  onUpdateRankings,
  onSaveRuntimeSettings,
  onResetDailySession,
  onRestartRuntimeDaemon,
  hostModel,
  hostReasoning,
  hostModelOptions,
  hostCandidates,
  selectedHostProvider,
  hostDiscoveryStatus,
  rankingsUpdateBusy,
  onSelectedHostProviderChange,
  onHostModelChange,
  onHostReasoningChange,
  diagnosticEvidenceEnabled,
  onDiagnosticEvidenceEnabledChange,
  strategyLines,
  editingStrategyIndex,
  strategyDraft,
  wikiStatus,
  onStrategyDraftChange,
  onEditStrategy,
  onSaveStrategy,
  onBuildWikiCuration,
  onRefreshWikiStatus,
  onCancelStrategyEdit
}: {
  section: MenuSection;
  runtimeState: RuntimeState | null;
  onSectionChange: (section: MenuSection) => void;
  onConnectMumu: () => void;
  onDiscoverHostCliAgents: () => void;
  onDetectHostCli: () => void;
  onUpdateRankings: () => void;
  onSaveRuntimeSettings: () => void;
  onResetDailySession: () => void;
  onRestartRuntimeDaemon: () => void;
  hostModel: string;
  hostReasoning: string;
  hostModelOptions: ModelOption[];
  hostCandidates: HostCliAgentCandidate[];
  selectedHostProvider: string;
  hostDiscoveryStatus: string;
  rankingsUpdateBusy: boolean;
  onSelectedHostProviderChange: (value: string) => void;
  onHostModelChange: (value: string) => void;
  onHostReasoningChange: (value: string) => void;
  diagnosticEvidenceEnabled: boolean;
  onDiagnosticEvidenceEnabledChange: (value: boolean) => void;
  strategyLines: string[];
  editingStrategyIndex: number | null;
  strategyDraft: string;
  wikiStatus: StrategyWikiStatus | null;
  onStrategyDraftChange: (value: string) => void;
  onEditStrategy: (index: number) => void;
  onSaveStrategy: () => void;
  onBuildWikiCuration: () => void;
  onRefreshWikiStatus: () => void;
  onCancelStrategyEdit: () => void;
}) {
  const runtimeHostMatchesSelection = runtimeState?.host_cli?.provider === selectedHostProvider
    && (runtimeState?.host_cli?.selected_model || "default") === hostModel;
  const runtimeReasoningOptions = runtimeHostMatchesSelection
    ? runtimeState?.host_cli?.capabilities?.reasoning_effort_options
    : null;
  const reasoningOptions = runtimeReasoningOptions?.length
    ? runtimeReasoningOptions
    : reasoningEffortOptionsForSelectedModel(hostModel, hostModelOptions);
  const modelOptions = hostModelOptions.length ? hostModelOptions : [{ value: "default", label: "跟随 CLI 默认", native: true }];
  const selectedHostCandidate = hostCandidates.find((agent) => agent.provider === selectedHostProvider);
  const canConnectSelectedHost = !hostCandidates.length || Boolean(selectedHostCandidate?.available);

  if (section === "mumu") {
    return (
      <aside className="menu-panel" aria-label="MuMu 连接设置">
        <div className="panel-title-row">
          <button type="button" onClick={() => onSectionChange("main")}>返回</button>
          <h2>连接 MuMu</h2>
        </div>
        <button type="button" onClick={onConnectMumu}>一键识别 MuMu / ADB 端口</button>
        <p>{stateText(runtimeState).mumu
          ? runtimeState?.device_connection?.ui_hint ?? "ADB 已通过近期连接验证。"
          : "ADB 当前未连接或连接尚未验证，请确认 MuMu 已打开后重新识别。"}</p>
      </aside>
    );
  }

  if (section === "agent") {
    return (
      <aside className="menu-panel" aria-label="宿主 CLI Agent 设置">
        <div className="panel-title-row">
          <button type="button" onClick={() => onSectionChange("main")}>返回</button>
          <h2>宿主 Agent</h2>
        </div>
        <div className="cli-header">
          <span>本机 CLI Agent</span>
          <button type="button" onClick={onDiscoverHostCliAgents}>扫描本机 CLI Agent</button>
        </div>
        <p className={hostDiscoveryStatus.toLowerCase().includes("failed") || hostDiscoveryStatus.includes("失败") ? "warning-line" : "quiet-line"}>
          {hostDiscoveryStatus}
        </p>
        <div className="cli-list">
          {(hostCandidates.length ? hostCandidates : [{
            provider: runtimeState?.host_cli?.provider ?? "codex",
            display_name: runtimeState?.host_cli?.display_name ?? "Codex CLI",
            available: runtimeState?.host_cli?.available ?? runtimeState?.host_cli?.codex_available ?? false,
            command: runtimeState?.host_cli?.command ?? null,
            version: runtimeState?.host_cli?.version ?? runtimeState?.host_cli?.codex_version ?? null,
            error: runtimeState?.host_cli?.error ?? runtimeState?.host_cli?.codex_error ?? null,
          }]).map((agent) => (
            <button
              className={`cli-card ${selectedHostProvider === agent.provider ? "selected" : ""}`}
              type="button"
              key={agent.provider}
              disabled={!agent.available}
              onClick={() => onSelectedHostProviderChange(agent.provider)}
            >
              <Terminal size={15} />
              <span>
                <strong>{agent.display_name ?? agent.provider}</strong>
                <em>{agent.version ?? (agent.error ? userVisibleRuntimeErrorText(agent.error, "不可用") : "等待扫描")}</em>
                {agent.command && <em>已配置命令</em>}
              </span>
              <small>{hostCliCandidateStatusLabel(agent)}</small>
            </button>
          ))}
        </div>
        <button type="button" onClick={onDetectHostCli} disabled={!canConnectSelectedHost}>连接所选 Agent</button>
        <button className="danger-menu-action" type="button" onClick={onRestartRuntimeDaemon}>重启 Runtime Daemon</button>
        {selectedHostProvider === "kimi" && (
          <p className="quiet-line">Kimi CLI 使用本机 OAuth 登录和 ACP 会话；仅在 CLI 明确支持图像能力时传递视觉请求。</p>
        )}
        {runtimeState?.host_cli?.command && <p className="quiet-line">已配置宿主 CLI 命令</p>}
        {runtimeState?.host_cli?.codex_error && <p className="warning-line">{userVisibleRuntimeErrorText(runtimeState.host_cli.codex_error, "Codex CLI 当前不可用。")}</p>}
        <label>
          <span>模型</span>
          <select value={hostModel} onChange={(event) => onHostModelChange(event.target.value)}>
            {modelOptions.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        {runtimeState?.host_cli?.default_model_label && (
          <p className="quiet-line">CLI 默认模型：{runtimeState.host_cli.default_model_label}</p>
        )}
        {runtimeState?.host_cli?.model_options_error && (
          <p className="warning-line">{userVisibleRuntimeErrorText(runtimeState.host_cli.model_options_error, "模型列表读取失败，将跟随 CLI 默认模型。")}</p>
        )}
        <label>
          <span>推理强度</span>
          <select value={hostReasoning} onChange={(event) => onHostReasoningChange(event.target.value)}>
            {reasoningOptions.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <p>最终教练回答由当前 CLI Agent 主模型生成；推理强度按当前模型原生能力透传。</p>
      </aside>
    );
  }

  if (section === "diagnostics") {
    return (
      <aside className="menu-panel" aria-label="故障诊断设置">
        <div className="panel-title-row">
          <button type="button" onClick={() => onSectionChange("main")}>返回</button>
          <h2>故障诊断</h2>
        </div>
        <label className="setting-toggle-row">
          <span>
            <strong>保留 OCR 与失败证据</strong>
            <small>仅排查问题时开启。开启后会限量保留 OCR 截图和失败诊断，默认关闭，最多保留 7 天。</small>
          </span>
          <input
            type="checkbox"
            checked={diagnosticEvidenceEnabled}
            onChange={(event) => onDiagnosticEvidenceEnabledChange(event.target.checked)}
          />
        </label>
        <p className="quiet-line">关闭时不保存 Quick OCR 截图；该设置不影响识别、巡航或教练建议。</p>
        <button className="primary-menu-action" type="button" onClick={onSaveRuntimeSettings}>保存诊断设置</button>
      </aside>
    );
  }

  if (section === "data") {
    const rankingStatusView = buildRankingStatusViewModel({
      rankingsStatus: runtimeState?.rankings_status,
      updateTask: runtimeState?.ranking_update_task,
    });
    const rankingBusy = rankingsUpdateBusy || rankingStatusView.update_task_busy;
    const rankingStatDate = rankingStatusView.active_stat_date;
    const dataAvailability = rankingStatDate
      ? String(rankingStatDate)
      : rankingStatusView.active_error
        ? "不可用"
        : "尚未更新";
    return (
      <aside className="menu-panel" aria-label="更新今日数据">
        <div className="panel-title-row">
          <button type="button" onClick={() => onSectionChange("main")}>返回</button>
          <h2>更新今日数据</h2>
        </div>
        <div className="data-status-grid" aria-label="掌盟大师以上数据状态">
          <span>数据日期</span>
          <strong>{dataAvailability}</strong>
          <span>最后更新</span>
          <strong>{formatRuntimeStamp(rankingStatusView.last_success_at)}</strong>
          <span>状态</span>
          <strong>{safeShortStatus(rankingStatusView.update_task_status || rankingStatusView.active_status)}</strong>
          <span>更新进度</span>
          <strong>{safeShortStatus(rankingStatusView.update_task_phase || "-")}</strong>
          <span>已用快照</span>
          <strong>{safeShortStatus(rankingStatusView.active_snapshot_id) || "-"}</strong>
          <span>错误</span>
          <strong>{rankingStatusView.error
            ? userVisibleRuntimeErrorText(rankingStatusView.error, "数据更新失败，可重试。")
            : "-"}</strong>
        </div>
        <div className="data-status-grid" aria-label="今日数据来源">
          <span>主数据源</span>
          <strong>掌盟</strong>
          <span>段位范围</span>
          <strong>大师以上</strong>
        </div>
        <button
          className="primary-menu-action"
          type="button"
          onClick={onUpdateRankings}
          disabled={rankingBusy}
          aria-busy={rankingBusy}
        >
          {rankingBusy ? "正在更新今日数据" : "更新今日数据"}
        </button>
        <p>今日数据来自掌盟大师以上段位；没有可用数据时显示尚未更新或不可用。</p>
      </aside>
    );
  }

  if (section === "wiki") {
    return (
      <aside className="menu-panel" aria-label="策略 Wiki 录入">
        <div className="panel-title-row">
          <button type="button" onClick={() => onSectionChange("main")}>返回</button>
          <h2>策略 Wiki</h2>
        </div>
        <textarea
          value={strategyDraft}
          onChange={(event) => onStrategyDraftChange(event.target.value)}
          placeholder="例如：我默认更重视稳前四，除非开局强化很胡。"
        />
        <div className="strategy-actions">
          <button type="button" onClick={onSaveStrategy}>
            {editingStrategyIndex === null ? "确认写入并检查冲突" : "确认修改并检查冲突"}
          </button>
          <button type="button" onClick={onBuildWikiCuration}>一键整理复盘/策略 Wiki</button>
          {editingStrategyIndex !== null && <button type="button" onClick={onCancelStrategyEdit}>取消编辑</button>}
        </div>
        <div className="wiki-status-card" aria-label="策略 Wiki 草稿和待确认问题">
          <div>
            <strong>Wiki 状态</strong>
            <button type="button" onClick={onRefreshWikiStatus}>刷新</button>
          </div>
          <p>
            草稿 {wikiStatus?.draft_pages?.length ?? 0} 页 · 已发布 {wikiStatus?.published_pages?.length ?? 0} 页 · 陈旧 {wikiStatus?.stale_pages?.length ?? 0} 页</p>
          <p>
            跨赛季 {wikiStatus?.published_pages?.filter((page) => page.scope === "cross_season").length ?? 0} 页 · 当前赛季 {wikiStatus?.published_pages?.filter((page) => page.scope === "current_season").length ?? 0} 页 · 待分类 {wikiStatus?.published_pages?.filter((page) => !page.scope || page.scope === "unclassified").length ?? 0} 页
          </p>
          {!!wikiStatus?.recent_runs?.length && (
            <p>
              最近整理：{wikiStatus.recent_runs[0]?.status === "pending_host_model" ? "等待宿主模型生成草稿" : wikiStatus.recent_runs[0]?.status ?? "未知状态"}
            </p>
          )}
          {!!wikiStatus?.pending_questions?.length && (
            <ul>
              {wikiStatus.pending_questions.map((question, index) => (
                <li key={`${question}-${index}`}>{question}</li>
              ))}
            </ul>
          )}
          {!!wikiStatus?.draft_pages?.length && (
            <div className="wiki-page-list">
              {wikiStatus.draft_pages.slice(0, 5).map((page) => (
                <span key={page.page_id ?? page.title}>
                  {page.title ?? "Untitled"}{page.scope ? ` · ${page.scope}` : ""}{page.confidence ? ` · ${page.confidence}` : ""}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="saved-strategy-list" aria-label="已写入策略">
          <span>已写入策略</span>
          {strategyLines.map((line, index) => (
            <button type="button" key={`${line}-${index}`} onClick={() => onEditStrategy(index)}>
              <strong>#{index + 1}</strong>
              <em>{line}</em>
            </button>
          ))}
        </div>
        <p>先在策略 Wiki 聊天中让 Agent 清洗并复述，再由你确认写入；新策略会和已有策略全量比对，发现冲突时优先保留最新确认项。</p>
      </aside>
    );
  }

  return (
    <aside className="menu-panel" aria-label="菜单弹层">
      <div>
        <p className="section-kicker">Menu</p>
        <h2>Settings</h2>
      </div>
      <button type="button" onClick={() => onSectionChange("mumu")}>连接 MuMu / 自动识别端口</button>
      <button type="button" onClick={() => onSectionChange("agent")}>识别宿主 CLI Agent</button>
      <button type="button" onClick={() => onSectionChange("data")}>更新今日数据</button>
      <button type="button" onClick={() => onSectionChange("diagnostics")}>故障诊断：OCR 截图与失败证据</button>
      <button type="button" onClick={() => onSectionChange("wiki")}>策略 Wiki 录入</button>
      <button type="button" onClick={onResetDailySession}>开启新对话</button>
      <p>复盘摘要会自动保留近 20 局；真正复盘在未开局时的复盘聊天里完成。</p>
    </aside>
  );
}

function NoMatchPanel({
  dailyMode,
  onDailyModeChange,
  onStart,
  onResetDailySession,
  onBuildWikiCuration
}: {
  dailyMode: DailyMode;
  onDailyModeChange: (mode: DailyMode) => void;
  onStart: () => void;
  onResetDailySession: () => void;
  onBuildWikiCuration: () => void;
}) {
  const title = dailyMode === "wiki" ? "策略 Wiki" : dailyMode === "review" ? "复盘聊天" : "日常聊天";
  const description = dailyMode === "wiki"
    ? "用自然语言整理策略。Agent 先清洗并复述，确认后才写入策略 Wiki。"
    : dailyMode === "review"
      ? "读取近 20 局结构化摘要，聊强化、装备、D 牌、站位和失误复盘。"
      : "大厅中的版本与策略聊天，不写当前局 live_state。开始对局后进入巡航。";

  return (
    <section className="no-match-panel" aria-label="日常聊天状态">
      <div>
        <p className="section-kicker">No Active Match</p>
        <h2>{title}</h2>
      </div>
      <p>{description}</p>
      <div className="settings-grid">
        <button className="match-primary" type="button" onClick={onStart}>Start Match</button>
        <button className={dailyMode === "chat" ? "selected" : ""} type="button" onClick={() => onDailyModeChange("chat")}>日常聊天</button>
        <button className={dailyMode === "wiki" ? "selected" : ""} type="button" onClick={() => onDailyModeChange("wiki")}>策略 Wiki</button>
        <button className={dailyMode === "review" ? "selected" : ""} type="button" onClick={() => onDailyModeChange("review")}>复盘聊天</button>
        <button type="button" onClick={onResetDailySession}>开启新对话</button>
      </div>
      {dailyMode === "wiki" && (
        <button className="wiki-curation-action" type="button" onClick={onBuildWikiCuration}>
          一键整理 / 生成策略 Wiki
        </button>
      )}
    </section>
  );
}

function VariablePanel({
  variableOptions,
  seasonVariableFields,
  value,
  draftResetKey,
  onConfirm,
  equipmentEditor,
}: {
  variableOptions: ManualVariableOptions;
  seasonVariableFields: SeasonVariableField[];
  value?: ManualVariablesPayload | null;
  draftResetKey: string;
  onConfirm: (payload: ManualVariablesPayload) => void;
  equipmentEditor?: React.ReactNode;
}) {
  const [seasonDraft, setSeasonDraft] = useState<Record<string, string | string[]>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [target, setTarget] = useState("");
  const hasSeasonVariables = seasonVariableFields.length > 0;

  useEffect(() => {
    setSeasonDraft({});
    setAdvancedOpen(false);
    setTarget("");
  }, [draftResetKey]);

  useEffect(() => {
    if (!value) return;
    setSeasonDraft(value.seasonVariables || {});
    setTarget(value.target || "");
    setAdvancedOpen(Object.entries(value.seasonVariables || {}).some(([key, fieldValue]) => {
      const field = seasonVariableFields.find((item) => item.key === key);
      if (field?.section !== "advanced") return false;
      return Array.isArray(fieldValue) ? fieldValue.some(Boolean) : Boolean(fieldValue);
    }));
  }, [value, seasonVariableFields]);

  useEffect(() => {
    const allowed = new Set(seasonVariableFields.map((field) => field.key));
    setSeasonDraft((current) => Object.fromEntries(Object.entries(current).filter(([key]) => allowed.has(key))));
  }, [seasonVariableFields]);

  const updateField = (key: string, nextValue: string | string[]) => {
    setSeasonDraft((current) => ({ ...current, [key]: nextValue }));
  };

  const normalizedFieldValue = (field: SeasonVariableField): string | string[] => {
    const current = seasonDraft[field.key];
    const repeat = field.control === "multi_select" ? Math.max(1, Number(field.max_items) || 1) : 1;
    if (repeat > 1 || Array.isArray(current)) {
      const values = Array.isArray(current) ? current : current ? [current] : [];
      return Array.from({ length: repeat }, (_, index) => values[index] || "");
    }
    return typeof current === "string" ? current : current?.[0] || "";
  };

  const renderField = (field: SeasonVariableField) => {
    const options = field.option_group ? variableOptions[field.option_group] || [] : [];
    const value = normalizedFieldValue(field);
    const repeat = Array.isArray(value) ? value.length : 1;
    const inputId = `season-variable-${field.key}`;
    const renderSingleControl = (currentValue: string, index?: number) => {
      const controlId = index == null ? inputId : `${inputId}-${index}`;
      const update = (nextValue: string) => {
        if (!Array.isArray(value)) {
          updateField(field.key, nextValue);
          return;
        }
        const nextValues = [...value];
        nextValues[index || 0] = nextValue;
        updateField(field.key, nextValues);
      };
      if (options.length) {
        return (
          <select id={controlId} value={currentValue} onChange={(event) => update(event.target.value)}>
            <option value="">未选择</option>
            {options.map((item) => (
              <option key={`${field.key}-${index ?? 0}-${item.name}`} value={item.name}>{item.name}</option>
            ))}
          </select>
        );
      }
      return (
        <input
          id={controlId}
          value={currentValue}
          onChange={(event) => update(event.target.value)}
          placeholder={field.label}
        />
      );
    };

    if (repeat > 1 && Array.isArray(value)) {
      return (
        <div className="two-column-picker" key={field.key}>
          {value.map((entry, index) => (
            <label key={`${field.key}-${index}`}>
              <span>{field.item_labels?.[index] || `${field.label} ${index + 1}`}</span>
              {renderSingleControl(entry, index)}
            </label>
          ))}
        </div>
      );
    }

    return (
      <label className="field-block" key={field.key}>
        <span>{field.label}</span>
        {renderSingleControl(String(value))}
      </label>
    );
  };

  const primaryFields = seasonVariableFields.filter((field) => field.section !== "advanced");
  const advancedFields = seasonVariableFields.filter((field) => field.section === "advanced");
  const summaryParts = seasonVariableFields
    .flatMap((field) => {
      const fieldValue = seasonDraft[field.key];
      return Array.isArray(fieldValue) ? fieldValue : [fieldValue];
    })
    .filter(Boolean);
  const advancedValues = advancedFields
    .flatMap((field) => {
      const fieldValue = seasonDraft[field.key];
      return Array.isArray(fieldValue) ? fieldValue : [fieldValue];
    })
    .filter(Boolean);
  const cleanedSeasonVariables = Object.fromEntries(
    Object.entries(seasonDraft)
      .map(([key, fieldValue]) => [
        key,
        Array.isArray(fieldValue)
          ? fieldValue.map((item) => item.trim()).filter(Boolean)
          : String(fieldValue || "").trim(),
      ] as const)
      .filter(([, fieldValue]) => Array.isArray(fieldValue) ? fieldValue.length > 0 : Boolean(fieldValue)),
  );

  return (
    <div className="variable-panel">
      {primaryFields.map(renderField)}

      {advancedFields.length > 0 && <details className="optional-variable-group" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>
          <span>赛季追加变量</span>
          <small>
            {advancedValues.length
              ? `已填写 ${advancedValues.length} 项`
              : advancedFields.map((field) => field.label).join(" / ")}
          </small>
          <ChevronRight size={14} aria-hidden="true" />
        </summary>
        <div className="optional-variable-fields">
          {advancedFields.map(renderField)}
        </div>
      </details>}

      <label className="field-block">
        <span>明确目标</span>
        <textarea value={target} onChange={(event) => setTarget(event.target.value)} placeholder="可留空；确定要围绕某套阵容或某个主C执行时再填写。" />
      </label>
      <p className="variable-summary">
        {hasSeasonVariables
          ? `当前：${summaryParts.length ? summaryParts.join(" · ") : "未填写"}`
          : "留空会保持开放；填写并确认后作为本局明确目标，后续仍会校验继续或退出条件。"}
      </p>
      <button type="button" onClick={() => onConfirm({
        target,
        seasonVariables: cleanedSeasonVariables,
      })}>
        {hasSeasonVariables ? "确认本局变量" : "确认本局目标"}
      </button>
      {equipmentEditor}
    </div>
  );
}

const holderEquipmentGroups = [
  { key: "components", label: "基础" },
  { key: "completed", label: "成型" },
  { key: "radiant", label: "光明" },
  { key: "support", label: "辅助" },
  { key: "artifacts", label: "神器" },
  { key: "emblems", label: "纹章" },
  { key: "special", label: "特殊" },
  { key: "other", label: "其他" },
] as const;

type HolderEquipmentRow = {
  ownerUnit: string;
  slots: Array<DecisionEquipmentEntry | null>;
};

function decisionEntityName(entry: DecisionCandidate | DecisionEquipmentEntry) {
  return String(entry.name || ("display_text" in entry ? entry.display_text : "") || "").trim();
}

function decisionEntitySearchTerms(entry: DecisionCandidate) {
  return Array.from(new Set([
    ...(entry.search_terms || []),
    ...(entry.alias_evidence || []).map((evidence) => evidence?.matched || ""),
  ].map((term) => String(term || "").trim()).filter(Boolean)));
}

function normalizeDecisionEntityLookup(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·・._\-/]+/g, "");
}

function resolveCatalogComboboxOption<T>(value: string, options: Array<CatalogComboboxOption<T>>) {
  const query = normalizeDecisionEntityLookup(value);
  if (!query) return null;
  const matches = options.filter((option) => [option.label, option.value, ...(option.searchTerms || [])]
    .some((term) => normalizeDecisionEntityLookup(term) === query));
  return matches.length === 1 ? matches[0] : null;
}

function holderEquipmentGroup(entry: DecisionCandidate | DecisionEquipmentEntry) {
  const category = String("item_category" in entry ? entry.item_category || "" : "").toLowerCase();
  const subtype = String(entry.item_subtype || "").toLowerCase();
  if (["components", "component", "basic"].includes(category)) return "components";
  if (["completed", "formed", "standard"].includes(category)) return "completed";
  if (["radiant", "support", "artifacts", "artifact", "emblems", "emblem", "special"].includes(category)) {
    if (category === "artifact") return "artifacts";
    if (category === "emblem") return "emblems";
    return category;
  }
  if (category === "support" || subtype.includes("support") || subtype.includes("辅助")) return "support";
  if (category === "special" || subtype === "special" || category === "other") return "special";
  return "other";
}

function equipmentRowsFromCanonical(boardNames: string[], equipped: DecisionEquipmentEntry[]): HolderEquipmentRow[] {
  const ownerNames = Array.from(new Set([
    ...boardNames,
    ...equipped.map((entry) => String(entry.owner_unit || "").trim()).filter(Boolean),
  ]));
  const rows = ownerNames.map((ownerUnit) => {
    const owned = equipped
      .filter((entry) => String(entry.owner_unit || "").trim() === ownerUnit)
      .sort((left, right) => Number(left.slot ?? 99) - Number(right.slot ?? 99));
    const slots: Array<DecisionEquipmentEntry | null> = [null, null, null];
    const unslotted: DecisionEquipmentEntry[] = [];
    for (const entry of owned) {
      const slot = Number(entry.slot);
      if (Number.isInteger(slot) && slot >= 1 && slot <= slots.length) {
        if (!slots[slot - 1]) slots[slot - 1] = entry;
      } else {
        unslotted.push(entry);
      }
    }
    for (let index = 0; index < slots.length && unslotted.length; index += 1) {
      if (!slots[index]) slots[index] = unslotted.shift() || null;
    }
    return {
      ownerUnit,
      slots,
    };
  });
  return rows.length ? rows : [{ ownerUnit: "", slots: [null, null, null] }];
}

function EquipmentHolderEditor({
  runtime,
  catalogMode,
  boardNames,
  stageRound,
  resetKey,
  onRuntimeResult,
  onStatus,
}: {
  runtime: RuntimeBridge;
  catalogMode: RuntimeMatchModeDescriptor | null;
  boardNames: string[];
  stageRound: string;
  resetKey: string;
  onRuntimeResult: (result: RuntimeResult) => void;
  onStatus: (text: string) => void;
}) {
  const [catalog, setCatalog] = useState<DecisionCandidate[]>([]);
  const [championCatalog, setChampionCatalog] = useState<DecisionCandidate[]>([]);
  const [rows, setRows] = useState<HolderEquipmentRow[]>([]);
  const [heroInputs, setHeroInputs] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setDirty(false);
    if (!catalogMode) {
      setCatalog([]);
      setChampionCatalog([]);
      setRows([]);
      setHeroInputs([]);
      return () => { cancelled = true; };
    }
    void runtime.getDecisionInputOptions({
      mode: catalogMode.id,
      backend_mode: catalogMode.backendMode,
      choice_kind: catalogMode.choiceKind || "item",
      stage_round: stageRound || undefined,
      limit: 256,
    }).then((result) => {
      if (cancelled) return;
      onRuntimeResult(result);
      if (!result.ok || !result.options) {
        setRows(equipmentRowsFromCanonical(boardNames, []));
        setHeroInputs(boardNames);
        onStatus("已穿装备目录暂时不可用，请稍后重试。");
        return;
      }
      const options = result.options as DecisionInputOptions;
      const optionGroups = Object.entries(options.options_by_group || {});
      const grouped = optionGroups
        .filter(([key]) => !/champion|chess|unit|hero/i.test(key))
        .flatMap(([, entries]) => entries) as DecisionCandidate[];
      const champions = optionGroups
        .filter(([key]) => /champion|chess|unit|hero/i.test(key))
        .flatMap(([, entries]) => entries)
        .filter((entry) => decisionEntityName(entry as DecisionCandidate)) as DecisionCandidate[];
      const allItems = [...(options.candidates || []), ...grouped]
        .filter((entry) => decisionEntityName(entry))
        .filter((entry, index, values) => values.findIndex((candidate) => (
          decisionEntityName(candidate) === decisionEntityName(entry)
          && String(candidate.ref?.id || candidate.ref?.address || "") === String(entry.ref?.id || entry.ref?.address || "")
        )) === index);
      setCatalog(allItems);
      setChampionCatalog(champions.filter((entry, index, values) => values.findIndex((candidate) => (
        decisionEntityName(candidate) === decisionEntityName(entry)
      )) === index));
      const nextRows = equipmentRowsFromCanonical(boardNames, options.current_effective_equipment?.equipped || []);
      setRows(nextRows);
      setHeroInputs(nextRows.map((row) => row.ownerUnit));
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, [boardNames.join("\u0000"), catalogMode, resetKey, runtime, stageRound]);

  const championByName = new Map(championCatalog.map((entry) => [decisionEntityName(entry), entry]));
  const heroOptions: Array<CatalogComboboxOption<string>> = Array.from(new Set([...boardNames, ...championByName.keys()])).map((name) => {
    const champion = championByName.get(name);
    return {
      key: name,
      value: name,
      label: name,
      searchTerms: champion ? decisionEntitySearchTerms(champion) : [],
      meta: boardNames.includes(name) ? "当前场上" : "英雄目录",
      metaChips: [{ key: "source", label: boardNames.includes(name) ? "场上" : "目录", tone: boardNames.includes(name) ? "info" : "neutral" }],
      data: name,
    };
  });
  const equipmentOptions: Array<CatalogComboboxOption<DecisionCandidate>> = [...catalog]
    .sort((left, right) => {
      const leftGroup = holderEquipmentGroups.findIndex((group) => group.key === holderEquipmentGroup(left));
      const rightGroup = holderEquipmentGroups.findIndex((group) => group.key === holderEquipmentGroup(right));
      return leftGroup - rightGroup || decisionEntityName(left).localeCompare(decisionEntityName(right), "zh-Hans-CN");
    })
    .map((entry) => {
      const group = holderEquipmentGroups.find((candidate) => candidate.key === holderEquipmentGroup(entry));
      const name = decisionEntityName(entry);
      return {
        key: `${entry.ref?.id || entry.ref?.address || name}:${name}`,
        value: name,
        label: name,
        searchTerms: decisionEntitySearchTerms(entry),
        meta: group?.label || "其他",
        metaChips: [{ key: "category", label: group?.label || "其他", tone: "neutral" }],
        data: entry,
      };
    });

  const updateRow = (rowIndex: number, updater: (row: HolderEquipmentRow) => HolderEquipmentRow) => {
    setRows((current) => current.map((row, index) => index === rowIndex ? updater(row) : row));
    setDirty(true);
  };

  const save = async (clearAll = false) => {
    if (!catalogMode || !hydrated || busy) return;
    const unresolved: string[] = [];
    const equipped = clearAll ? [] : rows.flatMap((row, rowIndex) => {
      const populatedSlots = row.slots.filter(Boolean);
      if (!populatedSlots.length) return [];
      const ownerInput = String(heroInputs[rowIndex] || row.ownerUnit || "").trim();
      const owner = resolveCatalogComboboxOption(ownerInput, heroOptions);
      if (!owner) {
        unresolved.push(`第 ${rowIndex + 1} 个持有者`);
        return [];
      }
      return row.slots.flatMap((entry, slotIndex) => {
        if (!entry) return [];
        const item = resolveCatalogComboboxOption(entry.name, equipmentOptions);
        if (!item) {
          unresolved.push(`${owner.label} 的装备 ${slotIndex + 1}`);
          return [];
        }
        return [{
          name: decisionEntityName(item.data),
          ref: item.data.ref || null,
          item_subtype: item.data.item_subtype || null,
          owner_unit: owner.data,
          holder_intent: entry.holder_intent || "current_holder",
          slot: slotIndex + 1,
        }];
      });
    });
    if (unresolved.length) {
      onStatus(`请选择下拉候选后再保存：${unresolved.join("、")}。`);
      return;
    }
    setBusy(true);
    const result = await runtime.submitDecisionInput({
      mode: catalogMode.id,
      backend_mode: catalogMode.backendMode,
      choice_kind: catalogMode.choiceKind || "item",
      stage_round: stageRound || undefined,
      action: "equipment_equipped_update",
      request_advice: false,
      equipment: { equipped },
      changed_sections: ["equipped"],
    });
    onRuntimeResult(result);
    if (result.ok) {
      const canonical = result.user_confirmed_equipment_update?.equipped || equipped;
      const nextRows = equipmentRowsFromCanonical(boardNames, canonical);
      setRows(nextRows);
      setHeroInputs(nextRows.map((row) => row.ownerUnit));
      setDirty(false);
      onStatus(clearAll ? "已清空本局已穿装备持有关系。" : "已保存本局已穿装备持有关系。");
    } else {
      onStatus("已穿装备保存失败，请重试。");
    }
    setBusy(false);
  };

  return (
    <section className="equipment-holder-editor" aria-label="场上棋子已穿装备">
      <div className="equipment-holder-head">
        <div>
          <strong>场上棋子装备</strong>
          <small>{hydrated ? (boardNames.length ? `${boardNames.length} 名可信场上棋子` : "场上识别缺失，可手工记录") : "正在读取本局装备"}</small>
        </div>
        <button type="button" className="icon-button" title="清空全部已穿装备" aria-label="清空全部已穿装备" disabled={!hydrated || busy || !rows.some((row) => row.slots.some(Boolean))} onClick={() => void save(true)}>
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="equipment-holder-table">
          {rows.map((row, rowIndex) => (
            <div className="equipment-holder-row" key={`${row.ownerUnit}:${rowIndex}`}>
              <div className="equipment-holder-field">
                <span className="equipment-holder-field-label">英雄</span>
                <CatalogCombobox
                  value={heroInputs[rowIndex] ?? row.ownerUnit}
                  options={heroOptions}
                  ariaLabel={`第 ${rowIndex + 1} 行英雄`}
                  disabled={busy}
                  onInput={(value) => setHeroInputs((current) => current.map((entry, index) => index === rowIndex ? value : entry))}
                  onCommit={(option) => {
                    setHeroInputs((current) => current.map((entry, index) => index === rowIndex ? option.data : entry));
                    updateRow(rowIndex, (current) => ({ ...current, ownerUnit: option.data }));
                  }}
                  onCommitInput={(value) => {
                    const ownerUnit = value.trim();
                    setHeroInputs((current) => current.map((entry, index) => index === rowIndex ? ownerUnit : entry));
                    updateRow(rowIndex, (current) => ({ ...current, ownerUnit }));
                  }}
                />
              </div>
              {row.slots.map((entry, slotIndex) => (
                <div className="equipment-holder-field" key={slotIndex}>
                  <span className="equipment-holder-field-label">装备 {slotIndex + 1}</span>
                  <div className="equipment-holder-slot">
                    <CatalogCombobox
                      value={entry?.name || ""}
                      options={equipmentOptions}
                      placeholder="选择装备"
                      ariaLabel={`${row.ownerUnit} 装备槽 ${slotIndex + 1}`}
                      disabled={busy}
                      onInput={(value) => updateRow(rowIndex, (current) => {
                        const slots = [...current.slots];
                        slots[slotIndex] = value ? { name: value, owner_unit: current.ownerUnit, slot: slotIndex + 1 } : null;
                        return { ...current, slots };
                      })}
                      onCommit={(option) => updateRow(rowIndex, (current) => {
                        const slots = [...current.slots];
                        slots[slotIndex] = {
                          name: decisionEntityName(option.data),
                          ref: option.data.ref || null,
                          item_subtype: option.data.item_subtype || null,
                          owner_unit: current.ownerUnit,
                          holder_intent: "current_holder",
                          slot: slotIndex + 1,
                        };
                        return { ...current, slots };
                      })}
                      onCommitInput={(value) => updateRow(rowIndex, (current) => {
                        const slots = [...current.slots];
                        slots[slotIndex] = value.trim() ? { name: value.trim(), owner_unit: current.ownerUnit, holder_intent: "current_holder", slot: slotIndex + 1 } : null;
                        return { ...current, slots };
                      })}
                    />
                    {entry && <button type="button" className="equipment-slot-clear" title="清空装备槽" aria-label={`清空 ${row.ownerUnit} 装备槽 ${slotIndex + 1}`} disabled={busy} onClick={() => updateRow(rowIndex, (current) => {
                      const slots = [...current.slots];
                      slots[slotIndex] = null;
                      return { ...current, slots };
                    })}><X size={13} aria-hidden="true" /></button>}
                  </div>
                </div>
              ))}
            </div>
          ))}
      </div>
      <div className="equipment-holder-actions">
        <button type="button" disabled={!hydrated || busy} onClick={() => {
          setRows((current) => [...current, { ownerUnit: "", slots: [null, null, null] }]);
          setHeroInputs((current) => [...current, ""]);
        }}><Plus size={14} aria-hidden="true" />添加持有者</button>
        <button type="button" className="equipment-holder-save" disabled={!hydrated || !dirty || busy} onClick={() => void save(false)}>
          {busy ? "保存中" : "保存已穿装备"}
        </button>
      </div>
    </section>
  );
}

function LoadoutList({ items }: { items: Loadout[] }) {
  return (
    <div className="loadout-list" aria-label="单位与装备">
      <p className="subhead">单位与装备</p>
      {items.map((entry) => (
        <div className="loadout-row" key={entry.unit}>
          <strong>{entry.unit}</strong>
          <span>{entry.items.join(" / ")}</span>
          {entry.note && <em>{entry.note}</em>}
        </div>
      ))}
    </div>
  );
}

function PinnedResult({
  activeView,
  onViewChange,
  variableOptions,
  seasonVariableFields,
  variableDraftResetKey,
  onConfirmVariables,
  manualVariables,
  lineupPlan,
  lineupStatus,
  onRequestFinalLineup,
  finalLineupRequestDisabled,
  finalLineupConfirmationLabel,
  equipmentEditor,
}: {
  activeView: PinnedView;
  onViewChange: (view: PinnedView) => void;
  variableOptions: ManualVariableOptions;
  seasonVariableFields: SeasonVariableField[];
  variableDraftResetKey: string;
  onConfirmVariables: (payload: ManualVariablesPayload) => void;
  manualVariables?: ManualVariablesPayload | null;
  lineupPlan: PinnedPlan | null;
  lineupStatus: LineupCardStatus;
  onRequestFinalLineup?: () => void;
  finalLineupRequestDisabled?: boolean;
  finalLineupConfirmationLabel?: string;
  equipmentEditor?: React.ReactNode;
}) {
  const hasSeasonVariables = seasonVariableFields.length > 0;
  const title = activeView === "lineup" ? "推荐阵容" : hasSeasonVariables ? "本局变量" : "本局目标";
  const plan = activeView === "lineup" ? lineupPlan : null;
  const displayTitle = activeView === "variables" ? title : plan?.title || title;

  return (
    <section className="pinned-card" aria-label="置顶结果">
      <div className="pinned-head">
        <div>
          <p className="section-kicker">置顶结果</p>
          <h2>{displayTitle}</h2>
        </div>
        {onRequestFinalLineup && (
          <button
            className="pinned-final-lineup-action"
            type="button"
            aria-pressed={lineupStatus === "published"}
            aria-label={finalLineupConfirmationLabel || finalLineupCardPrompt}
            title={finalLineupConfirmationLabel || finalLineupCardPrompt}
            disabled={finalLineupRequestDisabled}
            onClick={onRequestFinalLineup}
          >
            <LayoutTemplate size={14} />
            <span>{lineupStatus === "published" ? "更新最终阵容卡" : finalLineupConfirmationLabel || "确定最终阵容"}</span>
          </button>
        )}
        <div className="tab-switcher" role="tablist" aria-label="置顶结果类型">
          <button
            id="pinned-tab-lineup"
            role="tab"
            aria-controls="pinned-panel-lineup"
            aria-selected={activeView === "lineup"}
            tabIndex={activeView === "lineup" ? 0 : -1}
            className={activeView === "lineup" ? "tab-active" : ""}
            type="button"
            onKeyDown={(event) => {
              if (!["ArrowRight", "ArrowDown", "End"].includes(event.key)) return;
              event.preventDefault();
              onViewChange("variables");
              window.requestAnimationFrame(() => document.getElementById("pinned-tab-variables")?.focus());
            }}
            onClick={() => onViewChange("lineup")}
          >阵容</button>
          <button
            id="pinned-tab-variables"
            role="tab"
            aria-controls="pinned-panel-variables"
            aria-selected={activeView === "variables"}
            tabIndex={activeView === "variables" ? 0 : -1}
            className={activeView === "variables" ? "tab-active" : ""}
            type="button"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowUp", "Home"].includes(event.key)) return;
              event.preventDefault();
              onViewChange("lineup");
              window.requestAnimationFrame(() => document.getElementById("pinned-tab-lineup")?.focus());
            }}
            onClick={() => onViewChange("variables")}
          >{hasSeasonVariables ? "变量" : "目标"}</button>
        </div>
      </div>

      {activeView === "lineup" && plan && lineupStatus !== "published" && lineupStatus !== "idle" && (
        <p className="pinned-update-status" role="status">
          {lineupStatus === "pending"
            ? "正在生成新版阵容图；完成前继续保留上一张可用阵容。"
            : lineupStatus === "failed"
              ? "新版阵容图未通过发布校验；当前仍显示上一张可用阵容。"
              : "当前请求已停止；继续保留上一张可用阵容。"}
        </p>
      )}
      <div className="pinned-body">
        <div id="pinned-panel-variables" className="pinned-view" role="tabpanel" aria-labelledby="pinned-tab-variables" hidden={activeView !== "variables"}>
          <VariablePanel variableOptions={variableOptions} seasonVariableFields={seasonVariableFields} value={manualVariables} draftResetKey={variableDraftResetKey} onConfirm={onConfirmVariables} equipmentEditor={equipmentEditor} />
        </div>
        <div id="pinned-panel-lineup" className="pinned-view" role="tabpanel" aria-labelledby="pinned-tab-lineup" hidden={activeView !== "lineup"}>
          {plan ? (
            <>
              {plan.summary && <p className="lineup-summary">{plan.summary}</p>}
              <Board units={plan.units} />
              {plan.moves && plan.moves.length > 0 && (
                <div className="move-list">
                  {plan.moves.map((move) => (
                    <div key={move}>
                      <ChevronRight size={14} />
                      <span>{move}</span>
                    </div>
                  ))}
                </div>
              )}
              <LoadoutList items={plan.loadouts} />
            </>
          ) : (
            <div className="pinned-empty" data-lineup-status={lineupStatus}>
              <Shield size={18} />
              <strong>
                {lineupStatus === "pending"
                  ? "正在生成当前阵容图"
                  : lineupStatus === "failed"
                    ? "本次阵容图未发布"
                    : lineupStatus === "stale"
                      ? "上一张阵容图已过期"
                      : "还没有阵容图"}
              </strong>
              <p>
                {lineupStatus === "pending"
                  ? "正在等待宿主模型返回可发布的 4x7 站位、核心装备和下一步动作。"
                  : lineupStatus === "failed"
                    ? "后端没有发布合格的结构化阵容图；请重新发送阵容图请求。"
                    : lineupStatus === "stale"
                      ? "当前请求已停止或上下文已变化，请重新发送阵容图请求。"
                      : "教练根据大数据、目标方向和当前局势生成阵容后，会固定显示在这里。"}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ChatStream({
  messages,
  matchActive,
}: {
  messages: ChatMessage[];
  matchActive: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const stickToBottomRef = useRef(true);
  const lastCountRef = useRef(messages.length);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    stickToBottomRef.current = true;
    lastCountRef.current = messages.length;
    setUnreadCount(0);
  }, [matchActive]);

  useEffect(() => {
    const delta = messages.length - lastCountRef.current;
    lastCountRef.current = messages.length;
    if (stickToBottomRef.current) {
      endRef.current?.scrollIntoView({ block: "end" });
      if (delta > 0) setUnreadCount(0);
    } else if (delta > 0) {
      setUnreadCount((count) => count + delta);
    }
  }, [messages.length, matchActive]);

  const jumpToLatest = () => {
    stickToBottomRef.current = true;
    setUnreadCount(0);
    endRef.current?.scrollIntoView({ block: "end" });
  };

  return (
    <div className="chat-stream-wrap">
      <main
        className="chat-stream"
        aria-label="对话和建议流"
        aria-live="polite"
        aria-relevant="additions"
        ref={scrollRef}
        onScroll={() => {
          const node = scrollRef.current;
          if (!node) return;
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          stickToBottomRef.current = atBottom;
          if (atBottom) setUnreadCount(0);
        }}
      >
      {messages.map((message) => (
        <article
          className={`message ${message.role === "user" ? "user-message" : message.role === "status" ? "compact message-status" : "message-agent"}`}
          key={message.id}
        >
          {message.role !== "user" && (
            <div className="avatar">
              {message.role === "status" ? <CircleDot size={14} /> : <Bot size={15} />}
            </div>
          )}
          <div className="bubble">
            {message.role !== "user" && (
              <span className="bubble-kicker">{message.role === "status" ? "系统" : "教练"}</span>
            )}
            <p>{message.text}</p>
            {message.evidence && <p className="evidence">{message.evidence}</p>}
          </div>
        </article>
      ))}
        <div ref={endRef} aria-hidden="true" />
      </main>
      {unreadCount > 0 && (
        <button className="new-advice-jump" type="button" onClick={jumpToLatest} aria-label={`回到最新建议，${unreadCount} 条新消息`}>
          <ArrowDown size={13} />
          <span>{unreadCount} 条新消息</span>
        </button>
      )}
    </div>
  );
}

function Composer({
  modes,
  activeMode,
  dailyMode,
  itemChoiceKind,
  onItemChoiceKindChange,
  matchActive,
  isResponding,
  onSend,
  onStop,
  isTransitioning,
  structuredDecisionActive,
  dailyCoreTheoryAction,
  dailyRankingRecommendationAction,
  finalLineupConfirmationRequestKey,
  finalLineupConfirmationLabel,
  finalLineupConfirmationPrompt,
}: {
  modes: Mode[];
  activeMode: ModeId;
  dailyMode: DailyMode;
  itemChoiceKind: ItemChoiceKind;
  onItemChoiceKindChange: (kind: ItemChoiceKind) => void;
  matchActive: boolean;
  isResponding: boolean;
  onSend: (text: string, requestKind?: "host_question" | "match_fact_capture" | "hard_data_query" | "popular_recipe_query" | "daily_core_theory_query" | "ranking_recommendation_query", rankingCount?: number, modeOverride?: ModeId, requestMetadata?: { lineupConfirmationRequested?: boolean }) => void;
  onStop: () => void;
  isTransitioning: boolean;
  structuredDecisionActive: boolean;
  dailyCoreTheoryAction: RuntimeDailyCoreTheoryAction | null;
  dailyRankingRecommendationAction: RuntimeDailyRankingRecommendationAction | null;
  finalLineupConfirmationRequestKey: number;
  finalLineupConfirmationLabel: string;
  finalLineupConfirmationPrompt: string;
}) {
  const mode = useMemo(() => modes.find((item) => item.id === activeMode) ?? modes[0], [activeMode, modes]);
  const dailyPrompt = dailyMode === "wiki"
    ? "我想整理一条策略，请先复述你的理解，等我确认后再写入 Wiki。"
    : dailyMode === "review"
      ? "复盘最近一局，看看哪里能改。"
      : "聊一下当前上分思路，并且推荐 Master+ 大数据阵容，按照你的强度梯队，由高到低推荐 10 套阵容。";
  const currentPrompt = matchActive ? composerPromptForMode(mode, itemChoiceKind) : dailyPrompt;
  const usesUserReportedChoices = mode?.candidateInputPolicy === "current_match_user_report";
  const refreshReportPrompt = mode?.refreshReportPrefix?.trim() || refreshReportComposerPrompt;
  const finalLineupPrompt = finalLineupConfirmationPrompt.trim() || finalLineupCardPrompt;
  const [draft, setDraft] = useState(currentPrompt);
  const [draftRequestKind, setDraftRequestKind] = useState<"host_question" | "match_fact_capture" | "hard_data_query" | "popular_recipe_query" | "daily_core_theory_query" | "ranking_recommendation_query">("host_question");
  const [lineupConfirmationRequested, setLineupConfirmationRequested] = useState(false);
  const [rankingCount, setRankingCount] = useState(dailyRankingRecommendationAction?.defaultCount || 5);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previousPromptRef = useRef(currentPrompt);

  useEffect(() => {
    const previousPrompt = previousPromptRef.current;
    previousPromptRef.current = currentPrompt;
    setDraftRequestKind("host_question");
    setLineupConfirmationRequested(false);
    setDraft((value) => (value.trim() === "" || value === previousPrompt ? currentPrompt : value));
  }, [currentPrompt]);

  useEffect(() => {
    if (!finalLineupConfirmationRequestKey) return;
    setDraftRequestKind("host_question");
    setLineupConfirmationRequested(true);
    setDraft(finalLineupPrompt);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(finalLineupPrompt.length, finalLineupPrompt.length);
    });
  }, [finalLineupConfirmationRequestKey, finalLineupPrompt]);

  const prefillPreset = (text: string) => {
    const next = text.trim();
    if (!next || isTransitioning) return;
    setDraftRequestKind("host_question");
    setLineupConfirmationRequested(false);
    setDraft(next);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  const sendPreset = (text: string) => {
    const next = text.trim();
    if (!next || isResponding || isTransitioning) return;
    setDraft("");
    setDraftRequestKind("host_question");
    setLineupConfirmationRequested(false);
    onSend(next, "host_question");
  };

  const resetToCruiseComposer = () => {
    setDraftRequestKind("host_question");
    setLineupConfirmationRequested(false);
    setDraft(currentPrompt);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(currentPrompt.length, currentPrompt.length);
    });
  };

  const toggleActionMode = (
    requestKind: "match_fact_capture" | "hard_data_query" | "popular_recipe_query" | "daily_core_theory_query" | "ranking_recommendation_query",
    prompt: string,
  ) => {
    if (isTransitioning) return;
    if (draftRequestKind === requestKind) {
      resetToCruiseComposer();
      return;
    }
    const next = prompt.trim();
    if (!next) return;
    setLineupConfirmationRequested(false);
    setDraftRequestKind(requestKind);
    setDraft(next);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  const prefillFactCapture = () => {
    const action = mode?.factCaptureAction;
    if (!action) return;
    toggleActionMode(action.requestKind, action.prompt);
  };

  const prefillHardDataQuery = () => {
    const action = mode?.hardDataAction;
    if (!action) return;
    toggleActionMode(action.requestKind, action.prompt);
  };

  const prefillPopularRecipeQuery = () => {
    const action = mode?.popularRecipeAction;
    if (!action) return;
    toggleActionMode(action.requestKind, action.prompt);
  };

  const prefillDailyCoreTheoryQuery = () => {
    if (!dailyCoreTheoryAction) return;
    toggleActionMode(dailyCoreTheoryAction.requestKind, dailyCoreTheoryAction.prompt);
  };

  const prefillDailyRankingRecommendation = () => {
    if (!dailyRankingRecommendationAction) return;
    toggleActionMode(dailyRankingRecommendationAction.requestKind, dailyRankingRecommendationAction.prompt);
  };

  const toggleFinalLineupConfirmation = () => {
    if (isTransitioning) return;
    if (lineupConfirmationRequested) {
      resetToCruiseComposer();
      return;
    }
    setDraftRequestKind("host_question");
    setLineupConfirmationRequested(true);
    setDraft(finalLineupPrompt);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(finalLineupPrompt.length, finalLineupPrompt.length);
    });
  };

  const handleSendOrStop = () => {
    if (isTransitioning) return;
    if (isResponding) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    onSend(text, draftRequestKind, rankingCount, undefined, { lineupConfirmationRequested });
    setDraft("");
    setDraftRequestKind("host_question");
    setLineupConfirmationRequested(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!isResponding && !isTransitioning) handleSendOrStop();
  };

  return (
    <footer className={`composer ${matchActive ? "" : "composer-daily"}`}>
      <fieldset className="preset-row" disabled={isTransitioning} aria-busy={isTransitioning}>
        {!matchActive && dailyMode === "chat" && dailyCoreTheoryAction && (
          <button
            type="button"
            className={draftRequestKind === "daily_core_theory_query" ? "hard-data-query-active" : undefined}
            title={dailyCoreTheoryAction.description || undefined}
            aria-pressed={draftRequestKind === "daily_core_theory_query"}
            onClick={prefillDailyCoreTheoryQuery}
          >
            {dailyCoreTheoryAction.label}
          </button>
        )}
        {!matchActive && dailyMode === "chat" && dailyRankingRecommendationAction && (
          <>
            <button
              type="button"
              className={draftRequestKind === "ranking_recommendation_query" ? "ranking-recommendation-active" : undefined}
              title={dailyRankingRecommendationAction.description || undefined}
              aria-pressed={draftRequestKind === "ranking_recommendation_query"}
              onClick={prefillDailyRankingRecommendation}
            >
              {dailyRankingRecommendationAction.label}
            </button>
            {draftRequestKind === "ranking_recommendation_query" && (
              <label className="ranking-count-control">
                <span>数量</span>
                <input
                  type="number"
                  min={dailyRankingRecommendationAction.minCount}
                  max={dailyRankingRecommendationAction.maxCount}
                  value={rankingCount}
                  onChange={(event) => setRankingCount(Math.max(
                    dailyRankingRecommendationAction.minCount,
                    Math.min(dailyRankingRecommendationAction.maxCount, Number(event.target.value) || dailyRankingRecommendationAction.defaultCount),
                  ))}
                  aria-label="大数据推荐阵容数量"
                />
              </label>
            )}
          </>
        )}
        {matchActive && !structuredDecisionActive && (
          <>
            {activeMode === "cruise" && finalLineupConfirmationLabel && (
              <button
                type="button"
                className={lineupConfirmationRequested ? "final-lineup-confirmation-active" : undefined}
                aria-pressed={lineupConfirmationRequested}
                onClick={toggleFinalLineupConfirmation}
              >
                <LayoutTemplate size={13} />
                {finalLineupConfirmationLabel}
              </button>
            )}
            {mode?.factCaptureAction && (
              <button
                type="button"
                className={draftRequestKind === "match_fact_capture" ? "fact-capture-active" : undefined}
                title={mode.factCaptureAction.description || undefined}
                aria-pressed={draftRequestKind === "match_fact_capture"}
                onClick={prefillFactCapture}
              >
                {mode.factCaptureAction.label}
              </button>
            )}
            {mode?.hardDataAction && (
              <button
                type="button"
                className={draftRequestKind === "hard_data_query" ? "hard-data-query-active" : undefined}
                title={mode.hardDataAction.description || undefined}
                aria-pressed={draftRequestKind === "hard_data_query"}
                onClick={prefillHardDataQuery}
              >
                {mode.hardDataAction.label}
              </button>
            )}
            {usesUserReportedChoices && (
              <>
                <button
                  type="button"
                  title={mode?.primaryPresets[0]?.description || undefined}
                  onClick={() => prefillPreset(mode?.primaryPresets[0]?.prompt || currentPrompt)}
                >
                  {mode?.primaryPresets[0]?.label || "请报当前选项"}
                </button>
                <span className="preset-hint">{mode?.userReportPrompt || currentPrompt}</span>
              </>
            )}
            {activeMode === "augment" && (
              <>
                <button
                  type="button"
                  title={ownedAugmentTextPanelHint}
                  aria-label={`读取已选强化。${ownedAugmentTextPanelHint}`}
                  onClick={() => sendPreset(ownedAugmentTextPanelPreset)}
                >
                  读取已选强化</button>
                <span className="preset-hint" aria-hidden="true">{ownedAugmentTextPanelHint}</span>
              </>
            )}
            {!usesUserReportedChoices && mode?.primaryPresets.map((preset) => (
              <button
                type="button"
                key={`${mode.id}:${preset.label}`}
                title={preset.description || undefined}
                aria-label={preset.description ? `${preset.label}：${preset.description}` : preset.label}
                onClick={() => prefillPreset(preset.prompt)}
              >
                {preset.label}
              </button>
            ))}
            {mode?.popularRecipeAction && (
              <button
                type="button"
                className={draftRequestKind === "popular_recipe_query" ? "popular-recipe-query-active" : undefined}
                title={mode.popularRecipeAction.description || undefined}
                aria-pressed={draftRequestKind === "popular_recipe_query"}
                onClick={prefillPopularRecipeQuery}
              >
                {mode.popularRecipeAction.label}
              </button>
            )}
            {activeMode === "item" && (
              <div className="choice-kind-tabs" role="radiogroup" aria-label="装备锻造器类型">
                {itemChoiceKinds.map((kind) => (
                  <button
                    type="button"
                    role="radio"
                    className={itemChoiceKind === kind.id ? "selected" : ""}
                    key={kind.id}
                    aria-checked={itemChoiceKind === kind.id}
                    tabIndex={itemChoiceKind === kind.id ? 0 : -1}
                    data-item-choice-kind={kind.id}
                    onKeyDown={(event) => {
                      const currentIndex = itemChoiceKinds.findIndex((entry) => entry.id === itemChoiceKind);
                      const nextIndex = event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? itemChoiceKinds.length - 1
                          : ["ArrowRight", "ArrowDown"].includes(event.key)
                            ? (currentIndex + 1) % itemChoiceKinds.length
                            : ["ArrowLeft", "ArrowUp"].includes(event.key)
                              ? (currentIndex - 1 + itemChoiceKinds.length) % itemChoiceKinds.length
                              : -1;
                      if (nextIndex < 0) return;
                      event.preventDefault();
                      const nextKind = itemChoiceKinds[nextIndex];
                      onItemChoiceKindChange(nextKind.id);
                      prefillPreset(`${itemChoiceComposerPrompt} (${nextKind.label})`);
                      window.requestAnimationFrame(() => {
                        document.querySelector<HTMLButtonElement>(`[data-item-choice-kind="${nextKind.id}"]`)?.focus();
                      });
                    }}
                    onClick={() => onItemChoiceKindChange(kind.id)}
                  >
                    {kind.label}
                  </button>
                ))}
              </div>
            )}
            {activeMode === "item" && <span className="preset-hint">{itemChoiceComposerHint}</span>}
            {!usesUserReportedChoices && activeMode !== "augment" && !mode?.primaryPresets.length && (
              <button
                type="button"
                onClick={() => prefillPreset(mode?.prompt || currentPrompt)}
              >
                {activeMode === "item" ? "请报装备候选" : activeMode === "lineup" ? "填阵容图请求" : "使用预填"}
              </button>
            )}
            {usesUserReportedChoices && (
              <button
                type="button"
                onClick={() => {
                  prefillPreset(refreshReportPrompt);
                  window.requestAnimationFrame(() => textareaRef.current?.focus());
                }}
              >
                报刷新结果</button>
            )}
          </>
        )}
      </fieldset>
      <div className="input-shell">
        <Swords size={16} />
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={!matchActive && dailyMode === "chat" ? "继续提问，或聊聊你想玩的阵容……" : currentPrompt}
          aria-label="给教练发送消息"
          disabled={isTransitioning}
        />
        <button
          className={`send-button ${isResponding ? "stop-response" : ""}`}
          type="button"
          aria-label={isResponding ? "停止当前回答" : "发送"}
          onClick={handleSendOrStop}
          disabled={isTransitioning}
        >
          {isResponding ? <Square size={14} /> : <Send size={16} />}
        </button>
      </div>
      {isResponding && <p className="response-status">正在生成回答。点方块只停止当前回答，不停止本局，也不切换当前模式。</p>}
      {isTransitioning && <p className="response-status">正在切换模式，完成后即可发送。</p>}
    </footer>
  );
}

export function App() {
  const [runtime] = useState<RuntimeBridge>(() => getRuntimeBridge());
  const [runtimeState, setRuntimeState] = useState<RuntimeState | null>(null);
  const [previewClosed, setPreviewClosed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuSection, setMenuSection] = useState<MenuSection>("main");
  const [matchActive, setMatchActive] = useState(false);
  const [activeMode, setActiveMode] = useState<ModeId>("cruise");
  const [activeView, setActiveView] = useState<PinnedView>("lineup");
  const [pinnedPanelOpen, setPinnedPanelOpen] = useState(false);
  const [dailyMode, setDailyMode] = useState<DailyMode>("chat");
  const [itemChoiceKind, setItemChoiceKind] = useState<ItemChoiceKind>("basic_component_forge");
  const [decisionInputDrafts, setDecisionInputDrafts] = useState<DecisionInputCardDrafts>({});
  const [decisionInputStages, setDecisionInputStages] = useState<DecisionInputCardStages>({});
  const [dailyMessages, setDailyMessages] = useState<ChatMessage[]>(initialDailyMessages);
  const [matchMessages, setMatchMessages] = useState<ChatMessage[]>([]);
  const [lineupPlan, setLineupPlan] = useState<PinnedPlan | null>(null);
  const [lineupStatus, setLineupStatus] = useState<LineupCardStatus>("idle");
  const [finalLineupConfirmationRequestKey, setFinalLineupConfirmationRequestKey] = useState(0);
  const [manualVariableOptions, setManualVariableOptions] = useState<ManualVariableOptions>(emptyManualVariableOptions);
  const [seasonVariableFields, setSeasonVariableFields] = useState<SeasonVariableField[]>([]);
  const [activeSeasonId, setActiveSeasonId] = useState<string | null>(null);
  const [activeSeasonModeDefinitions, setActiveSeasonModeDefinitions] = useState<RuntimeUiModeDefinitions>({});
  const [seasonModeCapabilitiesLoaded, setSeasonModeCapabilitiesLoaded] = useState(false);
  const [confirmedManualVariables, setConfirmedManualVariables] = useState<ManualVariablesPayload | null>(null);
  const [strategyLines, setStrategyLines] = useState<string[]>(defaultStrategyLines);
  const [strategyDraft, setStrategyDraft] = useState("");
  const [editingStrategyIndex, setEditingStrategyIndex] = useState<number | null>(null);
  const [wikiStatus, setWikiStatus] = useState<StrategyWikiStatus | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const [rankingsUpdateBusy, setRankingsUpdateBusy] = useState(false);
  const rankingUpdateNoticeRef = useRef<string | null>(null);
  const rankingUpdateStartedTaskIdRef = useRef<string | null>(null);
  const [modeTransitionPending, setModeTransitionPending] = useState(false);
  const [hostModel, setHostModel] = useState("default");
  const [hostModelOptions, setHostModelOptions] = useState<ModelOption[]>([
    { value: "default", label: "跟随 CLI 默认", native: true },
  ]);
  const [hostReasoning, setHostReasoning] = useState("default");
  const [hostCandidates, setHostCandidates] = useState<HostCliAgentCandidate[]>([]);
  const [selectedHostProvider, setSelectedHostProvider] = useState("codex");
  const [hostDiscoveryStatus, setHostDiscoveryStatus] = useState("尚未扫描本机 CLI Agent。");
  // Durable preference state remains available to runtime and natural-language confirmation flows; its standalone editor is removed.
  const [rankTier, setRankTier] = useState("diamond");
  const [operationSpeed, setOperationSpeed] = useState("normal_can_pivot_next_round");
  const [defaultGoal, setDefaultGoal] = useState("balanced");
  const [diagnosticEvidenceEnabled, setDiagnosticEvidenceEnabled] = useState(false);
  const availableMatchModes = useMemo(
    () => sortMatchModesForDecisionRail(materializeMatchModes(resolveAvailableMatchModes({
      activeSeasonId,
      optionGroups: manualVariableOptions,
      seasonModeDefinitions: activeSeasonModeDefinitions,
    }))),
    [activeSeasonId, activeSeasonModeDefinitions, manualVariableOptions],
  );
  const dailyCoreTheoryAction = useMemo(() => resolveDailyCoreTheoryAction(), []);
  const dailyRankingRecommendationAction = useMemo(() => resolveDailyRankingRecommendationAction(), []);
  const liveMatchNoticeRef = useRef<string | null>(null);
  const visualStatusNoticeRef = useRef<string | null>(null);
  const runtimePollErrorNoticeRef = useRef<string | null>(null);
  const deliveredCoachResponseKeysRef = useRef<Map<string, true>>(new Map());
  const startMatchInFlightRef = useRef(false);
  const visualFollowupInFlightRef = useRef(false);
  const visualFollowupTimerRef = useRef<number | null>(null);
  const deliveryFollowupTimerRef = useRef<number | null>(null);
  const visualFollowupDeadlineRef = useRef(0);
  const deliveryExtendedNoticeRef = useRef<string | null>(null);
  const manualModeLockRef = useRef<{ mode: ModeId; until: number } | null>(null);
  const modeTransitionFenceRef = useRef(createModeTransitionFence());
  const runtimeStateRef = useRef<RuntimeState | null>(null);
  const responseGenerationRef = useRef(0);
  const activeModeRef = useRef<ModeId>(activeMode);
  const lineupExpectedTaskIdRef = useRef<string | null>(null);
  const lineupRequestInFlightRef = useRef(false);
  const confirmedVariablesSessionRef = useRef<string | null>(null);
  const decisionInputDraftSessionRef = useRef<string | null>(null);
  const runtimeReconcileHandlerRef = useRef<(request: RuntimeReconcileRequest & { sequence: number; observe: boolean }) => Promise<void>>(async () => {});
  const runtimeReconcileDrainRef = useRef<ReturnType<typeof createRuntimeReconcileDrain> | null>(null);
  if (!runtimeReconcileDrainRef.current) {
    runtimeReconcileDrainRef.current = createRuntimeReconcileDrain((request) => runtimeReconcileHandlerRef.current(request));
  }
  activeModeRef.current = activeMode;

  useEffect(() => {
    const matchSessionId = runtimeState?.match_session?.status === "active"
      ? runtimeState.match_session.match_session_id || null
      : null;
    if (decisionInputDraftSessionRef.current === matchSessionId) return;
    decisionInputDraftSessionRef.current = matchSessionId;
    setDecisionInputDrafts({});
    setDecisionInputStages({});
    deliveredCoachResponseKeysRef.current.clear();
    liveMatchNoticeRef.current = null;
    visualStatusNoticeRef.current = null;
    runtimePollErrorNoticeRef.current = null;
    manualModeLockRef.current = null;
    lineupExpectedTaskIdRef.current = null;
    lineupRequestInFlightRef.current = false;
    if (!matchSessionId) setMatchMessages([]);
  }, [runtimeState?.match_session?.match_session_id, runtimeState?.match_session?.status]);

  useEffect(() => {
    if (!seasonModeCapabilitiesLoaded) return;
    if (availableMatchModes.some((mode) => mode.id === activeMode)) return;
    activeModeRef.current = "cruise";
    setActiveMode("cruise");
    manualModeLockRef.current = null;
    if (matchActive) void runtime.setMode("cruise").then((result) => syncState(result.state));
  }, [activeMode, availableMatchModes, matchActive, runtime, seasonModeCapabilitiesLoaded]);

  const responseTaskIsUserCancellable = (task?: RuntimeState["response_task"] | null) => {
    if (!task) return false;
    return [
      "preparing",
      "running",
      "response_pending",
      "ai_native_requested",
      "cancelling",
      "awaiting_host_cli_agent_response",
      "awaiting_host_cli_agent_visual_response",
    ].includes(task.status || "");
  };

  const status = stateText(runtimeState);
  const composerIsResponding = isResponding || responseTaskIsUserCancellable(runtimeState?.response_task);
  const visibleMessages = matchActive ? matchMessages : dailyMessages;
  const pinnedPanelVisible = pinnedPanelShouldBeVisible({
    explicitlyOpen: pinnedPanelOpen,
    lineupPlan,
    lineupStatus,
    activeMode,
  });
  const suppressStructuredMissingChoicePrompts = true;
  const activeMatchModeDescriptor = availableMatchModes.find((mode) => mode.id === activeMode) || null;
  const lineupModeDescriptor = availableMatchModes.find((mode) => mode.id === "lineup") || null;
  const finalLineupConfirmationAction = lineupModeDescriptor?.finalConfirmationAction || null;
  const structuredDecisionMode = matchActive
    && Boolean(activeMatchModeDescriptor?.manualChoice && activeMatchModeDescriptor.cardType);
  const trustedBoardNames = useMemo(() => Array.from(new Set(
    (runtimeState?.resolved_decision_snapshot?.live_state_summary?.own_board?.units || [])
      .map((unit) => String(unit.name || unit.champion_name || "").trim())
      .filter(Boolean),
  )), [runtimeState?.resolved_decision_snapshot?.live_state_summary?.own_board?.units]);
  const equipmentCatalogMode = availableMatchModes.find((mode) => mode.id === "item" && mode.manualChoice) || null;
  const trustedStageRound = String(
    runtimeState?.resolved_decision_snapshot?.live_state_summary?.phase?.stage_round || "",
  );

  const appendMessageToStream = (stream: RuntimeDeliveryStream, message: Omit<ChatMessage, "id">) => {
    const next = { id: messageId(), ...message };
    if (stream === "match") {
      setMatchMessages((value) => [...value.slice(-(MAX_RENDERER_MESSAGES_PER_STREAM - 1)), next]);
    } else {
      setDailyMessages((value) => [...value.slice(-(MAX_RENDERER_MESSAGES_PER_STREAM - 1)), next]);
    }
  };

  const addMessage = (message: Omit<ChatMessage, "id">) => {
    appendMessageToStream(matchActive ? "match" : "daily", message);
  };

  const addDedupedStatus = (
    key: string,
    text: string,
    group: "visual" | "live" | "poll" = "visual",
    stream?: RuntimeDeliveryStream,
  ) => {
    const ref = group === "live"
      ? liveMatchNoticeRef
      : group === "poll"
        ? runtimePollErrorNoticeRef
        : visualStatusNoticeRef;
    if (ref.current === key) return;
    ref.current = key;
    if (stream) appendMessageToStream(stream, { role: "status", text });
    else addMessage({ role: "status", text });
  };

  const isRecoverableRuntimePollError = (message?: string | null) => {
    if (!message) return true;
    return message.includes("No pending advice_response_requested")
      || message.includes("request_id does not match")
      || message.includes("waiting")
      || message.includes("pending")
      || message.includes("host_visual_request_stale_timeout");
  };

  const userVisibleHostFailureText = (message?: string | null, diagnostics?: HostDiagnostics | null) => {
    return userVisibleHostCliFailureText(message, diagnostics);
  };

  const addHostFailureStatus = (
    message?: string | null,
    stream?: RuntimeDeliveryStream,
    diagnostics?: HostDiagnostics | null,
    responseTask?: RuntimeState["response_task"] | null,
  ) => {
    const task = responseTask || runtimeStateRef.current?.response_task || null;
    if (task?.origin === "runtime_event" && task.structured_card_action !== true) return false;
    const text = userVisibleHostFailureText(message, diagnostics);
    const key = `host-failure:${task?.response_task_id || "no-task"}:${task?.revision ?? "no-revision"}:${message || text}`;
    if (rememberBoundedDeliveryKey(deliveredCoachResponseKeysRef.current, key)) return false;
    if (stream) appendMessageToStream(stream, { role: "status", text });
    else addMessage({ role: "status", text });
    return true;
  };

  const isRuntimeManualChoiceFallback = (response?: CoachResponse | null) =>
    response?.generated_by === "jcc_runtime_manual_choice_status_fallback"
    || response?.generated_by === "jcc_runtime_manual_choice_host_fallback"
    || response?.schema === "jcc-runtime-manual-choice-fallback-status-v1";

  const emitRuntimeFallbackStatus = (response?: CoachResponse | null, stream?: RuntimeDeliveryStream) => {
    if (!isRuntimeManualChoiceFallback(response) || !response?.final_text) return false;
    const responseKey = [
      response.request_id ?? "",
      response.request_hash ?? "",
      response.generated_by ?? "",
      response.final_text,
    ].join("|");
    if (rememberBoundedDeliveryKey(deliveredCoachResponseKeysRef.current, `runtime-fallback:${responseKey}`)) return true;
    const message = {
      role: "status",
      text: response.final_text,
      evidence: response.confidence ? `OCR 兜底 · ${response.confidence}` : undefined,
    } satisfies Omit<ChatMessage, "id">;
    if (stream) appendMessageToStream(stream, message);
    else addMessage(message);
    return true;
  };

  const applyPinnedResult = (response?: CoachResponse, stream?: RuntimeDeliveryStream) => {
    const normalizedBackendResponse = response?.schema === "jcc-host-cli-coach-response-v1";
    const plan = normalizedBackendResponse ? pinnedPlanFromResponse(response?.pinned_result) : null;
    if (!plan) {
      if (uiModeFromBackendMode(response?.mode, availableMatchModes) === "lineup") {
        setLineupStatus("failed");
        setPinnedPanelOpen(true);
        lineupExpectedTaskIdRef.current = null;
        lineupRequestInFlightRef.current = false;
        if (activeModeRef.current === "lineup") setActiveView("lineup");
        addDedupedStatus(
          `lineup-card-missing:${response?.request_id || response?.request_hash || response?.final_text || ""}`,
          "阵容图未更新：本次返回的结构化阵容卡不完整，我不会沿用旧卡片；请按文字建议操作，或再发一次阵容图请求。",
          "poll",
          stream,
        );
      }
      return;
    }
    setLineupPlan(plan);
    setLineupStatus("published");
    setPinnedPanelOpen(true);
    lineupExpectedTaskIdRef.current = null;
    lineupRequestInFlightRef.current = false;
    if (activeModeRef.current === "lineup") setActiveView("lineup");
  };

  const lineupGuardDecisionForResponse = (
    response?: CoachResponse,
    task?: RuntimeState["response_task"] | null,
    source: "direct" | "canonical" = "canonical",
  ) => {
    return lineupDeliveryGuardDecision({
      response,
      task,
      expectedTaskId: lineupExpectedTaskIdRef.current,
      lineupRequestInFlight: lineupRequestInFlightRef.current,
      source,
    });
  };

  const responseMatchesManualLock = (response?: CoachResponse) => {
    const lock = manualModeLockRef.current;
    if (!lock || Date.now() >= lock.until) return true;
    if (!response?.mode) return true;
    const responseMode = uiModeFromBackendMode(response.mode, availableMatchModes);
    return responseMode === lock.mode;
  };

  const emitCoachResponse = (
    response?: CoachResponse,
    options: {
      respectManualLock?: boolean;
      stream?: RuntimeDeliveryStream;
      task?: RuntimeState["response_task"] | null;
    } = {},
  ) => {
    const deliveryText = response?.delivery_text || response?.final_text;
    if (!deliveryText) return false;
    if (options.respectManualLock && !responseMatchesManualLock(response)) return false;
    if (lineupGuardDecisionForResponse(response, options.task, "direct") !== "deliver") return false;
    const responseKey = [
      response.request_id ?? "",
      response.request_hash ?? "",
      response.mode ?? "",
      deliveryText,
    ].join("|");
    if (rememberBoundedDeliveryKey(deliveredCoachResponseKeysRef.current, `coach:${responseKey}`)) return true;
    applyPinnedResult(response, options.stream);
    const message = {
      role: "agent",
      text: deliveryText,
      evidence: response.confidence ? `置信度：${response.confidence}` : undefined,
    } satisfies Omit<ChatMessage, "id">;
    if (options.stream) appendMessageToStream(options.stream, message);
    else addMessage(message);
    return true;
  };

  const ackRenderedResponseTask = async (responseTask?: RuntimeState["response_task"] | null, reason = "ui_rendered_response") => {
    const responseTaskId = responseTask?.response_task_id ?? null;
    const responseTaskRevision = responseTask?.revision;
    if (!responseTaskId || !Number.isInteger(responseTaskRevision)) return;
    const result = await runtime.ackDeliveredResponse({
      response_task_id: responseTaskId,
      response_task_revision: responseTaskRevision,
      reason,
    });
    syncState(result.state);
    if (!result.ok) {
      addDedupedStatus(
        `response-ack-failed:${responseTaskId}:${result.status || result.error || ""}`,
        userVisibleHostFailureText(result.error || result.status),
        "poll",
      );
    }
  };

  const responseTaskFromResult = (result: RuntimeResult<{ response_task?: RuntimeState["response_task"] }>) =>
    result.response_task ?? result.state?.response_task ?? null;

  const emitFastChoiceHint = (hint?: {
    hint_id?: string;
    final_text?: string;
    confidence?: string;
    user_visible?: number | boolean;
    answer_layer?: string;
    mode?: string;
  } | null) => {
    if (!hint?.final_text) return false;
    if (hint.user_visible === 0 || hint.user_visible === false) return false;
    if (
      hint.answer_layer === "deterministic_scorer_evidence_not_user_visible"
      || hint.answer_layer === "rapidocr_observation_not_user_visible"
      || hint.answer_layer === "deterministic_fast_hint_not_ai_native"
    ) return false;
    const hintMode = uiModeFromBackendMode(hint.mode, availableMatchModes);
    if (hintMode && isManualMatchMode(activeMode) && hintMode === activeMode) return false;
    const key = hint.hint_id || hint.final_text;
    if (rememberBoundedDeliveryKey(deliveredCoachResponseKeysRef.current, `fast:${key}`)) return true;
    addMessage({
      role: "status",
      text: hint.final_text,
      evidence: hint.confidence ? `快速识别：${hint.confidence}` : undefined,
    });
    return true;
  };

  function shouldWaitForAiNativeAfterFastChoice(result: RuntimeResult) {
    const task = result.state?.response_task;
    const hint = result.fast_choice_hint
      ?? result.state?.visual_request_status?.fast_choice_hint
      ?? task?.fast_choice_hint
      ?? null;
    const mode = uiModeFromBackendMode(task?.mode ?? hint?.mode ?? result.state?.visual_request_status?.mode, availableMatchModes);
    const hiddenEvidence =
      hint?.user_visible === 0
      || hint?.user_visible === false
      || hint?.answer_layer === "deterministic_scorer_evidence_not_user_visible"
      || hint?.answer_layer === "rapidocr_observation_not_user_visible"
      || hint?.answer_layer === "deterministic_fast_hint_not_ai_native";
    const responseStatus = task?.status ?? result.state?.visual_request_status?.status;
    const hostResponsePending =
      responseStatus === "awaiting_host_cli_agent_response"
      || responseStatus === "running"
      || responseStatus === "response_pending"
      || responseStatus === "fast_choice_text_ready"
      || responseStatus === "ai_native_requested";
    return Boolean((hiddenEvidence || (mode !== null && isManualMatchMode(mode))) && hostResponsePending);
  }

  function fastChoiceHintIsVisible(hint?: {
    final_text?: string | null;
    user_visible?: number | boolean;
    answer_layer?: string;
  } | null) {
    if (!hint?.final_text) return false;
    if (hint.user_visible === 0 || hint.user_visible === false) return false;
    if (
      hint.answer_layer === "deterministic_scorer_evidence_not_user_visible"
      || hint.answer_layer === "rapidocr_observation_not_user_visible"
      || hint.answer_layer === "deterministic_fast_hint_not_ai_native"
    ) return false;
    return true;
  }

  function hasVisibleFastChoiceTerminalState(state?: RuntimeState) {
    const status = state?.visual_request_status?.status;
    const visualHint = state?.visual_request_status?.fast_choice_hint;
    const taskHint = state?.response_task?.fast_choice_hint;
    return status === "fast_hint_delivered"
      || (status === "fast_choice_text_ready" && fastChoiceHintIsVisible(visualHint))
      || (status === "superseded_by_fast_choice_text" && fastChoiceHintIsVisible(visualHint || taskHint))
      || fastChoiceHintIsVisible(taskHint);
  }

  function isManualChoiceAwaitingAiNative(result: RuntimeResult) {
    if (result.status !== "awaiting_host_cli_agent_response") return false;
    const task = result.state?.response_task;
    if (!task) return false;
    const mode = uiModeFromBackendMode(task?.mode, availableMatchModes);
    return mode !== null
      && isManualMatchMode(mode)
      && task.expiry_policy === "user_question_must_return_even_if_window_passed";
  }

  function hasManualChoiceAiNativeTask(state?: RuntimeState) {
    const task = state?.response_task;
    if (!task) return false;
    const mode = uiModeFromBackendMode(task?.mode, availableMatchModes);
    return mode !== null
      && isManualMatchMode(mode)
      && task.expiry_policy === "user_question_must_return_even_if_window_passed"
      && (
        task.status === "awaiting_host_cli_agent_response"
        || task.status === "running"
        || task.status === "response_pending"
        || task.status === "fast_choice_text_ready"
        || task.status === "ai_native_requested"
      );
  }

  function hasAutomaticHostResponseTask(state?: RuntimeState | null) {
    return ["runtime_event", "auto_cruise"].includes(state?.response_task?.origin || "");
  }

  function shouldSuppressChoiceFollowupNoise(result: RuntimeResult) {
    const lock = manualModeLockRef.current;
    const lockActive = lock && Date.now() < lock.until && lock.mode !== "cruise";
    return shouldWaitForAiNativeAfterFastChoice(result)
      || hasManualChoiceAiNativeTask(result.state)
      || Boolean(lockActive && isRecoverableRuntimePollError(result.error))
      || (
        Boolean(result.state)
        && hasVisibleFastChoiceTerminalState(result.state)
        && isManualMatchMode(activeMode)
      );
  }

  const clearVisualFollowup = () => {
    if (visualFollowupTimerRef.current !== null) {
      window.clearTimeout(visualFollowupTimerRef.current);
      visualFollowupTimerRef.current = null;
    }
    if (deliveryFollowupTimerRef.current !== null) {
      window.clearTimeout(deliveryFollowupTimerRef.current);
      deliveryFollowupTimerRef.current = null;
    }
    visualFollowupDeadlineRef.current = 0;
    deliveryExtendedNoticeRef.current = null;
  };

  const endManualChoiceFollowup = () => {
    clearVisualFollowup();
    manualModeLockRef.current = null;
  };

  const requestRuntimeReconcile = (request: RuntimeReconcileRequest) => {
    runtimeReconcileDrainRef.current?.request(request);
  };

  const scheduleVisualFollowup = (reason: string, delayMs = 1200) => {
    if (visualFollowupTimerRef.current !== null) return;
    if (!visualFollowupDeadlineRef.current) visualFollowupDeadlineRef.current = Date.now() + 120000;
    if (Date.now() > visualFollowupDeadlineRef.current) {
      const lock = manualModeLockRef.current;
      const currentRuntimeState = runtimeStateRef.current || runtimeState || undefined;
      clearVisualFollowup();
      addMessage({
        role: "status",
        text: (lock && lock.mode !== "cruise") || hasManualChoiceAiNativeTask(currentRuntimeState)
          ? "宿主 CLI Agent 回答仍未返回；本次手动问题会保留在本局记录里，不再误报成视觉识别超时。"
          : "视觉/建议请求等待超时；请确认选择窗口还在画面里后重试当前模式。",
      });
      return;
    }
    visualFollowupTimerRef.current = window.setTimeout(() => {
      visualFollowupTimerRef.current = null;
      void pollCruiseOnce(reason);
    }, delayMs);
  };

  const scheduleDeliveryFollowup = (reason: string, delayMs = 1200) => {
    if (deliveryFollowupTimerRef.current !== null) return;
    if (!visualFollowupDeadlineRef.current) {
      const task = runtimeStateRef.current?.response_task;
      visualFollowupDeadlineRef.current = Date.now() + (task?.mode === "lineup_card" ? 300000 : 120000);
    }
    if (Date.now() > visualFollowupDeadlineRef.current) {
      const task = runtimeStateRef.current?.response_task;
      if (task && (
        task.status === "awaiting_host_cli_agent_response"
        || task.status === "awaiting_host_cli_agent_visual_response"
        || task.status === "preparing"
        || task.status === "running"
        || task.status === "response_pending"
        || task.status === "ai_native_requested"
      )) {
        if (hasAutomaticHostResponseTask(runtimeStateRef.current)) {
          deliveryFollowupTimerRef.current = window.setTimeout(() => {
            deliveryFollowupTimerRef.current = null;
            void deliverReadyResponseOnce(`${reason}:automatic-quiet-wait`);
          }, Math.max(delayMs, 5000));
          return;
        }
        const noticeKey = `${task.response_task_id || "response-task"}:${task.status}`;
        if (deliveryExtendedNoticeRef.current !== noticeKey) {
          deliveryExtendedNoticeRef.current = noticeKey;
          addMessage({
            role: "status",
            text: "宿主 CLI Agent 回答仍未返回；我会降低频率继续等这次回答，不会重复发起新的建议任务。",
          });
        }
        deliveryFollowupTimerRef.current = window.setTimeout(() => {
          deliveryFollowupTimerRef.current = null;
          void deliverReadyResponseOnce(`${reason}:extended`);
        }, Math.max(delayMs, 5000));
        return;
      }
      clearVisualFollowup();
      return;
    }
    deliveryFollowupTimerRef.current = window.setTimeout(() => {
      deliveryFollowupTimerRef.current = null;
      void deliverReadyResponseOnce(reason);
    }, delayMs);
  };

  const deliverReadyResponseOnce = async (reason = "delivery continuation") => {
    requestRuntimeReconcile({ reason, observe: false });
    await runtimeReconcileDrainRef.current?.whenIdle();
  };

  const pollCruiseOnce = async (reason = "visual continuation") => {
    if (visualFollowupInFlightRef.current) return;
    visualFollowupInFlightRef.current = true;
    try {
      const result = await runtime.pollCruiseAdvice();
      syncState(result.state);
      const matchSessionId = result.state?.match_session?.match_session_id ?? null;
      if (result.ok && shouldWaitForAiNativeAfterFastChoice(result)) {
        scheduleDeliveryFollowup("hidden fast choice evidence AI-native continuation", 1200);
        return;
      }
      if (result.ok && result.status === "fast_choice_hint_returned" && emitFastChoiceHint(result.fast_choice_hint)) {
        scheduleVisualFollowup("fast choice AI-native explanation continuation", 1200);
        return;
      }
      if (result.ok && result.status === "completed") {
        scheduleDeliveryFollowup("poll cruise completed response canonical delivery", 0);
        return;
      }
      if (result.ok && result.status === "response_ready") {
        scheduleDeliveryFollowup("poll cruise response delivery", 200);
        return;
      }
      if (result.ok && result.status === "awaiting_host_cli_agent_visual_response") {
        if (hasVisibleFastChoiceTerminalState(result.state)) {
          scheduleVisualFollowup("fast choice AI-native explanation continuation", 1200);
          return;
        }
        const requestId = result.state?.visual_request_status?.request_id ?? result.phase_trigger?.visual_request_id ?? "pending";
        const noticeKey = `awaiting-visual:${requestId}`;
        if (visualStatusNoticeRef.current !== noticeKey) {
          visualStatusNoticeRef.current = noticeKey;
          addMessage({
            role: "status",
            text: "视觉采集已完成，正在等待宿主 CLI Agent 回答。",
          });
        }
        scheduleVisualFollowup(reason, 1200);
      } else if (result.ok && result.status === "visual_completed_without_choice_set") {
        clearVisualFollowup();
        addMessage({
          role: "status",
          text: "视觉识别已完成，但没有拿到可用的三选一候选。请确认选择窗口还在画面里，再重试当前模式。",
        });
      } else if (result.ok && result.status === "awaiting_host_cli_agent_response") {
        if (isManualChoiceAwaitingAiNative(result)) {
          scheduleDeliveryFollowup("manual choice AI-native response continuation", 1200);
          return;
        }
        if (hasAutomaticHostResponseTask(result.state)) {
          scheduleDeliveryFollowup("automatic cruise response continuation", 5000);
          return;
        }
        addMessage({
          role: "status",
          text: "视觉识别已完成，正在等待宿主 CLI 主模型生成建议。",
        });
        scheduleVisualFollowup(reason, 1200);
      } else if (result.ok && result.status === "response_running") {
        scheduleVisualFollowup(reason, 1200);
      } else if (result.ok && result.status === "response_pending") {
        scheduleVisualFollowup(reason, 1200);
      } else if (result.ok && result.status === "manual_choice_user_response_in_flight") {
        scheduleDeliveryFollowup("manual choice AI-native response continuation", 1200);
      } else if (!result.ok && result.status === "response_failed") {
        endManualChoiceFollowup();
        if (!emitRuntimeFallbackStatus(result.fallback_response || undefined)) {
          emitCoachResponse(result.fallback_response || undefined, { respectManualLock: false });
        }
        addHostFailureStatus(
          result.error,
          undefined,
          result.response_task?.host_diagnostics ?? result.state?.response_task?.host_diagnostics,
          result.response_task || result.state?.response_task,
        );
        await ackRenderedResponseTask(result.response_task, "poll_cruise_failed_response_rendered");
      } else if (result.ok && result.status === "waiting_for_current_match_live_state") {
        const rejected = result.rejected_base_match_session_id || result.state?.match_connection?.rejected_live_state_match_session_id || "old-match";
        const noticeKey = `waiting-current-live-state:${matchSessionId}:${rejected}`;
        if (liveMatchNoticeRef.current !== noticeKey) {
          liveMatchNoticeRef.current = noticeKey;
          addMessage({
            role: "status",
          text: `已忽略上一局的旧状态（${rejected}）；正在等待当前对局数据。`,
          });
        }
      } else if (!result.ok) {
        if (shouldSuppressChoiceFollowupNoise(result)) {
          scheduleDeliveryFollowup("manual choice AI-native response continuation", 1200);
          return;
        }
        endManualChoiceFollowup();
        const error = result.error ?? `${reason} failed.`;
        if (isRecoverableRuntimePollError(error)) {
          addDedupedStatus(`manual-followup-recoverable:${error}`, "当前追问暂时没有新结果；我会继续等待本次回答。", "poll");
        } else {
          addHostFailureStatus(
            error,
            undefined,
            result.response_task?.host_diagnostics ?? result.state?.response_task?.host_diagnostics,
            result.response_task || result.state?.response_task,
          );
        }
      }
    } finally {
      visualFollowupInFlightRef.current = false;
    }
  };

  const syncState = (state?: RuntimeState) => {
    if (!state) return;
    runtimeStateRef.current = state;
    setRuntimeState(state);
    const matchUiReady = state.match_session?.status === "active"
      && state.match_session?.ui_ready !== false;
    setMatchActive(matchUiReady);
    if (matchUiReady) {
      const nextMode = uiModeFromBackendMode(state.active_mode, availableMatchModes);
      const lock = manualModeLockRef.current;
      const lockActive = lock && Date.now() < lock.until;
      if (nextMode && (
        nextMode === "cruise"
        || !(lockActive && lock.mode !== "cruise" && nextMode !== lock.mode)
      )) {
        if (nextMode === "cruise") manualModeLockRef.current = null;
        activeModeRef.current = nextMode;
        setActiveMode(nextMode);
      }
    }
    if (state.user_preferences?.rank_tier) setRankTier(state.user_preferences.rank_tier);
    if (state.user_preferences?.operation_speed) setOperationSpeed(state.user_preferences.operation_speed);
    if (state.user_preferences?.default_goal) setDefaultGoal(state.user_preferences.default_goal);
    setDiagnosticEvidenceEnabled(state.runtime_settings?.diagnostic_evidence_enabled === true);
    const variablesMatchCurrentSession =
      !state.manual_match_variables?.match_session_id ||
      state.manual_match_variables.match_session_id === state.match_session?.match_session_id;
    const variables = variablesMatchCurrentSession
      ? manualVariablesFromRuntime(state.manual_match_variables, seasonVariableFields)
      : null;
    if (variables) {
      setConfirmedManualVariables(variables);
      confirmedVariablesSessionRef.current = state.match_session?.match_session_id || null;
    } else if (
      state.match_session?.status === "active"
      && confirmedVariablesSessionRef.current
      && confirmedVariablesSessionRef.current !== state.match_session?.match_session_id
    ) {
      setConfirmedManualVariables(null);
      confirmedVariablesSessionRef.current = null;
    }
  };

  const handleObservedRuntimeResult = async (
    result: Awaited<ReturnType<RuntimeBridge["observeRuntimeTick"]>>,
  ) => {
    if (startMatchInFlightRef.current) return;
    const matchSessionId = result.state?.match_session?.match_session_id ?? null;
    if (result.ok && (
      result.status === "awaiting_host_cli_agent_response"
      || result.status === "response_running"
      || result.status === "response_pending"
    )) {
      scheduleDeliveryFollowup("runtime observation response continuation", 1200);
    }
    if (
      result.ok
      && result.status === "missing_choice_confirmation_prompt"
      && result.prompt?.prompt
      && missingChoicePromptIsAvailable(result.prompt, availableMatchModes)
    ) {
      if (!suppressStructuredMissingChoicePrompts) {
        const promptKey = `missing-choice:${result.prompt.key}`;
        if (visualStatusNoticeRef.current !== promptKey) {
          visualStatusNoticeRef.current = promptKey;
          appendMessageToStream("match", { role: "status", text: result.prompt.prompt });
        }
      }
    }
    if (
      result.state?.match_connection?.status === "connected_to_live_match"
      && matchSessionId
      && liveMatchNoticeRef.current !== matchSessionId
    ) {
      liveMatchNoticeRef.current = matchSessionId;
      appendMessageToStream("match", {
        role: "status",
        text: "已接入这把游戏，进入事件巡航；后续按阶段、经济、血量和关键选择变化触发建议。",
      });
    }
    if (result.ok && result.status === "no_live_state") {
      const watcherStatus = result.state?.watcher?.status ?? "unknown";
      const noticeKey = `no-live-state:${matchSessionId}:${watcherStatus}`;
      if (liveMatchNoticeRef.current !== noticeKey) {
        liveMatchNoticeRef.current = noticeKey;
        appendMessageToStream("match", {
          role: "status",
            text: watcherStatus === "running"
              ? "实时监听已启动，但还没收到这局的游戏状态；我会继续监听。"
              : `实时监听还没拿到游戏状态，当前状态：${watcherStatus}。`,
        });
      }
    }
    if (!result.ok && !["response_failed", "response_failed_ready"].includes(result.status || "")) {
      const error = result.error ?? "巡航观察失败。";
      if (isRecoverableRuntimePollError(error)) {
        addDedupedStatus(`auto-observe-recoverable:${error}`, "巡航观察暂时失败；我会继续监听，不会重复请求模型。", "poll", "match");
      } else {
        addDedupedStatus(`auto-observe-error:${error}`, userVisibleHostFailureText(error), "poll", "match");
      }
    }
  };

  runtimeReconcileHandlerRef.current = async (request) => {
    if (startMatchInFlightRef.current) return;
    try {
      await reconcileCanonicalRuntimeDelivery({
        runtime,
        reason: request.reason,
        observe: request.observe && runtimeStateRef.current?.match_session?.status === "active"
          && runtimeStateRef.current?.match_session?.ui_ready !== false,
        onState: syncState,
        onObserved: handleObservedRuntimeResult,
        onDelivery: ({ stream, response, fallbackResponse, task, result }) => {
          if (startMatchInFlightRef.current) return false;
          const lineupGuardDecision = lineupGuardDecisionForResponse(response || fallbackResponse || undefined, task, "canonical");
          if (lineupGuardDecision === "defer_without_ack") {
            scheduleDeliveryFollowup("lineup card waiting for expected task id", 500);
            return false;
          }
          if (lineupGuardDecision === "suppress_and_ack") {
            return true;
          }
          if (result.status === "completed") {
            const rendered = emitCoachResponse(response || undefined, {
              respectManualLock: false,
              stream,
              task,
            });
            if (!rendered) {
              if (uiModeFromBackendMode(task?.mode, availableMatchModes) === "lineup") {
                setLineupStatus("failed");
                setPinnedPanelOpen(true);
                lineupExpectedTaskIdRef.current = null;
                lineupRequestInFlightRef.current = false;
              }
              appendMessageToStream(stream, {
                role: "status",
                text: "宿主 CLI Agent 已完成，但没有返回可展示的最终回答。",
              });
            }
            if (rendered && dailyDeliveryNeedsActiveMatchNotice({ stream, state: result.state || runtimeStateRef.current })) {
              addDedupedStatus(
                `daily-response-ready-during-match:${task?.response_task_id || response?.request_id || response?.request_hash || response?.final_text || ""}`,
                "日常回答已完成并保留在日常聊天；当前正在对局，我已在这里提醒你，结束对局或回到日常视图后可查看完整内容。",
                "poll",
                "match",
              );
            }
            if (manualChoiceBackendMode(task?.mode, availableMatchModes)) endManualChoiceFollowup();
            return true;
          }
          if (result.status === "response_failed") {
            if (uiModeFromBackendMode(task?.mode, availableMatchModes) === "lineup") {
              setLineupStatus("failed");
              setPinnedPanelOpen(true);
              lineupExpectedTaskIdRef.current = null;
              lineupRequestInFlightRef.current = false;
            }
            endManualChoiceFollowup();
            const fallbackRendered = emitRuntimeFallbackStatus(fallbackResponse || undefined, stream)
              || emitCoachResponse(fallbackResponse || undefined, {
                respectManualLock: false,
                stream,
                task,
              });
            if (!fallbackRendered) addHostFailureStatus(
              result.error,
              stream,
              task?.host_diagnostics ?? result.response_task?.host_diagnostics,
              task || result.response_task,
            );
            return true;
          }
          return false;
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addDedupedStatus(
        `runtime-reconcile-failed:${message}`,
        userVisibleRuntimeErrorText(message, "Runtime 状态同步失败；我会在下一次事件或 watchdog 重试。"),
        "poll",
        runtimeStateRef.current?.match_session?.status === "active" ? "match" : "daily",
      );
    }
  };

  useEffect(() => {
    if (!runtime.onRuntimeEvent) return;
    let cancelled = false;
    const unsubscribe = runtime.onRuntimeEvent((event) => {
      if (cancelled) return;
      if (!["response_task_changed", "watcher_observation", "daemon_reconnected", "self_state_refresh_changed", "hud_facts_changed", "rankings_status_changed", "ranking_update_task_changed"].includes(event?.type || "")) return;
      const eventSequence = event?.type === "daemon_reconnected"
        ? null
        : Number(event?.sequence ?? event?.event_id);
      requestRuntimeReconcile({
        sequence: Number.isInteger(eventSequence) && Number(eventSequence) > 0 ? Number(eventSequence) : null,
        observe: event?.type === "watcher_observation",
        reason: `runtime event ${event?.type || "unknown"}`,
      });
    });
    requestRuntimeReconcile({ reason: "renderer mounted canonical reconcile", observe: false });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [runtime]);

  useEffect(() => {
    const task = runtimeState?.ranking_update_task;
    if (!task?.task_id || !task.terminal) return;
    if (rankingUpdateStartedTaskIdRef.current !== task.task_id) return;
    const noticeKey = `${task.task_id}:${task.status}:${task.result_status || ""}`;
    if (rankingUpdateNoticeRef.current === noticeKey) return;
    rankingUpdateNoticeRef.current = noticeKey;
    if (task.status === "succeeded") {
      addMessage({ role: "status", text: "掌盟大师以上今日数据更新完成。" });
    } else if (task.status === "retryable") {
      addMessage({ role: "status", text: "今日数据已抓取，但语义维护或发布仍可重试；当前继续使用上一份 Active 数据。再次点击会继续处理。" });
    } else if (task.status === "failed") {
      addMessage({
        role: "status",
        text: userVisibleRuntimeErrorText(task.error, "今日数据更新失败，可重试。"),
      });
    }
  }, [runtimeState?.ranking_update_task?.task_id, runtimeState?.ranking_update_task?.status, runtimeState?.ranking_update_task?.terminal, runtimeState?.ranking_update_task?.result_status, runtimeState?.ranking_update_task?.error]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      requestRuntimeReconcile({
        reason: "30-second canonical reconciliation watchdog",
        observe: runtimeStateRef.current?.match_session?.status === "active"
          && runtimeStateRef.current?.match_session?.ui_ready !== false,
      });
    };
    const timer = window.setInterval(tick, 30000);
    const initialTimer = window.setTimeout(tick, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(initialTimer);
    };
  }, [runtime]);

  const handleHostModelChange = (value: string) => {
    setHostModel(value);
    const allowed = new Set(reasoningEffortOptionsForSelectedModel(value, hostModelOptions).map((option) => option.value));
    if (!allowed.has(hostReasoning)) setHostReasoning("default");
  };

  const handleSelectedHostProviderChange = (value: string, candidates = hostCandidates) => {
    setSelectedHostProvider(value);
    const selected = candidates.find((agent) => agent.provider === value);
    const options = selected?.model_options?.length
      ? selected.model_options
      : value === "codex"
        ? [
            { value: "default", label: "跟随 CLI 默认", native: true },
          ]
        : [{ value: "default", label: "跟随 CLI 默认", native: true }];
    setHostModelOptions(options);
    if (!options.some((option) => option.value === hostModel)) setHostModel("default");
    const selectedModel = options.find((option) => option.value === hostModel);
    const allowedReasoning = new Set(["default", ...(selectedModel?.supported_reasoning_levels || [])]);
    if (!allowedReasoning.has(hostReasoning)) setHostReasoning("default");
  };

  const handleDiscoverHostCliAgents = async () => {
    setHostDiscoveryStatus("正在扫描本机 CLI Agent...");
    addMessage({ role: "status", text: "正在扫描本机 CLI Agent..." });
    const result = await runtime.discoverHostCliAgents({ model: hostModel, reasoning_effort: hostReasoning });
    syncState(result.state);
    const agents = result.agents ?? result.discovery?.agents ?? [];
    setHostCandidates(agents);
    const preferredProvider = preferredAvailableHostProvider({
      agents,
      selectedProvider: selectedHostProvider,
      canonicalProvider: runtimeStateRef.current?.host_cli?.provider,
    });
    if (preferredProvider) handleSelectedHostProviderChange(preferredProvider, agents);
    const summary = !result.ok && result.error
      ? `扫描失败：${userVisibleRuntimeErrorText(result.error, "本机 CLI Agent 扫描失败。")}`
      : agents.length
        ? `扫描完成：找到 ${agents.filter((agent) => agent.available).length}/${agents.length} 个可用 Agent；${agents.map((agent) => `${agent.display_name ?? agent.provider}：${hostCliCandidateStatusLabel(agent)}`).join("；")}`
        : "扫描完成：未找到本机 CLI Agent。";
    setHostDiscoveryStatus(summary);
    addMessage({ role: "status", text: summary });
  };

  useEffect(() => {
    runtime.bootstrap()
      .then((result) => {
        syncState(result.state);
        if (result.state?.host_cli?.provider) setSelectedHostProvider(result.state.host_cli.provider);
        if (result.state?.host_cli?.model_options?.length) setHostModelOptions(result.state.host_cli.model_options);
        if (result.state?.host_cli?.selected_model) setHostModel(result.state.host_cli.selected_model);
        if (result.state?.host_cli?.reasoning_effort) setHostReasoning(result.state.host_cli.reasoning_effort);
        if (result.state?.host_cli?.provider === "kimi" && !result.state?.host_cli?.reasoning_effort) setHostReasoning("default");
        if (!result.ok) addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.error, "Runtime 启动检查失败。") });
      })
      .catch((error) => {
        addMessage({
          role: "status",
          text: userVisibleRuntimeErrorText(error instanceof Error ? error.message : String(error), "Runtime 启动检查失败。"),
        });
      })
      .finally(() => {
        requestRuntimeReconcile({ reason: "bootstrap canonical reconcile", observe: false });
      });
    runtime.getManualVariableOptions().then((result) => {
      if (result.ok && result.options) {
        const nextOptions = {
          ...emptyManualVariableOptions,
          ...result.options,
        };
        const nextSeasonVariableFields = result.season_variable_fields || [];
        const nextSeasonId = result.active_season_id || null;
        const nextSeasonModeDefinitions = result.active_season_ui_modes || {};
        const nextModes = resolveAvailableMatchModes({
          activeSeasonId: nextSeasonId,
          optionGroups: nextOptions,
          seasonModeDefinitions: nextSeasonModeDefinitions,
        });
        setActiveSeasonId(nextSeasonId);
        setActiveSeasonModeDefinitions(nextSeasonModeDefinitions);
        setManualVariableOptions(nextOptions);
        setSeasonVariableFields(nextSeasonVariableFields);
        const restoredVariables = manualVariablesFromRuntime(result.state?.manual_match_variables, nextSeasonVariableFields);
        if (restoredVariables) setConfirmedManualVariables(restoredVariables);
        const restoredMode = uiModeFromBackendMode(result.state?.active_mode, nextModes);
        if (restoredMode) {
          activeModeRef.current = restoredMode;
          setActiveMode(restoredMode);
        }
      } else {
        setActiveSeasonId(null);
        setActiveSeasonModeDefinitions({});
        setSeasonVariableFields([]);
        addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.error, "本局变量选项加载失败；Electron 后端未读到当前赛季数据。") });
      }
    }).finally(() => setSeasonModeCapabilitiesLoaded(true));
  }, [runtime]);

  const handleDetectHostCli = async () => {
    const selected = hostCandidates.find((agent) => agent.provider === selectedHostProvider);
    addMessage({ role: "status", text: `正在连接所选 CLI Agent：${selected?.display_name ?? selectedHostProvider}。` });
    const result = await runtime.detectHostCli({
      provider: selectedHostProvider,
      command: selected?.command ?? undefined,
      model: hostModel,
      reasoning_effort: hostReasoning,
    });
    syncState(result.state);
    if (result.ok) {
      addMessage({
        role: "status",
        text: `${result.host_cli?.display_name ?? "宿主 CLI Agent"} 已连接：${result.host_cli?.version ?? result.host_cli?.codex_version ?? "版本未知"}`,
        evidence: result.host_cli?.command ? `command: ${result.host_cli.command}` : undefined,
      });
    } else {
      addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.error, "Host CLI Agent connection failed.") });
    }
  };

  const handleRestartRuntimeDaemon = async () => {
    addMessage({ role: "status", text: "正在重启 Runtime Daemon，确保 Electron 使用当前源码和新的 watcher/session 边界。" });
    const result = await runtime.restartRuntimeDaemon();
    syncState(result.state);
    addMessage({
      role: "status",
      text: result.ok ? "Runtime Daemon 已重启；下一次 Start Match 会使用当前后端代码。" : userVisibleRuntimeErrorText(result.error, "Runtime Daemon 重启失败。"),
    });
  };

  const handleStart = async () => {
    if (startMatchInFlightRef.current) return;
    startMatchInFlightRef.current = true;
    let reconcileStartedMatch = false;
    try {
      await runtimeReconcileDrainRef.current?.whenIdle();
      liveMatchNoticeRef.current = null;
      visualStatusNoticeRef.current = null;
      deliveredCoachResponseKeysRef.current.clear();
      manualModeLockRef.current = null;
      clearVisualFollowup();
      responseGenerationRef.current += 1;
      addMessage({ role: "status", text: "正在开始新对局：清空上一局状态并启动实时监听。" });
      const result = await runtime.startMatch();
      syncState(result.state);
      const matchCreated = result.match_created === true
        && result.state?.match_session?.status === "active";
      if (matchCreated) {
        reconcileStartedMatch = true;
        activeModeRef.current = "cruise";
        setActiveMode("cruise");
        setConfirmedManualVariables(null);
        confirmedVariablesSessionRef.current = result.state?.match_session?.match_session_id || null;
        const readinessText = result.ready
          ? "本局已创建，正在等待游戏状态；接入这把游戏后会自动进入巡航并开始给建议。"
          : !result.host_ready && !result.watcher_ready
            ? `本局已创建，但底层 CLI Agent 和实时监听均未就绪：${userVisibleRuntimeErrorText(result.error, "请重新连接所选 Agent 和 MuMu 后重试。")} 当前对局边界已保留。`
            : !result.host_ready
              ? `本局已创建，但底层 CLI Agent 会话尚未就绪：${userVisibleRuntimeErrorText(result.error, "请重新连接所选 Agent 后重试。")} 当前对局边界已保留。`
              : `本局已创建，但实时监听未启动：${result.watcher?.watcher?.error ?? result.error ?? "请先连接 MuMu 后重试。"}`;
        setMatchMessages([
          ...initialMatchMessages,
          {
            id: messageId(),
            role: "status",
            text: readinessText,
          },
        ]);
        if (result.state?.match_session?.ui_ready === false) {
          appendMessageToStream("daily", { role: "status", text: readinessText });
        }
        deliveredCoachResponseKeysRef.current.clear();
        setLineupPlan(null);
        setLineupStatus("idle");
        setPinnedPanelOpen(true);
        setActiveView("variables");
        lineupExpectedTaskIdRef.current = null;
        lineupRequestInFlightRef.current = false;
      } else {
        addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.error, "Start Match 失败。") });
      }
    } catch (error) {
      addMessage({
        role: "status",
        text: userVisibleRuntimeErrorText(error instanceof Error ? error.message : String(error), "Start Match 失败。"),
      });
    } finally {
      startMatchInFlightRef.current = false;
      if (reconcileStartedMatch) {
        requestRuntimeReconcile({ reason: "Start Match canonical reconcile", observe: false });
      }
    }
  };

  const handleStop = async () => {
    manualModeLockRef.current = null;
    clearVisualFollowup();
    responseGenerationRef.current += 1;
    const result = await runtime.stopMatch();
    syncState(result.state);
    if (result.ok || result.match_stopped === true) {
      setLineupPlan(null);
      setLineupStatus("idle");
      setPinnedPanelOpen(false);
      setConfirmedManualVariables(null);
      confirmedVariablesSessionRef.current = null;
      lineupExpectedTaskIdRef.current = null;
      lineupRequestInFlightRef.current = false;
      setDailyMode("chat");
      appendMessageToStream("daily", {
        role: "status",
        text: result.ok
          ? "已停止当前对局，回到日常聊天；MuMu 连接保持。"
          : result.status === "watcher_termination_failed"
            ? userVisibleRuntimeErrorText(result.error, "本局状态已关闭，但实时监听进程没有确认退出；Runtime 不会把它当作干净停止。")
            : userVisibleRuntimeErrorText(result.error, "本局状态已关闭，但宿主 CLI 会话没有确认退出；Runtime 不会把它当作干净停止。"),
      });
    } else {
      appendMessageToStream("daily", {
        role: "status",
        text: userVisibleRuntimeErrorText(result.error, "Stop Match 失败。"),
      });
    }
  };

  const handleModeChange = async (mode: ModeId) => {
    const generation = modeTransitionFenceRef.current.begin();
    setModeTransitionPending(true);
    const previousMode = activeModeRef.current;
    const previousLock = manualModeLockRef.current;
    const previousView = activeView;
    const previousPinnedPanelOpen = pinnedPanelOpen;
    manualModeLockRef.current = isManualMatchMode(mode) ? { mode, until: Date.now() + 120000 } : null;
    activeModeRef.current = mode;
    setActiveMode(mode);
    if (mode === "lineup") {
      setPinnedPanelOpen(true);
      setActiveView("lineup");
    }
    if (mode === "vars") {
      setPinnedPanelOpen(true);
      setActiveView("variables");
    }
    try {
      const result = await runtime.setMode(mode);
      if (!modeTransitionFenceRef.current.isCurrent(generation)) return;
      if (!result.ok) {
        const current = await runtime.getState();
        syncState(current.state);
        manualModeLockRef.current = previousLock;
        activeModeRef.current = previousMode;
        setActiveMode(previousMode);
        setActiveView(previousView);
        setPinnedPanelOpen(previousPinnedPanelOpen);
        addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.error, `进入 ${mode} 模式失败。`) });
        return;
      }
      syncState(result.state);
      if (shouldWaitForAiNativeAfterFastChoice(result)) {
        scheduleDeliveryFollowup(`enter ${mode} mode hidden fast choice continuation`, 1200);
        return;
      }
      if (result.status === "fast_choice_text_ready" && emitFastChoiceHint(result.fast_choice_hint)) {
        scheduleVisualFollowup(`enter ${mode} mode fast choice continuation`, 1200);
      }
      if (result.status === "awaiting_host_cli_agent_visual_response" || result.status === "visual_refresh_queued") {
        scheduleVisualFollowup(`enter ${mode} mode visual continuation`, 300);
      }
    } catch (error) {
      if (!modeTransitionFenceRef.current.isCurrent(generation)) return;
      manualModeLockRef.current = previousLock;
      activeModeRef.current = previousMode;
      setActiveMode(previousMode);
      setActiveView(previousView);
      setPinnedPanelOpen(previousPinnedPanelOpen);
      addMessage({
        role: "status",
        text: userVisibleRuntimeErrorText(error instanceof Error ? error.message : String(error), `进入 ${mode} 模式失败。`),
      });
    } finally {
      if (modeTransitionFenceRef.current.isCurrent(generation)) setModeTransitionPending(false);
    }
  };

  const handleDailyModeChange = async (mode: DailyMode) => {
    const previousMode = dailyMode;
    setDailyMode(mode);
    const result = await runtime.setMode(mode);
    if (!result.ok) {
      setDailyMode(previousMode);
      const current = await runtime.getState();
      syncState(current.state);
      addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.error, `进入 ${mode} 失败。`) });
      return;
    }
    syncState(result.state);
    if (mode === "wiki") void handleRefreshWikiStatus();
  };

  const structuredDecisionBusinessFailureText = (result: RuntimeResult) => {
    const status = result.status || result.error || "structured_decision_failed";
    if (status === "stale_decision_input_payload") return "卡片状态已经更新，已同步到当前候选；请检查后重试本次操作。";
    if (status === "decision_input_payload_binding_required") return "卡片仍在同步当前对局状态，请稍候重试。";
    if (status === "selected_choice_not_in_current_choice_set") return "最终选择与当前候选不一致，请重新选择后确认。";
    if (status === "inactive_match") return "当前没有进行中的对局，无法提交这张卡片。";
    return userVisibleRuntimeErrorText(result.error || result.message || result.status, "当前卡片没有提交成功，请检查候选后重试。");
  };

  const handleDecisionInputResult = (result: RuntimeResult<{ response?: CoachResponse; response_task?: RuntimeState["response_task"] }>, reason: string) => {
    syncState(result.state);
    const resultTask = responseTaskFromResult(result);
    if (!result.ok) {
      addMessage({ role: "status", text: structuredDecisionBusinessFailureText(result) });
      return;
    }
    if (["choice_confirmation_recorded", "choice_confirmation_already_recorded"].includes(result.status || "")) {
      clearVisualFollowup();
      endManualChoiceFollowup();
      return;
    }
    if (
      result.status === "awaiting_host_cli_agent_response"
      || result.status === "response_pending"
      || result.status === "ai_native_requested"
      || (resultTask && ["preparing", "running", "awaiting_host_cli_agent_response", "response_pending", "ai_native_requested"].includes(resultTask.status || ""))
    ) {
      scheduleDeliveryFollowup(`structured decision ${reason}`, 1200);
      return;
    }
    if (result.response?.final_text) {
      const stream = resultTask
        ? responseTaskDeliveryDecision({ task: resultTask, state: result.state }).stream
        : "match";
      if (emitCoachResponse(result.response, { respectManualLock: false, stream, task: resultTask })) {
        void ackRenderedResponseTask(resultTask, "structured_decision_response_rendered");
      }
    }
  };

  const handleResetDailySession = async () => {
    const result = await runtime.resetDailySession();
    syncState(result.state);
    if (result.ok) {
      setDailyMode("chat");
      const statusMessage: ChatMessage = {
        id: messageId(),
        role: "status",
        text: "已开启新的日常对话；用户偏好、策略 Wiki、近 20 局复盘和 MuMu 连接都保留。"
      };
      setDailyMessages([
        statusMessage
      ]);
      if (matchActive) addMessage({ role: "status", text: "已重置日常对话 session；当前对局不受影响。" });
    } else {
      addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.error, "开启新对话失败。") });
    }
  };

  const handleSend = async (
    text: string,
    requestKind: "host_question" | "match_fact_capture" | "hard_data_query" | "popular_recipe_query" | "daily_core_theory_query" | "ranking_recommendation_query" = "host_question",
    rankingCount = dailyRankingRecommendationAction?.defaultCount || 5,
    modeOverride?: ModeId,
    requestMetadata?: { lineupConfirmationRequested?: boolean },
  ) => {
    const mode = matchActive
      ? requestMetadata?.lineupConfirmationRequested
        ? "lineup"
        : modeOverride || activeMode
      : dailyMode;
    const requestIsLineup = matchActive && mode === "lineup";
    const responseGeneration = responseGenerationRef.current;
    if (requestIsLineup) {
      setLineupStatus("pending");
      setPinnedPanelOpen(true);
      setActiveView("lineup");
      lineupExpectedTaskIdRef.current = null;
      lineupRequestInFlightRef.current = true;
    }
    addMessage({ role: "user", text });
    setIsResponding(true);
    let result: Awaited<ReturnType<RuntimeBridge["sendMessage"]>>;
    try {
      result = requestKind === "hard_data_query"
        ? await runtime.sendCruiseHardDataQuery(text)
        : requestKind === "daily_core_theory_query"
          ? await runtime.sendDailyCoreTheoryQuery(text)
        : requestKind === "popular_recipe_query"
          ? await runtime.sendCruisePopularRecipeQuery(text)
        : requestKind === "ranking_recommendation_query"
          ? await runtime.sendMessage({
              text,
              mode,
              request_kind: "host_question",
              ranking_recommendation: true,
              ranking_requested_count: rankingCount,
            })
        : await runtime.sendMessage({
            text,
            mode,
            request_kind: requestKind,
            ...(requestMetadata?.lineupConfirmationRequested ? { lineup_confirmation_requested: true } : {}),
            ...(matchActive && mode === "item" ? { item_choice_kind: itemChoiceKind } : {}),
          });
    } catch (error) {
      if (!runtimeResultGenerationIsCurrent(responseGeneration, responseGenerationRef.current)) return;
      setIsResponding(false);
      if (requestIsLineup) {
        setLineupStatus("failed");
        lineupExpectedTaskIdRef.current = null;
        lineupRequestInFlightRef.current = false;
      }
      addMessage({
        role: "status",
        text: userVisibleRuntimeErrorText(error instanceof Error ? error.message : String(error), "发送失败，教练服务暂时不可用，请稍后重试。"),
      });
      return;
    }
    if (!runtimeResultGenerationIsCurrent(responseGeneration, responseGenerationRef.current)) {
      const current = await runtime.getState();
      syncState(current.state);
      requestRuntimeReconcile({ reason: "discarded pre-Stop send result canonical reconcile", observe: false });
      return;
    }
    setIsResponding(false);
    syncState(result.state);
    const resultTask = responseTaskFromResult(result);
    if (requestIsLineup && resultTask?.response_task_id) {
      lineupExpectedTaskIdRef.current = resultTask.response_task_id;
      lineupRequestInFlightRef.current = false;
    }
    if (!result.ok) {
      if (requestIsLineup) {
        setLineupStatus("failed");
        lineupExpectedTaskIdRef.current = null;
        lineupRequestInFlightRef.current = false;
      }
      if (matchActive && isManualMatchMode(activeMode)) {
        endManualChoiceFollowup();
        activeModeRef.current = "cruise";
        setActiveMode("cruise");
      }
      addMessage({ role: "status", text: userVisibleHostFailureText(result.error, resultTask?.host_diagnostics) });
      return;
    }
    if (result.status === "response_status_pending") {
      addDedupedStatus(
        `response-status-pending:${resultTask?.response_task_id || "current"}`,
        result.message || "当前回答仍在生成；没有取消或发起新的回答任务。",
        "poll",
      );
      scheduleDeliveryFollowup("response status ping", 1200);
      return;
    }
    if (shouldWaitForAiNativeAfterFastChoice(result)) {
      setIsResponding(false);
      scheduleDeliveryFollowup("send message hidden fast choice AI-native continuation", 1200);
      return;
    }
    if (result.status === "fast_choice_hint_returned" && emitFastChoiceHint(result.fast_choice_hint)) {
      setIsResponding(false);
      scheduleVisualFollowup("send message fast choice AI-native continuation", 1200);
      return;
    }
    if (result.status === "fast_choice_text_worker_failed") {
      clearVisualFollowup();
      addMessage({
        role: "status",
        text: result.message ?? "快速 OCR worker 尚未就绪。",
      });
      return;
    }
    if (result.status === "fast_choice_text_capture_failed") {
      clearVisualFollowup();
      addMessage({
        role: "status",
        text: result.message ?? "快速 OCR 截图失败。",
      });
      return;
    }
    if (result.status === "fast_choice_text_no_choice") {
      clearVisualFollowup();
      addMessage({
        role: "status",
        text: "快速 OCR 没有读到稳定候选。",
      });
      return;
    }
    if (result.status === "choice_confirmation_recorded") {
      clearVisualFollowup();
      addMessage({
        role: "status",
        text: result.message ?? "已记录本局选择。",
      });
      return;
    }
    const responseStream = resultTask
      ? responseTaskDeliveryDecision({ task: resultTask, state: result.state }).stream
      : matchActive ? "match" : "daily";
    if (result.response?.final_text && emitCoachResponse(result.response, {
      respectManualLock: false,
      stream: responseStream,
      task: resultTask,
    })) {
      await ackRenderedResponseTask(resultTask, "send_message_response_rendered");
    } else if (result.status === "awaiting_host_cli_agent_visual_response") {
      const requestId = result.state?.visual_request_status?.request_id ?? "pending";
      const noticeKey = `awaiting-visual:${requestId}`;
      if (visualStatusNoticeRef.current !== noticeKey) {
        visualStatusNoticeRef.current = noticeKey;
        addMessage({
          role: "status",
          text: "视觉采集已完成，正在等待宿主 CLI Agent 回答。",
        });
      }
      scheduleVisualFollowup("send message visual continuation", 300);
    } else if (result.status === "awaiting_host_cli_agent_response") {
      scheduleDeliveryFollowup("send message AI-native continuation", 1200);
      if (isManualChoiceAwaitingAiNative(result)) return;
      addMessage({ role: "status", text: "已生成宿主 CLI Agent 请求，等待主模型最终回答；不会显示后端 scorer 草案。" });
    } else {
      addMessage({ role: "status", text: result.message ?? "后端动作已完成，暂无可展示最终回答。" });
    }
  };

  const handleRequestFinalLineup = async () => {
    if (!matchActive || composerIsResponding || modeTransitionPending) return;
    setFinalLineupConfirmationRequestKey((value) => value + 1);
  };

  const handleStopResponse = async () => {
    responseGenerationRef.current += 1;
    clearVisualFollowup();
    manualModeLockRef.current = null;
    const task = runtimeStateRef.current?.response_task;
    const taskId = task?.response_task_id ?? null;
    const taskRevision = Number.isInteger(task?.revision) ? task?.revision ?? null : null;
    if (lineupStatus === "pending") {
      setLineupStatus("stale");
      lineupExpectedTaskIdRef.current = null;
      lineupRequestInFlightRef.current = false;
    }
    setIsResponding(false);
    const result = await runtime.stopResponse({
      response_task_id: taskId,
      response_task_revision: taskRevision,
    });
    const current = await runtime.getState();
    syncState(current.state);
    if (!result.ok) {
      setIsResponding(responseTaskIsUserCancellable(current.state?.response_task));
      addMessage({
        role: "status",
        text: userVisibleRuntimeErrorText(result.message ?? result.error, "当前回答没有停止，请再试一次。"),
      });
      return;
    }
    addMessage({ role: "status", text: result.message ?? "已停止当前回答；当前模式保持不变。" });
  };

  const handleConnectMumu = async () => {
    const result = await runtime.connectMumu();
    syncState(result.state);
    addMessage({ role: "status", text: result.ok ? (result.message ?? "MuMu 自动发现完成。") : userVisibleRuntimeErrorText(result.message ?? result.error, "MuMu 自动发现失败。") });
  };

  const handleUpdateRankings = async () => {
    if (rankingsUpdateBusy) return;
    setRankingsUpdateBusy(true);
    addMessage({ role: "status", text: "正在启动今日数据更新。" });
    try {
      const result = await runtime.updateRankings();
      syncState(result.state);
      if (result.task_id) rankingUpdateStartedTaskIdRef.current = result.task_id;
      addMessage({
        role: "status",
        text: result.status === "ranking_update_already_running"
          ? "今日数据更新任务仍在后台执行。"
          : result.ok
            ? "今日数据更新任务已启动，后台会继续完成同步、语义维护和发布。"
            : userVisibleRuntimeErrorText(
                typeof result.error === "string" ? result.error : JSON.stringify(result.error ?? ""),
                "今日数据更新任务未能创建。",
              ),
      });
    } catch (error) {
      addMessage({
        role: "status",
        text: userVisibleRuntimeErrorText(error instanceof Error ? error.message : String(error), "今日数据更新任务未能创建。"),
      });
    } finally {
      setRankingsUpdateBusy(false);
    }
  };

  const handleSaveRuntimeSettings = async () => {
    const result = await runtime.saveRuntimeSettings({
      diagnostic_evidence_enabled: diagnosticEvidenceEnabled,
      diagnostic_retention_days: 7,
    });
    syncState(result.state);
    addMessage({
      role: "status",
      text: result.ok
        ? `故障诊断已${diagnosticEvidenceEnabled ? "开启" : "关闭"}。`
        : userVisibleRuntimeErrorText(result.error, "故障诊断设置保存失败。"),
    });
  };

  // Kept for compatibility with persisted settings and confirmed natural-language preference writes.
  const handleSaveUserPreferences = async () => {
    const result = await runtime.saveUserPreferences({
      rank_tier: rankTier,
      operation_speed: operationSpeed,
      default_goal: defaultGoal,
    });
    syncState(result.state);
    addMessage({
      role: "status",
      text: result.ok
        ? "用户偏好已保存。"
        : userVisibleRuntimeErrorText(result.error, "用户偏好保存失败。"),
    });
  };

  const handleConfirmVariables = async (payload: ManualVariablesPayload) => {
    const result = await runtime.saveManualVariables(payload);
    syncState(result.state);
    if (result.ok) {
      const savedVariables = manualVariablesFromRuntime(
        result.variables || result.state?.manual_match_variables,
        seasonVariableFields,
      );
      setConfirmedManualVariables(savedVariables || payload);
      confirmedVariablesSessionRef.current = result.state?.match_session?.match_session_id || null;
      setPinnedPanelOpen(true);
      setActiveView("variables");
      manualModeLockRef.current = null;
      activeModeRef.current = "cruise";
      setActiveMode("cruise");
    }
    if (result.ok && result.response?.final_text && emitCoachResponse(result.response, { respectManualLock: false })) {
      await ackRenderedResponseTask(responseTaskFromResult(result), "manual_variables_response_rendered");
      return;
    }
    addMessage({
      role: "status",
      text: result.ok
        ? (result.message ?? (seasonVariableFields.length ? "已确认本局变量。" : "已确认本局目标。"))
        : userVisibleRuntimeErrorText(result.error, seasonVariableFields.length ? "变量确认失败。" : "目标确认失败。"),
    });
  };

  const handleEditStrategy = (index: number) => {
    setEditingStrategyIndex(index);
    setStrategyDraft(strategyLines[index] ?? "");
  };

  const handleCancelStrategyEdit = () => {
    setEditingStrategyIndex(null);
    setStrategyDraft("");
  };

  const handleRefreshWikiStatus = async () => {
    const result = await runtime.getStrategyWikiStatus();
    syncState(result.state);
    if (result.ok) setWikiStatus(result.wiki_status ?? null);
    else addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.error, "策略 Wiki 状态读取失败。") });
  };

  const handleSaveStrategy = async () => {
    const text = strategyDraft.trim();
    if (!text) {
      addMessage({ role: "status", text: "策略内容为空，未写入。" });
      return;
    }
    const result = await runtime.saveStrategyMemory({ text });
    syncState(result.state);
    if (!result.ok) {
      addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.message ?? result.error, "策略写入失败。") });
      return;
    }
    setStrategyLines((value) => {
      if (editingStrategyIndex === null) return [text, ...value];
      return value.map((line, index) => (index === editingStrategyIndex ? text : line));
    });
    const notices = result.result?.agent_notice_events?.map((event) => event.user_visible_text).filter(Boolean) ?? [];
    addMessage({
      role: "status",
      text: notices.length
        ? `策略已保存；冲突提示：${notices.join(" ")}`
        : (editingStrategyIndex === null ? "策略已保存。" : "策略更新已保存。")
    });
    setEditingStrategyIndex(null);
    setStrategyDraft("");
  };

  const handleBuildWikiCuration = async () => {
        addMessage({ role: "status", text: "正在整理复盘/策略 Wiki：收集近 20 局复盘、用户策略和今日数据证据。" });
    setIsResponding(true);
    const result = await runtime.buildWikiCurationRequest({ trigger: "manual_one_click", limit: 20 });
    setIsResponding(false);
    syncState(result.state);
    if (!result.ok) {
      addMessage({ role: "status", text: userVisibleRuntimeErrorText(result.error ?? result.message, "策略 Wiki 整理失败。") });
      return;
    }
    if (result.status === "completed") {
      const pageCount = result.apply_result?.written_pages?.length ?? 0;
      const staleCount = result.apply_result?.stale_updates?.length ?? 0;
      const userQuestions = result.apply_result?.user_questions?.map((question) => String(question).trim()).filter(Boolean) ?? [];
      const questionCount = userQuestions.length;
      const questionText = userQuestions.length ? ` Pending: ${userQuestions.join("; ")}` : "";
      await handleRefreshWikiStatus();
      if (userQuestions.length) {
        setWikiStatus((current) => ({
          ...(current ?? {
            schema: "jcc-strategy-wiki-status-v1",
            draft_pages: [],
            published_pages: [],
            stale_pages: [],
            recent_runs: [],
          }),
          pending_questions: userQuestions,
        }));
      }
      addMessage({
        role: "status",
        text: pageCount > 0
          ? `策略 Wiki 草稿已生成：${pageCount} 页，${staleCount} 页已过期，${questionCount} 个待确认问题。${questionText}`
          : `没有生成策略 Wiki 草稿：${staleCount} 页已过期，${questionCount} 个待确认问题。${questionText}`
      });
      return;
    }
    const sourceCount = result.result?.source_event_ids?.length ?? 0;
    await handleRefreshWikiStatus();
    addMessage({
      role: "status",
      text: `已根据 ${sourceCount} 条来源生成策略 Wiki 整理请求。`,
    });
  };

  const handleClose = async () => {
    const result = await runtime.closeWindow();
    if (result.status === "preview_noop") {
      setPreviewClosed(true);
      return;
    }
    if (!result.ok || result.status === "preview_noop") {
      addMessage({ role: "status", text: result.message ?? "浏览器预览页不能关闭窗口；Electron 版会直接关闭 Runtime UI。" });
    }
  };

  const handleMinimize = async () => {
    const result = await runtime.minimizeWindow();
    if (result.status === "preview_noop") {
      setPreviewClosed(true);
      return;
    }
    if (!result.ok) {
      addMessage({ role: "status", text: result.message ?? "缩小 Runtime UI 失败。" });
    }
  };

  if (previewClosed) {
    return (
      <div className="closed-preview" role="status" aria-label="Runtime UI 已关闭">
        <strong>Runtime UI 已关闭</strong>
        <span>这是浏览器预览状态，页面容器不能被网页脚本真正关闭；Electron 版会直接关窗。</span>
        <button type="button" onClick={() => setPreviewClosed(false)}>重新打开预览</button>
      </div>
    );
  }

  return (
    <div className={`app-shell ${matchActive ? "match-shell" : "daily-shell"}`}>
      <TopBar
        menuOpen={menuOpen}
        matchActive={matchActive}
        mumuConnected={status.mumu}
        onToggleMenu={() => {
          setMenuSection("main");
          setMenuOpen((value) => !value);
        }}
        onStart={handleStart}
        onStop={handleStop}
        onMinimize={handleMinimize}
        onClose={handleClose}
      />
      {matchActive && <ModeRail modes={availableMatchModes} activeMode={activeMode} onModeChange={handleModeChange} />}
      {matchActive && (
        <SelfStateStrip
          refresh={runtimeState?.self_state_refresh}
          matchConnection={runtimeState?.match_connection}
        />
      )}
      {structuredDecisionMode && activeMatchModeDescriptor && (
        <div className="decision-input-region">
          <DecisionInputCard
            runtime={runtime}
            mode={activeMatchModeDescriptor}
            manualOptions={manualVariableOptions}
            itemChoiceKind={itemChoiceKind}
            onItemChoiceKindChange={setItemChoiceKind}
            onRuntimeResult={handleDecisionInputResult}
            onStatus={(text) => addMessage({ role: "status", text })}
            drafts={decisionInputDrafts}
            setDrafts={setDecisionInputDrafts}
            stageByMode={decisionInputStages}
            setStageByMode={setDecisionInputStages}
          />
        </div>
      )}
      {matchActive && pinnedPanelVisible && (
        <div className="pinned-region" hidden={structuredDecisionMode} aria-hidden={structuredDecisionMode}>
          <PinnedResult
            activeView={activeView}
            onViewChange={(view) => {
              setPinnedPanelOpen(true);
              setActiveView(view);
            }}
          variableOptions={manualVariableOptions}
          seasonVariableFields={seasonVariableFields}
          variableDraftResetKey={runtimeState?.match_session?.match_session_id || "no-active-match"}
          onConfirmVariables={handleConfirmVariables}
          manualVariables={confirmedManualVariables}
          lineupPlan={lineupPlan}
           lineupStatus={lineupStatus}
           onRequestFinalLineup={handleRequestFinalLineup}
           finalLineupRequestDisabled={composerIsResponding || modeTransitionPending}
           finalLineupConfirmationLabel={finalLineupConfirmationAction?.label}
          equipmentEditor={equipmentCatalogMode ? (
            <EquipmentHolderEditor
              runtime={runtime}
              catalogMode={equipmentCatalogMode}
              boardNames={trustedBoardNames}
              stageRound={trustedStageRound}
              resetKey={runtimeState?.match_session?.match_session_id || "no-active-match"}
              onRuntimeResult={(result) => handleDecisionInputResult(result, "equipment holder update")}
              onStatus={(text) => addMessage({ role: "status", text })}
            />
          ) : null}
          />
        </div>
      )}
      {!matchActive && (
        <div className="daily-mode-region">
          <NoMatchPanel
            dailyMode={dailyMode}
            onDailyModeChange={handleDailyModeChange}
            onStart={handleStart}
            onResetDailySession={handleResetDailySession}
            onBuildWikiCuration={handleBuildWikiCuration}
          />
        </div>
      )}
      <ChatStream
        messages={visibleMessages}
        matchActive={matchActive}
      />
      {menuOpen && (
        <MenuPanel
          section={menuSection}
          runtimeState={runtimeState}
          onSectionChange={setMenuSection}
          onConnectMumu={handleConnectMumu}
          onDiscoverHostCliAgents={handleDiscoverHostCliAgents}
          onDetectHostCli={handleDetectHostCli}
          onUpdateRankings={handleUpdateRankings}
          onSaveRuntimeSettings={handleSaveRuntimeSettings}
          onResetDailySession={handleResetDailySession}
          onRestartRuntimeDaemon={handleRestartRuntimeDaemon}
        hostModel={hostModel}
        hostReasoning={hostReasoning}
        hostModelOptions={hostModelOptions}
        hostCandidates={hostCandidates}
        selectedHostProvider={selectedHostProvider}
        hostDiscoveryStatus={hostDiscoveryStatus}
        rankingsUpdateBusy={rankingsUpdateBusy}
        onSelectedHostProviderChange={handleSelectedHostProviderChange}
        onHostModelChange={handleHostModelChange}
        onHostReasoningChange={setHostReasoning}
          diagnosticEvidenceEnabled={diagnosticEvidenceEnabled}
          onDiagnosticEvidenceEnabledChange={setDiagnosticEvidenceEnabled}
          strategyLines={strategyLines}
          editingStrategyIndex={editingStrategyIndex}
          strategyDraft={strategyDraft}
          onStrategyDraftChange={setStrategyDraft}
          onEditStrategy={handleEditStrategy}
          onSaveStrategy={handleSaveStrategy}
          onBuildWikiCuration={handleBuildWikiCuration}
          onRefreshWikiStatus={handleRefreshWikiStatus}
          onCancelStrategyEdit={handleCancelStrategyEdit}
          wikiStatus={wikiStatus}
        />
      )}
      <Composer
        modes={availableMatchModes}
        activeMode={activeMode}
        dailyMode={dailyMode}
        itemChoiceKind={itemChoiceKind}
        onItemChoiceKindChange={setItemChoiceKind}
        matchActive={matchActive}
        isResponding={composerIsResponding}
        onSend={handleSend}
        onStop={handleStopResponse}
        isTransitioning={modeTransitionPending}
        structuredDecisionActive={structuredDecisionMode}
        dailyCoreTheoryAction={dailyCoreTheoryAction}
        dailyRankingRecommendationAction={dailyRankingRecommendationAction}
        finalLineupConfirmationRequestKey={finalLineupConfirmationRequestKey}
        finalLineupConfirmationLabel={finalLineupConfirmationAction?.label || "确认最终阵容："}
        finalLineupConfirmationPrompt={finalLineupConfirmationAction?.prompt || finalLineupCardPrompt}
      />
    </div>
  );
}
