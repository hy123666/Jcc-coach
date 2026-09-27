export function classifyJccBuffSourceEntityKind(row) {
  const iconIdentity = `${row?.icon || ""} ${row?.icon_small || ""}`.toLowerCase();
  if (iconIdentity.includes("godaugment")) return "season_reward_internal";
  return "augment";
}
