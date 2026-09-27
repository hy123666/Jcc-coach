import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HOST_COACH_INSTRUCTION_CONTRACT_PATH = path.resolve(
  import.meta.dirname,
  "../data/runtime/jcc/host-coach-instruction-contract.json",
);

export const REQUIRED_HOST_COACH_MODES = Object.freeze([
  "daily_chat",
  "postgame_review",
  "user_preferences",
  "strategy_wiki",
  "cruise",
  "augment_choice",
  "item_choice",
  "lineup_card",
  "refresh_self_state",
  "manual_match_variables",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim());
}

function pushError(errors, pathLabel, message) {
  errors.push(`${pathLabel}: ${message}`);
}

function orderedSectionMap(contract) {
  const map = new Map();
  for (const section of contract.base_instruction_sections || []) {
    if (section?.id) map.set(section.id, section);
  }
  return map;
}

export async function readHostCoachInstructionContract(options = {}) {
  const contractPath = options.contractPath || HOST_COACH_INSTRUCTION_CONTRACT_PATH;
  const raw = await readFile(contractPath, "utf8");
  return JSON.parse(raw);
}

export function readHostCoachInstructionContractSync(options = {}) {
  const contractPath = options.contractPath || HOST_COACH_INSTRUCTION_CONTRACT_PATH;
  return JSON.parse(readFileSync(contractPath, "utf8").replace(/^\uFEFF/, ""));
}

export function buildHostKnowledgeOperationInstructions(contract = readHostCoachInstructionContractSync()) {
  return [...(orderedSectionMap(contract).get("knowledge_operations")?.instructions || [])];
}

export function validateHostCoachInstructionContract(contract) {
  const errors = [];
  if (!isPlainObject(contract)) {
    return { ok: false, errors: ["contract: expected object"] };
  }

  if (contract.schema !== "jcc-host-coach-instruction-contract-v1") {
    pushError(errors, "schema", "must be jcc-host-coach-instruction-contract-v1");
  }
  if (contract.provider_neutral !== true) pushError(errors, "provider_neutral", "must be true");
  if (contract.runtime_invariant !== true) pushError(errors, "runtime_invariant", "must be true");
  if (contract.season_specific_content_allowed !== false) {
    pushError(errors, "season_specific_content_allowed", "must be false");
  }
  if (contract.patch_specific_content_allowed !== false) {
    pushError(errors, "patch_specific_content_allowed", "must be false");
  }
  if (contract.hardcoded_choice_stage_literals_allowed !== false) {
    pushError(errors, "hardcoded_choice_stage_literals_allowed", "must be false");
  }

  if (!Array.isArray(contract.authority_order) || contract.authority_order.length < 2) {
    pushError(errors, "authority_order", "must contain ordered authority entries");
  } else {
    contract.authority_order.forEach((entry, index) => {
      if (!entry?.id || !entry?.instruction) {
        pushError(errors, `authority_order[${index}]`, "must include id and instruction");
      }
    });
  }

  if (!Array.isArray(contract.base_instruction_sections) || contract.base_instruction_sections.length === 0) {
    pushError(errors, "base_instruction_sections", "must contain sections");
  } else {
    contract.base_instruction_sections.forEach((section, index) => {
      if (!section?.id || !section?.title || !asStringArray(section?.instructions)) {
        pushError(errors, `base_instruction_sections[${index}]`, "must include id, title, and instructions");
      }
    });
  }

  if (!isPlainObject(contract.modes)) {
    pushError(errors, "modes", "must be an object");
  } else {
    for (const mode of REQUIRED_HOST_COACH_MODES) {
      const modeContract = contract.modes[mode];
      if (!modeContract) {
        pushError(errors, `modes.${mode}`, "missing required mode");
      } else if (!modeContract.title || !asStringArray(modeContract.instructions)) {
        pushError(errors, `modes.${mode}`, "must include title and instructions");
      }
    }
  }

  if (!isPlainObject(contract.default_mode) || !contract.default_mode.title || !asStringArray(contract.default_mode.instructions)) {
    pushError(errors, "default_mode", "must include title and instructions");
  }

  if (!Array.isArray(contract.required_modes)) {
    pushError(errors, "required_modes", "must be an array");
  } else {
    const requiredModes = new Set(contract.required_modes);
    for (const mode of REQUIRED_HOST_COACH_MODES) {
      if (!requiredModes.has(mode)) pushError(errors, "required_modes", `missing ${mode}`);
    }
  }

  const sectionMap = orderedSectionMap(contract);
  if (!Array.isArray(contract.instruction_order)) {
    pushError(errors, "instruction_order", "must be an array");
  } else {
    for (const sectionId of contract.instruction_order) {
      if (
        !["authority_order", "active_mode", "optional_signature_contract"].includes(sectionId)
        && !sectionMap.has(sectionId)
      ) {
        pushError(errors, "instruction_order", `unknown section ${sectionId}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function normalizeBuildArgs(modeOrOptions, maybeOptions) {
  if (typeof modeOrOptions === "string") {
    return { ...(maybeOptions || {}), mode: modeOrOptions };
  }
  if (isPlainObject(modeOrOptions)) return { ...modeOrOptions };
  return { ...(maybeOptions || {}), mode: undefined };
}

function appendTitledInstructions(output, title, instructions) {
  for (const instruction of instructions) {
    output.push(`${title}: ${instruction}`);
  }
}

function signatureForMode(signatureContract, mode) {
  if (!isPlainObject(signatureContract)) return null;
  const signatures = signatureContract.signatures;
  if (!isPlainObject(signatures)) return null;
  const aliases = {
    augment_choice: "manual_augment_choice",
    cruise: "cruise_advice",
  };
  return signatures[mode] || signatures[aliases[mode]] || signatures.default || null;
}

function appendSignatureInstructions(output, signatureContract, mode) {
  const signature = signatureForMode(signatureContract, mode);
  if (!isPlainObject(signature)) return;
  if (asStringArray(signature.required_semantics)) {
    appendTitledInstructions(output, "Optional Signature Semantics", signature.required_semantics);
  }
  if (asStringArray(signature.output_fields)) {
    output.push(`Optional Signature Output Fields: ${signature.output_fields.join(", ")}`);
  }
}

function normalizedSeasonModeAddon(value, mode) {
  if (typeof value === "string" && value.trim()) {
    return { title: `${mode} season guidance`, instructions: [value.trim().slice(0, 16384)] };
  }
  if (Array.isArray(value)) {
    const instructions = value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim().slice(0, 16384))
      .slice(0, 16);
    return instructions.length ? { title: `${mode} season guidance`, instructions } : null;
  }
  if (!isPlainObject(value)) return null;
  const sourceInstructions = Array.isArray(value.instructions)
    ? value.instructions
    : typeof value.instructions === "string"
      ? [value.instructions]
      : [];
  const instructions = sourceInstructions
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim().slice(0, 16384))
    .slice(0, 16);
  if (!instructions.length) return null;
  return {
    title: typeof value.title === "string" && value.title.trim()
      ? value.title.trim().slice(0, 240)
      : `${mode} season guidance`,
    instructions,
  };
}

export function buildHostCoachInstructions(modeOrOptions = {}, maybeOptions = {}) {
  const options = normalizeBuildArgs(modeOrOptions, maybeOptions);
  const contract = options.contract;
  if (!isPlainObject(contract)) {
    throw new Error("buildHostCoachInstructions requires a contract object; call readHostCoachInstructionContract first or pass { contract }");
  }

  const validation = validateHostCoachInstructionContract(contract);
  if (!validation.ok) {
    throw new Error(`Invalid host coach instruction contract:\n${validation.errors.join("\n")}`);
  }

  const requestedMode = typeof options.mode === "string" && options.mode.trim() ? options.mode.trim() : "default";
  const aliasTarget = options.modeAliases?.[requestedMode];
  if (aliasTarget !== undefined && (typeof aliasTarget !== "string" || !aliasTarget.trim())) {
    throw new Error(`Invalid host mode alias for ${requestedMode}`);
  }
  const mode = typeof aliasTarget === "string" && aliasTarget.trim() ? aliasTarget.trim() : requestedMode;
  const seasonModeAddon = normalizedSeasonModeAddon(options.seasonModeAddons?.[mode], mode);
  const commonModeContract = contract.modes[mode] || null;
  const modeContracts = [commonModeContract, seasonModeAddon].filter(Boolean);
  if (!modeContracts.length) modeContracts.push(contract.default_mode);
  const sectionMap = orderedSectionMap(contract);
  const output = [];
  const includeBase = options.includeBase !== false;
  const includeMode = options.includeMode !== false;
  const includeSignature = options.includeSignature !== false;

  for (const sectionId of contract.instruction_order) {
    if (sectionId === "authority_order") {
      if (!includeBase) continue;
      for (const entry of contract.authority_order) {
        output.push(`Authority Order: ${entry.instruction}`);
      }
      continue;
    }
    if (sectionId === "active_mode") {
      if (!includeMode) continue;
      for (const modeContract of modeContracts) {
        appendTitledInstructions(output, `Active Mode - ${modeContract.title}`, modeContract.instructions);
      }
      continue;
    }
    if (sectionId === "optional_signature_contract") {
      if (!includeSignature) continue;
      appendSignatureInstructions(output, options.signatureContract, mode);
      continue;
    }
    if (!includeBase) continue;
    const section = sectionMap.get(sectionId);
    if (section) appendTitledInstructions(output, section.title, section.instructions);
  }

  return output;
}

export const read = readHostCoachInstructionContract;
export const readSync = readHostCoachInstructionContractSync;
export const validate = validateHostCoachInstructionContract;
export const build = buildHostCoachInstructions;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modeArgIndex = process.argv.indexOf("--mode");
  const mode = modeArgIndex >= 0 ? process.argv[modeArgIndex + 1] : "daily_chat";
  const contract = await readHostCoachInstructionContract();
  const instructions = buildHostCoachInstructions({ contract, mode });
  process.stdout.write(`${JSON.stringify({ ok: true, mode, instructions }, null, 2)}\n`);
}
