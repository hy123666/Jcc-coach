#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { importS18SourceDocs } from './import-jcc-s18-source-docs.mjs';
import { parseTypedAugmentEffect } from './jcc_typed_effect_parser.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'jcc-typed-effect-import-'));
try {
  const result = await importS18SourceDocs({
    championsDoc: 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/champions-and-traits.md',
    augmentsDoc: 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/augments.md',
    spritesDoc: 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/nature-sprites.md',
    equipmentDoc: 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/equipment.md',
    outDir: root,
    seasonId: 's18',
    patchId: 's18_1',
    modeId: 'mode18',
    upstreamSeasonId: 'S18',
    upstreamVersion: '18.18.1',
    expectedCounts: { champions: 65, traits: 36, augments: 186, equipment: 151, sprites: 354 },
  });
  const augments = result.catalogs.augments.items;
  const lateGameSpecialist = augments.find((entry) => entry.name === '后期专家');
  assert(lateGameSpecialist);
  assert.equal(lateGameSpecialist.effects.schema, 'jcc-common-typed-effect-v1');
  assert.equal(lateGameSpecialist.effects.unmapped_audit.status, 'complete');
  const goldTerm = lateGameSpecialist.effects.effect_terms.find((term) => (
    term.rewards.some((reward) => reward.kind === 'gold' && reward.amount === 27)
  ));
  assert(goldTerm);
  assert.equal(goldTerm.trigger.kind, 'level_reached');
  assert.equal(goldTerm.trigger.level, 9);
  assert.equal(goldTerm.rewards[0].delivery, 'condition_met');

  const jeweledLotus = augments.find((entry) => entry.name === '珠光莲花 II');
  assert(jeweledLotus);
  const metrics = jeweledLotus.effects.metrics;
  assert(metrics.some((metric) => metric.metric === 'critical_strike' && metric.value === 25));
  assert(metrics.some((metric) => metric.metric === 'critical_damage' && metric.value === 10));
  assert(metrics.some((metric) => metric.metric === 'skill_crit' && metric.value === true));

  const branchingOut = augments.find((entry) => entry.name === '节外生枝+');
  assert(branchingOut);
  assert(branchingOut.effects.rewards.some((reward) => reward.kind === 'emblem' && reward.random));
  assert(branchingOut.effects.rewards.some((reward) => reward.kind === 'item_reforger'));

  const officialDocument = JSON.parse(await readFile(
    'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/official-s18-augments.json',
    'utf8',
  ));
  const officialAugments = Array.isArray(officialDocument) ? officialDocument : officialDocument.augments;
  assert.equal(officialAugments.length, 260);
  const parsedOfficial = officialAugments.map((entry) => ({
    id: String(entry.id),
    effect: parseTypedAugmentEffect(entry.description),
  }));
  assert(parsedOfficial.every((entry) => entry.effect.schema === 'jcc-common-typed-effect-v1'));
  assert.equal(parsedOfficial.filter((entry) => (
    entry.effect.parse_status === 'semantic_only'
      && /\d/.test(String(entry.effect.source_text || ''))
  )).length, 0, 'numeric official effects must never silently remain semantic_only');
  const calculatedLoss = parsedOfficial.find((entry) => entry.id === '1002').effect;
  assert.equal(calculatedLoss.effect_terms[0].trigger.kind, 'post_loss');
  assert(calculatedLoss.rewards.some((reward) => reward.kind === 'free_shop_refresh' && reward.amount === 1));
  const corrosion = parsedOfficial.find((entry) => entry.id === '10252').effect;
  assert(corrosion.metrics.some((entry) => entry.metric === 'armor' && entry.delta === -4));
  assert(corrosion.metrics.some((entry) => entry.metric === 'magic_resist' && entry.delta === -4));

  console.log(JSON.stringify({
    ok: true,
    schema: 'jcc-common-typed-effect-import-integration-v1',
    augment_count: augments.length,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
