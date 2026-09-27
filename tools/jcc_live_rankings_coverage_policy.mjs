function catalogCount(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Ranking coverage policy requires a non-empty ${label} catalog`);
  }
  return value.length;
}

export function buildLiveRankingCoverageMinimums({ traits, champions, items }) {
  const traitCatalogCount = catalogCount(traits, "trait");
  const championCatalogCount = catalogCount(champions, "champion");
  const itemCatalogCount = catalogCount(items, "item");
  return Object.freeze({
    traitCount: Math.max(12, Math.ceil(traitCatalogCount * 0.9)),
    heroCount: Math.max(20, Math.ceil(championCatalogCount * 0.9)),
    equipCount: Math.max(40, Math.ceil(itemCatalogCount * 0.75)),
    winningRecipeCount: Math.max(12, Math.min(50, traitCatalogCount)),
  });
}
