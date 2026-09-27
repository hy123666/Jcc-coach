function integerOrNull(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string" && (!/^\d+$/.test(value) || value.trim() !== value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function normalizeMumuHeroId(value) {
  const rawHeroId = integerOrNull(value);
  const starBucket = rawHeroId == null ? null : Math.trunc(rawHeroId / 10000);
  const canonicalSuffix = rawHeroId == null ? null : rawHeroId % 10000;
  if (rawHeroId == null || starBucket < 1 || starBucket > 4 || canonicalSuffix === 0) {
    return {
      raw_hero_id: rawHeroId,
      base_hero_id: null,
      hero_id: null,
      champion_id: null,
      star_bucket: starBucket,
      star_level_hint: null,
    };
  }
  const baseHeroId = canonicalSuffix + 10000;
  return {
    raw_hero_id: rawHeroId,
    base_hero_id: baseHeroId,
    hero_id: baseHeroId,
    champion_id: baseHeroId,
    star_bucket: starBucket,
    star_level_hint: starBucket >= 1 && starBucket <= 4 ? starBucket : null,
  };
}
