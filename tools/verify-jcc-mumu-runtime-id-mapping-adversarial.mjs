import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzeMumuRuntimeIdEvents,
  championMappingFingerprint,
  verifyMumuRuntimeIdReceipt,
  verifyReceiptProfileBinding,
} from "./verify-jcc-mumu-runtime-id-mapping.mjs";

const patchManifest = JSON.parse(await readFile("data/game-knowledge/jcc/seasons/s18/patches/s18_2/source-manifest.json", "utf8"));
const overlayPath = patchManifest.source_artifacts.find((entry) => entry.role === "runtime_catalog_overlay")?.path;
assert.match(overlayPath || "", /^data\/core-patches\/jcc\/generations\/[a-f0-9]{64}\/runtime-catalog-overlay\.json$/);
const overlayText = await readFile(overlayPath, "utf8");
const overlay = JSON.parse(overlayText);
const starOneEntries = Object.values(overlay.champions_by_id)
  .filter((entry) => entry.star === 1)
  .slice(0, 60);

assert.equal(starOneEntries.length, 60);
const rawIds = starOneEntries.map((entry) => Number(entry.id));
const extraStarIds = starOneEntries.slice(0, 3).map((entry) => Number(entry.id) + 10000);
const event = (command, field, ids) => JSON.stringify({
  schema: "jcc-mumu-runtime-watch-event-v1",
  type: "mumu_gi_message",
  match_session_id: "synthetic-mapping-review",
  observed_at: "2026-08-21T00:00:00.000Z",
  command,
  payload: { [field]: ids.map((id) => ({ i: id })) },
});
const validText = [
  event(4352, "wl", rawIds),
  event(4353, "hl", [...rawIds, ...extraStarIds]),
  event(4354, "bl", [...rawIds, 15468]),
].join("\n");
const options = { seasonId: "s18", patchId: "s18_2", allowedShopOnlyIds: [] };

const parsedEvent = JSON.parse(event(4354, "bl", rawIds));
delete parsedEvent.match_session_id;
assert.throws(
  () => analyzeMumuRuntimeIdEvents([event(4352, "wl", rawIds), event(4353, "hl", rawIds), JSON.stringify(parsedEvent)].join("\n"), overlay, options),
  /missing match_session_id/,
);
const missingTimestampEvent = JSON.parse(event(4354, "bl", rawIds));
delete missingTimestampEvent.observed_at;
assert.throws(
  () => analyzeMumuRuntimeIdEvents([event(4352, "wl", rawIds), event(4353, "hl", rawIds), JSON.stringify(missingTimestampEvent)].join("\n"), overlay, options),
  /invalid observed_at/,
);
const invalidTimestampEvent = JSON.parse(event(4354, "bl", rawIds));
invalidTimestampEvent.observed_at = "not-a-timestamp";
assert.throws(
  () => analyzeMumuRuntimeIdEvents([event(4352, "wl", rawIds), event(4353, "hl", rawIds), JSON.stringify(invalidTimestampEvent)].join("\n"), overlay, options),
  /invalid observed_at/,
);

const receipt = analyzeMumuRuntimeIdEvents(validText, overlay, options);
receipt.identity.champion_catalog_sha256 = "placeholder";
receipt.identity.champion_mapping_sha256 = championMappingFingerprint(overlay);
assert.equal(receipt.unresolved.length, 0);
assert.equal(receipt.resolved.find((entry) => entry.raw_id === "15468")?.canonical_id, "5459");
assert.equal(receipt.resolved.find((entry) => entry.raw_id === "15468")?.source_variant?.trait_name, "野兽之灵");

const unknownOwnStateText = [
  event(4352, "wl", rawIds),
  event(4353, "hl", [...rawIds, ...extraStarIds, 19999]),
  event(4354, "bl", rawIds),
].join("\n");
assert.throws(
  () => analyzeMumuRuntimeIdEvents(unknownOwnStateText, overlay, options),
  /not explicitly allowed/,
);

const wrongStarOverlay = structuredClone(overlay);
wrongStarOverlay.champions_by_id[String(extraStarIds[0])].star = 3;
assert.throws(
  () => analyzeMumuRuntimeIdEvents(validText, wrongStarOverlay, options),
  /catalog star mismatch/,
);

const liveReceipt = JSON.parse(await readFile(
  "data/game-knowledge/jcc/seasons/s18/patches/s18_2/mumu-runtime-id-mapping-receipt.json",
  "utf8",
));
const liveReceiptText = await readFile(
  "data/game-knowledge/jcc/seasons/s18/patches/s18_2/mumu-runtime-id-mapping-receipt.json",
  "utf8",
);
await verifyReceiptProfileBinding(
  "data/game-knowledge/jcc/seasons/s18/patches/s18_2/mumu-runtime-id-mapping-receipt.json",
  liveReceiptText,
  options,
);
const forgedIdentityReceipt = structuredClone(liveReceipt);
forgedIdentityReceipt.evidence.match_session_id = "forged-match-session";
forgedIdentityReceipt.evidence.raw_events_sha256 = "f".repeat(64);
await assert.rejects(
  () => verifyReceiptProfileBinding(
    "data/game-knowledge/jcc/seasons/s18/patches/s18_2/mumu-runtime-id-mapping-receipt.json",
    `${JSON.stringify(forgedIdentityReceipt, null, 2)}\n`,
    options,
  ),
  /not bound to a matching immutable Core Profile/,
);
const forgedEmptyReceipt = structuredClone(liveReceipt);
forgedEmptyReceipt.resolved = [];
forgedEmptyReceipt.unresolved = [];
assert.throws(
  () => verifyMumuRuntimeIdReceipt(forgedEmptyReceipt, overlay, overlayText, options),
  /requires resolved hero rows|unique-id count drift/,
);

const missingIdentityLineageReceipt = structuredClone(liveReceipt);
delete missingIdentityLineageReceipt.evidence.event_identity_validation;
assert.throws(
  () => verifyMumuRuntimeIdReceipt(missingIdentityLineageReceipt, overlay, overlayText, options),
  /requires event identity validation lineage/,
);

const duplicateReceipt = structuredClone(liveReceipt);
duplicateReceipt.resolved.push(structuredClone(duplicateReceipt.resolved[0]));
assert.throws(
  () => verifyMumuRuntimeIdReceipt(duplicateReceipt, overlay, overlayText, options),
  /duplicate raw hero ids/,
);

const changedChampionCatalog = structuredClone(overlay);
const firstChampion = Object.keys(changedChampionCatalog.champions_by_id)[0];
changedChampionCatalog.champions_by_id[firstChampion].name = "fingerprint-drift";
assert.throws(
  () => verifyMumuRuntimeIdReceipt(liveReceipt, changedChampionCatalog, JSON.stringify(changedChampionCatalog), options),
  /champion mapping fingerprint mismatch/,
);

const changedChampionBalance = structuredClone(overlay);
changedChampionBalance.champions_by_id[firstChampion].cost = 99;
changedChampionBalance.champions_by_id[firstChampion].balance_only_test_field = "ignored-by-mapping-fingerprint";
verifyMumuRuntimeIdReceipt(liveReceipt, changedChampionBalance, JSON.stringify(changedChampionBalance), options);

const reorderedVariantOverlay = structuredClone(overlay);
reorderedVariantOverlay.champions_by_id["15468"].source_variant = {
  trait_name: reorderedVariantOverlay.champions_by_id["15468"].source_variant.trait_name,
  trait_id: reorderedVariantOverlay.champions_by_id["15468"].source_variant.trait_id,
  order: reorderedVariantOverlay.champions_by_id["15468"].source_variant.order,
  source_id: reorderedVariantOverlay.champions_by_id["15468"].source_variant.source_id,
};
verifyMumuRuntimeIdReceipt(liveReceipt, reorderedVariantOverlay, JSON.stringify(reorderedVariantOverlay), options);

const changedVariantOverlay = structuredClone(overlay);
changedVariantOverlay.champions_by_id["15468"].source_variant.trait_name = "错误羁绊";
assert.throws(
  () => verifyMumuRuntimeIdReceipt(liveReceipt, changedVariantOverlay, JSON.stringify(changedVariantOverlay), options),
  /champion mapping fingerprint mismatch|source variant drift/,
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  checked: [
    "explicit patch variant mapping resolves without a shop-only exception",
    "missing match-session identity fails closed",
    "missing or invalid observation timestamp fails closed",
    "unregistered shop-only id fails closed",
    "unknown own-state id fails closed",
    "raw star and catalog star drift fails closed",
    "champion mapping fingerprint drift fails closed without coupling balance-only fields",
    "source variant key order is ignored while source variant identity drift fails closed",
    "aggregate-only forged receipts fail closed",
    "receipts without event-identity lineage fail closed",
    "duplicate raw ids fail closed",
    "receipt mutation fails immutable Core Profile binding",
  ],
})}\n`);
