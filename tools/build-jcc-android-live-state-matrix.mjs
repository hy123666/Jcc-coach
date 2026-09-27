import { readFile, writeFile } from "node:fs/promises";

const SCHEMA_PATH = "data/runtime/jcc/android-live-state-schema.json";
const MATRIX_PATH = "data/runtime/jcc/android-live-state-field-evidence-matrix.json";
const EVIDENCE_PACKET = ".omx/runtime-evidence/android-probe-ingame-20260605-214908/match-live-state.json";

const VERIFIED = {
  "match.game_start_time": {
    source_type: "external_file",
    observed_pattern: "GameStart time:<yyyymmddhhmmss>",
    extractor: "tools/extract-jcc-android-runtime-signals.mjs:match_start",
    confidence: 0.9,
    freshness_budget: "per_match",
    evidence_packet: EVIDENCE_PACKET,
    evidence_status: "real_mumu_packet_verified",
  },
  "local.local_chair_id": {
    source_type: "external_file",
    observed_pattern: "#SoGame_Report# ... chairid:<n>",
    extractor: "tools/build-jcc-match-live-state.mjs:bindLocalChair",
    confidence: 0.9,
    freshness_budget: "bind_on_each_GameStart",
    evidence_packet: EVIDENCE_PACKET,
    evidence_status: "real_mumu_packet_verified",
  },
  "local.binding_status": {
    source_type: "semantic_normalizer",
    observed_pattern: "local_report_chair_candidate -> strongly_bound",
    extractor: "tools/build-jcc-match-live-state.mjs:bindLocalChair",
    confidence: 0.9,
    freshness_budget: "bind_on_each_GameStart",
    evidence_packet: EVIDENCE_PACKET,
    evidence_status: "real_mumu_packet_verified",
  },
  "local.binding_source": {
    source_type: "semantic_normalizer",
    observed_pattern: "local_report_chair_candidate",
    extractor: "tools/build-jcc-match-live-state.mjs:bindLocalChair",
    confidence: 0.9,
    freshness_budget: "bind_on_each_GameStart",
    evidence_packet: EVIDENCE_PACKET,
    evidence_status: "real_mumu_packet_verified",
  },
  "local.binding_confidence": {
    source_type: "semantic_normalizer",
    observed_pattern: "max(0.9, signal confidence)",
    extractor: "tools/build-jcc-match-live-state.mjs:bindLocalChair",
    confidence: 0.9,
    freshness_budget: "bind_on_each_GameStart",
    evidence_packet: EVIDENCE_PACKET,
    evidence_status: "real_mumu_packet_verified",
  },
  "local.binding_evidence": {
    source_type: "external_file",
    observed_pattern: "#SoGame_Report# ... chairid:<n>",
    extractor: "tools/build-jcc-match-live-state.mjs:bindLocalChair",
    confidence: 0.9,
    freshness_budget: "bind_on_each_GameStart",
    evidence_packet: EVIDENCE_PACKET,
    evidence_status: "real_mumu_packet_verified",
  },
  "economy.hp": {
    source_type: "external_file",
    observed_pattern: "interalBattle pPlayer life ... ChairId:<local_chair_id>",
    extractor: "tools/build-jcc-match-live-state.mjs:latestPlayerLife",
    confidence: 0.72,
    freshness_budget: "after_battle_event",
    evidence_packet: EVIDENCE_PACKET,
    evidence_status: "real_mumu_packet_verified",
  },
  "shop.shop_units": {
    source_type: "external_file",
    observed_pattern: "TAC_GenerateHeroListFromHeroPool:<hero_ids>",
    extractor: "tools/build-jcc-match-live-state.mjs:latestShopCandidates",
    confidence: 0.86,
    freshness_budget: "per_shop_refresh",
    evidence_packet: EVIDENCE_PACKET,
    evidence_status: "real_mumu_packet_verified",
  },
};

const PARTIAL = {
  "match.game_end_time": "Builder supports match_end candidate gating, but real postgame end boundary has not been observed in current MuMu packet.",
  "match.status": "GameStart/no-end normalizes to in_game and synthetic match_end gates strategy, but real postgame end boundary is not observed yet.",
  "match.set": "Set id appears in round payloads and catalog, but runtime source is not normalized yet.",
  "phase.round": "Turn markers exist, but stage-round semantics are not mapped.",
  "phase.turn_count": "SoGame report turn_count exists, but lifecycle relation needs calibration.",
  "items.loot_orbs": "Equipment bag refill and item drop hints exist, but inventory semantics are not mapped.",
  "augments.choices": "Augment UI/assets appear in logs, but local three-choice options are not proven.",
  "augments.selected_augments": "add Hextech signals exist, but local selected augment mapping is not proven.",
  "opponents.alive_count": "Latest player_life by player chair can derive alive chairs, but rank/elimination semantics still need postgame calibration.",
  "combat.opponent_chair_id": "Battle pairing signals exist, but current local combat opponent selection needs calibration.",
  "combat.is_home_board": "Battle pairing bIsHome exists, but route into live_state is not implemented.",
  "combat.earned_money": "Battle earned money signals exist, but local-chair filtering is not implemented.",
};

function defaultBlocker(fieldKey) {
  if (fieldKey.startsWith("board.")) return "No verified board unit/position signal in current evidence packet.";
  if (fieldKey.startsWith("bench.")) return "No verified bench slot signal in current evidence packet.";
  if (fieldKey.startsWith("items.")) return "Only item/drop hints are visible; item bench/equipped mapping is not proven.";
  if (fieldKey.startsWith("phase.")) return "Phase/timer semantics require targeted capture across planning/combat/choice screens.";
  if (fieldKey.startsWith("economy.")) return "No verified local-player economy signal for this field in current evidence packet.";
  if (fieldKey.startsWith("traits.")) return "Trait state is not mapped from runtime signals yet.";
  if (fieldKey.startsWith("carousel.")) return "No carousel-stage evidence packet captured yet.";
  if (fieldKey.startsWith("rewards.")) return "No reward-choice/anvil evidence packet captured yet.";
  if (fieldKey.startsWith("actions.")) return "Action availability needs phase and UI-state mapping first.";
  if (fieldKey.startsWith("metadata.")) return "Transport/source probe metadata is not yet wired into live_state output.";
  return "No verified runtime signal is mapped for this field yet.";
}

function nextExperiment(fieldKey) {
  if (fieldKey.startsWith("board.") || fieldKey.startsWith("bench.")) return "Capture planning phase after moving units; diff logcat/external files for board/bench signals.";
  if (fieldKey.startsWith("items.")) return "Capture creep loot, item bench, equip, remover/reforger/anvil screens and diff signals.";
  if (fieldKey.startsWith("augments.")) return "Pause on augment selection and capture ADB/logcat/external-file delta.";
  if (fieldKey.startsWith("carousel.")) return "Capture carousel stage with available unit+item list visible.";
  if (fieldKey.startsWith("rewards.")) return "Capture item-anvil/god-reward/choice UI screens.";
  if (fieldKey.startsWith("opponents.")) return "Scout an opponent board and capture local/current observer signals.";
  if (fieldKey.startsWith("phase.") || fieldKey.startsWith("actions.")) return "Capture all phase transitions: loading/opening/planning/combat/post_combat/choice.";
  if (fieldKey.startsWith("metadata.")) return "Run generic ADB source probe and write probe health into live_state metadata.";
  return "Run targeted ADB source capture and update extractor only after evidence is observed.";
}

async function main() {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  const fields = [];
  for (const [section, spec] of Object.entries(schema.sections)) {
    for (const field of spec.fields) {
      const fieldKey = `${section}.${field.key}`;
      if (VERIFIED[fieldKey]) {
        fields.push({
          field_key: fieldKey,
          meaning: `${spec.label}: ${field.key}`,
          status: "verified",
          blocker: null,
          next_experiment: null,
          ...VERIFIED[fieldKey],
        });
      } else if (PARTIAL[fieldKey]) {
        fields.push({
          field_key: fieldKey,
          meaning: `${spec.label}: ${field.key}`,
          source_type: "external_file",
          observed_pattern: "candidate signals observed but not fully normalized",
          extractor: "pending",
          confidence: 0.4,
          freshness_budget: "unknown_until_mapped",
          evidence_packet: EVIDENCE_PACKET,
          evidence_status: "partial_evidence_only",
          status: "partial",
          blocker: PARTIAL[fieldKey],
          next_experiment: nextExperiment(fieldKey),
        });
      } else {
        fields.push({
          field_key: fieldKey,
          meaning: `${spec.label}: ${field.key}`,
          source_type: "unknown",
          observed_pattern: "not observed in current evidence packet",
          extractor: "none",
          confidence: 0,
          freshness_budget: "unknown_until_mapped",
          evidence_packet: null,
          evidence_status: "missing",
          status: "missing",
          blocker: defaultBlocker(fieldKey),
          next_experiment: nextExperiment(fieldKey),
        });
      }
    }
  }

  const matrix = {
    contract_id: "jcc-android-runtime-field-evidence-matrix",
    generated_from_schema: SCHEMA_PATH.replaceAll("\\", "/"),
    evidence_policy: "A field is verified only when a real evidence packet or focused synthetic verifier proves the source and normalization path. Otherwise it must remain partial/missing/blocked/fallback_only with blocker and next_experiment.",
    fields,
  };
  await writeFile(MATRIX_PATH, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, out: MATRIX_PATH, field_count: fields.length }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
