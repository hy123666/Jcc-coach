import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-host-rule-gate-"));
  try {
    const requestFile = path.join(tempRoot, "request.json");
    const badResponseFile = path.join(tempRoot, "bad-response.json");
    const goodResponseFile = path.join(tempRoot, "good-response.json");
    const conditionalResponseFile = path.join(tempRoot, "conditional-response.json");
    const request = {
      schema: "jcc-runtime-advice-response-request-v1",
      type: "advice_response_requested",
      response_id: "verify-response-rule-gate",
      task_id: "verify-task",
      ai_native_policy: { output_model: "host_cli_main_model_required" },
      user_visible_text: null,
      response_draft: {
        summary: "awaiting host model",
        why: "structured evidence",
      },
      host_cli_agent_request: {
        schema: "jcc-host-cli-coach-response-request-v1",
        type: "host_cli_agent_coach_response_request",
        request_id: "verify-response-rule-gate",
        request_hash: "verify-hash",
        context: {
          game_rule_contract: {
            schema: "jcc-game-rule-contract-v1",
            stage_round: "2-2",
            past_choice_checkpoints: [
              { kind: "augment", mode: "augment_choice", stage_round: "2-1", label: "2-1 augment choice" },
            ],
            current_choice_checkpoint: null,
            must_not: [
              "Do not say to wait for 2-1 augment; that checkpoint is current or already past.",
            ],
          },
        },
      },
    };
    const badResponse = {
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      request_id: "verify-response-rule-gate",
      request_hash: "verify-hash",
      final_text: "\u5148\u522b\u5b9a\u9635\u5bb9\uff0c\u7b49 2-1 \u6d77\u514b\u65af\u5f3a\u5316\u51fa\u6765\u540e\u518d\u51b3\u5b9a\u8fde\u80dc\u8fd8\u662f\u4fdd\u7ecf\u6d4e\u3002",
      recommended_action: "wait_for_augment",
      confidence: "medium",
      followup_question: null,
    };
    const goodResponse = {
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      request_id: "verify-response-rule-gate",
      request_hash: "verify-hash",
      final_text: "2-1 \u6d77\u514b\u65af\u5df2\u7ecf\u8fc7\u4e86\uff1b\u6211\u6ca1\u6709\u8bb0\u5f55\u5230\u4f60\u6700\u7ec8\u9009\u4e86\u54ea\u4e2a\uff0c\u5148\u6309\u5f53\u524d\u724c\u548c\u88c5\u5907\u7a33\u8fc7\u6e21\uff0c\u4f60\u544a\u8bc9\u6211\u521a\u624d\u62ff\u7684\u5f3a\u5316\u540e\u6211\u518d\u4fee\u6b63\u65b9\u5411\u3002",
      recommended_action: "ask_selected_augment",
      confidence: "medium",
      followup_question: "\u521a\u521a 2-1 \u4f60\u6700\u7ec8\u62ff\u7684\u662f\u54ea\u4e00\u4e2a\u6d77\u514b\u65af\uff1f",
    };
    const conditionalResponse = {
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      request_id: "verify-response-rule-gate",
      request_hash: "verify-hash",
      final_text: "\u73b0\u5728\u5148\u4fdd\u4f4f 20 \u91d1\u5e01\u5e76\u7528\u5bf9\u5b50\u6253\u6700\u5f3a\u677f\uff1b\u5982\u679c 3-2 \u51fa\u73b0\u524d\u6392\u5f3a\u5316\uff0c\u518d\u628a\u65b9\u5411\u6536\u675f\u5230\u5f53\u524d\u6765\u724c\u66f4\u96c6\u4e2d\u7684\u9635\u5bb9\u3002",
      recommended_action: "hold_interest_and_keep_pairs",
      confidence: "medium",
      followup_question: null,
    };
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    await writeFile(badResponseFile, `${JSON.stringify(badResponse, null, 2)}\n`, "utf8");
    await writeFile(goodResponseFile, `${JSON.stringify(goodResponse, null, 2)}\n`, "utf8");
    await writeFile(conditionalResponseFile, `${JSON.stringify(conditionalResponse, null, 2)}\n`, "utf8");

    const bad = await runNode([
      "tools/run-jcc-host-coach-response.mjs",
      "--request", requestFile,
      "--agent-response", badResponseFile,
    ]);
    assert(bad.code !== 0, "rule-conflicting host response must be rejected");
    assert(
      bad.stderr.includes("conflicts with current game rules"),
      `bad response should fail with game rule contract error, got: ${bad.stderr || bad.stdout}`,
    );

    const good = await runNode([
      "tools/run-jcc-host-coach-response.mjs",
      "--request", requestFile,
      "--agent-response", goodResponseFile,
    ]);
    assert(good.code === 0, `non-conflicting host response should pass: ${good.stderr || good.stdout}`);
    const result = JSON.parse(good.stdout);
    assert(result.status === "completed", "valid response should complete");

    const missingSchemaFile = path.join(tempRoot, "missing-schema-response.json");
    const missingSchemaResponse = { ...goodResponse };
    delete missingSchemaResponse.schema;
    await writeFile(missingSchemaFile, `${JSON.stringify(missingSchemaResponse, null, 2)}\n`, "utf8");
    const missingSchema = await runNode([
      "tools/run-jcc-host-coach-response.mjs",
      "--request", requestFile,
      "--agent-response", missingSchemaFile,
    ]);
    assert(missingSchema.code !== 0, "schema-less host response must be rejected by the standalone runner");
    assert(missingSchema.stderr.includes("missing schema identity"), `schema-less response should fail at schema gate: ${missingSchema.stderr}`);

    const conditional = await runNode([
      "tools/run-jcc-host-coach-response.mjs",
      "--request", requestFile,
      "--agent-response", conditionalResponseFile,
    ]);
    assert(conditional.code === 0, `conditional planning with an immediate action should pass: ${conditional.stderr || conditional.stdout}`);

    console.log(JSON.stringify({
      ok: true,
      schema: "jcc-host-coach-response-rule-gate-verifier-v1",
      rejected_conflicting_text: true,
      accepted_unknown_selection_question: true,
      accepted_actionable_conditional_plan: true,
    }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
