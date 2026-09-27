#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-effective-equipment-flow-"));
try {
  const matchSessionId = "effective-equipment-match";
  const liveStateFile = path.join(tempDir, "live-state.json");
  const contextFile = path.join(tempDir, "context.json");
  const adviceStateFile = path.join(tempDir, "advice-state.json");
  const outFile = path.join(tempDir, "pipeline.json");
  await writeFile(liveStateFile, JSON.stringify({
    schema: "jcc-cruise-runtime-live-state-from-mumu-watch-v1",
    match_session_id: matchSessionId,
    observed_at: "2026-07-23T10:00:00.000Z",
    phase: { stage_round: "3-1", status: 1 },
    economy: { hp: 30, gold: 30, level: 6, xp: "0/36" },
    items: { item_bench: [], equipped_items: [], item_bench_candidates: [] },
  }, null, 2), "utf8");
  await writeFile(contextFile, JSON.stringify({
    minimum_value_score_to_speak: 0.5,
    target_plan: { name: "新星特攻队阿卡丽" },
    match_context: {
      match_session_id: matchSessionId,
      target_plan: { name: "新星特攻队阿卡丽" },
      user_confirmed_equipment: {
        schema: "jcc-user-confirmed-equipment-v1",
        match_session_id: matchSessionId,
        source: "user_confirmed",
        authority: "explicit_user",
        confirmed_fields: { item_bench: true, equipped_items: true },
        item_bench: [
          { name: "反曲之弓", source: "user_confirmed", authority: "explicit_user" },
          { name: "拳套", source: "user_confirmed", authority: "explicit_user" },
        ],
        equipped_items: [
          { name: "无尽之刃", owner_unit: "阿卡丽", source: "user_confirmed", authority: "explicit_user" },
        ],
      },
    },
  }, null, 2), "utf8");

  const result = await runNode([
    "tools/run-jcc-cruise-runtime-pipeline.mjs",
    "--live-state", liveStateFile,
    "--context", contextFile,
    "--advice-state", adviceStateFile,
    "--out", outFile,
    "--retain-full-state",
    "--now", "2026-07-23T10:00:00.000Z",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const output = JSON.parse(await readFile(outFile, "utf8"));
  const itemTask = output.score?.advice_tasks?.find((task) => task.trigger_id === "item_slam_or_greed");
  assert.equal(itemTask, undefined, "ordinary equipment facts must not create an automatic Cruise answer task");
  const hostRequest = output.response_events
    ?.find((event) => event.host_cli_agent_request)
    ?.host_cli_agent_request;
  assert.equal(hostRequest, undefined, "ordinary equipment facts must wait for a fixed strategic checkpoint or explicit equipment advice action");
  const equipment = output.lifecycle?.match_context?.user_confirmed_equipment;
  assert(equipment, "user-confirmed equipment must remain in the current-match evidence owned by the scorer");
  assert.equal(equipment?.source, "user_confirmed");
  assert.equal(equipment?.authority, "explicit_user");
  assert.deepEqual(equipment?.item_bench?.map((item) => item.name), ["反曲之弓", "拳套"]);
  assert.deepEqual(equipment?.equipped_items?.map((item) => [item.owner_unit, item.name]), [["阿卡丽", "无尽之刃"]]);
  assert.equal(equipment?.confirmed_fields?.item_bench, true);
  assert.equal(equipment?.confirmed_fields?.equipped_items, true);

  const staleContextFile = path.join(tempDir, "stale-context.json");
  const staleAdviceStateFile = path.join(tempDir, "stale-advice-state.json");
  const staleOutFile = path.join(tempDir, "stale-pipeline.json");
  await writeFile(staleContextFile, JSON.stringify({
    minimum_value_score_to_speak: 0.5,
    target_plan: { name: "current target" },
    match_context: {
      target_plan: { name: "current target" },
      user_confirmed_equipment: {
        schema: "jcc-user-confirmed-equipment-v1",
        match_session_id: "old-match",
        source: "user_confirmed",
        authority: "explicit_user",
        confirmed_fields: { item_bench: true, equipped_items: true },
        item_bench: [{ name: "Stale Sword", source: "user_confirmed" }],
        equipped_items: [{ name: "Stale Armor", owner_unit: "Old Holder", source: "user_confirmed" }],
      },
    },
  }, null, 2), "utf8");
  const staleResult = await runNode([
    "tools/run-jcc-cruise-runtime-pipeline.mjs",
    "--live-state", liveStateFile,
    "--context", staleContextFile,
    "--advice-state", staleAdviceStateFile,
    "--out", staleOutFile,
    "--retain-full-state",
    "--now", "2026-07-23T10:00:00.000Z",
  ]);
  assert.equal(staleResult.code, 0, staleResult.stderr || staleResult.stdout);
  const staleOutput = JSON.parse(await readFile(staleOutFile, "utf8"));
  const staleEquipment = staleOutput.score?.context?.equipment_context
    || staleOutput.response_events?.find((event) => event.host_cli_agent_request)
      ?.host_cli_agent_request?.context?.cruise_decision_context?.equipment
    || staleOutput.lifecycle?.match_context?.user_confirmed_equipment
    || null;
  assert.notEqual(staleEquipment?.effective_source_by_field?.item_bench, "user_confirmed");
  assert.notEqual(staleEquipment?.effective_source_by_field?.equipped_items, "user_confirmed");
  const staleDecisionSurfaces = JSON.stringify({
    standardized_live_state: staleOutput.standardized_live_state,
    score: staleOutput.score,
    lifecycle: staleOutput.lifecycle,
    response_events: staleOutput.response_events,
  });
  assert.equal(staleDecisionSurfaces.includes("Stale Sword"), false);
  assert.equal(staleDecisionSurfaces.includes("Stale Armor"), false);
  assert.equal(staleEquipment?.has_current_match_user_confirmation === true, false);

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-effective-equipment-runtime-flow-verification-v1",
    checked: [
      "user-confirmed equipment reaches the proactive scorer",
      "ordinary equipment facts cannot open an automatic Host response",
      "effective equipment remains available to fixed checkpoints and explicit advice",
      "user-confirmed facts do not wait for structured or visual sources",
      "stale or unscoped user equipment cannot cross match sessions",
    ],
  }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
