function stringTerms(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function termVariants(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return [];
  const withoutStage = normalized.replace(/^\d+-\d+\s+/, "").trim();
  const variants = new Set([withoutStage]);
  variants.add(withoutStage.replace(/[_-]+/g, " "));
  variants.add(withoutStage.replace(/[\s_]+/g, "-"));
  variants.add(withoutStage.replace(/[\s-]+/g, "_"));
  for (const current of [...variants]) {
    const shortened = current.replace(/(?:[\s_-]+)(?:choice|sequence|checkpoint|window)$/i, "").trim();
    if (shortened) variants.add(shortened);
  }
  return [...variants].filter((term) => term && term !== "choice" && term !== "checkpoint" && term !== "window");
}

function commonChoiceKindTerms(checkpoint) {
  const kind = String(checkpoint?.kind || "").trim().toLowerCase();
  const mode = String(checkpoint?.mode || "").trim().toLowerCase();
  if (kind === "augment" || mode === "augment_choice") {
    return ["augment", "augment choice", "海克斯", "强化", "强化符文"];
  }
  if (kind === "item" || mode === "item_choice") {
    return ["item", "item choice", "装备", "锻造器"];
  }
  return [];
}

export function choiceCheckpointSemanticTerms(checkpoint) {
  const terms = [
    checkpoint?.choice_label,
    checkpoint?.label,
    checkpoint?.kind,
    checkpoint?.mechanic_id,
    checkpoint?.mode,
    checkpoint?.phase,
    ...stringTerms(checkpoint?.intent_terms),
    ...stringTerms(checkpoint?.trigger_terms),
    ...stringTerms(checkpoint?.advice_task_trigger_terms),
    ...stringTerms(checkpoint?.aliases),
    ...stringTerms(checkpoint?.semantic_terms),
    ...commonChoiceKindTerms(checkpoint),
  ];
  return [...new Set(terms.flatMap(termVariants))];
}

export function textMentionsChoiceCheckpoint(text, checkpoint) {
  const source = String(text || "").toLowerCase();
  const stageRound = String(checkpoint?.stage_round || "").trim();
  if (!source || !stageRound || !source.includes(stageRound.toLowerCase())) return false;
  return choiceCheckpointSemanticTerms(checkpoint).some((term) => source.includes(term));
}
