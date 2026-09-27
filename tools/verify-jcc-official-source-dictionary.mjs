#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import {
  buildOfficialSourceDictionary,
  buildOfficialSourceUrls,
  compileOfficialChessDictionary,
  compileOfficialTraitDictionary,
  projectOfficialSourceObservedIds,
  resolveOfficialTraitSemantic,
  validateOfficialSourceDocument,
} from './jcc_official_source_dictionary.mjs';

const upstreamIdentity = Object.freeze({ mode: '18', version: '18.18.1', season: 'S19' });

const traitDocument = {
  version: '18.18.1',
  season: 'S19',
  setId: '18',
  data: {
    83910102: {
      id: 83910102,
      checkId: '351',
      name: '召唤师',
      num: '3',
    },
    84700102: {
      id: 84700102,
      checkId: '458',
      name: '地狱火',
      num: '3',
    },
  },
};

const chessDocument = {
  version: '18.18.1',
  season: 'S19',
  setId: '18',
  data: {
    11450: {
      id: '11450',
      name: '崔斯特',
      heroPaint: 's19_twistedfate',
      tftHeroId: '11450',
      mapID: '701',
    },
    21450: {
      id: '21450',
      name: '崔斯特',
      checkId: '1450',
      heroPaint: 's19_twistedfate',
      tftHeroId: '21450',
      mapID: '702',
      star: 2,
    },
  },
};

async function main() {
  const urls = buildOfficialSourceUrls(upstreamIdentity);
  assert.equal(urls.trait, 'https://game.gtimg.cn/images/lol/act/jkzlk/js/18/18.18.1-S19/trait.js');
  assert.equal(urls.chess, 'https://game.gtimg.cn/images/lol/act/jkzlk/js/18/18.18.1-S19/chess.js');

  const trait = compileOfficialTraitDictionary(traitDocument, upstreamIdentity);
  assert.deepEqual(trait.by_source_id['83910102'], {
    name: '召唤师',
    core: { check_id: '351' },
    breakpoint: 3,
  });
  assert.deepEqual(trait.by_source_id['84700102'], {
    name: '地狱火',
    core: { check_id: '458' },
    breakpoint: 3,
  });
  assert.deepEqual(resolveOfficialTraitSemantic({ trait }, {
    trait_id: '84700102',
    hero_num: 3,
    canonical_trait_id: '454',
    source_trait_text: '峡谷野怪',
  }), {
    source_id: '84700102',
    name: '地狱火',
    core: { check_id: '458' },
    breakpoint: 3,
  }, 'official source resolution must ignore stale derived semantics and recompute from raw source identity plus breakpoint');
  const chess = compileOfficialChessDictionary(chessDocument, upstreamIdentity);
  assert.deepEqual(chess.by_source_id['11450'], {
    name: '崔斯特',
    core: {
      check_id: '1450',
      trait_ids: [],
      identity: {
        check_id: '1450',
        map_id: '701',
        resource_key: 's19_twistedfate',
        star: 1,
      },
    },
  });
  assert.equal(chess.by_source_id['21450'].core.check_id, '1450');
  assert.equal(chess.by_source_id['21450'].core.identity.star, 2);
  assert.doesNotMatch(JSON.stringify(chess.by_source_id['11450']), /11450/u);

  const requestedUrls = [];
  const documentsByUrl = new Map([
    [urls.trait, traitDocument],
    [urls.chess, chessDocument],
  ]);
  const snapshot = await buildOfficialSourceDictionary({
    upstream_identity: upstreamIdentity,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        text: async () => `${JSON.stringify(documentsByUrl.get(url))}\n`,
      };
    },
  });
  assert.deepEqual(requestedUrls.sort(), [urls.chess, urls.trait].sort());
  assert.match(snapshot.content_hash, /^[a-f0-9]{64}$/u);
  assert.match(snapshot.source_hashes.trait_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(snapshot.trait.content_hash, trait.content_hash);

  assert.deepEqual(
    projectOfficialSourceObservedIds(snapshot, {
      trait_ids: ['84700102', 'missing', '83910102'],
      chess_ids: ['21450'],
    }),
    {
      trait: {
        83910102: trait.by_source_id['83910102'],
        84700102: trait.by_source_id['84700102'],
      },
      chess: {
        21450: chess.by_source_id['21450'],
      },
    },
  );

  assert.throws(
    () => validateOfficialSourceDocument({ ...traitDocument, version: '18.18.2' }, upstreamIdentity),
    /version mismatch/u,
  );
  assert.throws(
    () => validateOfficialSourceDocument({ ...traitDocument, season: 'S20' }, upstreamIdentity),
    /season mismatch/u,
  );
  assert.throws(
    () => validateOfficialSourceDocument({ ...traitDocument, setId: '17' }, upstreamIdentity),
    /setId mismatch/u,
  );
  validateOfficialSourceDocument({ data: traitDocument.data }, upstreamIdentity);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    urls,
    trait_rows: trait.count,
    chess_rows: chess.count,
    content_hash: snapshot.content_hash,
    verified_traits: ['83910102', '84700102'],
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
