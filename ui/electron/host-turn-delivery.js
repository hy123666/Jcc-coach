// Only completed message items are eligible; streamed fragments may be commentary.
export function resolveCodexTurnDelivery(turn, completedMessages = [], { streamedText = "", hasNonUserActivity = false } = {}) {
  const items = [...completedMessages, ...(turn?.items || [])];
  const messages = items
    .filter(item => item?.type === "agentMessage" || item?.type === "agent_message");
  const explicitFinal = messages.filter(item => item.phase === "final_answer" && item.text?.trim()).at(-1);
  if (explicitFinal) return { text: explicitFinal.text, recovered_final: turn?.status !== "completed" };
  if (turn?.status === "completed") {
    const legacyFinal = messages.filter(item => !item.phase && item.text?.trim()).at(-1);
    if (legacyFinal) return { text: legacyFinal.text, recovered_final: false };
  }
  return { text: null,
    empty_completion: turn?.status === "completed" && !turn?.error && !streamedText.trim() && !hasNonUserActivity
      && items.every(item => item?.type === "userMessage" || item?.type === "user_message"),
    error: turn?.error?.message || (typeof turn?.error === "string" ? turn.error : null)
    || (turn?.status === "completed" ? "host_turn_missing_final_answer" : "host_turn_incomplete") };
}

export async function recoverEmptyHostTurn(result, { isCurrent, invoke }) {
  if (result.ok || result.empty_completion !== true || !isCurrent()) return result;
  return invoke();
}
