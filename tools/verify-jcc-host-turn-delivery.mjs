import assert from "node:assert/strict";
import { resolveCodexTurnDelivery, recoverEmptyHostTurn } from "../ui/electron/host-turn-delivery.js";

const interim = { type: "agentMessage", phase: "commentary", text: "我会查询当前阵容。" };
const final = { type: "agentMessage", phase: "final_answer", text: "现在存钱，保留当前二星前排。" };
for (const status of ["failed", "interrupted", "completed"]) {
  assert.equal(resolveCodexTurnDelivery({ status }, [interim]).text, null);
}
assert.equal(resolveCodexTurnDelivery({ status: "failed", error: { message: "429" } }, [interim]).error, "429");
assert.equal(resolveCodexTurnDelivery({ status: "completed" }, [interim, final]).text, final.text);
assert.equal(resolveCodexTurnDelivery({ status: "failed" }, [interim, final]).text, final.text);
assert.equal(resolveCodexTurnDelivery({ status: "completed", items: [final] }).text, final.text);
assert.equal(resolveCodexTurnDelivery({ status: "completed" }, [{ type: "agentMessage", text: "legacy answer" }]).text, "legacy answer");
assert.equal(resolveCodexTurnDelivery({ status: "failed" }, [{ type: "agentMessage", text: "legacy unfinished" }]).text, null);
console.log("Host turn delivery phase/status matrix passed");

const empty = resolveCodexTurnDelivery({ status: "completed", items: [], itemsView: "notLoaded" }, [
  { type: "userMessage", content: [{ type: "text", text: "current request" }] },
]);
assert.equal(empty.empty_completion, true);
assert.equal(resolveCodexTurnDelivery({ status: "completed" }, [], { hasNonUserActivity: true }).empty_completion, false);
for (const [turn, items, streamedText] of [
  [{ status: "failed" }, [], ""],
  [{ status: "interrupted" }, [], ""],
  [{ status: "completed", error: { message: "429" } }, [], ""],
  [{ status: "completed" }, [interim], ""],
  [{ status: "completed" }, [{ type: "dynamicToolCall" }], ""],
  [{ status: "completed" }, [], "unfinished delta"],
]) assert.notEqual(resolveCodexTurnDelivery(turn, items, { streamedText }).empty_completion, true);

for (const mode of ["daily_chat", "cruise", "augment_select", "lineup_card"]) {
  let calls = 0;
  const failure = { ok: false, error: empty.error, empty_completion: true };
  const recovered = await recoverEmptyHostTurn(failure, {
    isCurrent: () => true,
    invoke: async () => { calls++; return { ok: true, response: { mode, final_text: "answer" } }; },
  });
  assert.equal(recovered.ok, true);
  assert.equal(calls, 1);
  calls = 0;
  const stillEmpty = await recoverEmptyHostTurn(failure, {
    isCurrent: () => true, invoke: async () => { calls++; return failure; },
  });
  assert.equal(stillEmpty.ok, false);
  assert.equal(calls, 1, "no retry loop on repeated empty responses");
  calls = 0;
  await recoverEmptyHostTurn(failure, { isCurrent: () => false, invoke: async () => { calls++; } });
  assert.equal(calls, 0, "cancelled or superseded owners must not resume");
  await recoverEmptyHostTurn({ ok: false, error: "429" }, { isCurrent: () => true, invoke: async () => { calls++; } });
  assert.equal(calls, 0, "unrelated errors must not retry");
}
console.log("Empty completion classification and bounded recovery passed");
