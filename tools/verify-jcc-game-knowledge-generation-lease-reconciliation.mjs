import assert from "node:assert/strict";
import {
  generationLeaseSnapshotKey,
  reconcileGameKnowledgeGenerationLeases,
} from "../ui/electron/game-knowledge-generation-leases.js";

const coreA = "a".repeat(64);
const coreB = "b".repeat(64);
const recipeA = "c".repeat(64);
const recipeB = "d".repeat(64);
const rankingA = `20260830-${"1".repeat(24)}`;
const rankingB = `20260831-${"2".repeat(24)}`;

const failedOldMatch = {
  core_profile_id: coreA,
  ranking_overlay_id: rankingA,
  recipe_generation_id: recipeA,
  match_session_id: "match-old",
  status: "termination_failed",
};
const startingNewMatch = {
  core_profile_id: coreB,
  ranking_overlay_id: rankingB,
  recipe_generation_id: recipeB,
  match_session_id: null,
  status: "starting",
};

const starting = reconcileGameKnowledgeGenerationLeases(
  [failedOldMatch],
  [startingNewMatch],
  { now: "2026-09-01T00:00:00.000Z" },
);
assert.equal(starting.length, 2, "starting a new Match must preserve an unresolved prior Match lease");
assert(starting.some((lease) => lease.match_session_id === "match-old" && lease.status === "termination_failed"));

const activeNewMatch = reconcileGameKnowledgeGenerationLeases(
  starting,
  [{ ...startingNewMatch, match_session_id: "match-new", status: "active" }],
  {
    release_starting_snapshot_keys: [generationLeaseSnapshotKey({
      core_profile_id: coreB,
      ranking_overlay_id: rankingB,
      recipe_catalog_generation_id: recipeB,
    })],
    now: "2026-09-01T00:00:01.000Z",
  },
);
assert.equal(activeNewMatch.length, 2, "promoting a starting lease must not discard unrelated unresolved owners");
assert(!activeNewMatch.some((lease) => lease.status === "starting"));
assert(activeNewMatch.some((lease) => lease.match_session_id === "match-new" && lease.status === "active"));

const stoppedNewMatch = reconcileGameKnowledgeGenerationLeases(activeNewMatch, [], {
  release_match_session_ids: ["match-new"],
  now: "2026-09-01T00:00:02.000Z",
});
assert.deepEqual(
  stoppedNewMatch.map((lease) => [lease.match_session_id, lease.status]),
  [["match-old", "termination_failed"]],
  "a clean Stop must release only its own Match lease",
);

const recoveredOldMatch = reconcileGameKnowledgeGenerationLeases(stoppedNewMatch, [], {
  release_match_session_ids: ["match-old"],
  now: "2026-09-01T00:00:03.000Z",
});
assert.equal(recoveredOldMatch.length, 0, "an unresolved owner may be released only after its termination is confirmed");

console.log(JSON.stringify({
  schema: "jcc-game-knowledge-generation-lease-reconciliation-verification-v1",
  status: "pass",
  checks: [
    "unresolved_previous_match_is_preserved",
    "starting_lease_promotes_by_generation_identity",
    "clean_stop_releases_only_own_match",
    "confirmed_old_owner_release_is_explicit",
  ],
}, null, 2));
