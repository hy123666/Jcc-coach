import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { detectHostAgent, runHostAgentRequest } from "../ui/electron/host-adapters.js";

function hasFlag(name) {
  return process.argv.includes(name);
}

function hasMojibake(text) {
  return /绱|鍗|鐨|涓|宸|埅|熷|�/.test(String(text || ""));
}

async function main() {
  const requireLive = hasFlag("--require-live");
  const timeoutMs = Number(process.env.JCC_CODEX_COACH_SIM_TIMEOUT_MS || 45000);
  const maxElapsedMs = Number(process.env.JCC_CODEX_COACH_SIM_MAX_MS || 15000);
  const model = process.env.JCC_CODEX_MODEL || null;
  const reasoningEffort = process.env.JCC_CODEX_REASONING_EFFORT || "low";
  const detected = await detectHostAgent({
    provider: "codex",
    model,
    reasoning_effort: reasoningEffort,
  });

  if (!detected.available) {
    const report = {
      ok: !requireLive,
      schema: "jcc-codex-cli-live-coach-simulation-v1",
      status: "external_dependency_pending",
      provider: "codex",
      live_generation_accepted: false,
      reason: detected.error || "Codex CLI not found",
      strict_live_required: requireLive,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (requireLive) process.exit(1);
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-codex-coach-sim-"));
  const startedAt = Date.now();
  try {
    const input = {
      schema: "jcc-runtime-selected-context-coach-simulation-v1",
      mode: "augment_choice",
      user_message: "选哪个？要不要刷新？",
      runtime_context: {
        state_owner: "jcc-runtime-daemon",
        host_model_role: "ai_native_final_coach_only",
        response_policy: "use_current_facts_only_ignore_stale_context",
      },
      current_live_state: {
        match_session_id: "sim-match",
        phase: { stage_round: "3-2", status: "choice" },
        economy: { gold: 50, hp: 72, level: 6, xp: { value: 14, to_next: 36 } },
        selected_augments: ["纷乱头脑"],
        own_board: {
          units: [
            { name: "蕾欧娜", star: 2, role: "frontline" },
            { name: "科加斯", star: 2, role: "frontline" },
            { name: "崔斯特", star: 1, role: "item_holder" },
          ],
        },
        items: { item_bench: ["暴风大剑", "反曲之弓", "锁子甲"] },
      },
      current_choices: {
        source: "rapidocr_text_fast_path",
        stage_round: "3-2",
        augment_choices: [
          { slot: 0, name: "战时补给：巨人腰带" },
          { slot: 1, name: "小巨人" },
          { slot: 2, name: "认知税" },
        ],
      },
      stale_context_to_ignore: {
        phase: { stage_round: "2-1" },
        economy: { gold: 24 },
        selected_augments: [],
        note: "This is deliberately stale; mentioning 2-1 or 24 gold is a failure.",
      },
    };

    const prompt = [
      "You are the current host CLI main model for JCC Runtime.",
      "Return exactly one JSON object. No Markdown. No code fence.",
      "Use only INPUT_JSON.current_live_state and INPUT_JSON.current_choices for the answer.",
      "INPUT_JSON.stale_context_to_ignore is a trap: do not use it, mention it, or reason from it.",
      "Final_text must be concise Chinese coaching text, 1-3 short sentences.",
      "Required keys: generated_by, observed_stage_round, observed_gold, ignored_stale_stage, ignored_stale_gold, recommended_action, confidence, final_text.",
      "generated_by must equal current_cli_agent_main_model.",
      "confidence must be exactly one string enum: high, medium, or low. Do not output a numeric confidence.",
      "observed_stage_round must equal 3-2. observed_gold must equal 50.",
      "ignored_stale_stage and ignored_stale_gold must be true.",
      "",
      "INPUT_JSON:",
      JSON.stringify(input),
    ].join("\n");

    const result = await runHostAgentRequest(detected, prompt, {
      parseJson: true,
      jsonResponseKind: "raw",
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      timeoutMs,
    });

    if (!result.ok && /auth|login|credential|network|rate|quota/i.test(String(result.error || ""))) {
      const report = {
        ok: !requireLive,
        schema: "jcc-codex-cli-live-coach-simulation-v1",
        status: "external_dependency_pending",
        live_generation_accepted: false,
        provider: "codex",
        command: detected.command,
        version: detected.version || null,
        reason: result.error,
        strict_live_required: requireLive,
        elapsed_ms: Date.now() - startedAt,
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (requireLive) process.exit(1);
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    const response = result.response || {};
    assert.equal(result.ok, true, result.error || "Codex live coach simulation failed");
    assert.equal(result.completed_from, "json_event_stream", "Codex coach simulation must use JSON event stream");
    assert.equal(response.generated_by, "current_cli_agent_main_model", "coach response must declare host main model provenance");
    assert.equal(response.observed_stage_round, "3-2", "coach must use current 3-2 stage");
    assert.equal(Number(response.observed_gold), 50, "coach must use current 50 gold");
    assert.equal(response.ignored_stale_stage, true, "coach must ignore stale stage");
    assert.equal(response.ignored_stale_gold, true, "coach must ignore stale gold");
    assert(
      ["high", "medium", "low"].includes(String(response.confidence || "").toLowerCase()),
      `coach confidence must be high/medium/low; response=${JSON.stringify(response)}`,
    );
    assert(!/2-1|24金|24 金/.test(String(response.final_text || "")), "coach final_text must not repeat stale 2-1/24 gold facts");
    assert(!hasMojibake(response.final_text), "coach final_text must not contain mojibake");
    assert(elapsedMs <= maxElapsedMs, `Codex coach simulation exceeded latency budget: ${elapsedMs}ms > ${maxElapsedMs}ms`);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-codex-cli-live-coach-simulation-v1",
      status: "pass",
      provider: "codex",
      command: detected.command,
      version: detected.version || null,
      completed_from: result.completed_from,
      elapsed_ms: elapsedMs,
      max_elapsed_ms: maxElapsedMs,
      event_count: Array.isArray(result.events) ? result.events.length : 0,
      response,
      checked: [
        "codex-live-ai-native-coach-response",
        "current-stage-and-gold-used",
        "stale-stage-and-gold-ignored",
        "host-main-model-provenance",
        "no-mojibake",
        "latency-budget",
      ],
    }, null, 2)}\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
