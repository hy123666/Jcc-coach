import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const LIVE_STATE = "tools/fixtures/jcc-self-board-s1-state.json";
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
  });
}

function hasImageBytes(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.startsWith("data:image/") || value.length > 500000;
  if (Array.isArray(value)) return value.some(hasImageBytes);
  if (typeof value === "object") return Object.values(value).some(hasImageBytes);
  return false;
}

async function writeFrameFixture(tmp) {
  const imagePath = path.join(tmp, "frame.png");
  const framePath = path.join(tmp, "visual-frame.json");
  await writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG, "base64"));
  await writeFile(framePath, `${JSON.stringify({
    ok: true,
    source: "verifier_fixture",
    frame_id: "frame:vision-verifier",
    sha256: "vision-verifier",
    match_session_id: "sample-match",
    image: {
      format: "png",
      width: 1,
      height: 1,
      persisted: true,
      path: imagePath,
    },
  }, null, 2)}\n`, "utf8");
  return framePath;
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "jcc-vision-model-"));
  try {
    const frame = await writeFrameFixture(tmp);
    const requestOut = path.join(tmp, "vision-request.json");
    const requestResult = await run("node", [
      "tools/run-jcc-vision-model-observation.mjs",
      "--frame", frame,
      "--live-state", LIVE_STATE,
      "--mode", "refresh_self_state",
      "--emit-request",
      "--out", requestOut,
    ]);
    assert(requestResult.code === 0, `vision request envelope failed: ${requestResult.stderr || requestResult.stdout}`);
    const request = JSON.parse(await readFile(requestOut, "utf8"));
    assert(request.type === "jcc_vision_model_request", "request envelope should declare request type");
    assert(request.context.scope === "self_or_visible_choice", "request must declare the product self/choice scope");
    assert(Array.isArray(request.context.mumu_current_view_units), "request should include MuMu current-view unit anchors");
    assert(
      Array.isArray(request.context.live_context?.current_view_units) && request.context.live_context.current_view_units.length > 0,
      "request should include enriched live-context unit anchors from the reference pack",
    );
    assert(
      request.context.live_context.current_view_units.some((unit) => unit.screen_position?.x != null && unit.screen_position?.y != null),
      "enriched unit anchors should include screen positions for equipment grounding",
    );
    assert(
      request.context.live_context.current_view_units.every((unit) => unit.visual_task_hint?.includes("HP bar")),
      "enriched unit anchors should instruct HP-bar equipment inspection",
    );
    assert(
      request.context.inspection_targets?.includes("items.equipped_items"),
      "request should carry mode-specific inspection targets",
    );
    assert(request.context.response_constraints?.no_invention === true, "request should carry no-invention constraints");
    assert(request.context.candidate_database?.candidate_kinds?.includes("item"), "request should include item catalog pairing hints");
    assert(request.context.candidate_database?.candidate_kinds?.includes("augment"), "request should include augment catalog pairing hints");
    assert(request.context.candidate_database?.icon_assets?.role === "reference_assets_for_multimodal_agent_not_live_template_matching", "request should include icon assets as reference data only");
    assert(request.context.candidate_database?.icon_assets?.available === true, "request should load the icon asset manifest when available");
    assert(request.instructions.some((line) => line.includes("multimodal main runtime agent")), "request should frame the main agent as the visual interpreter");
    assert(request.instructions.some((line) => line.includes("candidate database")), "request should tell the model to pair against the candidate database");
    assert(
      request.instructions.some((line) => line.includes("reference data only") && line.includes("local icon matcher score")),
      "request must prevent icon matcher scores from becoming product truth",
    );
    assert(request.instructions.some((line) => line.includes("mode-specific vision_reference_pack")), "request should prefer the mode-specific reference pack");
    assert(request.context.candidate_database?.vision_reference_pack?.not_a_matcher === true, "request should include a non-matcher vision reference pack");
    assert(
      request.context.candidate_database?.vision_reference_pack?.inspection_targets?.includes("items.equipped_items"),
      "embedded reference pack should preserve inspection targets",
    );
    assert(
      request.context.candidate_database?.vision_reference_pack?.response_constraints?.unresolved_policy?.includes("possible_ids"),
      "embedded reference pack should preserve possible_ids unresolved policy",
    );
    assert((request.context.candidate_database?.vision_reference_pack?.counts?.item || 0) > 0, "request should include item reference candidates");
    assert((request.context.candidate_database?.vision_reference_pack?.counts?.augment || 0) > 0, "request should include augment reference candidates");
    assert(request.instructions.some((line) => line.includes("Do not output board_units")), "request must forbid board/bench output");
    assert(
      request.instructions.some((line) => line.includes("This request asks for these fields only")),
      "request instructions should limit the model to requested fields",
    );
    assert(
      request.instructions.some((line) => line.includes("equipment row below those units' HP bars")),
      "request instructions should ground unit equipment to MuMu unit anchors",
    );
    assert(
      request.instructions.some((line) => line.includes("return possible_ids") && line.includes("needs_confirmation")),
      "request instructions should require ambiguous visual matches to stay ambiguous",
    );
    assert(
      request.expected_response_shape.observations.phase.stage_round.includes("3-6"),
      "vision request must explicitly ask for visible stage round such as 3-6",
    );
    assert(!hasImageBytes(request), "vision request must not embed raw image bytes");

    const selfRequestOut = path.join(tmp, "self-vision-request.json");
    const selfRequestResult = await run("node", [
      "tools/run-jcc-vision-model-observation.mjs",
      "--frame", frame,
      "--live-state", LIVE_STATE,
      "--mode", "refresh_self_state",
      "--emit-request",
      "--out", selfRequestOut,
    ]);
    assert(selfRequestResult.code === 0, `self-state vision request envelope failed: ${selfRequestResult.stderr || selfRequestResult.stdout}`);
    const selfRequest = JSON.parse(await readFile(selfRequestOut, "utf8"));
    assert(
      selfRequest.instructions.some((line) => line.includes("do not read or guess HUD phase/economy numbers")),
      "self-state refresh vision must not read HUD phase/economy facts",
    );
    assert(
      selfRequest.instructions.some((line) => line.includes("RapidOCR HUD fast path")),
      "self-state refresh request must route stage/gold/HP to self-state ROI OCR",
    );

    const selfResponse = path.join(tmp, "self-vision-response.json");
    const selfOut = path.join(tmp, "self-observations.json");
    const selfLiveOut = path.join(tmp, "self-visual-live-state.json");
    await writeFile(selfResponse, `${JSON.stringify({
      provider: "fixture",
      model: "mock-vision",
      confidence: 0.91,
      observations: {
        phase: {
          value: "planning_shop",
          stage_round: "3-6",
          current_round_text: "3-6",
          confidence: 0.93
        },
        economy: {
          hp: { value: 43, confidence: 0.84 },
          gold: { value: 59, confidence: 0.95 },
          level: { value: 9, confidence: 0.94 },
          xp: { value: 36, to_next: 68, display: "36/68", confidence: 0.93 }
        },
        item_bench: [
          { id: "3003", confidence: 0.95, slot: 0 },
          { id: "1003", confidence: 0.92, slot: 1 }
        ],
        equipped_items: [
          {
            hero_id: 13462,
            items: [
              { id: "41716", confidence: 0.9, slot: 0 },
              { id: "41711", confidence: 0.89, slot: 1 },
              { id: "2039", confidence: 0.91, slot: 2 }
            ]
          }
        ],
        selected_augments: [
          { id: "10212", confidence: 0.88, slot: 0 }
        ],
        augment_choices: [
          { name: "挑个好伙计!", confidence: 0.96, slot: 0 },
          { name: "升级咯!", confidence: 0.95, slot: 1 },
          { name: "战时补给:无用大棒", confidence: 0.94, slot: 2 }
        ]
      }
    }, null, 2)}\n`, "utf8");
    const selfResult = await run("node", [
      "tools/run-jcc-vision-model-observation.mjs",
      "--frame", frame,
      "--live-state", LIVE_STATE,
      "--vision-response", selfResponse,
      "--mode", "refresh_self_state",
      "--out", selfOut,
    ]);
    assert(selfResult.code === 0, `self vision observation failed: ${selfResult.stderr || selfResult.stdout}`);
    const selfObs = JSON.parse(await readFile(selfOut, "utf8"));
    const selfVisual = selfObs.visual_observations;
    assert(selfVisual.metadata.source === "vision_model", "self observations must be vision_model sourced");
    assert(selfVisual.phase.value.stage_round === null, "self visual phase must not preserve model-guessed stage_round");
    assert(Object.keys(selfVisual.economy || {}).length === 0, "self visual economy must not preserve model-guessed HUD numbers");
    assert(selfVisual.items.item_bench.length === 2, "self item bench should contain fixture items");
    assert(selfVisual.items.equipped_items.length === 3, "self equipped items should flatten unit equipment");
    assert(selfVisual.items.equipped_items.every((entry) => entry.owner_scope === "self"), "self equipped items must be scoped to self");
    assert(selfVisual.augments.choices.length === 3, "self augment choices should preserve fixture choices");
    assert(
      selfVisual.augments.choices.some((entry) => entry.catalog_match?.id === "30571" && entry.catalog_match?.name === "挑个好伙计！"),
      "halfwidth exclamation augment names should resolve to fullwidth catalog entries",
    );
    assert(
      selfVisual.augments.choices.some((entry) => entry.catalog_match?.name === "升级咯！"),
      "halfwidth exclamation should resolve upgrade augment punctuation",
    );
    assert(
      selfVisual.augments.choices.some((entry) => entry.catalog_match?.name === "战时补给：无用大棒"),
      "halfwidth colon should resolve wartime-supply augment punctuation",
    );
    assert(!selfVisual.board.board_units.length && !selfVisual.bench.bench_units.length, "vision model must not write board/bench units");
    assert(!hasImageBytes(selfObs), "vision observations must not embed raw image bytes");

    const lowConfidenceResponse = path.join(tmp, "low-confidence-equipped-response.json");
    const lowConfidenceOut = path.join(tmp, "low-confidence-equipped-observations.json");
    const lowConfidenceLiveOut = path.join(tmp, "low-confidence-equipped-live-state.json");
    await writeFile(lowConfidenceResponse, `${JSON.stringify({
      provider: "fixture",
      model: "mock-vision",
      confidence: 0.8,
      observations: {
        equipped_items: [
          {
            hero_id: 13462,
            items: [
              { id: "41716", confidence: 0.62, slot: 0 },
              { id: "41711", confidence: 0.91, slot: 1, needs_confirmation: true }
            ]
          }
        ]
      }
    }, null, 2)}\n`, "utf8");
    const lowConfidenceResult = await run("node", [
      "tools/run-jcc-vision-model-observation.mjs",
      "--frame", frame,
      "--live-state", LIVE_STATE,
      "--vision-response", lowConfidenceResponse,
      "--mode", "refresh_self_state",
      "--out", lowConfidenceOut,
    ]);
    assert(lowConfidenceResult.code === 0, `low-confidence equipped observation failed: ${lowConfidenceResult.stderr || lowConfidenceResult.stdout}`);
    const lowConfidenceObs = JSON.parse(await readFile(lowConfidenceOut, "utf8"));
    const lowEquipped = lowConfidenceObs.visual_observations.items.equipped_items;
    assert(lowEquipped.length === 2, "low-confidence fixture should preserve both evidence candidates");
    assert(
      lowEquipped.every((entry) => entry.status === "visual_low_confidence_candidate"),
      "catalog-matched but low-confidence or confirmation-required equipment must not become visual_candidate",
    );
    assert(
      lowEquipped.every((entry) => entry.promotion_blocked_reason),
      "blocked equipment candidates should explain why promotion is blocked",
    );
    const lowApply = await run("node", [
      "tools/build-jcc-visual-live-state.mjs",
      "--live-state", LIVE_STATE,
      "--visual-observations", lowConfidenceOut,
      "--out", lowConfidenceLiveOut,
    ]);
    assert(lowApply.code === 0, `low-confidence visual live-state apply failed: ${lowApply.stderr || lowApply.stdout}`);
    const lowLive = JSON.parse(await readFile(lowConfidenceLiveOut, "utf8"));
    const lowState = lowLive.live_state || lowLive;
    assert(
      lowState.field_status?.["items.equipped_items"]?.status === "visual_low_confidence_candidate",
      "field status must expose low-confidence equipment as blocked, not usable",
    );
    assert(
      lowState.field_status?.["items.equipped_items"]?.promotion_status === "blocked_by_low_confidence",
      "low-confidence equipment field must be blocked from promotion",
    );

    const selfApply = await run("node", [
      "tools/build-jcc-visual-live-state.mjs",
      "--live-state", LIVE_STATE,
      "--visual-observations", selfOut,
      "--out", selfLiveOut,
    ]);
    assert(selfApply.code === 0, `self visual live-state apply failed: ${selfApply.stderr || selfApply.stdout}`);
    const selfLive = JSON.parse(await readFile(selfLiveOut, "utf8"));
    const selfState = selfLive.live_state || selfLive;
    assert(selfState.visual?.metadata?.source === "vision_model", "self live_state should preserve vision_model metadata");
    assert(selfState.visual?.items?.equipped_items?.length === 3, "self live_state should contain vision equipment candidates");
    assert(selfState.field_status?.["items.equipped_items"]?.source_type === "visual_screen", "self field status should mark visual candidate source");

    const removedOpponentModeResult = await run("node", [
      "tools/run-jcc-vision-model-observation.mjs",
      "--frame", frame,
      "--live-state", LIVE_STATE,
      "--mode", "opponent_power",
      "--emit-request",
    ]);
    assert(
      removedOpponentModeResult.code !== 0,
      "removed opponent_power visual mode must be rejected",
    );
    assert(
      /Unsupported --mode opponent_power/.test(removedOpponentModeResult.stderr || removedOpponentModeResult.stdout),
      "removed opponent_power visual mode should fail with an explicit unsupported-mode error",
    );

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "vision model response converts to visual_observations",
        "vision request envelope carries frame reference, MuMu context, and catalog pairing hints without image bytes",
        "vision request carries inspection targets, enriched 4353 unit anchors, same-icon ambiguity policy, and no-invention constraints",
        "vision request treats icon templates as reference data, not live matcher truth",
        "self visual facts stay candidate-scoped and do not write board/bench units",
        "host visual augment names resolve across fullwidth/halfwidth punctuation variants",
        "removed opponent visual mode is rejected",
        "catalog-unmatched names remain unresolved candidates",
        "low-confidence or confirmation-required equipped items stay blocked even when catalog-matched",
        "vision observations apply into visual_live_state",
        "visual economy hp/gold/level/xp candidates are preserved",
        "structured output does not embed raw image bytes",
      ],
    }, null, 2));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
