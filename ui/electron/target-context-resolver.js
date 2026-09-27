function asTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function targetTimestamp(target) {
  if (!target || typeof target !== "object") return null;
  return asTimestamp(target.at || target.updated_at || target.confirmed_at || target.created_at);
}

function isNewer(left, right) {
  const leftAt = targetTimestamp(left);
  const rightAt = targetTimestamp(right);
  if (leftAt === null) return false;
  if (rightAt === null) return true;
  return leftAt > rightAt;
}

export function resolveTargetContextAuthority({
  currentTurnInstruction = null,
  replacementIntent = null,
  durableTargetPlan = null,
  provisionalIntent = null,
} = {}) {
  if (currentTurnInstruction) {
    return {
      authority: "current_turn_instruction",
      target: currentTurnInstruction,
      persisted: false,
      basis: "exact_current_turn_instruction",
    };
  }
  if (replacementIntent && (!durableTargetPlan || isNewer(replacementIntent, durableTargetPlan))) {
    return {
      authority: "current_turn_replacement",
      target: replacementIntent,
      persisted: false,
      basis: "newer_explicit_replacement_for_current_answer",
    };
  }
  if (durableTargetPlan) {
    return {
      authority: "durable_target_plan",
      target: durableTargetPlan,
      persisted: true,
      basis: "canonical_persisted_target_plan",
    };
  }
  if (provisionalIntent) {
    return {
      authority: "provisional_user_intent",
      target: provisionalIntent,
      persisted: false,
      basis: "latest_provisional_lineup_intent",
    };
  }
  return {
    authority: "none",
    target: null,
    persisted: false,
    basis: "no_target_context",
  };
}

export function normalizeTargetContextAuthority(value) {
  const authority = String(value || "none");
  if ([
    "current_turn_instruction",
    "current_turn_replacement",
    "durable_target_plan",
    "provisional_user_intent",
    "none",
  ].includes(authority)) return authority;
  return "none";
}

export function classifyPersistedTargetPlanAuthority(targetPlan) {
  if (!targetPlan || typeof targetPlan !== "object" || Array.isArray(targetPlan)) return "none";
  const declaredAuthority = normalizeTargetContextAuthority(targetPlan.authority);
  if (declaredAuthority !== "none") return declaredAuthority;
  if ([
    targetPlan.candidate_id,
    targetPlan.lineup_group_id,
    targetPlan.atomic_roster_id,
    targetPlan.variant_id,
  ].some((value) => String(value || "").trim())) return "durable_target_plan";
  if (targetPlan.source === "explicit_user_commitment") {
    return "durable_target_plan";
  }
  return "provisional_user_intent";
}

export function buildDurableTargetPlanReplacement(previousTargetPlan = null, replacementTarget = null) {
  const replacement = replacementTarget && typeof replacementTarget === "object"
    ? { ...replacementTarget }
    : null;
  if (!replacement) return previousTargetPlan || null;
  const previous = previousTargetPlan && typeof previousTargetPlan === "object"
    ? { ...previousTargetPlan }
    : previousTargetPlan || null;
  const previousRevision = Number(previous?.target_revision);
  return {
    ...replacement,
    authority: "durable_target_plan",
    status: "confirmed",
    source: replacement.source || "explicit_user_commitment",
    target_context_basis: "explicit_user_commitment",
    target_revision: Number.isFinite(previousRevision) ? previousRevision + 1 : 1,
    previous_target_plan: previous,
    replaced_target_identity: previous
      ? {
          candidate_id: previous.candidate_id || null,
          selected_variant_id: previous.selected_variant_id || null,
          atomic_roster_id: previous.atomic_roster_id || null,
          name: previous.name || previous.target_name || previous.summary || null,
        }
      : null,
  };
}
