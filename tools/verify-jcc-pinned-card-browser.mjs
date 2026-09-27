import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { terminateProcessTree } from "./jcc_process_runner.mjs";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

const url = process.env.JCC_UI_URL || "http://127.0.0.1:5173";
const chromeCandidates = process.platform === "win32"
  ? [
      path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ]
  : ["google-chrome", "chromium", "chromium-browser"];

async function pathExists(candidate) {
  if (!candidate) return false;
  try {
    await import("node:fs/promises").then(({ access }) => access(candidate));
    return true;
  } catch {
    return false;
  }
}

async function firstChrome() {
  for (const candidate of chromeCandidates) {
    if (process.platform !== "win32" || await pathExists(candidate)) return candidate;
  }
  throw new Error("Chrome executable not found for pinned-card browser verification");
}

async function uiIsReachable() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureUiServer() {
  if (await uiIsReachable()) return null;
  if (process.env.JCC_UI_URL) {
    throw new Error(`JCC_UI_URL is not reachable: ${url}`);
  }
  const viteBin = path.resolve("ui", "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
    cwd: path.resolve("ui"),
    stdio: "ignore",
    windowsHide: true,
  });
  const deadline = Date.now() + Number(process.env.JCC_UI_SERVER_READY_TIMEOUT_MS || 60000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before the browser verifier could reach ${url}`);
    if (await uiIsReachable()) return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await terminateProcessTree(child);
  throw new Error(`Timed out starting the JCC UI renderer at ${url}`);
}

async function waitForTarget(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl && String(entry.url || "").startsWith(url))
        || targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools target did not become ready");
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
    else resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    async send(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function compactPreviewOption(entity, searchTerms = []) {
  return {
    ...entity,
    search_terms: searchTerms,
    ref: {
      kind: entity.kind,
      id: String(entity.id),
      address: entity.address,
      season_id: entity.season_id,
      source: entity.source,
    },
  };
}

function previewDecisionOptions(stageRound, choiceKind, optionsByGroup, candidates = [], inheritedCandidates = []) {
  return {
    schema: "jcc-decision-input-options-v1",
    candidates,
    inherited_candidates: inheritedCandidates,
    options_by_group: optionsByGroup,
    payload_binding: {
      schema: "jcc-decision-input-payload-binding-v1",
      match_session_id: "browser-preview-match",
      stage_round: stageRound,
      choice_kind: choiceKind,
      choice_set_revision: 0,
      report_id: `browser-preview-${choiceKind}-${stageRound}-r0`,
    },
    current_effective_equipment: {
      components: [],
      completed: [],
      radiant: [],
      artifacts: [],
      emblems: [],
      equipped: [],
      revision: 0,
    },
  };
}

async function buildPreviewCapabilities() {
  const runtimePaths = createRuntimePaths(path.resolve(import.meta.dirname, ".."));
  const specialRules = runtimePaths.activeCoreKnowledgeBundle?.season?.runtime_contract?.special_rules;
  assert(specialRules, "active Core Profile must expose the season special-rule compatibility view");
  const manifestFile = path.resolve(runtimePaths.activeHardDataManifest);
  const perMatch = await readJson(path.join(path.dirname(manifestFile), "normalized", "per_match_variables.json"));
  const catalog = await readJson(runtimePaths.activeDecisionInputCatalogFile);
  const variablesByKey = new Map((perMatch.variables || []).map((entry) => [String(entry.key), entry]));
  const manualFields = specialRules.mechanics?.manual_variable_fields || [];
  const options = Object.fromEntries(manualFields.map((field) => [
    String(field.option_group || field.option_source_key),
    variablesByKey.get(String(field.option_source_key))?.options || [],
  ]));
  const seasonModes = Object.fromEntries((specialRules.mechanics?.choice_mechanics || [])
    .filter((mechanic) => mechanic?.mode && mechanic?.runtime_ui_mode)
    .map((mechanic) => [String(mechanic.mode), mechanic.runtime_ui_mode]));
  const aliasesByAddress = new Map();
  for (const alias of catalog.aliases || []) {
    const address = String(alias?.ref?.address || "");
    if (!address || !String(alias?.alias || "").trim()) continue;
    aliasesByAddress.set(address, [...new Set([...(aliasesByAddress.get(address) || []), String(alias.alias)])]);
  }
  const entities = (catalog.entities || []).map((entity) => compactPreviewOption(
    entity,
    aliasesByAddress.get(String(entity.address || "")) || [],
  ));
  const itemsByCategory = Object.fromEntries(["components", "completed", "radiant", "support", "artifacts", "emblems", "special"].map((category) => [
    category,
    entities.filter((entity) => entity.kind === "item" && entity.item_category === category),
  ]));
  const allAugments = entities.filter((entity) => entity.kind === "augment");
  const crossStageAugment = allAugments.find((entity) => entity.tier_color === "gold"
    && Array.isArray(entity.rounds)
    && entity.rounds.length > 0
    && !entity.rounds.includes("2-1"));
  assert(crossStageAugment?.name, "active catalog must provide a known-stage gold augment outside 2-1 for cross-stage search verification");
  const decisionOptions = {};
  for (const stageRound of ["2-1", "3-2", "4-2"]) {
    for (const tier of ["silver", "gold", "prismatic"]) {
      const augments = entities.filter((entity) => entity.kind === "augment"
        && entity.tier_color === tier
        && Array.isArray(entity.rounds)
        && entity.rounds.includes(stageRound));
      decisionOptions[`augment:${stageRound}:${tier}`] = previewDecisionOptions(
        stageRound,
        "augment_choice_3",
        { augment: augments, ...itemsByCategory },
        augments,
      );
    }
  }
  decisionOptions["augment:search"] = previewDecisionOptions("", "augment_choice_3", { augment: allAugments, ...itemsByCategory }, allAugments);
  const itemChoiceCategories = {
    basic_component_forge: "components",
    completed_item_forge: "completed",
    artifact_forge: "artifacts",
    radiant_item_choice: "radiant",
  };
  for (const [itemChoiceKind, category] of Object.entries(itemChoiceCategories)) {
    const candidates = itemsByCategory[category] || [];
    decisionOptions[`item:${itemChoiceKind}`] = previewDecisionOptions("", "item_choice", itemsByCategory, candidates);
    decisionOptions[`item:${itemChoiceKind}:search`] = previewDecisionOptions("", "item_choice", itemsByCategory, candidates);
  }
  const allItems = entities.filter((entity) => entity.kind === "item");
  decisionOptions.item = previewDecisionOptions("", "item_choice", {
    ...itemsByCategory,
    champions: entities.filter((entity) => entity.kind === "champion"),
  }, allItems);
  return {
    active_season_id: runtimePaths.activeSeasonId,
    active_patch_id: runtimePaths.activePatchId,
    options,
    season_variable_fields: manualFields.map((field) => ({
      ...field,
      option_group: field.option_group || field.option_source_key,
    })),
    prompt_at_match_start: perMatch.prompt_at_match_start || [],
    active_season_ui_modes: seasonModes,
    decision_options: decisionOptions,
    test_cross_stage_augment_name: crossStageAugment.name,
    runtime_state: {
      resolved_decision_snapshot: {
        live_state_summary: {
          phase: { stage_round: "3-2" },
          own_board: {
            units: [
              { name: "盖伦", star: 2 },
              { name: "卡莎", star: 2 },
              { name: "科加斯", star: 1 },
              { name: "卢锡安", star: 1 },
            ],
          },
        },
      },
    },
    submission_log: [],
  };
}

const profileDir = await mkdtemp(path.join(os.tmpdir(), "jcc-pinned-browser-"));
const artifactDir = path.resolve(".jcc-runtime-data", "ui-verification");
const screenshotFile = path.join(artifactDir, "pinned-card-tab-stability.png");
const compactMainScreenshotFile = path.join(artifactDir, "live-coach-main-500x625.png");
const wideMainScreenshotFile = path.join(artifactDir, "live-coach-main-900x800.png");
const augmentCardScreenshotFile = path.join(artifactDir, "augment-decision-card-500x720.png");
const itemCardScreenshotFile = path.join(artifactDir, "item-decision-card-500x720.png");
const port = 9337;
let chrome = null;
let cdp = null;
let ownedVite = null;

try {
  const previewCapabilities = await buildPreviewCapabilities();
  ownedVite = await ensureUiServer();
  const chromeCommand = await firstChrome();
  chrome = spawn(chromeCommand, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=396,720",
    url,
  ], { stdio: "ignore", windowsHide: true });
  const target = await waitForTarget(port);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__JCC_RUNTIME_PREVIEW_CAPABILITIES__ = ${JSON.stringify(previewCapabilities)};`,
  });
  await cdp.send("Page.navigate", { url });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: `
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const click = (selector, label) => {
          const elements = Array.from(document.querySelectorAll(selector));
          const target = elements.find((element) => (
            (element.getAttribute('aria-label') || '').includes(label)
            || (element.textContent || '').includes(label)
          ));
          if (!target) throw new Error('missing control: ' + label + '; candidates=' + elements.map((element) => (element.textContent || '').trim()).join('|') + '; url=' + location.href + '; body=' + document.body.innerText.slice(0, 300));
          target.click();
        };
        for (let attempt = 0; attempt < 1200 && !document.querySelector('button'); attempt += 1) await wait(50);
        click('button', '开局');
        for (let attempt = 0; attempt < 40 && document.querySelectorAll('.equipment-holder-row').length < 4; attempt += 1) await wait(50);
        const initialStart = {
          active_mode: document.querySelector('.mode-grid button[aria-pressed="true"]')?.textContent?.trim() || null,
          pinned_visible: Boolean(document.querySelector('.pinned-region')),
          active_pinned_tab: document.querySelector('.pinned-card .tab-active')?.textContent?.trim() || null,
          professional_presets: Array.from(document.querySelectorAll('.preset-row > button'))
            .map((element) => (element.textContent || '').trim())
            .filter(Boolean),
          equipment_holder_rows: document.querySelectorAll('.equipment-holder-row').length,
          equipment_holder_slots: document.querySelectorAll('.equipment-holder-slot').length,
          equipment_holder_present: Boolean(document.querySelector('.equipment-holder-editor')),
          pinned_text: document.querySelector('.pinned-card')?.textContent?.trim().slice(0, 300) || null,
          mode_labels: Array.from(document.querySelectorAll('.mode-grid button')).map((element) => element.textContent?.trim()),
        };
        let firstHolderRow = document.querySelector('.equipment-holder-row');
        let holderInputs = Array.from(firstHolderRow?.querySelectorAll('.catalog-combobox input') || []);
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const setInput = (input, value) => {
          inputSetter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        if (holderInputs.length !== 4) throw new Error('holder row must expose hero plus three equipment inputs');
        setInput(holderInputs[0], '小鸡');
        await wait(80);
        const heroAliasMatches = Array.from(firstHolderRow.querySelectorAll('.catalog-option-label')).map((element) => element.textContent?.trim());
        firstHolderRow.querySelector('.catalog-combobox-list button')?.click();
        await wait(30);
        firstHolderRow = document.querySelector('.equipment-holder-row');
        holderInputs = Array.from(firstHolderRow?.querySelectorAll('.catalog-combobox input') || []);
        const heroCanonicalValue = holderInputs[0]?.value;
        setInput(holderInputs[1], '攻速');
        await wait(80);
        const itemAliasMatches = Array.from(firstHolderRow.querySelectorAll('.catalog-option-label')).map((element) => element.textContent?.trim());
        firstHolderRow.querySelectorAll('.catalog-combobox-list button')[0]?.click();
        await wait(30);
        firstHolderRow = document.querySelector('.equipment-holder-row');
        holderInputs = Array.from(firstHolderRow?.querySelectorAll('.catalog-combobox input') || []);
        const itemCanonicalValue = holderInputs[1]?.value;
        const submissionLog = window.__JCC_RUNTIME_PREVIEW_CAPABILITIES__?.submission_log || [];
        const submissionsBeforeUnresolvedSave = submissionLog.length;
        setInput(holderInputs[3], '攻速');
        await wait(30);
        document.querySelector('.equipment-holder-save')?.click();
        await wait(80);
        const aliasSaveSubmission = submissionLog.at(-1);
        const directAliasSaveCanonicalized = submissionLog.length === submissionsBeforeUnresolvedSave + 1
          && aliasSaveSubmission?.payload?.equipment?.equipped?.some((entry) => (
            entry.slot === 3
            && entry.name === '反曲之弓'
            && entry.ref?.address
          ));
        firstHolderRow = document.querySelector('.equipment-holder-row');
        holderInputs = Array.from(firstHolderRow?.querySelectorAll('.catalog-combobox input') || []);
        setInput(holderInputs[3], '');
        await wait(30);
        const holderFields = Array.from(firstHolderRow.querySelectorAll('.equipment-holder-field'));
        const holderFieldTops = holderFields.map((element) => Math.round(element.getBoundingClientRect().top));
        initialStart.equipment_holder_layout = {
          field_count: holderFields.length,
          labels: holderFields.map((element) => element.querySelector('.equipment-holder-field-label')?.textContent?.trim()),
          vertical: holderFieldTops.every((top, index) => index === 0 || top > holderFieldTops[index - 1]),
          no_horizontal_overflow: document.querySelector('.equipment-holder-table').scrollWidth <= document.querySelector('.equipment-holder-table').clientWidth + 1,
        };
        initialStart.equipment_holder_alias_search = {
          hero: heroAliasMatches,
          item: itemAliasMatches,
          hero_canonical_value: heroCanonicalValue,
          item_canonical_value: itemCanonicalValue,
          direct_alias_save_canonicalized: Boolean(directAliasSaveCanonicalized),
        };
        const targetModeLabel = initialStart.mode_labels.includes('目标') ? '目标' : '变量';
        const targetTabLabels = Array.from(document.querySelectorAll('.pinned-card .tab-switcher button'))
          .map((element) => (element.textContent || '').trim());
        const targetTabLabel = targetTabLabels.includes('目标') ? '目标' : '变量';
        click('.mode-grid button', targetModeLabel);
        await wait(150);
        const draftInput = document.querySelector('.variable-panel textarea');
        if (!draftInput) throw new Error('variable draft input missing');
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        valueSetter.call(draftInput, '未确认变量草稿');
        draftInput.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(50);
        const modeLabels = Array.from(document.querySelectorAll('.mode-grid button'))
          .map((element) => (element.textContent || '').trim())
          .filter(Boolean);
        for (const requiredMode of ['巡航', '海克斯', '装备', '阵容图', targetModeLabel]) {
          if (!modeLabels.includes(requiredMode)) throw new Error('missing common mode: ' + requiredMode);
        }
        const cases = [];
        for (const mode of modeLabels) {
          click('.mode-grid button', mode);
          await wait(80);
          const structured = ['海克斯', '装备'].includes(mode);
          if (structured) {
            const structuredPinned = document.querySelector('.pinned-region');
            cases.push({
              mode,
              structured,
              pinned_before: Boolean(structuredPinned && !structuredPinned.hidden && getComputedStyle(structuredPinned).display !== 'none'),
              decision_card_visible: Boolean(document.querySelector('.decision-input-card')),
              composer_top_before: document.querySelector('.composer')?.getBoundingClientRect().top ?? null,
              composer_top_after: document.querySelector('.composer')?.getBoundingClientRect().top ?? null,
            });
            continue;
          }
          click('.pinned-card .tab-switcher button', targetTabLabel);
          await wait(50);
          const pinnedBefore = document.querySelector('.pinned-region');
          const composerBefore = document.querySelector('.composer');
          if (!pinnedBefore || !composerBefore) throw new Error('pinned card or composer missing before tab change in ' + mode);
          const composerTopBefore = composerBefore.getBoundingClientRect().top;
          click('.pinned-card .tab-switcher button', '阵容');
          await wait(50);
          const pinnedAfter = document.querySelector('.pinned-region');
          const composerAfter = document.querySelector('.composer');
          cases.push({
            mode,
            structured,
            pinned_before: Boolean(pinnedBefore),
            pinned_after: Boolean(pinnedAfter),
            composer_top_before: composerTopBefore,
            composer_top_after: composerAfter?.getBoundingClientRect().top ?? null,
            active_tab: document.querySelector('.pinned-card .tab-active')?.textContent?.trim() || null,
            empty_lineup_visible: Boolean(document.querySelector('.pinned-card .pinned-empty')),
          });
        }
        await wait(250);
        click('.mode-grid button', targetModeLabel);
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const activeLabel = document.querySelector('.mode-grid button[aria-pressed="true"]')?.textContent?.trim();
          if (activeLabel === targetModeLabel && document.querySelector('.pinned-card')) break;
          await wait(50);
        }
        click('.pinned-card .tab-switcher button', targetTabLabel);
        await wait(50);
        const preservedDraft = document.querySelector('.variable-panel textarea')?.value || null;
        const preservedDraftState = {
          active_mode: document.querySelector('.mode-grid button[aria-pressed="true"]')?.textContent?.trim() || null,
          pinned_visible: Boolean(document.querySelector('.pinned-card')),
          active_tab: document.querySelector('.pinned-card .tab-active')?.textContent?.trim() || null,
          variable_panel_visible: Boolean(document.querySelector('.variable-panel')),
        };
        click('button', '停止');
        await wait(100);
        click('button', '开局');
        await wait(100);
        click('.mode-grid button', targetModeLabel);
        await wait(100);
        const resetDraft = document.querySelector('.variable-panel textarea')?.value ?? null;
        click('button', '菜单');
        await wait(50);
        click('.menu-panel button', '识别宿主 CLI Agent');
        await wait(50);
        click('.menu-panel button', '扫描本机 CLI Agent');
        await wait(100);
        const kimiCard = Array.from(document.querySelectorAll('.cli-card')).find((card) => (card.textContent || '').includes('Kimi CLI'));
        return {
          initial_start: initialStart,
          target_tab_label: targetTabLabel,
          cases,
          preserved_variable_draft: preservedDraft,
          preserved_variable_draft_state: preservedDraftState,
          reset_variable_draft: resetDraft,
          preview_kimi: {
            present: Boolean(kimiCard),
            status: kimiCard?.querySelector('small')?.textContent?.trim() || null,
            disabled: Boolean(kimiCard?.disabled),
          },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const result = evaluated.result?.value;
  assert.equal(result?.initial_start?.active_mode, "巡航", "Start Match must keep cruise selected while revealing setup");
  assert.equal(result?.initial_start?.pinned_visible, true, "Start Match must reveal the pinned setup card");
  assert.equal(result?.initial_start?.active_pinned_tab, result?.target_tab_label, "Start Match must reveal the descriptor-driven target/variables tab");
  assert.equal(result?.initial_start?.equipment_holder_rows, 4, `S18 target panel must use the trusted own-board list for equipped holders: ${JSON.stringify(result?.initial_start)}`);
  assert.equal(result?.initial_start?.equipment_holder_slots, 12, "each trusted own-board holder must expose exactly three equipment slots");
  assert.equal(result?.initial_start?.equipment_holder_layout?.field_count, 4, "each equipped holder must render four vertical fields");
  assert.deepEqual(result?.initial_start?.equipment_holder_layout?.labels, ["英雄", "装备 1", "装备 2", "装备 3"]);
  assert.equal(result?.initial_start?.equipment_holder_layout?.vertical, true, "holder hero and equipment controls must stack vertically");
  assert.equal(result?.initial_start?.equipment_holder_layout?.no_horizontal_overflow, true, "holder editor must not create horizontal scrolling at compact width");
  assert(result?.initial_start?.equipment_holder_alias_search?.hero?.includes("深红锋喙鸟"), "S18 champion alias 小鸡 must find 深红锋喙鸟 in the target card");
  assert(result?.initial_start?.equipment_holder_alias_search?.item?.includes("反曲之弓"), "Common equipment alias 攻速 must find 反曲之弓 in the target card");
  assert.equal(result?.initial_start?.equipment_holder_alias_search?.hero_canonical_value, "深红锋喙鸟", "target-card alias selection must commit the canonical champion name");
  assert.equal(result?.initial_start?.equipment_holder_alias_search?.item_canonical_value, "反曲之弓", "target-card alias selection must commit the canonical item name");
  assert.equal(result?.initial_start?.equipment_holder_alias_search?.direct_alias_save_canonicalized, true, "target-card exact alias text must canonicalize before persistence even without an option click");
  for (const label of ["上限阵容", "经济节奏", "阵容方向", "查大数据", "强化适配", "装备/D牌"]) {
    assert(result?.initial_start?.professional_presets?.includes(label), `Cruise professional preset must be visible: ${label}`);
  }
  assert(result?.cases?.length >= 5, "browser verifier should exercise every active match mode card surface");
  for (const scenario of result.cases) {
    if (scenario.structured) {
      assert.equal(scenario.pinned_before, false, `${scenario.mode}: structured decision mode must replace the generic pinned card`);
      assert.equal(scenario.decision_card_visible, true, `${scenario.mode}: structured decision card must be visible`);
      continue;
    }
    assert.equal(scenario.pinned_before, true, `${scenario.mode}: variables tab should keep the pinned card mounted`);
    assert.equal(scenario.pinned_after, true, `${scenario.mode}: clicking the lineup tab must keep the pinned card mounted`);
    assert.equal(scenario.active_tab, "阵容", `${scenario.mode}: lineup tab should remain selected after the transition`);
    assert.equal(scenario.empty_lineup_visible, true, `${scenario.mode}: empty lineup state should render inside the stable pinned slot`);
    assert(Math.abs(scenario.composer_top_after - scenario.composer_top_before) <= 1, `${scenario.mode}: composer position must stay stable across pinned tab changes`);
  }
  assert.equal(
    result.preserved_variable_draft,
    "未确认变量草稿",
    `unconfirmed variable draft must survive pinned tab and mode changes; state=${JSON.stringify(result.preserved_variable_draft_state)}`,
  );
  assert.equal(result.reset_variable_draft, "", "variable draft must reset across Stop Match and the next match session");
  assert.equal(result.preview_kimi?.present, true, "browser preview should list Kimi as a provider candidate");
  assert.equal(result.preview_kimi?.status, "Electron required", "browser preview must explain that local discovery requires Electron");
  assert.equal(result.preview_kimi?.disabled, true, "browser preview must not let users connect an unscanned local Kimi candidate");

  await mkdir(artifactDir, { recursive: true });
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(screenshotFile, Buffer.from(screenshot.data, "base64"));

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 500,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const augmentCardEvaluation = await cdp.send("Runtime.evaluate", {
    expression: `
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const clickByText = (selector, label) => {
          const target = Array.from(document.querySelectorAll(selector)).find((element) => (
            (element.getAttribute('aria-label') || '').includes(label)
            || (element.textContent || '').includes(label)
          ));
          if (!target) throw new Error('missing control: ' + label);
          target.click();
        };
        if (document.querySelector('.menu-panel')) {
          clickByText('.topbar button', '菜单');
          await wait(100);
        }
        clickByText('.mode-grid button', '海克斯');
        for (let attempt = 0; attempt < 40 && !document.querySelector('.decision-input-card'); attempt += 1) await wait(50);
        clickByText('.decision-tier-selector button', '金色');
        await wait(250);
        const firstCandidate = document.querySelector('.candidate-row input[role="combobox"]');
        const firstCandidateControl = firstCandidate?.closest('.catalog-combobox-control');
        firstCandidateControl?.querySelector('button')?.click();
        await wait(80);
        const currentStageDropdownText = Array.from(document.querySelectorAll('.candidate-row:first-child .catalog-combobox-list button'))
          .map((element) => (element.textContent || '').trim());
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const crossStageAugmentName = window.__JCC_RUNTIME_PREVIEW_CAPABILITIES__?.test_cross_stage_augment_name;
        if (!crossStageAugmentName) throw new Error('missing active cross-stage augment fixture');
        inputSetter.call(firstCandidate, crossStageAugmentName);
        firstCandidate.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(450);
        const searchedStageMismatch = Array.from(document.querySelectorAll('.candidate-row:first-child .catalog-combobox-list button'))
          .find((element) => (element.textContent || '').includes(crossStageAugmentName));
        const chooseFirstEligibleOption = async (row) => {
          const input = row.querySelector('input[role="combobox"]');
          inputSetter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(80);
          let option = Array.from(row.querySelectorAll('.catalog-combobox-list button')).find((element) => !element.disabled);
          if (!option) {
            input.closest('.catalog-combobox-control')?.querySelector('button')?.click();
            await wait(80);
            option = Array.from(row.querySelectorAll('.catalog-combobox-list button')).find((element) => !element.disabled);
          }
          if (!option) throw new Error('missing current-stage candidate option');
          option.click();
          await wait(80);
        };
        const candidateRows = Array.from(document.querySelectorAll('.candidate-row'));
        for (const row of candidateRows) await chooseFirstEligibleOption(row);
        candidateRows[0].querySelector('.candidate-confirm input')?.click();
        await wait(80);
        document.querySelector('.decision-confirm-button')?.click();
        await wait(350);
        const submissionLog = window.__JCC_RUNTIME_PREVIEW_CAPABILITIES__?.submission_log || [];
        const finalConfirmIndex = submissionLog.findIndex((entry) => entry.action === 'confirmDecisionSelection');
        const precedingSubmit = finalConfirmIndex > 0 ? submissionLog[finalConfirmIndex - 1] : null;
        const componentInput = document.querySelector('input[aria-label="散件装备"]');
        componentInput.closest('.catalog-combobox-control')?.querySelector('button')?.click();
        await wait(80);
        const componentDropdownText = Array.from(componentInput.closest('.equipment-category').querySelectorAll('.catalog-combobox-list button'))
          .map((element) => (element.textContent || '').trim());
        inputSetter.call(componentInput, '攻速');
        componentInput.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(80);
        const componentAliasDropdownText = Array.from(componentInput.closest('.equipment-category').querySelectorAll('.catalog-combobox-list button'))
          .map((element) => (element.textContent || '').trim());
        componentInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        inputSetter.call(componentInput, '');
        componentInput.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(30);
        const completedCategory = Array.from(document.querySelectorAll('.equipment-category'))
          .find((element) => (element.querySelector('.equipment-category-title span')?.textContent || '').trim() === '成装');
        const frontlineFacet = Array.from(completedCategory.querySelectorAll('.equipment-facets button'))
          .find((element) => (element.textContent || '').trim() === '前排');
        frontlineFacet?.click();
        completedCategory.querySelector('.catalog-combobox-control button')?.click();
        await wait(80);
        const completedFrontlineDropdownText = Array.from(completedCategory.querySelectorAll('.catalog-combobox-list button'))
          .map((element) => (element.textContent || '').trim());
        const equipmentCategoryBoxes = Array.from(document.querySelectorAll('.equipment-category')).map((element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, top: box.top, width: box.width };
        });
        const componentCategory = componentInput.closest('.equipment-category');
        const addCustomComponent = async () => {
          inputSetter.call(componentInput, '自定义散件');
          componentInput.dispatchEvent(new Event('input', { bubbles: true }));
          componentInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await wait(180);
        };
        await addCustomComponent();
        await addCustomComponent();
        const duplicateCountAfterAdd = Array.from(componentCategory.querySelectorAll('.token-input > button'))
          .filter((element) => (element.textContent || '').includes('自定义散件')).length;
        Array.from(componentCategory.querySelectorAll('.token-input > button'))
          .find((element) => (element.textContent || '').includes('自定义散件'))?.click();
        await wait(180);
        const duplicateCountAfterClick = Array.from(componentCategory.querySelectorAll('.token-input > button'))
          .filter((element) => (element.textContent || '').includes('自定义散件')).length;
        componentInput.focus();
        componentInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
        await wait(180);
        const duplicateCountAfterBackspace = Array.from(componentCategory.querySelectorAll('.token-input > button'))
          .filter((element) => (element.textContent || '').includes('自定义散件')).length;
        const radiantCategory = Array.from(document.querySelectorAll('.equipment-category'))
          .find((element) => (element.querySelector('.equipment-category-title span')?.textContent || '').trim() === '光明装备');
        radiantCategory?.querySelector('.catalog-combobox-control button')?.click();
        await wait(80);
        const radiantDropdownText = Array.from(radiantCategory?.querySelectorAll('.catalog-combobox-list button') || [])
          .map((element) => (element.textContent || '').trim());
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const draftProbe = 'draft-preservation-probe';
        const draftProbeInput = document.querySelector('.candidate-row input[role="combobox"]');
        inputSetter.call(draftProbeInput, draftProbe);
        draftProbeInput.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(80);
        const modeButtons = Array.from(document.querySelectorAll('.mode-grid button'));
        const augmentModeButton = modeButtons.find((element) => element.getAttribute('aria-current') === 'page');
        const cruiseModeButton = modeButtons[0];
        cruiseModeButton?.click();
        for (let attempt = 0; attempt < 40 && document.querySelector('.decision-input-card'); attempt += 1) await wait(50);
        augmentModeButton?.click();
        for (let attempt = 0; attempt < 40 && !document.querySelector('.decision-input-card'); attempt += 1) await wait(50);
        const restoredDraftValue = document.querySelector('.candidate-row input[role="combobox"]')?.value || '';
        const card = document.querySelector('.decision-input-card');
        const composer = document.querySelector('.composer');
        const body = document.querySelector('.decision-card-body');
        const rect = (node) => {
          if (!node) return null;
          const box = node.getBoundingClientRect();
          return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
        };
        return {
          viewport: { width: innerWidth, height: innerHeight },
          card: rect(card),
          composer: rect(composer),
          body_scrollable: Boolean(body && body.scrollHeight > body.clientHeight + 1),
          stage_tabs: Array.from(document.querySelectorAll('.decision-tabs button')).map((element) => (element.textContent || '').trim()),
          candidate_inputs: document.querySelectorAll('.candidate-row input[role="combobox"]').length,
          equipment_sections: Array.from(document.querySelectorAll('.equipment-category-title span')).map((element) => (element.textContent || '').trim()),
          advice_labels: Array.from(document.querySelectorAll('.decision-actions button')).map((element) => (element.textContent || '').trim()),
          has_final_confirmation: Boolean(document.querySelector('.decision-confirm-button')),
          draft_mode_roundtrip: {
            expected: draftProbe,
            restored: restoredDraftValue,
          },
          stage_discovery: {
            cross_stage_augment_name: crossStageAugmentName,
            empty_dropdown_contains_cross_stage: currentStageDropdownText.some((text) => text.includes(crossStageAugmentName)),
            empty_dropdown_contains_chef: currentStageDropdownText.some((text) => text.includes('厨神阿福')),
            typed_search_found_cross_stage: Boolean(searchedStageMismatch),
            typed_search_disables_cross_stage: Boolean(searchedStageMismatch?.disabled),
            typed_search_label: searchedStageMismatch?.textContent?.trim() || null,
          },
          final_confirmation_flow: {
            final_confirm_index: finalConfirmIndex,
            preceding_action: precedingSubmit?.action || null,
            preceding_payload_action: precedingSubmit?.payload?.action || null,
            preceding_payload_requests_advice: precedingSubmit?.payload?.request_advice ?? null,
            preceding_payload_has_equipment: Object.prototype.hasOwnProperty.call(precedingSubmit?.payload || {}, 'equipment'),
          },
          equipment_token_flow: {
            duplicate_count_after_add: duplicateCountAfterAdd,
            duplicate_count_after_click: duplicateCountAfterClick,
            duplicate_count_after_backspace: duplicateCountAfterBackspace,
          },
          equipment_dropdowns: {
            component_labels: componentDropdownText,
            component_alias_labels: componentAliasDropdownText,
            completed_frontline_labels: completedFrontlineDropdownText,
            radiant_labels: radiantDropdownText,
            category_boxes: equipmentCategoryBoxes,
          },
          menu_panel_visible: Boolean(document.querySelector('.menu-panel')),
          horizontal_overflow: document.documentElement.scrollWidth - innerWidth,
          vertical_overflow: document.documentElement.scrollHeight - innerHeight,
        };
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  if (augmentCardEvaluation.exceptionDetails) {
    throw new Error(augmentCardEvaluation.exceptionDetails.exception?.description || augmentCardEvaluation.exceptionDetails.text);
  }
  const augmentCard = augmentCardEvaluation.result?.value;
  assert(augmentCard?.card && augmentCard?.composer, "augment structured card and composer must render");
  assert(augmentCard.card.height >= augmentCard.viewport.height * 0.45, "augment card should receive roughly half of the live-coach viewport");
  assert(augmentCard.card.bottom <= augmentCard.composer.top + 1, "augment card must not overlap the composer");
  assert.deepEqual(augmentCard.stage_tabs, ["2-1", "3-2", "4-2"], "augment card must expose exact decision checkpoints");
  assert.equal(augmentCard.candidate_inputs, 3, "augment card must expose three searchable candidate slots");
  for (const equipmentSection of ["散件", "成装", "光明装备", "神器", "纹章"]) {
    assert(augmentCard.equipment_sections.includes(equipmentSection), `augment card must expose shared equipment section: ${equipmentSection}`);
  }
  assert.equal(augmentCard.advice_labels.filter((label) => label === "获取建议").length, 1, "augment card must expose exactly one context-complete advice action");
  assert.equal(augmentCard.advice_labels.some((label) => label.includes("只看当前选择") || label.includes("整体获取建议")), false, "augment card must not expose redundant advice variants");
  assert.equal(augmentCard.has_final_confirmation, true, "augment card must expose final confirmation");
  assert.equal(augmentCard.draft_mode_roundtrip?.restored, augmentCard.draft_mode_roundtrip?.expected, "unsubmitted augment draft must survive Cruise mode round-trip inside the same match");
  assert.equal(augmentCard.stage_discovery?.empty_dropdown_contains_cross_stage, false, `2-1 gold dropdown must exclude active cross-stage augment ${augmentCard.stage_discovery?.cross_stage_augment_name}`);
  assert.equal(augmentCard.stage_discovery?.empty_dropdown_contains_chef, true, "2-1 gold dropdown must include source-backed 厨神阿福");
  assert.equal(augmentCard.stage_discovery?.typed_search_found_cross_stage, true, "typed search must still find cross-stage catalog entries");
  assert.equal(augmentCard.stage_discovery?.typed_search_disables_cross_stage, true, "known cross-stage search results must be visible but not confirmable");
  assert(augmentCard.final_confirmation_flow?.final_confirm_index > 0, "dirty final confirmation must reach the runtime bridge");
  assert.equal(augmentCard.final_confirmation_flow?.preceding_action, "submitDecisionInput", "dirty final confirmation must first save the current candidate set");
  assert.equal(augmentCard.final_confirmation_flow?.preceding_payload_action, "choice_update", "dirty final confirmation pre-save must be a no-model choice update");
  assert.equal(augmentCard.final_confirmation_flow?.preceding_payload_requests_advice, false, "dirty final confirmation pre-save must not request a Host answer");
  assert.equal(augmentCard.final_confirmation_flow?.preceding_payload_has_equipment, false, "dirty final confirmation must not implicitly rewrite shared equipment");
  assert.equal(augmentCard.equipment_token_flow?.duplicate_count_after_add, 2, "owned equipment must allow two copies of the same token");
  assert.equal(augmentCard.equipment_token_flow?.duplicate_count_after_click, 1, "clicking a duplicate equipment token must remove one copy only");
  assert.equal(augmentCard.equipment_token_flow?.duplicate_count_after_backspace, 0, "empty Backspace must remove one remaining whole token");
  assert(augmentCard.equipment_dropdowns?.component_labels?.some((label) => label.includes("暴风之剑")), "component dropdown arrow must expose selectable components");
  assert.deepEqual(augmentCard.equipment_dropdowns?.component_alias_labels, ["1002 | 反曲之弓"], "shared confirmed-equipment search must resolve 攻速 to 反曲之弓 in augment mode");
  assert(augmentCard.equipment_dropdowns?.completed_frontline_labels?.length > 0, "completed-item frontline facet must expose selectable completed items");
  assert(augmentCard.equipment_dropdowns?.radiant_labels?.some((label) => label.includes("光明版")), "radiant owned-equipment dropdown must expose radiant items");
  const equipmentBoxes = augmentCard.equipment_dropdowns?.category_boxes || [];
  assert.equal(equipmentBoxes.length, 7, "shared equipment editor must render all seven canonical inventory category rows");
  assert(equipmentBoxes.every((box) => Math.abs(box.left - equipmentBoxes[0].left) <= 1 && Math.abs(box.width - equipmentBoxes[0].width) <= 1), "shared equipment categories must use one aligned full-width column");
  assert(equipmentBoxes.slice(1).every((box, index) => box.top > equipmentBoxes[index].top), "shared equipment categories must stack vertically instead of using two columns");
  assert.equal(augmentCard.menu_panel_visible, false, "augment card screenshot must not be covered by the settings menu");
  assert(augmentCard.horizontal_overflow <= 1, "augment card must not overflow horizontally");
  assert(augmentCard.vertical_overflow <= 1, "augment card must not overflow vertically");
  const augmentImage = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(augmentCardScreenshotFile, Buffer.from(augmentImage.data, "base64"));

  const itemCardEvaluation = await cdp.send("Runtime.evaluate", {
    expression: `
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const modeButton = Array.from(document.querySelectorAll('.mode-grid button'))
          .find((element) => (element.textContent || '').trim() === '装备');
        if (!modeButton) throw new Error('item mode is missing from the match rail');
        modeButton.click();
        for (let attempt = 0; attempt < 40 && !document.querySelector('.decision-mode-item'); attempt += 1) await wait(50);
        await wait(180);
        const selectKind = async (label) => {
          const button = Array.from(document.querySelectorAll('.decision-mode-item .decision-tabs button'))
            .find((element) => (element.textContent || '').trim() === label);
          if (!button) throw new Error('missing item kind: ' + label);
          button.click();
          await wait(220);
        };
        const candidateLabels = async () => {
          const input = document.querySelector('.decision-mode-item .candidate-row input[role="combobox"]');
          input?.closest('.catalog-combobox-control')?.querySelector('button')?.click();
          await wait(80);
          return Array.from(input?.closest('.candidate-field')?.querySelectorAll('.catalog-combobox-list button') || [])
            .map((element) => (element.textContent || '').trim());
        };
        const chooseFacet = async (label) => {
          const button = Array.from(document.querySelectorAll('.decision-mode-item .decision-item-facets button'))
            .find((element) => (element.textContent || '').trim() === label);
          if (!button) throw new Error('missing item facet: ' + label);
          button.click();
          await wait(80);
        };
        const result = { counts: {}, labels: {} };
        await selectKind('基础装备锻造器');
        result.counts.components = document.querySelectorAll('.decision-mode-item .candidate-row').length;
        result.labels.components = await candidateLabels();
        await selectKind('成装锻造器');
        await chooseFacet('物理');
        result.counts.completed = document.querySelectorAll('.decision-mode-item .candidate-row').length;
        result.labels.completed = await candidateLabels();
        await selectKind('神器锻造器');
        await chooseFacet('物理');
        result.counts.artifacts = document.querySelectorAll('.decision-mode-item .candidate-row').length;
        result.labels.artifacts = await candidateLabels();
        await selectKind('光明装备选择');
        await chooseFacet('物理');
        result.counts.radiant = document.querySelectorAll('.decision-mode-item .candidate-row').length;
        result.labels.radiant = await candidateLabels();
        result.kind_tabs = Array.from(document.querySelectorAll('.decision-mode-item .decision-tabs button'))
          .map((element) => (element.textContent || '').trim());
        result.equipment_sections = Array.from(document.querySelectorAll('.equipment-category-title span'))
          .map((element) => (element.textContent || '').trim());
        await selectKind('神器锻造器');
        const submissionLog = window.__JCC_RUNTIME_PREVIEW_CAPABILITIES__.submission_log;
        const fillAndConfirm = async () => {
          const inputs = Array.from(document.querySelectorAll('.decision-mode-item .candidate-row input[role="combobox"]'));
          for (let index = 0; index < inputs.length; index += 1) {
            inputs[index].closest('.catalog-combobox-control').querySelector('button').click();
            await wait(100);
            const options = Array.from(inputs[index].closest('.candidate-field').querySelectorAll('.catalog-combobox-list button'))
              .filter((button) => !button.disabled);
            if (options.length <= index) throw new Error('not enough forge options for browser confirmation');
            options[index].click();
            await wait(80);
          }
          document.querySelector('.decision-mode-item .candidate-row input[type="radio"]').click();
          await wait(80);
          const confirm = document.querySelector('.decision-mode-item .decision-confirm-button');
          if (confirm.disabled) throw new Error('forge confirmation unexpectedly disabled');
          const previousCount = submissionLog.filter((entry) => entry.action === 'confirmDecisionSelection').length;
          confirm.click();
          for (let attempt = 0; attempt < 60; attempt += 1) {
            await wait(50);
            const confirms = submissionLog.filter((entry) => entry.action === 'confirmDecisionSelection');
            if (confirms.length > previousCount) return confirms.at(-1).payload;
          }
          throw new Error('forge confirmation did not reach the bridge');
        };
        const firstForge = await fillAndConfirm();
        const nextChoice = Array.from(document.querySelectorAll('.decision-mode-item button'))
          .find((button) => (button.textContent || '').trim() === '下一次装备选择');
        if (!nextChoice) throw new Error('next equipment choice control is missing');
        nextChoice.click();
        await wait(250);
        const cleared = Array.from(document.querySelectorAll('.decision-mode-item .candidate-row input[role="combobox"]'))
          .every((input) => input.value === '');
        const secondForge = await fillAndConfirm();
        result.independent_forge_windows = {
          first_id: firstForge.choice_window_instance_id,
          second_id: secondForge.choice_window_instance_id,
          first_binding_id: firstForge.payload_binding?.choice_window_instance_id,
          second_binding_id: secondForge.payload_binding?.choice_window_instance_id,
          same_stage: Boolean(firstForge.stage_round) && firstForge.stage_round === secondForge.stage_round,
          cleared,
        };
        result.horizontal_overflow = document.documentElement.scrollWidth - innerWidth;
        result.vertical_overflow = document.documentElement.scrollHeight - innerHeight;
        return result;
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  if (itemCardEvaluation.exceptionDetails) {
    throw new Error(itemCardEvaluation.exceptionDetails.exception?.description || itemCardEvaluation.exceptionDetails.text);
  }
  const itemCard = itemCardEvaluation.result?.value;
  assert.deepEqual(itemCard.kind_tabs, ["基础装备锻造器", "成装锻造器", "神器锻造器", "光明装备选择"], "item card must expose four isolated choice kinds");
  assert.deepEqual(itemCard.counts, { components: 4, completed: 5, artifacts: 4, radiant: 4 }, "item choice kinds must use their contracted slot counts");
  assert(itemCard.labels.components.length > 0 && itemCard.labels.components.every((label) => !label.includes("光明版") && !label.includes("大亨之铠")), "component forge must contain only components");
  assert(itemCard.labels.completed.length > 0 && itemCard.labels.completed.every((label) => !label.includes("光明版") && !label.includes("大亨之铠")), "completed forge must contain only standard completed items");
  assert(itemCard.labels.artifacts.length > 0 && itemCard.labels.artifacts.every((label) => !label.includes("光明版")), "artifact forge physical facet must contain artifact candidates only");
  assert(itemCard.labels.radiant.length > 0 && itemCard.labels.radiant.every((label) => label.includes("光明版")), "radiant choice physical facet must contain radiant candidates only");
  assert(itemCard.equipment_sections.includes("光明装备"), "item card must inherit radiant owned equipment");
  const forgeWindows = itemCard.independent_forge_windows;
  assert(forgeWindows?.first_id && forgeWindows?.second_id, "both forge confirmations must carry a window identity");
  assert.notEqual(forgeWindows.first_id, forgeWindows.second_id, "independent same-stage forges need different identities");
  assert.equal(forgeWindows.first_id, forgeWindows.first_binding_id, "first forge binding must match its window");
  assert.equal(forgeWindows.second_id, forgeWindows.second_binding_id, "second forge binding must match its window");
  assert.equal(forgeWindows.same_stage, true, "the regression must exercise two forges in the same stage");
  assert.equal(forgeWindows.cleared, true, "starting the next forge must clear the previous candidate draft");
  assert(itemCard.horizontal_overflow <= 1, "item card must not overflow horizontally");
  assert(itemCard.vertical_overflow <= 1, "item card must not overflow vertically");
  const itemImage = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(itemCardScreenshotFile, Buffer.from(itemImage.data, "base64"));

  const captureMainView = async (width, height, outputFile) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const layout = await cdp.send("Runtime.evaluate", {
      expression: `
        (async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const click = (selector, label) => {
            const target = Array.from(document.querySelectorAll(selector)).find((element) => (
              (element.getAttribute('aria-label') || '').includes(label)
              || (element.textContent || '').includes(label)
            ));
            if (!target) throw new Error('missing control: ' + label);
            target.click();
          };
          for (let attempt = 0; attempt < 40 && !document.querySelector('button'); attempt += 1) await wait(50);
          click('button', '开局');
          await wait(150);
          const rect = (selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const box = node.getBoundingClientRect();
            return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
          };
          const pinnedBody = document.querySelector('.pinned-body');
          return {
            viewport: { width: innerWidth, height: innerHeight },
            app: rect('.app-shell'),
            pinned: rect('.pinned-card'),
            chat: rect('.chat-stream-wrap'),
            composer: rect('.composer'),
            horizontal_overflow: document.documentElement.scrollWidth - innerWidth,
            vertical_overflow: document.documentElement.scrollHeight - innerHeight,
            pinned_body_scrollable: Boolean(pinnedBody && pinnedBody.scrollHeight > pinnedBody.clientHeight + 1),
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    if (layout.exceptionDetails) throw new Error(layout.exceptionDetails.exception?.description || layout.exceptionDetails.text);
    const metrics = layout.result?.value;
    assert(metrics?.app && metrics?.pinned && metrics?.chat && metrics?.composer, `${width}x${height}: main live-coach regions must render`);
    assert(metrics.horizontal_overflow <= 1, `${width}x${height}: renderer must not overflow horizontally`);
    assert(metrics.vertical_overflow <= 1, `${width}x${height}: renderer must not overflow vertically`);
    assert(metrics.pinned.bottom <= metrics.chat.top + 1, `${width}x${height}: pinned card must not overlap the chat stream`);
    assert(metrics.chat.bottom <= metrics.composer.top + 1, `${width}x${height}: chat stream must not overlap the composer`);
    assert(metrics.composer.bottom <= height + 1, `${width}x${height}: composer must remain inside the viewport`);
    assert(metrics.chat.height >= (height <= 625 ? 48 : 120), `${width}x${height}: chat stream must retain usable scan space`);
    const image = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(outputFile, Buffer.from(image.data, "base64"));
    return metrics;
  };

  const compactMain = await captureMainView(500, 625, compactMainScreenshotFile);
  const wideMain = await captureMainView(900, 800, wideMainScreenshotFile);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-pinned-card-browser-verification-v1",
    result,
    main_layouts: { compact: compactMain, wide: wideMain, augment_card: augmentCard, item_card: itemCard },
    screenshots: {
      menu: screenshotFile,
      compact_main: compactMainScreenshotFile,
      wide_main: wideMainScreenshotFile,
      augment_card: augmentCardScreenshotFile,
      item_card: itemCardScreenshotFile,
    },
  }, null, 2)}\n`);
} finally {
  cdp?.close();
  await Promise.all([
    terminateProcessTree(chrome),
    terminateProcessTree(ownedVite),
  ]);
  await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
