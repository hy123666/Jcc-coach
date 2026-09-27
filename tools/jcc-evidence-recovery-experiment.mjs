import { restoreHostEvidence } from "../ui/electron/host-evidence-materialization.js";
import { restoreRankingToolCandidate } from "../ui/electron/ranking-tool-projection.js";

// Test-only interventions. Production never imports this module.
export function experimentPrompt(prompt, treatment) {
  if (treatment !== "instructions") return prompt;
  return prompt.replace(/Objects with schema=jcc-host-evidence-address-reference-v1[^\n]*\n/, "")
    .replace("INPUT_JSON:\n", "A tool result is a self-contained document. Local aliases and address references point within that document, including other candidates; they do not require another query. Remaining candidates are optional pagination, not missing fields. Read the delivered candidates directly.\nINPUT_JSON:\n");
}

export function experimentResult(value, treatment) {
  if (treatment === "status") {
    const result = structuredClone(value);
    const page = result.result?.selected_ranking_candidates || result.result;
    if (page && Object.hasOwn(page, "candidate_working_set_truncated")) {
      page.more_candidates_available = Number(page.remaining_count || 0) > 0;
      delete page.candidate_working_set_truncated;
    }
    result.delivery = { ...result.delivery, recovery_available: true,
      already_retrieved: Boolean(result.delivery?.cache_hit),
      payload_state: "complete_returned_candidates", pagination_is_optional: true };
    return result;
  }
  if (treatment === "references") {
    const result = restoreHostEvidence(value);
    const page = result.result?.selected_ranking_candidates || result.result;
    if (Array.isArray(page?.candidates)) page.candidates = page.candidates.map(restoreRankingToolCandidate);
    return result;
  }
  return value;
}
