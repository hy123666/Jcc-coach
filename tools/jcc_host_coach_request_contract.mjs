export const HOST_CLI_MAIN_MODEL_OUTPUT = "host_cli_main_model_required";

export function buildHostCoachAiNativePolicy(policy = {}) {
  const source = policy && typeof policy === "object" ? policy : {};
  return {
    ...source,
    output_model: HOST_CLI_MAIN_MODEL_OUTPUT,
    structure_is_guidance_not_cage: source.structure_is_guidance_not_cage !== false,
    structured_envelope_required: source.structured_envelope_required !== false,
    require_model_rendering: source.require_model_rendering !== false,
    fallback_is_not_final_answer: source.fallback_is_not_final_answer !== false,
    allow_model_to_rephrase: source.allow_model_to_rephrase !== false,
    rendering_policy: source.rendering_policy || {
      agent_can_merge_fields: true,
      why_and_evidence_expandable: true,
      do_not_render_as_table_by_default: true,
    },
  };
}

export function normalizeAdviceResponseRequestEvent(request, options = {}) {
  if (!request || typeof request !== "object") return request;
  const hostCliAgentRequest = options.hostCliAgentRequest || request.host_cli_agent_request || null;
  if (!hostCliAgentRequest) return request;
  if (request.type && request.type !== "advice_response_requested") return request;
  return {
    ...request,
    type: "advice_response_requested",
    response_id: request.response_id
      || request.host_cli_agent_request?.request_id
      || hostCliAgentRequest.request_id
      || null,
    match_session_id: options.matchSessionId
      || request.match_session_id
      || hostCliAgentRequest.match_session_id
      || null,
    ai_native_policy: buildHostCoachAiNativePolicy(request.ai_native_policy),
    host_cli_agent_request: hostCliAgentRequest,
  };
}
