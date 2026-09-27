const DEFAULT_SCHEMA = "jcc-mature-recipe-variant-set-v1";

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export function compactMatureRecipeVariantPacket({
  variants,
  receipt = null,
  limit = 6,
} = {}) {
  const sourceVariants = Array.isArray(variants) ? variants : [];
  const normalizedLimit = nonNegativeInteger(limit);
  if (normalizedLimit === null) {
    throw new TypeError("mature recipe variant packet limit must be a non-negative integer");
  }

  const retainedVariants = sourceVariants.slice(0, normalizedLimit);
  if (!receipt && sourceVariants.length === 0) {
    return {
      mature_recipe_variants: retainedVariants,
      mature_recipe_variant_receipt: null,
    };
  }

  const declaredSourceCount = nonNegativeInteger(receipt?.source_count);
  const sourceCount = Math.max(sourceVariants.length, declaredSourceCount ?? 0);
  return {
    mature_recipe_variants: retainedVariants,
    mature_recipe_variant_receipt: {
      ...(receipt && typeof receipt === "object" ? receipt : {}),
      schema: receipt?.schema || DEFAULT_SCHEMA,
      source_count: sourceCount,
      retained_count: retainedVariants.length,
      truncated: sourceCount > retainedVariants.length,
    },
  };
}
