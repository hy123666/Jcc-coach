import { normalizeHostLineupTransport } from "./host-coach-response-contract.js";

function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function cleanStringArray(value, limit = Infinity) {
  return firstArray(value)
    .map((entry) => cleanString(entry?.name || entry))
    .filter(Boolean)
    .slice(0, limit);
}

function seasonCatalogFromHostRequest(hostRequest) {
  return hostRequest?.season_catalog
    || hostRequest?.runtime_context?.season_catalog
    || hostRequest?.context?.season_catalog
    || hostRequest?.context?.runtime_context?.season_catalog
    || null;
}

function currentSeasonChampionNames(hostRequest) {
  const catalog = seasonCatalogFromHostRequest(hostRequest);
  const names = new Set(firstArray(catalog?.champion_names).map((name) => cleanString(name)).filter(Boolean));
  for (const champion of Object.values(catalog?.champions_by_cost || {}).flat()) {
    const name = cleanString(champion?.name);
    if (name) names.add(name);
  }
  return names;
}

function moveText(move) {
  const action = cleanString(move?.action);
  const unit = cleanString(move?.unit);
  const from = cleanString(move?.from);
  const to = cleanString(move?.to);
  const reason = cleanString(move?.reason);
  const description = cleanString(move?.description || move?.text || move?.note);
  const position = from && to ? `${from} -> ${to}` : to || from;
  const head = action || [unit, position].filter(Boolean).join(" ");
  return [head, description, reason].filter(Boolean).join(": ");
}

function normalizeRecommendedMove(move) {
  if (typeof move === "string") {
    const description = cleanString(move);
    return description ? { description } : null;
  }
  if (!move || typeof move !== "object" || Array.isArray(move)) return null;
  const normalized = {
    ...(cleanString(move.unit || move.name || move.champion) ? { unit: cleanString(move.unit || move.name || move.champion) } : {}),
    ...(cleanString(move.from) ? { from: cleanString(move.from) } : {}),
    ...(cleanString(move.to) ? { to: cleanString(move.to) } : {}),
    ...(cleanString(move.action) ? { action: cleanString(move.action) } : {}),
    ...(cleanString(move.reason) ? { reason: cleanString(move.reason) } : {}),
    ...(cleanString(move.description || move.text || move.note) ? { description: cleanString(move.description || move.text || move.note) } : {}),
  };
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeUnit(unit) {
  const row = Number(unit?.row ?? unit?.r);
  const col = Number(unit?.col ?? unit?.column ?? unit?.column_index ?? unit?.c);
  const name = cleanString(unit?.name || unit?.unit || unit?.champion || unit?.champion_name);
  const items = cleanStringArray(unit?.items || unit?.equipment, 3);
  return {
    row,
    col,
    name,
    ...(unit?.mark ? { mark: String(unit.mark) } : {}),
    ...(unit?.star != null && unit.star !== "" && Number.isFinite(Number(unit.star)) ? { star: Number(unit.star) } : {}),
    ...(cleanString(unit?.role || unit?.semantic_role) ? { role: cleanString(unit.role || unit.semantic_role) } : {}),
    ...(items.length ? { items } : {}),
    ...(unit?.notes || unit?.note ? { notes: cleanString(unit.notes || unit.note) } : {}),
  };
}

function normalizeLoadout(loadout) {
  const unit = cleanString(loadout?.unit || loadout?.name || loadout?.champion);
  return {
    unit,
    items: cleanStringArray(loadout?.items || loadout?.equipment, 3),
    ...(loadout?.note ? { note: cleanString(loadout.note) } : {}),
  };
}

function normalizeLineupNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const board = firstObject(node.board);
  const nodeUnits = firstArray(node.units).length ? firstArray(node.units) : firstArray(board?.units);
  const units = nodeUnits
    .map(normalizeUnit)
    .filter((unit) => unit.name && unit.row >= 1 && unit.row <= 4 && unit.col >= 1 && unit.col <= 7);
  const rawRecommendedMoves = firstArray(node.recommended_moves).length ? firstArray(node.recommended_moves) : firstArray(node.moves);
  const recommendedMoves = rawRecommendedMoves.map(normalizeRecommendedMove).filter(Boolean);
  const moves = firstArray(node.moves).length
    ? cleanStringArray(node.moves)
    : recommendedMoves.map(moveText).filter(Boolean);
  const normalized = {
    ...(cleanString(node.id) ? { id: cleanString(node.id) } : {}),
    ...(cleanString(node.label || node.title || node.stage) ? { label: cleanString(node.label || node.title || node.stage) } : {}),
    ...(cleanString(node.timing || node.round) ? { timing: cleanString(node.timing || node.round) } : {}),
    ...((node.level ?? node.population) != null && Number.isFinite(Number(node.level ?? node.population)) ? { level: Number(node.level ?? node.population) } : {}),
    ...(units.length ? { units } : {}),
    ...(recommendedMoves.length ? { recommended_moves: recommendedMoves } : {}),
    ...(moves.length ? { moves } : {}),
  };
  return Object.keys(normalized).length ? normalized : null;
}

export function lineupPinnedResultSchemaDiagnostics(value, hostRequest = null) {
  const errors = [];
  try { value = normalizeHostLineupTransport(value); } catch (error) { return [error.message]; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["pinned_result must be an object"];

  const inputSchema = cleanString(value.schema);
  if (inputSchema && inputSchema !== "jcc-internal-lineup-plan-v1") {
    errors.push(`schema must be jcc-internal-lineup-plan-v1, got ${inputSchema}`);
  }

  const board = firstObject(value.board);
  const rawUnits = firstArray(value.units).length ? firstArray(value.units) : firstArray(board?.units);
  if (!rawUnits.length) errors.push("units must contain at least one board unit");

  errors.push(...finalTargetStrategyErrors(value, hostRequest));

  const occupied = new Set();
  rawUnits.forEach((unit, index) => {
    const path = `units[${index}]`;
    const row = Number(unit?.row ?? unit?.r);
    const col = Number(unit?.col ?? unit?.column ?? unit?.column_index ?? unit?.c);
    const name = cleanString(unit?.name || unit?.unit || unit?.champion || unit?.champion_name);
    if (!name) errors.push(`${path}.name must be a non-empty current-season champion name`);
    if (!Number.isInteger(row) || row < 1 || row > 4) errors.push(`${path}.row must be an integer from 1 to 4`);
    if (!Number.isInteger(col) || col < 1 || col > 7) errors.push(`${path}.col must be an integer from 1 to 7`);
    if (unit?.star != null && (!Number.isInteger(unit.star) || unit.star < 1 || unit.star > 4)) errors.push(`${path}.star must be an integer from 1 to 4`);
    const key = `${row}:${col}`;
    if (Number.isInteger(row) && Number.isInteger(col)) {
      if (occupied.has(key)) errors.push(`${path} duplicates board coordinate ${key}`);
      occupied.add(key);
    }
    firstArray(unit?.items || unit?.equipment).forEach((item, itemIndex) => {
      if (!cleanString(item?.name || item)) errors.push(`${path}.items[${itemIndex}] must be a non-empty item name`);
    });
    if (firstArray(unit?.items || unit?.equipment).length > 3) errors.push(`${path}.items must contain at most 3 items`);
  });

  const seasonNames = currentSeasonChampionNames(hostRequest);
  if (seasonNames.size) {
    rawUnits.forEach((unit, index) => {
      const name = cleanString(unit?.name || unit?.unit || unit?.champion || unit?.champion_name);
      if (name && !seasonNames.has(name)) errors.push(`units[${index}].name is absent from current season catalog: ${name}`);
    });
  }

  firstArray(value.recommended_moves).forEach((move, index) => {
    if (typeof move === "string") {
      if (!cleanString(move)) errors.push(`recommended_moves[${index}] must be a non-empty string or object`);
      return;
    }
    if (!move || typeof move !== "object" || Array.isArray(move)) {
      errors.push(`recommended_moves[${index}] must be an object in canonical output`);
      return;
    }
    if (!moveText(move)) errors.push(`recommended_moves[${index}] must include action, description, unit/from/to, or reason`);
  });

  firstArray(value.moves).forEach((move, index) => {
    if (!cleanString(move)) errors.push(`moves[${index}] must be a non-empty string`);
  });

  firstArray(value.nodes || value.transition_nodes || value.plan_nodes).forEach((node, index) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) errors.push(`nodes[${index}] must be an object`);
  });

  return errors;
}

function finalTargetStrategyErrors(value, hostRequest = null) {
  if (cleanString(hostRequest?.lineup_card_intent).toLowerCase() !== "final_target") return [];
  const strategy = firstObject(value?.strategy || value?.strategy_context || value?.plan_context);
  return [
    ["main_carry", "strategy.main_carry"],
    ["main_tank", "strategy.main_tank"],
    ["core_traits", "strategy.core_traits"],
    ["formation_burden", "strategy.formation_burden"],
    ["cap", "strategy.cap"],
    ["floor", "strategy.floor"],
  ]
    .filter(([field]) => !cleanString(strategy?.[field]))
    .map(([, label]) => `${label} is required for a final target card`);
}

function finalLineupTargetSource(value) {
  return cleanString(
    value?.target_source
      || value?.provenance?.target_source
      || value?.strategy?.target_source,
  ).toLowerCase();
}

function finalLineupUsesExplicitNonCandidateSource(value, hostRequest = null) {
  if (hostRequest?.lineup_confirmation_requested !== true) return false;
  return ["chat_discovery", "user_custom"].includes(finalLineupTargetSource(value));
}

function selectedRankingCandidateEntries(hostRequest) {
  const selected = hostRequest?.selected_ranking_candidates
    || hostRequest?.runtime_context?.selected_ranking_candidates
    || hostRequest?.context?.selected_ranking_candidates
    || hostRequest?.context?.runtime_context?.selected_ranking_candidates
    || null;
  return Array.isArray(selected) ? selected : firstArray(selected?.candidates);
}

function strategyFitPacketFromHostRequest(hostRequest) {
  const runtimeContext = hostRequest?.runtime_context || hostRequest?.context?.runtime_context || null;
  return runtimeContext?.strategy_fit_packet
    || runtimeContext?.cruise_decision_context?.strategy_fit_packet
    || hostRequest?.strategy_fit_packet
    || hostRequest?.context?.strategy_fit_packet
    || null;
}

function atomicCandidateIdentities(candidate) {
  return [
    candidate?.candidate_id,
    candidate?.line_id,
    candidate?.id,
    candidate?.lineup_group_id,
  ].map(cleanString).filter(Boolean);
}

function atomicCandidateVariantIdentities(candidate) {
  const profile = firstObject(candidate?.strategy_profile);
  const canonical = firstObject(candidate?.canonical_variant) || firstObject(profile?.canonical_variant);
  return [
    candidate?.selected_variant_id,
    candidate?.variant_id,
    candidate?.atomic_roster_id,
    canonical?.selected_variant_id,
    canonical?.variant_id,
    canonical?.atomic_roster_id,
  ].map(cleanString).filter(Boolean);
}

function atomicRosterMemberName(member) {
  return cleanString(
    member?.champion_name
      || member?.name
      || member?.display_name
      || member?.unit
      || member?.champion
      || member,
  );
}

function atomicRoleName(role) {
  if (typeof role === "string") return cleanString(role);
  if (!firstObject(role)) return "";
  const name = role.champion_name || role.name || role.display_name || role.unit || role.champion;
  return typeof name === "string" ? atomicRosterMemberName(role) : "";
}

function atomicRosterNames(value, expectedUnitCount = null) {
  if (!Array.isArray(value) || !value.length) return null;
  const names = value.map(atomicRosterMemberName);
  if (!names.every(Boolean)) return null;
  const expected = Number(expectedUnitCount);
  if (Number.isInteger(expected) && expected > 0 && names.length !== expected) return null;
  return names;
}

function normalizedStringSet(value) {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return [...new Set(values.map((entry) => cleanString(entry?.name || entry?.id || entry)).filter(Boolean))].sort();
}

function normalizedLoadoutMap(value) {
  const entries = Array.isArray(value) ? value : [];
  return entries.map((entry) => ({
    unit: cleanString(entry?.unit || entry?.name || entry?.champion || entry?.champion_name),
    items: normalizedStringSet(entry?.items || entry?.equipment || entry?.item_names),
  })).filter((entry) => entry.unit && entry.items.length).sort((left, right) => left.unit.localeCompare(right.unit));
}

function atomicCandidateSnapshot(candidate) {
  const profile = firstObject(candidate?.strategy_profile);
  const variants = [
    ...firstArray(candidate?.variants).map(firstObject).filter(Boolean),
    ...firstArray(profile?.variants).map(firstObject).filter(Boolean),
  ];
  const selectedVariantId = cleanString(
    candidate?.selected_variant_id
      || candidate?.variant_id
      || candidate?.atomic_roster_id,
  );
  const canonicalVariants = [
    firstObject(candidate?.canonical_variant),
    firstObject(profile?.canonical_variant),
  ].filter(Boolean);
  const variantIds = (variant) => [variant?.selected_variant_id, variant?.variant_id, variant?.atomic_roster_id].map(cleanString).filter(Boolean);
  // Resolve once. An explicitly selected branch cannot borrow another branch's
  // roster or roles, even when its own evidence is absent or incomplete.
  const canonical = selectedVariantId
    ? variants.find((variant) => variantIds(variant).includes(selectedVariantId))
      || canonicalVariants.find((variant) => variantIds(variant).includes(selectedVariantId))
      || (!variants.length && canonicalVariants.length === 1 && !variantIds(canonicalVariants[0]).length ? canonicalVariants[0] : null)
      || (!variants.length && !canonicalVariants.length ? firstObject(candidate) : null)
    : canonicalVariants[0] || (variants.length === 1 ? variants[0] : !variants.length ? firstObject(candidate) : null);
  const sources = canonical === candidate ? [candidate, profile].filter(Boolean) : canonical ? [canonical] : [];
  const rosterSources = [
    ...sources.flatMap((variant) => [
      [variant?.atomic_roster_members, variant?.roster_unit_count || variant?.atomic_roster?.roster_unit_count || variant?.population || variant?.target_population],
      [variant?.atomic_roster?.members, variant?.atomic_roster?.roster_unit_count || variant?.roster_unit_count || variant?.population || variant?.target_population],
      [variant?.lineup_names, variant?.roster_unit_count || variant?.population || variant?.target_population],
      [variant?.champion_names, variant?.roster_unit_count || variant?.population || variant?.target_population],
      [variant?.core_units, variant?.roster_unit_count || variant?.population || variant?.target_population],
      [variant?.core_unit_names, variant?.roster_unit_count || variant?.population || variant?.target_population],
    ]),
  ];
  let names = null;
  for (const [source, expectedUnitCount] of rosterSources) {
    names = atomicRosterNames(source, expectedUnitCount);
    if (names) break;
  }
  const variantId = cleanString(
    selectedVariantId
      || canonical?.selected_variant_id
      || canonical?.variant_id
      || canonical?.atomic_roster_id,
  );
  const population = Number(canonical?.population ?? canonical?.base_team_size ?? canonical?.target_population);
  const rosterUnitCount = Number(canonical?.roster_unit_count ?? names?.length);
  const occupiedPopulation = Number(canonical?.occupied_population ?? population);
  const baseTeamSize = Number(canonical?.base_team_size ?? population);
  const teamSizeBonus = Number(canonical?.team_size_bonus ?? 0);
  const effectiveTeamSize = Number(canonical?.effective_team_size ?? baseTeamSize);
  const sameSourceProfile = canonical === candidate ? profile : null;
  return {
    candidate,
    canonical,
    variant_id: variantId || null,
    names,
    population: Number.isInteger(population) && population > 0 ? population : names?.length || null,
    roster_unit_count: Number.isInteger(rosterUnitCount) && rosterUnitCount > 0 ? rosterUnitCount : names?.length || null,
    occupied_population: Number.isInteger(occupiedPopulation) && occupiedPopulation > 0 ? occupiedPopulation : null,
    base_team_size: Number.isInteger(baseTeamSize) && baseTeamSize > 0 ? baseTeamSize : null,
    team_size_bonus: Number.isFinite(teamSizeBonus) && teamSizeBonus >= 0 ? teamSizeBonus : 0,
    effective_team_size: Number.isInteger(effectiveTeamSize) && effectiveTeamSize > 0 ? effectiveTeamSize : null,
    population_legal: canonical?.population_legal ?? null,
    team_size_modifiers: firstArray(canonical?.team_size_modifiers),
    main_carry: atomicRoleName(canonical?.main_carry || canonical?.primary_carry || sameSourceProfile?.main_carry),
    main_tank: atomicRoleName(canonical?.main_tank || canonical?.primary_tank || sameSourceProfile?.main_tank || sameSourceProfile?.primary_tank),
    core_traits: normalizedStringSet(canonical?.core_traits || canonical?.main_traits || sameSourceProfile?.core_traits),
    loadouts: normalizedLoadoutMap(canonical?.loadouts || canonical?.equipment_plan || canonical?.equipment_requirements),
    augments: normalizedStringSet(canonical?.augment_conditions || canonical?.associated_augments || sameSourceProfile?.augment_conditions),
    transitions: normalizedStringSet(canonical?.transition_path || canonical?.transition_steps || canonical?.transition_populations || sameSourceProfile?.transition_path),
    cap: cleanString(canonical?.cap || canonical?.ceiling || sameSourceProfile?.cap),
    floor: cleanString(canonical?.floor || sameSourceProfile?.floor),
  };
}

function selectedAtomicCandidateEntries(hostRequest) {
  const selected = selectedRankingCandidateEntries(hostRequest);
  const packet = strategyFitPacketFromHostRequest(hostRequest);
  const hasWorkingSet = Array.isArray(packet?.candidate_working_set);
  const workingSet = hasWorkingSet
    ? firstArray(packet.candidate_working_set)
    : firstArray(packet?.candidate_lines);
  const references = [
    ...firstArray(packet?.candidate_lines),
    ...firstArray(packet?.candidate_frontier),
  ];
  // The current working set owns variant selection, including an explicitly empty set.
  const primary = hasWorkingSet ? workingSet : selected.length ? selected : workingSet.length ? workingSet : references;
  return primary.map((candidate) => {
    const identities = atomicCandidateIdentities(candidate);
    const variantIdentities = atomicCandidateVariantIdentities(candidate);
    // Authoritative rows already own their selected variant. Only external
    // references need lookup; shared canonical aliases cannot remap these rows.
    const mapped = !hasWorkingSet && identities.length
      ? workingSet.find((entry) => {
          const candidateMatches = atomicCandidateIdentities(entry).some((id) => identities.includes(id));
          if (!candidateMatches) return false;
          if (!variantIdentities.length) return true;
          return atomicCandidateVariantIdentities(entry).some((id) => variantIdentities.includes(id));
        })
      : null;
    const direct = atomicCandidateSnapshot(candidate);
    const evidence = mapped || (direct.names ? candidate : mapped || candidate);
    const snapshot = atomicCandidateSnapshot(evidence);
    return {
      candidate,
      identities: [...new Set([...identities, ...atomicCandidateIdentities(mapped)])],
      variant_identities: [...new Set([...variantIdentities, ...atomicCandidateVariantIdentities(mapped)])],
      ...snapshot,
    };
  });
}

function sameStringSet(left, right) {
  const expected = normalizedStringSet(left);
  const actual = normalizedStringSet(right);
  return expected.length === actual.length && expected.every((entry, index) => entry === actual[index]);
}

export function queryAtomicLineupEvidence(hostRequest, query = {}) {
  const terms = (query.candidate_id !== undefined ? [query.candidate_id] : firstArray(query.entity_names))
    .map(cleanString).filter(Boolean);
  if (!terms.length) return { status: "query_required", missing_fields: ["candidate_id"] };
  const variantId = cleanString(query.selected_variant_id);
  const evidenceId = cleanString(query.candidate_evidence_id);
  const matches = selectedAtomicCandidateEntries(hostRequest).filter((entry) =>
    entry.identities.some((id) => terms.includes(id))
    && (!variantId || entry.variant_id === variantId)
    && (!evidenceId || (entry.candidate?.candidate_evidence_id || entry.canonical?.candidate_evidence_id) === evidenceId));
  if (!matches.length) return { status: "not_found", requested_candidate_ids: terms };
  if (matches.length !== 1) return { status: "ambiguous", missing_fields: ["selected_variant_id"] };
  const entry = matches[0];
  if (!entry.names?.length) return { status: "incomplete", missing_fields: ["canonical_roster"] };
  return {
    schema: "jcc-atomic-lineup-evidence-v1",
    status: "ok",
    candidate_id: entry.identities[0],
    selected_variant_id: entry.variant_id,
    candidate_evidence_id: entry.candidate?.candidate_evidence_id || entry.canonical?.candidate_evidence_id || null,
    roster: entry.names,
    population: entry.population,
    roster_unit_count: entry.roster_unit_count,
    occupied_population: entry.occupied_population,
    base_team_size: entry.base_team_size,
    team_size_bonus: entry.team_size_bonus,
    effective_team_size: entry.effective_team_size,
    population_legal: entry.population_legal,
    team_size_modifiers: entry.team_size_modifiers,
    main_carry: entry.main_carry,
    main_tank: entry.main_tank,
    core_traits: entry.core_traits,
    loadouts: entry.loadouts,
    augment_conditions: entry.augments,
    transitions: entry.transitions,
    cap: entry.cap,
    floor: entry.floor,
    canonical_variant: entry.canonical,
  };
}

function currentPositionEvidencePresent(hostRequest) {
  const runtime = hostRequest?.runtime_context || hostRequest?.context?.runtime_context || {};
  const facts = runtime?.match_facts || runtime?.live_state || hostRequest?.match_facts || {};
  const board = facts?.board?.board_units || facts?.board_units || runtime?.board?.board_units || runtime?.board_units;
  const bench = facts?.bench?.bench_units || facts?.bench_units || runtime?.bench?.bench_units || runtime?.bench_units;
  return (Array.isArray(board) && board.length > 0) || (Array.isArray(bench) && bench.length > 0);
}

function unconditionalPositionInstruction(text) {
  const value = cleanString(text).toLowerCase();
  if (!value) return false;
  const action = /(上场|卖出|卖掉|替换|换下|换上|移动|移到|挪到|deploy|field|sell|replace|move)/i.test(value);
  const nonOperational = /(不要|不(?:要|自动|应|可|能|得)|不能|不得|禁止|避免|无需|仅在|只有|除非|不改变|不强行|不指定|not|never|avoid|do\s*not|only\s*when)/i.test(value);
  const conditional = /(如果|若|当|看到|有|拿到|来牌|在.*棋盘|在.*备战席|确认|根据|视|否则|再|后|if|when|once|after|provided|depending)/i.test(value);
  return action && !nonOperational && !conditional;
}

function positionInstructionErrors(value, hostRequest) {
  if (currentPositionEvidencePresent(hostRequest)) return [];
  const texts = [
    ...firstArray(value?.moves),
    ...firstArray(value?.recommended_moves).map(moveText),
    ...firstArray(value?.nodes || value?.transition_nodes || value?.plan_nodes).flatMap((node) => [
      ...firstArray(node?.moves),
      ...firstArray(node?.recommended_moves).map(moveText),
    ]),
  ];
  return texts.some(unconditionalPositionInstruction)
    ? ["unconditional deploy/sell/replace/move instructions require current board or bench position evidence; use explicit conditional language when position is unknown"]
    : [];
}

export function lineupPinnedResultAtomicRosterDiagnostics(value, hostRequest = null) {
  if (cleanString(hostRequest?.lineup_card_intent).toLowerCase() !== "final_target") return [];
  if (finalLineupUsesExplicitNonCandidateSource(value, hostRequest)) {
    const targetIdentity = cleanString(
      value?.target_identity
        || value?.provenance?.target_identity
        || value?.strategy?.target_identity,
    );
    return targetIdentity ? positionInstructionErrors(value, hostRequest) : [
      "target_identity is required when a final target card uses chat_discovery or user_custom source",
    ];
  }
  const requestedCandidateId = cleanString(
    value?.candidate_id
      || value?.provenance?.candidate_id
      || value?.strategy?.candidate_id,
  );
  const requestedVariantId = cleanString(
    value?.selected_variant_id
      || value?.variant_id
      || value?.provenance?.selected_variant_id
      || value?.strategy?.selected_variant_id,
  );
  const candidates = selectedAtomicCandidateEntries(hostRequest);
  if (!candidates.length) {
    return requestedCandidateId
      ? ["atomic candidate roster evidence is required for the selected final target candidate"]
      : [];
  }
  const matchingCandidates = requestedCandidateId
    ? candidates.filter((entry) => entry.identities.includes(requestedCandidateId))
    : candidates;
  const selected = requestedCandidateId
    ? requestedVariantId
      ? matchingCandidates.find((entry) => entry.variant_id === requestedVariantId)
        || (matchingCandidates.length === 1 && matchingCandidates[0].variant_identities.length === 0 ? matchingCandidates[0] : null)
      : matchingCandidates.length === 1 ? matchingCandidates[0] : null
    : candidates.length === 1 ? candidates[0] : null;
  if (!selected && requestedCandidateId && requestedVariantId && matchingCandidates.length) {
    const expectedVariants = [...new Set(matchingCandidates.map((entry) => entry.variant_id).filter(Boolean))];
    return [`selected_variant_id mismatch: expected one of ${expectedVariants.join(", ") || "missing-runtime-variant"}, received ${requestedVariantId}; final target card must bind the exact Runtime canonical variant`];
  }
  if (!selected) return ["atomic candidate roster identity is required for a final target card"];
  if (!selected.names) return ["atomic candidate roster evidence is required for the selected final target candidate"];
  if (!requestedVariantId) return ["selected_variant_id is required for a final target card"];
  if (!selected.variant_id || requestedVariantId !== selected.variant_id) {
    return [`selected_variant_id mismatch: expected ${selected.variant_id || "missing-runtime-variant"}, received ${requestedVariantId}; final target card must bind the exact Runtime canonical variant`];
  }
  const actualNames = firstArray(value?.units).map((unit) => cleanString(unit?.name)).filter(Boolean);
  const expected = [...selected.names].sort();
  const actual = [...actualNames].sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    return ["atomic roster mismatch: final target card must preserve the selected candidate roster"];
  }
  const errors = [];
  if (selected.roster_unit_count && actualNames.length !== selected.roster_unit_count) {
    errors.push("atomic roster unit count mismatch: final target card must preserve the canonical variant roster");
  }
  const strategy = firstObject(value?.strategy);
  if (selected.main_carry && cleanString(strategy?.main_carry) !== selected.main_carry) errors.push("main carry mismatch: final target card must preserve the canonical variant main carry");
  if (selected.main_tank && cleanString(strategy?.main_tank) !== selected.main_tank) errors.push("main tank mismatch: final target card must preserve the canonical variant main tank");
  if (selected.core_traits.length && !sameStringSet(strategy?.core_traits, selected.core_traits)) errors.push("core trait mismatch: final target card must preserve the canonical variant traits");
  if (selected.loadouts.length && JSON.stringify(normalizedLoadoutMap(value?.loadouts)) !== JSON.stringify(selected.loadouts)) errors.push("equipment mismatch: final target card must preserve the canonical variant loadouts");
  if (selected.augments.length && !sameStringSet(strategy?.augment_conditions || value?.augment_conditions, selected.augments)) errors.push("augment mismatch: final target card must preserve the canonical variant augment conditions");
  if (selected.transitions.length && !sameStringSet(strategy?.transition_path || value?.transition_path || value?.moves, selected.transitions)) errors.push("transition mismatch: final target card must preserve the canonical variant transition path");
  if (selected.cap && cleanString(strategy?.cap) !== selected.cap) errors.push("cap mismatch: final target card must preserve the canonical variant cap");
  if (selected.floor && cleanString(strategy?.floor) !== selected.floor) errors.push("floor mismatch: final target card must preserve the canonical variant floor");
  return [...errors, ...positionInstructionErrors(value, hostRequest)];
}

export function assertLineupPinnedResultSchema(value, hostRequest = null) {
  const errors = lineupPinnedResultSchemaDiagnostics(value, hostRequest);
  if (errors.length) throw new Error(`lineup pinned_result schema error: ${errors.join("; ")}`);
}

export function normalizeLineupPinnedResult(value) {
  value = normalizeHostLineupTransport(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const inputSchema = cleanString(value.schema);
  if (inputSchema && inputSchema !== "jcc-internal-lineup-plan-v1") return null;

  const board = firstObject(value.board);
  const slot = ["lineup", "position", "target", "transition", "next_pivot", "positioning"].includes(cleanString(value.slot))
    ? cleanString(value.slot)
    : "lineup";
  const rawUnits = firstArray(value.units).length ? firstArray(value.units) : firstArray(board?.units);
  // Reject malformed members before renderer normalization can drop or truncate them.
  for (const [index, unit] of rawUnits.entries()) {
    const row = unit?.row;
    const col = unit?.col;
    if (!Number.isInteger(row) || row < 1 || row > 4 || !Number.isInteger(col) || col < 1 || col > 7) {
      throw new Error(`pinned_result.units[${index}] coordinates must be an integer in board bounds`);
    }
    if (unit?.star != null && (!Number.isInteger(unit.star) || unit.star < 1 || unit.star > 4)) throw new Error(`pinned_result.units[${index}].star must be an integer from 1 to 4`);
    if (firstArray(unit?.items || unit?.equipment).length > 3) throw new Error(`pinned_result.units[${index}].items must contain at most 3 items`);
  }
  const units = rawUnits
    .map(normalizeUnit)
    .filter((unit) => unit.name && unit.row >= 1 && unit.row <= 4 && unit.col >= 1 && unit.col <= 7);
  if (!units.length) return null;

  const rawLoadouts = firstArray(value.loadouts).length ? firstArray(value.loadouts) : firstArray(value.core_units);
  const loadouts = rawLoadouts.map(normalizeLoadout).filter((loadout) => loadout.unit);
  const rawRecommendedMoves = firstArray(value.recommended_moves).length
    ? firstArray(value.recommended_moves)
    : firstArray(value.moves);
  const recommendedMoves = rawRecommendedMoves.map(normalizeRecommendedMove).filter(Boolean);
  const moves = firstArray(value.moves).length
    ? cleanStringArray(value.moves)
    : recommendedMoves.length
      ? recommendedMoves.map(moveText).filter(Boolean)
      : cleanStringArray(value.next_steps);
  const nodes = firstArray(value.nodes || value.transition_nodes || value.plan_nodes).map(normalizeLineupNode).filter(Boolean);
  const strategy = firstObject(value.strategy || value.strategy_context || value.plan_context);
  const candidateId = cleanString(value.candidate_id || strategy?.candidate_id);
  const selectedVariantId = cleanString(value.selected_variant_id || value.variant_id || strategy?.selected_variant_id);
  const normalizedStrategy = strategy
    ? {
        ...(cleanString(strategy.target_source) ? { target_source: cleanString(strategy.target_source) } : {}),
        ...(cleanString(strategy.target_identity) ? { target_identity: cleanString(strategy.target_identity) } : {}),
        ...(cleanString(strategy.candidate_id) ? { candidate_id: cleanString(strategy.candidate_id) } : {}),
        ...(cleanString(strategy.selected_variant_id) ? { selected_variant_id: cleanString(strategy.selected_variant_id) } : {}),
        ...(cleanString(strategy.main_carry || strategy.primary_carry) ? { main_carry: cleanString(strategy.main_carry || strategy.primary_carry) } : {}),
        ...(cleanString(strategy.main_tank || strategy.primary_tank) ? { main_tank: cleanString(strategy.main_tank || strategy.primary_tank) } : {}),
        ...(cleanString(strategy.secondary_carry || strategy.secondary_role) ? { secondary_carry: cleanString(strategy.secondary_carry || strategy.secondary_role) } : {}),
        ...(normalizedStringSet(strategy.core_traits || strategy.core_bonds).length
          ? { core_traits: normalizedStringSet(strategy.core_traits || strategy.core_bonds) }
          : {}),
        ...(cleanString(strategy.formation_burden || strategy.formation_difficulty) ? { formation_burden: cleanString(strategy.formation_burden || strategy.formation_difficulty) } : {}),
        ...(cleanString(strategy.cap || strategy.upper_bound) ? { cap: cleanString(strategy.cap || strategy.upper_bound) } : {}),
        ...(cleanString(strategy.floor || strategy.lower_bound) ? { floor: cleanString(strategy.floor || strategy.lower_bound) } : {}),
        ...(cleanString(strategy.augment_fit) ? { augment_fit: cleanString(strategy.augment_fit) } : {}),
        ...(cleanString(strategy.artifact_fit) ? { artifact_fit: cleanString(strategy.artifact_fit) } : {}),
        ...(cleanString(strategy.emblem_fit || strategy.trait_fit) ? { emblem_fit: cleanString(strategy.emblem_fit || strategy.trait_fit) } : {}),
        ...(cleanString(strategy.key_mechanic || strategy.mechanic) ? { key_mechanic: cleanString(strategy.key_mechanic || strategy.mechanic) } : {}),
        ...(normalizedStringSet(strategy.augment_conditions).length ? { augment_conditions: normalizedStringSet(strategy.augment_conditions) } : {}),
        ...(normalizedStringSet(strategy.transition_path).length ? { transition_path: normalizedStringSet(strategy.transition_path) } : {}),
        ...(Array.isArray(strategy.conditions) ? { conditions: strategy.conditions.map(cleanString).filter(Boolean).slice(0, 8) } : {}),
        ...(Array.isArray(strategy.replacements) ? { replacements: strategy.replacements.map(cleanString).filter(Boolean).slice(0, 8) } : {}),
      }
    : null;

  return {
    schema: "jcc-internal-lineup-plan-v1",
    slot,
    title: cleanString(value.title || (slot === "lineup" ? "\u63a8\u8350\u9635\u5bb9\u56fe" : "\u7ad9\u4f4d\u65b9\u6848")),
    ...(candidateId ? { candidate_id: candidateId } : {}),
    ...(selectedVariantId ? { selected_variant_id: selectedVariantId } : {}),
    ...(cleanString(value.target_source || value.provenance?.target_source) ? { target_source: cleanString(value.target_source || value.provenance?.target_source) } : {}),
    ...(cleanString(value.target_identity || value.provenance?.target_identity) ? { target_identity: cleanString(value.target_identity || value.provenance?.target_identity) } : {}),
    ...(value.summary ? { summary: cleanString(value.summary) } : {}),
    units,
    ...(value.degraded ? { degraded: true } : {}),
    ...(value.provenance && typeof value.provenance === "object" ? { provenance: value.provenance } : {}),
    ...(loadouts.length ? { loadouts } : {}),
    ...(recommendedMoves.length ? { recommended_moves: recommendedMoves } : {}),
    ...(moves.length ? { moves } : {}),
    ...(nodes.length ? { nodes } : {}),
    equipment_status: cleanString(value.equipment_status) || (loadouts.some((loadout) => firstArray(loadout.items).length) || units.some((unit) => firstArray(unit.items).length) ? "provided" : "not_provided_in_evidence"),
    ...(normalizedStrategy && Object.keys(normalizedStrategy).length ? { strategy: normalizedStrategy } : {}),
  };
}

export function lineupPinnedResultMinimumUnitCount(pinnedResult, hostRequest) {
  const slot = cleanString(pinnedResult?.slot).toLowerCase();
  const text = [
    pinnedResult?.title,
    hostRequest?.user_message,
    hostRequest?.runtime_context?.game_state_brief?.latest_user_intent?.text,
    hostRequest?.runtime_context?.match_facts?.latest_target_intent?.text,
    hostRequest?.runtime_context?.match_facts?.latest_user_intent?.text,
    hostRequest?.context?.runtime_context?.game_state_brief?.latest_user_intent?.text,
  ].map((value) => cleanString(value)).join("\n");
  const explicitlyTransition = /(?:\u8fc7\u6e21|transition|\u5f53\u524d\u677f|\u4e34\u65f6\u677f|\u4e2d\u671f\u677f)/i.test(text);
  if (slot === "transition" && explicitlyTransition) return 4;
  const explicitPopulation = text.match(/(?:^|[^0-9])(10|[4-9])\s*(?:\u4eba\u53e3|\u7ea7)(?:[^0-9]|$)/u);
  if (explicitPopulation) return Number(explicitPopulation[1]);
  // Trait breakpoints such as "10 + a trait name" describe the final board
  // even when the user does not spell out a population count. Avoid treating ordinary
  // stage, cost, gold, star, or item counts as a population requirement.
  const explicitTraitPopulation = text.match(
    /(?:^|[^0-9])(10|[4-9])\s*(?!(?:\u9636\u6bb5|\u8d39|\u7ea7|\u91d1|\u4ef6|\u4e2a|\u5f20|\u661f|\u8f6e|\u56de\u5408|\u4eba\u53e3))[\u4e00-\u4e5d\u4e00-\u9fff]{2,}/u,
  );
  if (explicitTraitPopulation) return Number(explicitTraitPopulation[1]);
  if (/(?:\u6700\u7ec8|\u6210\u578b|\u5b8c\u6574|\u5927\u6210|target|final|capped)/i.test(text)) return 7;
  // A lineup-card request defaults to the final target board. Six units are
  // usually an interim skeleton; explicit population text can still lower
  // this requirement for a deliberately staged board.
  return 7;
}

function lineupRequestExplicitlyAsksTransition(hostRequest) {
  const text = [
    hostRequest?.user_message,
    hostRequest?.runtime_context?.game_state_brief?.latest_user_intent?.text,
    hostRequest?.runtime_context?.match_facts?.latest_user_intent?.text,
    hostRequest?.context?.runtime_context?.game_state_brief?.latest_user_intent?.text,
  ].map((value) => cleanString(value)).join("\n");
  return /(?:\u8fc7\u6e21|transition|\u5f53\u524d\u677f|\u4e34\u65f6\u677f|\u4e2d\u671f\u677f)/i.test(text);
}

export function lineupPinnedResultIsPublishable(pinnedResult, hostRequest) {
  if (!pinnedResult || typeof pinnedResult !== "object" || pinnedResult.degraded) return false;
  if (finalTargetStrategyErrors(pinnedResult, hostRequest).length) return false;
  if (lineupPinnedResultAtomicRosterDiagnostics(pinnedResult, hostRequest).length) return false;
  if (cleanString(pinnedResult.slot).toLowerCase() === "transition" && !lineupRequestExplicitlyAsksTransition(hostRequest)) return false;
  const units = firstArray(pinnedResult.units);
  if (units.length < lineupPinnedResultMinimumUnitCount(pinnedResult, hostRequest)) return false;
  const occupied = new Set();
  const unitNames = new Set();
  for (const unit of units) {
    const row = Number(unit?.row);
    const col = Number(unit?.col);
    const name = cleanString(unit?.name);
    const key = `${row}:${col}`;
    if (!name || row < 1 || row > 4 || col < 1 || col > 7 || occupied.has(key)) return false;
    occupied.add(key);
    unitNames.add(name);
  }
  const loadouts = firstArray(pinnedResult.loadouts);
  const unitItems = units.some((unit) => firstArray(unit?.items).length);
  const loadoutItems = loadouts.some((loadout) => unitNames.has(cleanString(loadout?.unit)) && firstArray(loadout?.items).length);
  if (!unitItems && !loadoutItems && !["not_provided_in_evidence", "unknown", "pending"].includes(cleanString(pinnedResult.equipment_status))) return false;
  if (!firstArray(pinnedResult.moves).length) return false;
  const seasonNames = currentSeasonChampionNames(hostRequest);
  if (seasonNames.size && units.some((unit) => !seasonNames.has(unit.name))) return false;
  return true;
}

export function buildLineupPinnedResultCanonicalOutputSchema() {
  return {
    schema: "jcc-internal-lineup-plan-v1",
    required: ["schema", "slot", "title", "units", "recommended_moves", "moves"],
    board: "4 rows x 7 columns; row is 1..4, col is 1..7; custom positioning is represented only by row/col.",
    unit: {
      row: "integer 1..4",
      col: "integer 1..7",
      name: "current-season champion name",
      star: "optional number",
      role: "optional semantic role such as main_carry/main_tank/secondary_carry/frontline/function",
      items: "optional string[], max 3",
      notes: "optional string",
    },
    recommended_move: {
      unit: "optional champion name",
      from: "optional position label",
      to: "optional position label",
      action: "optional concise action",
      reason: "optional reason",
      description: "optional freeform move; legacy string[] inputs normalize here",
    },
    moves: "string[] render summary derived from canonical recommended_moves or supplied directly",
    equipment_status: "optional provided|not_provided_in_evidence|unknown|pending; missing equipment evidence must be explicit, not a reason to reject an otherwise valid final target board.",
    identity: "Ranking candidates require exact candidate_id + selected_variant_id; explicit chat_discovery/user_custom confirmation requires target_source + target_identity and a complete user-confirmed roster",
    target_source: "optional candidate|chat_discovery|user_custom; required for explicit non-candidate final confirmation",
    target_identity: "stable target identity for chat_discovery/user_custom final confirmation",
    strategy: "optional bounded strategy metadata: target_source/target_identity/candidate_id/selected_variant_id/main_carry/main_tank/secondary_carry/core_traits/formation_burden/cap/floor/augment_conditions/transition_path/augment_fit/artifact_fit/emblem_fit/key_mechanic/conditions/replacements",
    nodes: "optional transition/level nodes with label/timing/level/units/recommended_moves/moves",
    ownership: "This is Runtime's internal materialized card shape. The Agent returns only lineup_handoff; Runtime restores canonical fields and Renderer owns layout.",
  };
}

export function buildLineupPinnedResultInstructions() {
  return [
    "For a lineup-card task, make the strategic choice in final_text and return only the minimal lineup_handoff needed by Runtime.",
    "lineup_handoff contains candidate_id, variant_id, target_source, target_identity, adjustments, equipment_priority, and positioning_intent. Use null for an unavailable identity instead of inventing one.",
    "For a Ranking target, copy one exact candidate and variant identity from current evidence. For chat_discovered or user_custom targets, name the stable target identity and describe only the semantic adjustments Runtime cannot recover.",
    "Do not write the complete roster, board coordinates, canonical equipment, traits, or rendering fields into lineup_handoff. Runtime materializes those deterministic fields from the pinned snapshot and Renderer owns layout.",
    "Never merge candidates. If exact positioning evidence is absent, state the positioning intent or uncertainty in final_text; do not invent coordinates.",
  ].join("\n");
}
