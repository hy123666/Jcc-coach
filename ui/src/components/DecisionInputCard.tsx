import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Check, Plus, ScanText, Trash2 } from "lucide-react";
import { CatalogCombobox, type CatalogComboboxOption } from "./CatalogCombobox";
import {
  type DecisionCandidate,
  type DecisionEquipmentEntry,
  type DecisionEquipmentPayload,
  type DecisionInputAction,
  type DecisionInputOptions,
  type DecisionInputPayload,
  type DecisionPayloadBinding,
  type DecisionSelectionPayload,
  type ItemChoiceKind,
  type ManualVariableOption,
  type ManualVariableOptions,
  type RuntimeBridge,
  type RuntimeMatchModeDescriptor,
  type RuntimeResult,
} from "../runtimeBridge";

type CandidateDraft = {
  input: string;
  resolved: DecisionCandidate | null;
};

type EquipmentCategory = "components" | "completed" | "radiant" | "support" | "artifacts" | "emblems" | "special";
type EquipmentDraft = Record<EquipmentCategory, DecisionEquipmentEntry[]>;
type CatalogOption = ManualVariableOption | DecisionCandidate;

export type DecisionInputCardDraft = {
  tierColor: string;
  categoryIds: string[];
  candidates: CandidateDraft[];
  selectedIndex: number | null;
  targetNote: string;
  changedSlots: number[];
  dirty: boolean;
  choiceWindowInstanceId?: string;
};

export type DecisionInputCardDrafts = Record<string, DecisionInputCardDraft>;
export type DecisionInputCardStages = Record<string, string>;

const augmentTiers = [
  { id: "silver", label: "银色" },
  { id: "gold", label: "金色" },
  { id: "prismatic", label: "彩色" },
];
const equipmentCategories: Array<{ key: EquipmentCategory; label: string; aliases: string[] }> = [
  { key: "components", label: "散件", aliases: ["component", "components", "basic", "散件", "基础"] },
  { key: "completed", label: "成装", aliases: ["completed", "complete", "item", "成装", "装备"] },
  { key: "radiant", label: "光明装备", aliases: ["radiant", "光明", "光明装备", "光明武器"] },
  { key: "support", label: "辅助装备", aliases: ["support", "辅助", "辅助装备"] },
  { key: "artifacts", label: "神器", aliases: ["artifact", "artifacts", "神器"] },
  { key: "emblems", label: "纹章", aliases: ["emblem", "emblems", "trait", "转职", "纹章"] },
  { key: "special", label: "特殊装备", aliases: ["special", "other", "特殊", "特殊装备", "其他装备"] },
];
const equipmentFacets = [
  { id: "all", label: "全部" },
  { id: "tank", label: "前排" },
  { id: "physical", label: "物理" },
  { id: "magic", label: "法系" },
  { id: "speed", label: "攻速" },
  { id: "mana", label: "启动" },
  { id: "sustain", label: "续航" },
  { id: "utility", label: "功能" },
  { id: "special", label: "经济/特殊" },
];
const itemChoiceKinds: Array<{ id: ItemChoiceKind; label: string; slots: number }> = [
  { id: "basic_component_forge", label: "基础装备锻造器", slots: 4 },
  { id: "completed_item_forge", label: "成装锻造器", slots: 5 },
  { id: "artifact_forge", label: "神器锻造器", slots: 4 },
  { id: "radiant_item_choice", label: "光明装备选择", slots: 4 },
];

const emptyEquipment: EquipmentDraft = {
  components: [],
  completed: [],
  radiant: [],
  support: [],
  artifacts: [],
  emblems: [],
  special: [],
};

function emptyCandidates(count: number): CandidateDraft[] {
  return Array.from({ length: count }, () => ({ input: "", resolved: null }));
}

function createDraft(count: number): DecisionInputCardDraft {
  return {
    tierColor: "",
    categoryIds: [],
    candidates: emptyCandidates(count),
    selectedIndex: null,
    targetNote: "",
    changedSlots: [],
    dirty: false,
  };
}

function candidateName(option: ManualVariableOption | DecisionCandidate | DecisionEquipmentEntry) {
  return String(
    "name" in option && option.name
      ? option.name
      : "label" in option && option.label
        ? option.label
        : "display_text" in option && option.display_text
          ? option.display_text
          : "id" in option && option.id
            ? option.id
            : "",
  ).trim();
}

function candidateId(option: ManualVariableOption | DecisionCandidate) {
  return String(
    "ref" in option && option.ref?.id
      ? option.ref.id
      : "option_id" in option && option.option_id
        ? option.option_id
        : option.id || "",
  ).trim();
}

function displayOption(option: ManualVariableOption | DecisionCandidate) {
  const id = candidateId(option);
  const name = candidateName(option);
  return id && name && id !== name ? `${id} | ${name}` : name || id;
}

function displayEquipment(entry: DecisionEquipmentEntry) {
  return entry.name;
}

function optionSearchTerms(option: CatalogOption) {
  return Array.from(new Set([
    ...(((option as DecisionCandidate).search_terms || []).map(String)),
    ...(((option as DecisionCandidate).alias_evidence || []).map((entry) => String(entry?.matched || ""))),
  ].map((entry) => entry.trim()).filter(Boolean)));
}

function optionKind(option: CatalogOption) {
  return String((option as DecisionCandidate).kind || ("ref" in option ? option.ref?.kind : "") || "").trim();
}

function optionRounds(option: CatalogOption) {
  return Array.isArray((option as DecisionCandidate).rounds) ? ((option as DecisionCandidate).rounds || []).map(String) : [];
}

function optionStageNum(option: CatalogOption) {
  const raw = (option as DecisionCandidate).stage_num;
  return raw === null || raw === undefined ? "" : String(raw);
}

function optionStageLabel(option: CatalogOption, activeStage: string) {
  const availability = String((option as DecisionCandidate).availability_match || "");
  if (availability === "stage_unknown" || (option as DecisionCandidate).stage_unknown) return "阶段未知";
  const rounds = optionRounds(option);
  if (rounds.length) return rounds.includes(activeStage) ? activeStage : `仅${rounds.join("/")}`;
  const stageNum = optionStageNum(option);
  if (stageNum) return `仅阶段${stageNum}`;
  if ((option as DecisionCandidate).round_bucket === "unknown_round") return "阶段未知";
  return "";
}

function optionMatchesStage(option: CatalogOption, activeStage: string) {
  if (!activeStage) return true;
  const availability = String((option as DecisionCandidate).availability_match || "");
  if (availability === "current_stage") return true;
  if (availability === "stage_mismatch" || availability === "stage_unknown") return false;
  const stageNum = optionStageNum(option);
  if (stageNum) return activeStage.startsWith(`${stageNum}-`);
  const stageRounds = Array.isArray((option as DecisionCandidate).stage_rounds)
    ? ((option as DecisionCandidate).stage_rounds || []).map(String)
    : [];
  if (stageRounds.length) return stageRounds.includes(activeStage);
  const kind = optionKind(option);
  if (kind && kind !== "augment") return true;
  const rounds = optionRounds(option);
  if (rounds.length) return rounds.includes(activeStage);
  return (option as DecisionCandidate).round_bucket !== "unknown_round";
}

function optionMatchesDefaultList(option: CatalogOption, activeStage: string) {
  if (!optionMatchesStage(option, activeStage)) return false;
  return (option as DecisionCandidate).round_bucket !== "unknown_round";
}

function flattenOptions(groups: ManualVariableOptions, matcher: (key: string) => boolean) {
  return Object.entries(groups)
    .filter(([key]) => matcher(key.toLowerCase()))
    .flatMap(([, values]) => values || []);
}

function groupOptions(groups: ManualVariableOptions, groupNames: string[]) {
  const wanted = new Set(groupNames.map((group) => group.toLowerCase()));
  return Object.entries(groups)
    .filter(([key]) => wanted.has(key.toLowerCase()))
    .flatMap(([, values]) => values || []);
}

function uniqueOptions<T extends ManualVariableOption | DecisionCandidate>(options: T[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${candidateId(option)}:${candidateName(option)}`;
    if (!key || key === ":" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function optionBrowseFacets(option: CatalogOption) {
  return Array.isArray((option as DecisionCandidate).browse_facets)
    ? ((option as DecisionCandidate).browse_facets || []).map(String)
    : [];
}

function equipmentFacetLabels(option: CatalogOption) {
  const facets = new Set(optionBrowseFacets(option));
  return equipmentFacets
    .filter((facet) => facet.id !== "all" && facets.has(facet.id))
    .map((facet) => facet.label);
}

function optionMatchesEquipmentFacet(option: CatalogOption, facetId: string) {
  if (facetId === "all") return true;
  if (!equipmentFacets.some((entry) => entry.id === facetId)) return true;
  return optionBrowseFacets(option).includes(facetId);
}

function optionsForMode(
  mode: RuntimeMatchModeDescriptor,
  manualOptions: ManualVariableOptions,
  decisionOptions: DecisionInputOptions | null,
  tierColor: string,
) {
  const backend = decisionOptions?.options_by_group || {};
  const merged = { ...manualOptions, ...backend };
  const catalogCandidates = decisionOptions?.candidates || [];
  const optionGroupTerms = mode.candidateOptionGroupTerms.map((term) => term.toLowerCase());
  const explicitCandidateSource = mode.candidateOptionSourceKey
    ? groupOptions(merged, [mode.candidateOptionSourceKey])
    : [];
  const groupedCandidates = flattenOptions(merged, (key) => optionGroupTerms.some((term) => key.includes(term)));
  const candidates = catalogCandidates.length
    ? catalogCandidates
    : explicitCandidateSource.length
      ? explicitCandidateSource
      : groupedCandidates;
  return uniqueOptions(candidates).filter((option) => {
    if (mode.id !== "augment" || !tierColor) return true;
    const optionTier = String((option as DecisionCandidate).tier_color || "").toLowerCase();
    return !optionTier || optionTier === tierColor;
  });
}

function equipmentOptionsFor(
  category: EquipmentCategory,
  manualOptions: ManualVariableOptions,
  decisionOptions: DecisionInputOptions | null,
) {
  const backendOptions = decisionOptions?.options_by_group?.[category] || [];
  if (backendOptions.length) return uniqueOptions(backendOptions);
  const aliases = equipmentCategories.find((entry) => entry.key === category)?.aliases || [];
  return uniqueOptions(flattenOptions(manualOptions, (key) => aliases.some((alias) => key === alias)));
}

function catalogComboboxOptions(
  options: CatalogOption[],
  {
    activeStage = "",
    strictStage = false,
  }: {
    activeStage?: string;
    strictStage?: boolean;
  } = {},
): Array<CatalogComboboxOption<CatalogOption>> {
  return options.map((option) => {
    const value = displayOption(option);
    const stageLabel = optionStageLabel(option, activeStage);
    const stageUnknown = String((option as DecisionCandidate).availability_match || "") === "stage_unknown"
      || Boolean((option as DecisionCandidate).stage_unknown);
    const crossStage = strictStage && activeStage && !stageUnknown && !optionMatchesStage(option, activeStage);
    const facetLabels = equipmentFacetLabels(option).slice(0, 2);
    const meta = [
      stageLabel && stageLabel !== activeStage ? stageLabel : "",
      (option as DecisionCandidate).item_subtype === "radiant" ? "光明装备" : "",
      ...facetLabels,
      crossStage ? "不可确认" : "",
      stageUnknown ? "按本局上报" : "",
    ].filter(Boolean).join(" / ");
    const metaChips = [
      ...(stageLabel && stageLabel !== activeStage
        ? [{ key: "stage", label: stageLabel.replace(/^仅阶段/u, "阶段 "), tone: "info" as const }]
        : []),
      ...facetLabels.map((label, index) => ({ key: `facet-${index}-${label}`, label, tone: "neutral" as const })),
      ...(crossStage ? [{ key: "cross-stage", label: "不可确认", tone: "danger" as const }] : []),
      ...(stageUnknown ? [{ key: "unknown-stage", label: "本局上报", tone: "warning" as const }] : []),
    ];
    return {
      key: `${candidateId(option)}:${candidateName(option)}:${stageLabel}`,
      value,
      label: value,
      searchTerms: optionSearchTerms(option),
      meta,
      metaChips,
      disabled: Boolean(crossStage),
      data: option,
    };
  });
}

function findOption(value: string, options: Array<ManualVariableOption | DecisionCandidate>) {
  const normalized = value.trim().toLowerCase();
  return options.find((option) => {
    const values = [displayOption(option), candidateName(option), candidateId(option), ...optionSearchTerms(option)]
      .map((entry) => entry.toLowerCase());
    return values.includes(normalized);
  }) || null;
}

function optionCanBeConfirmed(option: CatalogOption | null, activeStage: string) {
  if (!option) return false;
  const availability = String((option as DecisionCandidate).availability_match || "");
  if (["stage_mismatch", "tier_mismatch", "stage_and_tier_mismatch"].includes(availability)) return false;
  if ((option as DecisionCandidate).current_stage_eligible === false && availability !== "stage_unknown") return false;
  return availability === "stage_unknown" || optionMatchesStage(option, activeStage);
}

function normalizeCandidate(candidate: CandidateDraft, slot: number, tierColor: string): DecisionCandidate {
  const resolved = candidate.resolved;
  const raw = candidate.input.trim();
  const separator = raw.indexOf("|");
  const fallbackId = separator > 0 ? raw.slice(0, separator).trim() : null;
  const fallbackName = separator > 0 ? raw.slice(separator + 1).trim() : raw;
  return {
    slot,
    option_id: candidateId(resolved || {}) || fallbackId,
    id: candidateId(resolved || {}) || fallbackId,
    name: candidateName(resolved || {}) || fallbackName,
    label: candidateName(resolved || {}) || fallbackName,
    display_text: candidateName(resolved || {}) || fallbackName,
    tier: resolved?.tier || null,
    tier_color: resolved?.tier_color || tierColor || null,
    item_subtype: resolved?.item_subtype || null,
    item_category: resolved?.item_category || null,
    ref: resolved?.ref || null,
  };
}

function equipmentEntryFromValue(value: string, options: Array<ManualVariableOption | DecisionCandidate>) {
  const resolved = findOption(value, options);
  return {
    name: candidateName(resolved || {}) || value.trim().replace(/^.*?\|\s*/, ""),
    ref: resolved && "ref" in resolved ? resolved.ref || null : null,
    item_subtype: resolved?.item_subtype || null,
  } satisfies DecisionEquipmentEntry;
}

function equipmentFromRuntime(options: DecisionInputOptions | null): EquipmentDraft {
  const current = options?.current_effective_equipment;
  return {
    components: current?.components || [],
    completed: current?.completed || [],
    radiant: current?.radiant || [],
    support: current?.support || [],
    artifacts: current?.artifacts || [],
    emblems: current?.emblems || [],
    special: current?.special || [],
  };
}

function candidateCountForMode(mode: RuntimeMatchModeDescriptor, itemChoiceKind: ItemChoiceKind) {
  if (mode.id === "item") {
    return mode.candidateCountsByKind[itemChoiceKind]
      || itemChoiceKinds.find((kind) => kind.id === itemChoiceKind)?.slots
      || 4;
  }
  return mode.candidateCount || 3;
}

function choiceKindForMode(mode: RuntimeMatchModeDescriptor) {
  return mode.choiceKind || mode.backendMode;
}

function modeTitle(mode: RuntimeMatchModeDescriptor, itemChoiceKind: ItemChoiceKind) {
  if (mode.id === "augment") return "强化选择";
  if (mode.id === "item") return itemChoiceKinds.find((kind) => kind.id === itemChoiceKind)?.label || "装备选择";
  return mode.label || "决策选择";
}

export function DecisionInputCard({
  runtime,
  mode,
  manualOptions,
  itemChoiceKind,
  onItemChoiceKindChange,
  onRuntimeResult,
  onStatus,
  drafts,
  setDrafts,
  stageByMode,
  setStageByMode,
}: {
  runtime: RuntimeBridge;
  mode: RuntimeMatchModeDescriptor;
  manualOptions: ManualVariableOptions;
  itemChoiceKind: ItemChoiceKind;
  onItemChoiceKindChange: (kind: ItemChoiceKind) => void;
  onRuntimeResult: (result: RuntimeResult, reason: string) => void;
  onStatus: (message: string) => void;
  drafts: DecisionInputCardDrafts;
  setDrafts: Dispatch<SetStateAction<DecisionInputCardDrafts>>;
  stageByMode: DecisionInputCardStages;
  setStageByMode: Dispatch<SetStateAction<DecisionInputCardStages>>;
}) {
  const stages = useMemo(() => mode.decisionStages, [mode.decisionStages]);
  const persistedStage = stageByMode[mode.id] || "";
  const stage = stages.includes(persistedStage) ? persistedStage : stages[0] || "";
  const setStage = (nextStage: string) => {
    setStageByMode((current) => ({ ...current, [mode.id]: nextStage }));
  };
  const slotCount = candidateCountForMode(mode, itemChoiceKind);
  const draftKey = `${mode.id}:${mode.id === "item" ? itemChoiceKind : stage}`;
  const draft = drafts[draftKey] || createDraft(slotCount);
  const choiceWindowInstanceId = mode.id === "item"
    ? draft.choiceWindowInstanceId
    : undefined;
  const selectedCategoryIds = draft.categoryIds || [];
  const [decisionOptions, setDecisionOptions] = useState<DecisionInputOptions | null>(null);
  const [binding, setBinding] = useState<DecisionPayloadBinding | null>(null);
  const [equipment, setEquipment] = useState<EquipmentDraft>(emptyEquipment);
  const [equipmentRevision, setEquipmentRevision] = useState(-1);
  const [equipmentHydrated, setEquipmentHydrated] = useState(false);
  const [equipmentDirty, setEquipmentDirty] = useState(false);
  const [itemCandidateFacet, setItemCandidateFacet] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [candidateSearchResults, setCandidateSearchResults] = useState<Record<number, CatalogOption[]>>({});
  const candidateSearchRevision = useRef(0);
  const equipmentEditGeneration = useRef(0);
  const equipmentDirtyRef = useRef(false);
  const equipmentRevisionRef = useRef(-1);
  const firstCandidateRef = useRef<HTMLInputElement | null>(null);
  const draftRequestGuard = useRef({
    key: draftKey,
    tierColor: draft.tierColor,
    categoryFingerprint: JSON.stringify(selectedCategoryIds),
    candidateFingerprint: JSON.stringify(draft.candidates.map((candidate) => candidate.input)),
  });
  draftRequestGuard.current = {
    key: draftKey,
    tierColor: draft.tierColor,
    categoryFingerprint: JSON.stringify(selectedCategoryIds),
    candidateFingerprint: JSON.stringify(draft.candidates.map((candidate) => candidate.input)),
  };
  equipmentDirtyRef.current = equipmentDirty;
  equipmentRevisionRef.current = equipmentRevision;

  const candidateOptions = useMemo(
    () => optionsForMode(mode, manualOptions, decisionOptions, draft.tierColor),
    [mode, manualOptions, decisionOptions, draft.tierColor],
  );
  const activeStage = stage
    || binding?.stage_round
    || decisionOptions?.current_reported_set?.choice_stage_round
    || "";
  const augmentCategoryDefinitions = decisionOptions?.candidate_filters?.categories || [];

  const updateDraft = (updater: (current: DecisionInputCardDraft) => DecisionInputCardDraft) => {
    setDrafts((current) => ({
      ...current,
      [draftKey]: updater(current[draftKey] || createDraft(slotCount)),
    }));
  };

  useEffect(() => {
    const initialStage = mode.decisionStages[0] || "";
    setStageByMode((current) => (
      mode.decisionStages.includes(current[mode.id] || "")
        ? current
        : { ...current, [mode.id]: initialStage }
    ));
  }, [mode.id, mode.decisionStages, setStageByMode]);

  useEffect(() => {
    setItemCandidateFacet("all");
  }, [itemChoiceKind]);

  useEffect(() => {
    setDrafts((current) => {
      if (current[draftKey]?.candidates.length === slotCount) return current;
      const previous = current[draftKey] || createDraft(slotCount);
      const candidates = emptyCandidates(slotCount);
      previous.candidates.slice(0, slotCount).forEach((candidate, index) => {
        candidates[index] = candidate;
      });
      return { ...current, [draftKey]: { ...previous, candidates, selectedIndex: null } };
    });
  }, [draftKey, slotCount]);

  useEffect(() => {
    let cancelled = false;
    const requestEquipmentGeneration = equipmentEditGeneration.current;
    setBinding(null);
    setEquipmentHydrated(false);
    runtime.getDecisionInputOptions({
      mode: mode.id,
      backend_mode: mode.backendMode,
      choice_kind: choiceKindForMode(mode),
      stage_round: stage || undefined,
      tier: draft.tierColor || null,
      category_ids: selectedCategoryIds,
      item_choice_kind: mode.id === "item" ? itemChoiceKind : undefined,
      choice_window_instance_id: choiceWindowInstanceId,
      limit: 256,
    }).then((result) => {
      if (cancelled) return;
      onRuntimeResult(result, "decision input options loaded");
      if (!result.options) return;
      setDecisionOptions(result.options);
      setBinding(result.options.payload_binding || result.payload_binding || null);
      const hydratedWindowId = result.options.payload_binding?.choice_window_instance_id
        || result.payload_binding?.choice_window_instance_id;
      if (mode.id === "item" && hydratedWindowId) {
        setDrafts((current) => ({
          ...current,
          [draftKey]: {
            ...(current[draftKey] || createDraft(slotCount)),
            choiceWindowInstanceId: hydratedWindowId,
          },
        }));
      }

      const reported = result.options.current_reported_set;
      const finalSelection = result.options.current_final_selection;
      const reportedForStage = reported && (!stages.length || reported.choice_stage_round === stage)
        ? reported.candidates || []
        : [];
      const candidatesToHydrate = reportedForStage.length
        ? reportedForStage
        : result.options.inherited_candidates || [];
      if (candidatesToHydrate.length) {
        setDrafts((current) => {
          const currentDraft = current[draftKey] || createDraft(slotCount);
          if (currentDraft.dirty || currentDraft.candidates.some((candidate) => candidate.input)) return current;
          const candidates = emptyCandidates(slotCount);
          candidatesToHydrate.slice(0, slotCount).forEach((candidate, index) => {
            candidates[index] = {
              input: displayOption(candidate),
              resolved: candidate,
            };
          });
          const tierColor = currentDraft.tierColor
            || String(candidatesToHydrate[0]?.tier_color || candidatesToHydrate[0]?.tier || "");
          const selectedIndex = candidates.findIndex((candidate) => {
            const candidateRef = candidate.resolved?.ref?.address;
            const selectedRef = finalSelection?.selected_ref?.address;
            return Boolean(selectedRef && candidateRef === selectedRef)
              || Boolean(finalSelection?.choice && candidate.resolved && displayOption(candidate.resolved) === finalSelection.choice);
          });
          return {
            ...current,
            [draftKey]: {
              ...currentDraft,
              tierColor,
              targetNote: currentDraft.targetNote || reported?.target_note || "",
              candidates,
              selectedIndex: selectedIndex >= 0 ? selectedIndex : currentDraft.selectedIndex,
              dirty: false,
              changedSlots: [],
            },
          };
        });
      }

      const nextRevision = Number(result.options.current_effective_equipment?.revision ?? 0);
      if (
        requestEquipmentGeneration === equipmentEditGeneration.current
        && !equipmentDirtyRef.current
        && nextRevision >= equipmentRevisionRef.current
      ) {
        setEquipment(equipmentFromRuntime(result.options));
        setEquipmentRevision(nextRevision);
        equipmentRevisionRef.current = nextRevision;
      }
      setEquipmentHydrated(true);
    }).catch((error) => onStatus(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
    };
  }, [runtime, mode.id, mode.backendMode, stage, stages.length, itemChoiceKind, choiceWindowInstanceId, draft.tierColor, selectedCategoryIds.join("|")]);

  useEffect(() => {
    const queries = draft.candidates.map((candidate) => (
      candidate.resolved && displayOption(candidate.resolved) === candidate.input
        ? ""
        : candidate.input.trim()
    ));
    const revision = ++candidateSearchRevision.current;
    setCandidateSearchResults((current) => Object.fromEntries(
      Object.entries(current).filter(([index]) => Boolean(queries[Number(index)])),
    ));
    if (!queries.some(Boolean)) return undefined;
    const timer = window.setTimeout(() => {
      void Promise.all(queries.map(async (query, index) => {
        if (!query) return [index, []] as const;
        const result = await runtime.getDecisionInputOptions({
          mode: mode.id,
          backend_mode: mode.backendMode,
          choice_kind: choiceKindForMode(mode),
          stage_round: activeStage || undefined,
          tier: draft.tierColor || null,
          category_ids: selectedCategoryIds,
          query,
          item_choice_kind: mode.id === "item" ? itemChoiceKind : undefined,
          limit: 256,
        });
        return [index, (result.options?.candidates || []) as CatalogOption[]] as const;
      })).then((rows) => {
        if (candidateSearchRevision.current !== revision) return;
        setCandidateSearchResults(Object.fromEntries(rows));
      }).catch((error) => {
        if (candidateSearchRevision.current !== revision) return;
        onStatus(error instanceof Error ? error.message : String(error));
      });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [
    runtime,
    mode.id,
    mode.backendMode,
    activeStage,
    draft.tierColor,
    selectedCategoryIds.join("|"),
    itemChoiceKind,
    draft.candidates.map((candidate) => `${candidate.input}\u0000${candidate.resolved ? displayOption(candidate.resolved) : ""}`).join("\u0001"),
  ]);

  const updateCandidate = (index: number, value: string) => {
    const matched = findOption(value, [...candidateOptions, ...(candidateSearchResults[index] || [])]);
    const resolved = optionCanBeConfirmed(matched, activeStage) ? matched : null;
    updateDraft((current) => ({
      ...current,
      candidates: current.candidates.map((candidate, candidateIndex) => candidateIndex === index
        ? { ...candidate, input: value, resolved }
        : candidate),
      changedSlots: Array.from(new Set([...current.changedSlots, index + 1])),
      dirty: true,
    }));
  };

  const selectCandidate = (index: number, option: CatalogOption) => {
    updateDraft((current) => ({
      ...current,
      candidates: current.candidates.map((candidate, candidateIndex) => candidateIndex === index
        ? { ...candidate, input: displayOption(option), resolved: option as DecisionCandidate }
        : candidate),
      changedSlots: Array.from(new Set([...current.changedSlots, index + 1])),
      dirty: true,
    }));
  };

  const normalizedCandidates = () => draft.candidates
    .map((candidate, index) => normalizeCandidate(candidate, index + 1, draft.tierColor))
    .filter((candidate) => candidate.name);

  const candidateInputsAreResolved = () => draft.candidates.every((candidate) => candidate.resolved !== null);

  const applyResultBinding = (result: RuntimeResult, equipmentRequestGeneration: number | null = null) => {
    const next = result as RuntimeResult<{
      payload_binding?: DecisionPayloadBinding;
      reported_choice_set?: DecisionInputOptions["current_reported_set"];
      user_confirmed_equipment_update?: DecisionInputOptions["current_effective_equipment"];
    }>;
    if (next.payload_binding) setBinding(next.payload_binding);
    const canApplyEquipment = equipmentRequestGeneration === null
      ? !equipmentDirtyRef.current
      : equipmentRequestGeneration === equipmentEditGeneration.current;
    if (next.user_confirmed_equipment_update && canApplyEquipment) {
      setEquipment({
        components: next.user_confirmed_equipment_update.components || [],
        completed: next.user_confirmed_equipment_update.completed || [],
        radiant: next.user_confirmed_equipment_update.radiant || [],
        support: next.user_confirmed_equipment_update.support || [],
        artifacts: next.user_confirmed_equipment_update.artifacts || [],
        emblems: next.user_confirmed_equipment_update.emblems || [],
        special: next.user_confirmed_equipment_update.special || [],
      });
      setEquipmentRevision(Number(next.user_confirmed_equipment_update.revision ?? equipmentRevision));
      equipmentRevisionRef.current = Number(next.user_confirmed_equipment_update.revision ?? equipmentRevisionRef.current);
      setEquipmentDirty(false);
      equipmentDirtyRef.current = false;
    }
    setDecisionOptions((current) => current ? {
      ...current,
      payload_binding: next.payload_binding || current.payload_binding,
      current_reported_set: next.reported_choice_set || current.current_reported_set,
    } : current);
    return !next.user_confirmed_equipment_update || canApplyEquipment;
  };

  const submitChoice = async (requestAdvice = true) => {
    const candidates = normalizedCandidates();
    if (mode.id === "augment" && !draft.tierColor) {
      onStatus("请先选择本轮强化等级。 ");
      return;
    }
    if (candidates.length !== slotCount || !candidateInputsAreResolved()) {
      onStatus(`请从当前阶段目录中搜索并选满 ${slotCount} 个候选，再获取建议。`);
      firstCandidateRef.current?.focus();
      return;
    }
    const action: DecisionInputAction = requestAdvice ? "choice_advice" : "choice_update";
    const payload: DecisionInputPayload = {
      mode: mode.id,
      backend_mode: mode.backendMode,
      choice_kind: choiceKindForMode(mode),
      stage_round: activeStage || undefined,
      tier: draft.tierColor || null,
      action,
      request_advice: requestAdvice,
      structured_card_action_id: requestAdvice ? crypto.randomUUID() : undefined,
      advice_action: requestAdvice ? "choice_advice" : undefined,
      target_note: draft.targetNote.trim(),
      candidates,
      changed_slots: draft.changedSlots.filter((slot) => Number.isInteger(slot) && slot >= 1 && slot <= slotCount),
      payload_binding: binding,
      ...(requestAdvice && equipmentHydrated ? {
        equipment,
        changed_sections: equipmentCategories.map((category) => category.key),
      } : {}),
      item_choice_kind: mode.id === "item" ? itemChoiceKind : undefined,
      choice_window_instance_id: choiceWindowInstanceId,
    };
    setBusy(action);
    try {
      const result = await runtime.submitDecisionInput(payload);
      applyResultBinding(result);
      onRuntimeResult(result, action);
      if (!result.ok) return result;
      updateDraft((current) => ({ ...current, dirty: false, changedSlots: [] }));
      onStatus(result.message || (requestAdvice ? "已提交当前卡片，正在结合共享装备、聊天上下文、最新用户意图、目标计划和 live state 生成建议。" : "已无建议保存当前候选。"));
      return result;
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const confirmSelection = async () => {
    const candidates = normalizedCandidates();
    const selected = draft.selectedIndex === null ? null : candidates.find((candidate) => candidate.slot === draft.selectedIndex! + 1);
    if (!selected || candidates.length !== slotCount || !candidateInputsAreResolved()) {
      onStatus("请先从目录中选满候选并选中最终项。");
      return;
    }
    let confirmBinding = binding;
    if (draft.dirty || !confirmBinding) {
      const saveResult = await submitChoice(false) as RuntimeResult<{
        payload_binding?: DecisionPayloadBinding;
        options?: DecisionInputOptions;
      }> | null;
      confirmBinding = saveResult?.payload_binding || saveResult?.options?.payload_binding || binding;
      if (!saveResult?.ok || !confirmBinding) {
        onStatus("当前候选未能原子保存，暂不确认最终选择。");
        return;
      }
    }
    const payload: DecisionSelectionPayload = {
      mode: mode.id,
      backend_mode: mode.backendMode,
      choice_kind: choiceKindForMode(mode),
      stage_round: activeStage || undefined,
      slot: Number(selected.slot),
      selected_choice: candidateName(selected),
      ref: selected.ref || null,
      payload_binding: confirmBinding,
      item_choice_kind: mode.id === "item" ? itemChoiceKind : undefined,
      choice_window_instance_id: choiceWindowInstanceId,
    };
    setBusy("confirm");
    try {
      const result = await runtime.confirmDecisionSelection(payload);
      applyResultBinding(result);
      onRuntimeResult(result, "confirmDecisionSelection");
      if (!result.ok) return;
      if (result.status === "choice_confirmation_already_recorded") {
        onStatus(result.message || "这项最终选择已经记录。");
        return;
      }
      onStatus(result.message || "已记录最终选择，后续建议会使用这项选择。");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const addEquipmentToken = (
    category: EquipmentCategory,
    value: string,
    options: Array<ManualVariableOption | DecisionCandidate>,
  ) => {
    const entry = equipmentEntryFromValue(value, options);
    if (!entry.name) return;
    const nextEntries = [...equipment[category], entry];
    const requestGeneration = ++equipmentEditGeneration.current;
    setEquipment((current) => ({ ...current, [category]: nextEntries }));
    setEquipmentDirty(true);
    equipmentDirtyRef.current = true;
    void submitEquipment(category, nextEntries, false, true, requestGeneration);
  };

  const removeEquipmentToken = (category: EquipmentCategory, index: number) => {
    const nextEntries = equipment[category].filter((_, itemIndex) => itemIndex !== index);
    const requestGeneration = ++equipmentEditGeneration.current;
    setEquipment((current) => ({ ...current, [category]: nextEntries }));
    setEquipmentDirty(true);
    equipmentDirtyRef.current = true;
    void submitEquipment(category, nextEntries, false, true, requestGeneration);
  };

  async function submitEquipment(
    category?: EquipmentCategory,
    overrideEntries?: DecisionEquipmentEntry[],
    requestAdvice = true,
    silent = false,
    requestGeneration = equipmentEditGeneration.current,
  ) {
    const selectedEquipment: DecisionEquipmentPayload = category
      ? { [category]: overrideEntries ?? equipment[category] }
      : equipment;
    const action = category
      ? `equipment_${category}_update`
      : requestAdvice ? "equipment_all_advice" : "equipment_all_update";
    const payload: DecisionInputPayload = {
      mode: mode.id,
      backend_mode: mode.backendMode,
      choice_kind: choiceKindForMode(mode),
      stage_round: activeStage || undefined,
      action,
      request_advice: requestAdvice,
      structured_card_action_id: requestAdvice ? crypto.randomUUID() : undefined,
      advice_action: requestAdvice ? "global_advice" : undefined,
      candidates: [],
      equipment: selectedEquipment,
      changed_sections: category ? [category] : equipmentCategories.map((entry) => entry.key),
      payload_binding: binding,
      item_choice_kind: mode.id === "item" ? itemChoiceKind : undefined,
    };
    const tracksBusy = requestAdvice || (!category && !silent);
    if (tracksBusy) setBusy(action);
    try {
      const result = await runtime.submitDecisionInput(payload);
      const equipmentAcknowledged = applyResultBinding(result, requestGeneration);
      onRuntimeResult(result, action);
      if (!result.ok) return;
      if (equipmentAcknowledged) {
        setEquipmentDirty(false);
        equipmentDirtyRef.current = false;
      }
      if (!silent) onStatus(result.message || (requestAdvice ? "装备事实已更新，正在生成装备建议。" : "装备已确认，本次没有请求教练建议。"));
    } catch (error) {
      if (!silent) onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (tracksBusy) setBusy(null);
    }
  }

  const clearEquipmentCategory = (category: EquipmentCategory) => {
    const requestGeneration = ++equipmentEditGeneration.current;
    setEquipment((current) => ({ ...current, [category]: [] }));
    setEquipmentDirty(true);
    equipmentDirtyRef.current = true;
    void submitEquipment(category, [], false, true, requestGeneration);
  };

  const clearCandidates = () => updateDraft((current) => ({
    ...current,
    candidates: emptyCandidates(slotCount),
    selectedIndex: null,
    changedSlots: Array.from({ length: slotCount }, (_, index) => index + 1),
    dirty: true,
  }));

  const beginNewItemChoiceWindow = () => {
    if (mode.id !== "item") return;
    const nextWindowId = crypto.randomUUID();
    setBinding(null);
    setDecisionOptions(null);
    updateDraft(() => ({
      ...createDraft(slotCount),
      choiceWindowInstanceId: nextWindowId,
    }));
    onStatus("已开始下一次装备选择；请提交这次候选后再确认最终选择。");
  };

  const captureOcrDraft = async () => {
    if (!activeStage || !draft.tierColor) {
      onStatus("请先选择强化阶段和颜色，再使用快速 OCR。");
      return;
    }
    const requestGuard = { ...draftRequestGuard.current };
    setBusy("explicit_ocr_draft");
    try {
      const result = await runtime.captureDecisionInputOcrDraft({
        mode: mode.id,
        backend_mode: mode.backendMode,
        choice_kind: choiceKindForMode(mode),
        stage_round: activeStage,
        tier: draft.tierColor,
      });
      const candidates = result.draft_candidates || [];
      if (!result.ok || candidates.length === 0) {
        onStatus(result.message || "快速 OCR 没有完整识别三个强化，原卡片内容未改动。");
        return;
      }
      const currentGuard = draftRequestGuard.current;
      if (
        currentGuard.key !== requestGuard.key
        || currentGuard.tierColor !== requestGuard.tierColor
        || currentGuard.categoryFingerprint !== requestGuard.categoryFingerprint
        || currentGuard.candidateFingerprint !== requestGuard.candidateFingerprint
      ) {
        onStatus("快速 OCR 返回时卡片阶段、颜色或候选已经变化；为避免覆盖你的新编辑，本次结果未写入。");
        return;
      }
      updateDraft((current) => ({
        ...current,
        candidates: current.candidates.map((existing, index) => {
          const candidate = candidates.find((entry) => Number(entry.slot) === index + 1);
          return candidate ? {
            input: displayOption(candidate),
            resolved: candidate,
          } : existing;
        }),
        selectedIndex: null,
        changedSlots: Array.from(new Set([
          ...current.changedSlots,
          ...candidates.map((candidate) => Number(candidate.slot)).filter((slot) => Number.isInteger(slot) && slot >= 1 && slot <= slotCount),
        ])),
        dirty: true,
      }));
      onStatus(result.message || "已填入 OCR 草稿，请核对后再获取建议或确认最终选择。");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const confirmDisabled = busy !== null
    || draft.selectedIndex === null
    || normalizedCandidates().length !== slotCount
    || !candidateInputsAreResolved();

  return (
    <section className={`decision-input-card decision-mode-${mode.id}`} aria-label={`${mode.label}结构化决策`}>
      <div className="decision-card-head">
        <div>
          <p>{modeTitle(mode, itemChoiceKind)}</p>
          <h2>{mode.label}</h2>
        </div>
        {stages.length > 0 ? (
          <div className="decision-tabs" role="tablist" aria-label="选择阶段">
            {stages.map((entry) => (
              <button
                type="button"
                role="tab"
                aria-selected={stage === entry}
                className={stage === entry ? "selected" : ""}
                key={entry}
                onClick={() => setStage(entry)}
              >
                {entry}
              </button>
            ))}
          </div>
        ) : mode.id === "item" ? (
          <div className="decision-tabs" role="radiogroup" aria-label="装备选择类型">
            {itemChoiceKinds.map((kind) => (
              <button
                type="button"
                role="radio"
                aria-checked={itemChoiceKind === kind.id}
                className={itemChoiceKind === kind.id ? "selected" : ""}
                key={kind.id}
                onClick={() => onItemChoiceKindChange(kind.id)}
              >
                {kind.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="decision-card-body">
        {mode.id === "augment" && (
          <section className="decision-tier-selector" aria-label="强化等级">
            <span>强化等级</span>
            <div role="radiogroup">
              {augmentTiers.map((tier) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.tierColor === tier.id}
                  className={draft.tierColor === tier.id ? "selected" : ""}
                  key={tier.id}
                  onClick={() => updateDraft((current) => ({
                    ...current,
                    tierColor: tier.id,
                    candidates: emptyCandidates(slotCount),
                    selectedIndex: null,
                    changedSlots: Array.from({ length: slotCount }, (_, index) => index + 1),
                    dirty: true,
                  }))}
                >
                  {tier.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {mode.id === "augment" && augmentCategoryDefinitions.length > 0 && (
          <fieldset className="decision-category-filter">
            <legend>强化分类</legend>
            <div>
              {augmentCategoryDefinitions.map((category) => {
                const checked = selectedCategoryIds.includes(category.id);
                return (
                  <label key={category.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy !== null}
                      onChange={() => updateDraft((current) => ({
                        ...current,
                        categoryIds: checked
                          ? (current.categoryIds || []).filter((id) => id !== category.id)
                          : [...new Set([...(current.categoryIds || []), category.id])].sort(),
                        candidates: emptyCandidates(slotCount),
                        selectedIndex: null,
                        changedSlots: Array.from({ length: slotCount }, (_, index) => index + 1),
                        dirty: true,
                      }))}
                    />
                    <span>{category.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        {mode.id === "item" && itemChoiceKind !== "basic_component_forge" && (
          <section className="decision-item-facets" aria-label="装备候选分类">
            <span>候选分类</span>
            <div className="equipment-facets" role="group">
              {equipmentFacets.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className={itemCandidateFacet === entry.id ? "selected" : ""}
                  aria-pressed={itemCandidateFacet === entry.id}
                  onClick={() => setItemCandidateFacet(entry.id)}
                  disabled={busy !== null}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {decisionOptions?.current_final_selection?.choice && (
          <p className="decision-recorded-selection">
            已记录{decisionOptions.current_final_selection.choice_stage_round ? ` ${decisionOptions.current_final_selection.choice_stage_round}` : ""}最终选择：
            <strong>{decisionOptions.current_final_selection.choice}</strong>
          </p>
        )}
        <section className="candidate-grid" aria-label="候选输入">
          {draft.candidates.map((candidate, index) => {
            const candidateDefault = candidateOptions.filter((option) => (
              optionMatchesDefaultList(option, activeStage)
              && (mode.id !== "item" || optionMatchesEquipmentFacet(option, itemCandidateFacet))
            ));
            const candidateSource = candidate.input.trim()
              ? candidateSearchResults[index] ?? candidateOptions
              : candidateDefault;
            return (
            <div className="candidate-row" key={`${draftKey}-${index}`}>
              <div className="candidate-field">
                <span>{mode.candidateLabel ? `${mode.candidateLabel} ${index + 1}` : `候选 ${index + 1}`}</span>
                <CatalogCombobox
                  inputRef={index === 0 ? firstCandidateRef : undefined}
                  value={candidate.input}
                  options={catalogComboboxOptions(candidateSource, {
                    activeStage,
                    strictStage: Boolean(candidate.input.trim()),
                  })}
                  maxVisible={10}
                  ariaLabel={`候选 ${index + 1}`}
                  onInput={(value) => updateCandidate(index, value)}
                  onCommit={(option) => selectCandidate(index, option.data)}
                  placeholder="搜索名称、简称或 ID"
                />
              </div>
              <label className="candidate-confirm">
                <input
                  type="radio"
                  name={`decision-final-${draftKey}`}
                  checked={draft.selectedIndex === index}
                  onChange={() => updateDraft((current) => ({ ...current, selectedIndex: index }))}
                />
                <span>最终选择</span>
              </label>
            </div>
          );
          })}
        </section>

        <label className="decision-target-note">
          <span>目标 / 补充条件</span>
          <input
            value={draft.targetNote}
            onChange={(event) => updateDraft((current) => ({ ...current, targetNote: event.target.value }))}
            placeholder="可留空，也可以写想玩的阵容、装备倾向或临时思路"
          />
        </label>

        <div className="decision-actions">
          <button type="button" onClick={clearCandidates} disabled={busy !== null}>
            <Trash2 size={13} />
            清空候选
          </button>
          {mode.id === "item" && (
            <button type="button" onClick={beginNewItemChoiceWindow} disabled={busy !== null}>
              <Plus size={13} />
              下一次装备选择
            </button>
          )}
          {mode.id === "augment" && (
            <button type="button" onClick={captureOcrDraft} disabled={busy !== null || !activeStage || !draft.tierColor}>
              <ScanText size={13} />
              快速 OCR
            </button>
          )}
          <button type="button" onClick={() => submitChoice()} disabled={busy !== null || !binding}>
            <Check size={13} />
            获取建议
          </button>
          {mode.id !== "item" && <span>建议会自动使用共享装备、聊天上下文、最新意图、目标计划和 live state；目标可留空。</span>}
          <span>{mode.refreshReportPrefix || "刷新后直接修改发生变化的候选槽位，再重新获取建议；未变化的候选会保留。"}</span>
        </div>

        <section className="equipment-editor" aria-label="共享装备编辑器">
          <div className="equipment-editor-head">
            <strong>已确认装备</strong>
            <button type="button" onClick={() => submitEquipment(undefined, undefined, false, false)} disabled={busy !== null || !equipmentHydrated}>确认装备</button>
            <button type="button" onClick={() => submitEquipment()} disabled={busy !== null || !binding}>整体装备建议</button>
          </div>
          {equipmentCategories.map((category) => (
            <EquipmentCategoryEditor
              key={category.key}
              category={category.key}
              label={category.label}
              tokens={equipment[category.key]}
              options={equipmentOptionsFor(category.key, manualOptions, decisionOptions)}
              onAdd={addEquipmentToken}
              onRemove={removeEquipmentToken}
              onClear={clearEquipmentCategory}
              disabled={busy !== null || !binding}
            />
          ))}
        </section>
      </div>

      <div className="decision-confirm-row">
        <button className="decision-confirm-button" type="button" onClick={confirmSelection} disabled={confirmDisabled}>
          <Check size={14} />
          确认最终选择
        </button>
        <span>{draft.dirty ? "候选有变化；确认时会先无模型保存，再确认最终选择。" : busy ? "处理中..." : "最终确认后会记录本局选择，并给一次下一步 Coach 建议。"}</span>
      </div>
    </section>
  );
}

function EquipmentCategoryEditor({
  category,
  label,
  tokens,
  options,
  onAdd,
  onRemove,
  onClear,
  disabled,
}: {
  category: EquipmentCategory;
  label: string;
  tokens: DecisionEquipmentEntry[];
  options: Array<ManualVariableOption | DecisionCandidate>;
  onAdd: (category: EquipmentCategory, value: string, options: Array<ManualVariableOption | DecisionCandidate>) => void;
  onRemove: (category: EquipmentCategory, index: number) => void;
  onClear: (category: EquipmentCategory) => void;
  disabled: boolean;
}) {
  const [input, setInput] = useState("");
  const [facet, setFacet] = useState("all");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const showFacets = category === "completed" || category === "radiant" || category === "artifacts";
  const visibleOptions = useMemo(() => {
    if (input.trim() || !showFacets || facet === "all") return options;
    return options.filter((option) => optionMatchesEquipmentFacet(option, facet));
  }, [facet, input, options, showFacets]);

  const commit = () => {
    const value = input.trim();
    if (!value) return;
    onAdd(category, value, options);
    setInput("");
  };

  return (
    <div className="equipment-category">
      <div className="equipment-category-title">
        <span>{label}</span>
        <button type="button" aria-label={`清空${label}`} onClick={() => onClear(category)} disabled={disabled || tokens.length === 0}>
          <Trash2 size={12} />
        </button>
      </div>
      {showFacets && (
        <div className="equipment-facets" role="group" aria-label={`${label}分类`}>
          {equipmentFacets.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={facet === entry.id ? "selected" : ""}
              aria-pressed={facet === entry.id}
              onClick={() => setFacet(entry.id)}
              disabled={disabled}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      <div className="token-input" onClick={() => inputRef.current?.focus()}>
        {tokens.map((token, index) => (
          <button type="button" key={`${token.ref?.address || "manual"}:${token.name}:${index}`} onClick={() => onRemove(category, index)} title="删除这一份">
            {displayEquipment(token)}
          </button>
        ))}
        <CatalogCombobox
          inputRef={inputRef}
          value={input}
          options={catalogComboboxOptions(visibleOptions)}
          maxVisible={category === "completed" || category === "radiant" || category === "artifacts" ? 9 : 7}
          ariaLabel={`${label}装备`}
          onInput={setInput}
          onCommit={(option) => {
            onAdd(category, option.value, options);
            setInput("");
          }}
          onCommitInput={(value) => {
            onAdd(category, value, options);
            setInput("");
          }}
          onBackspaceEmpty={() => {
            if (tokens.length) onRemove(category, tokens.length - 1);
          }}
          placeholder={tokens.length ? "" : "搜索添加"}
        />
      </div>
    </div>
  );
}
