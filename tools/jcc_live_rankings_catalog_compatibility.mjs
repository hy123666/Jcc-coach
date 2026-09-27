function addId(target, value) {
  const id = String(value || "").trim();
  if (!id) return;
  target.add(id);
  if (/^\d{5}$/.test(id)) target.add(id.slice(1));
}

function championIds(champions) {
  const ids = new Set();
  for (const champion of champions || []) {
    for (const value of [
      champion?.id,
      champion?.champion_id,
      champion?.canonical_id,
      champion?.mumu_base_id,
      ...(champion?.raw_refs?.raw_star_ids || []),
      ...(champion?.raw_refs?.origin_hero_ids || []),
    ]) addId(ids, value);
  }
  return ids;
}

function itemIds(items) {
  const ids = new Set();
  for (const item of items || []) {
    for (const value of [
      item?.id,
      item?.equip_id,
      item?.icon_key,
      ...(item?.raw_refs?.origin_equip_ids || []),
    ]) addId(ids, value);
  }
  return ids;
}

function collectRows(snapshot) {
  const heroStrength = new Set();
  const lineupUnits = new Set();
  const mainCarries = new Set();
  const rankedItems = new Set();
  const lineupItems = new Set();
  const heroEquipmentItems = new Set();
  for (const tier of Object.values(snapshot?.tiers || {})) {
    for (const rows of Object.values(tier?.hero_strength || {})) {
      for (const row of rows || []) addId(heroStrength, row?.hero_id);
    }
    for (const group of tier?.lineup_group?.main_traits_data || []) {
      addId(mainCarries, group?.info?.main_c_chess_id);
      for (const variant of group?.info?.list || []) {
        for (const id of [
          ...(variant?.lineup || []),
          ...(variant?.core_chess || []),
          ...(variant?.free_chess || []),
          ...(variant?.assist_chess || []),
        ]) addId(lineupUnits, id);
        for (const id of [
          ...(variant?.main_c_chess_equip || []),
          ...(variant?.assist_chess_equip || []),
        ]) addId(lineupItems, id);
      }
    }
    for (const row of tier?.equip_rank?.list || []) addId(rankedItems, row?.equip_id);
    for (const hero of Object.values(tier?.hero_equip_rankings?.by_hero_id || {})) {
      for (const id of hero?.single_itemid || []) addId(heroEquipmentItems, id);
      for (const itemPackage of hero?.combine_itemid_details || []) {
        for (const id of itemPackage?.equips || []) addId(heroEquipmentItems, id);
      }
    }
  }
  return { heroStrength, lineupUnits, mainCarries, rankedItems, lineupItems, heroEquipmentItems };
}

function coverage(observed, allowed) {
  const ids = [...observed];
  const matched = ids.filter((id) => allowed.has(id));
  const unknown = ids.filter((id) => !allowed.has(id));
  return {
    observed_count: ids.length,
    matched_count: matched.length,
    match_ratio: ids.length ? matched.length / ids.length : 0,
    unknown_ids: unknown.slice(0, 24),
  };
}

export function auditLiveRankingCatalogCompatibility(snapshot, { champions, items }) {
  const allowed = championIds(champions);
  const allowedItems = itemIds(items);
  if (allowed.size === 0) throw new Error("Ranking catalog compatibility requires a non-empty champion identity set");
  if (allowedItems.size === 0) throw new Error("Ranking catalog compatibility requires a non-empty item identity set");
  const observed = collectRows(snapshot);
  const sections = {
    hero_strength: coverage(observed.heroStrength, allowed),
    lineup_units: coverage(observed.lineupUnits, allowed),
    main_carries: coverage(observed.mainCarries, allowed),
    ranked_items: coverage(observed.rankedItems, allowedItems),
    lineup_items: coverage(observed.lineupItems, allowedItems),
    hero_equipment_items: coverage(observed.heroEquipmentItems, allowedItems),
  };
  const failures = [];
  for (const [section, result] of Object.entries(sections)) {
    if (result.observed_count === 0) failures.push({ reason: "ranking_catalog_identity_evidence_missing", section, ...result });
    else if (result.match_ratio < 0.8) failures.push({ reason: "ranking_catalog_identity_mismatch", section, ...result });
  }
  return {
    schema: "jcc-live-ranking-catalog-compatibility-v1",
    status: failures.length ? "fail" : "pass",
    minimum_match_ratio: 0.8,
    allowed_champion_identity_count: allowed.size,
    allowed_item_identity_count: allowedItems.size,
    sections,
    failures,
  };
}
