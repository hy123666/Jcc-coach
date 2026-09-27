import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildContext } from "./build-jcc-combat-cap-estimator-context.mjs";
import { scoreLiveState } from "./score-jcc-cruise-strategy.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-augment-resolution-"));
try {
  const active = JSON.parse(await readFile("data/game-knowledge/jcc/active-profile.json", "utf8"));
  const catalog = JSON.parse(await readFile(path.resolve("data/game-knowledge/jcc", active.decision_input_catalog_path), "utf8"));
  const choices = ["2022", "3128", "2021"].map((id) => {
    const row = catalog.entities.find((entry) => entry.kind === "augment" && String(entry.id) === id);
    assert(row, `current catalog missing ${id}`);
    return { name: row.name, ref: { id, kind: "augment", season_id: active.season_id, address: row.address || `jcc:${active.season_id}:augment:${id}` } };
  });
  const live = { match_session_id: "resolution-test", phase: { stage_round: "3-2" }, economy: { hp: 80, gold: 30, level: 6 }, augments: { current_choice_set: { source: "current_match_user_report", choices } } };
  const file = path.join(temp, "live.json");
  await writeFile(file, JSON.stringify(live));
  const built = await buildContext({ liveState: file });
  const context = built.context;
  const index = context.hard_data_context.augment_semantic_profiles;
  assert(index.by_id["2022"] && index.by_id["3128"], "profiles already exist, no Core rewrite needed");
  function evaluate(candidate, ctx = context) {
    const input = structuredClone(live);
    input.augments.current_choice_set.choices[0] = candidate;
    const scored = scoreLiveState(input, ctx);
    const task = [...scored.advice_tasks, ...scored.suppressed_tasks].find((entry) => entry.trigger_id === "augment_choice_advice");
    assert(task, "scorer must produce choice evidence");
    return task.evidence.find((entry) => entry.type === "augments.ranked_recommendation").value.ranked.find((entry) => entry.slot === 0);
  }
  const original = evaluate(choices[0]);
  assert.equal(original.resolution_status, "resolved_active_core_profile", "catalog ref.id=2022 must bind despite Roman/space display name");
  assert.equal(original.id, "2022");
  for (const name of ["星界赐福 II", "星界赐福Ⅱ", "星界赐福2"]) {
    const row = evaluate({ ...choices[0], name });
    assert.equal(row.id, "2022");
    assert.deepEqual(row.axis_scores, original.axis_scores);
    assert.equal(evaluate({ name }).resolution_status, "resolved_active_core_profile", "unique name fallback");
  }
  assert.equal(evaluate({ name: "unrelated display", ref: choices[0].ref }).id, "2022", "native ref outranks display text");
  assert.equal(evaluate({ name: "address only", ref: { address: choices[0].ref.address } }).id, "2022");
  for (const ref of [
    { ...choices[0].ref, id: "missing" },
    { ...choices[0].ref, kind: "item" },
    { ...choices[0].ref, season_id: "retired-season" },
    { address: "jcc:retired-season:augment:2022" },
    { address: "malformed" },
  ]) assert.equal(evaluate({ name: choices[0].name, ref }).resolution_status, "unresolved_active_core_profile", JSON.stringify(ref));
  const ambiguous = structuredClone(context);
  ambiguous.hard_data_context.augment_semantic_profiles.by_id.other = { ...index.by_id["2022"], augment_id: "other", name: "星界赐福 II" };
  assert.equal(evaluate({ name: "星界赐福2" }, ambiguous).resolution_status, "unresolved_active_core_profile");
  const jewel = evaluate({ ...choices[1], name: "珠光莲花Ⅱ" });
  assert.equal(jewel.resolution_status, "resolved_active_core_profile");
  assert.equal(jewel.id, "3128");
  assert(!jewel.missing_fields.includes("active_core_augment_profile"));
  const compatibility = structuredClone(context);
  compatibility.augment_choice_evidence = { candidate_coverage_by_augment_id: { "2022": 0.73 } };
  assert.equal(evaluate({ name: "display only", ref: choices[0].ref }, compatibility).axis_scores.candidate_coverage_score, 0.73,
    "typed compatibility must bind through the same canonical ref as the semantic profile");
  assert.equal(evaluate({ name: "珠光莲花3" }).resolution_status, "unresolved_active_core_profile", "a tier must never be dropped to force a name match");
  console.log(JSON.stringify({ ok: true, core_profile_id: active.core_profile_id, astral: original, jewel, checked: ["existing_core_profiles", "native_ref_id_and_address", "unique_roman_space_alias", "foreign_or_conflicting_ref_rejected", "ambiguous_alias_rejected"] }, null, 2));
} finally { await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
