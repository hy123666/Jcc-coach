function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function normalizedArtifactCount(name, value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;

  if (name === 'reward_tables') {
    return arrayLength(value.entity_tables)
      + arrayLength(value.season_tables)
      + arrayLength(value.supplemental_unbound_tables);
  }

  return value.counts?.population_buckets
    ?? value.counts?.champion_mappings
    ?? value.variables?.length
    ?? value.shop_extensions?.[0]?.entries?.length
    ?? value.applied_operations
    ?? 0;
}

export function buildNormalizedArtifactCounts(normalizedArtifacts) {
  return Object.fromEntries(
    Object.entries(normalizedArtifacts || {}).map(([name, value]) => [
      name,
      normalizedArtifactCount(name, value),
    ]),
  );
}
