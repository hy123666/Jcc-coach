import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const ownedAugmentTextPanelPreset =
  "\u6211\u5df2\u70b9\u5f00\u5df2\u62e5\u6709\u5f3a\u5316\u7b26\u6587\uff0c\u8bfb\u53d6\u8fd9\u4e2a\u5f3a\u5316";
const ownedAugmentTextPanelHint =
  "\u5148\u5728\u6e38\u620f\u91cc\u70b9\u5f00\u53f3\u4fa7\u201c\u5df2\u62e5\u6709\u5f3a\u5316\u7b26\u6587\u201d\u9762\u677f";
const ownedAugmentTextPanelLabel = "\u8bfb\u53d6\u5df2\u9009\u5f3a\u5316";

async function main() {
  const appTsx = await readFile("ui/src/App.tsx", "utf8");
  const styles = await readFile("ui/src/styles.css", "utf8");
  const contract = JSON.parse(await readFile("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"));

  assert(appTsx.includes(`const ownedAugmentTextPanelPreset = "${ownedAugmentTextPanelPreset}";`), "App preset constant mismatch");
  assert(appTsx.includes(`const ownedAugmentTextPanelHint = "${ownedAugmentTextPanelHint}";`), "App hint constant mismatch");
  assert(appTsx.includes("activeMode === \"augment\""), "owned augment preset must be scoped to augment mode");
  assert(appTsx.includes("title={ownedAugmentTextPanelHint}"), "owned augment hint must be visible as a tooltip");
  assert(appTsx.includes(`aria-label={\`${ownedAugmentTextPanelLabel}\u3002${"${ownedAugmentTextPanelHint}"}\`}`), "owned augment button must expose hint to assistive tech");
  assert(appTsx.includes("const sendPreset = (text: string) => {"), "preset buttons must keep an explicit send helper");
  assert(appTsx.includes("onSend(next);"), "preset helper must send through the runtime path");
  assert(appTsx.includes("onClick={() => sendPreset(ownedAugmentTextPanelPreset)}"), "owned augment preset must send the clean runtime prompt");
  assert(appTsx.includes('mode?.candidateInputPolicy === "current_match_user_report"'), "augment candidate reporting must use the generic user-report mode contract");
  assert(appTsx.includes("onClick={() => prefillPreset(currentPrompt)}"), "augment candidate chip must prefill instead of sending immediately");
  assert(appTsx.includes("prefillPreset(refreshReportPrompt);"), "refresh-result chip must prefill the composer");
  assert(!appTsx.includes("onClick={onAugmentReroll}"), "refresh-result chip must not call the backend reroll path directly");
  assert(!appTsx.includes("onClick={() => sendPreset(\"\u9009\u54ea\u4e2a\uff1f\u8981\u4e0d\u8981\u5237\u65b0\uff1f\")}"), "augment candidate chip must not send the old generic choice text immediately");
  assert(!appTsx.includes("onClick={() => sendPreset(\"\u5237\u65b0\u6211\u65b9\u72b6\u6001\u3002\")}"), "refresh-result chip must not send refresh text immediately");
  assert(!appTsx.includes("onPreset(ownedAugmentTextPanelHint)"), "owned augment UI hint must never be sent as a runtime preset");
  assert(!appTsx.includes("onSend(ownedAugmentTextPanelHint)"), "owned augment UI hint must never be sent as user content");
  assert(!appTsx.includes("ownedAugmentTextPanelPreset + ownedAugmentTextPanelHint"), "owned augment preset and hint must not be concatenated");
  assert(styles.includes(".preset-hint"), "preset hint styling missing");
  assert(/\.preset-row\s*\{[\s\S]*?flex-wrap:\s*wrap;/.test(styles), "preset row must wrap so UI-only hints can sit below preset buttons");
  assert(/\.preset-hint\s*\{[\s\S]*?flex-basis:\s*100%;/.test(styles), "owned augment UI hint must occupy a full next line below preset buttons");
  assert(/\.preset-hint\s*\{[\s\S]*?white-space:\s*normal;/.test(styles), "owned augment UI hint must be allowed to wrap instead of forcing a same-line pill row");

  const panel = contract.modes?.augment_choice?.manual_owned_augment_text_panel || {};
  assert(panel.label === ownedAugmentTextPanelLabel, "contract label mismatch");
  assert(panel.prefill === ownedAugmentTextPanelPreset, "contract prefill mismatch");
  assert(panel.user_hint === ownedAugmentTextPanelHint, "contract user hint mismatch");
  assert(panel.user_hint_delivery === "ui_only_not_sent_to_runtime_or_host", "contract hint delivery policy mismatch");
  assert(!panel.prefill.includes(panel.user_hint), "contract prefill must not include UI-only hint text");
  assert(panel.placement === "augment_choice_mode_secondary_preset", "contract placement mismatch");
  assert(panel.trigger?.includes("user_clicks_owned_augment_detail_panel"), "contract trigger must require the in-game owned augment panel");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "augment mode exposes a visible owned-augment reader button",
      "the UI-only instruction is visible but not sent to runtime or host",
      "candidate reporting and refresh-result controls prefill without auto-send",
      "the runtime owned-augment preset remains a clean explicit send",
      "runtime UI mode contract documents the same split",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
