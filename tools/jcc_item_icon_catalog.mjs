import { createHash } from "node:crypto";

export const ITEM_TEMPLATE_SETS = Object.freeze({
  LEFT_ITEM_RAIL_INVENTORY: "left_item_rail_inventory",
  BASIC_COMPONENT_FORGE: "basic_component_forge",
  COMPLETED_ITEM_FORGE: "completed_item_forge",
  ARTIFACT_FORGE: "artifact_forge",
  RADIANT_ITEM: "radiant_item",
  EMBLEM_ITEM: "emblem_item",
  CONSUMABLE_TOOL: "consumable_tool",
  SPECIAL_ITEM: "special_item",
});

const KNOWN_SPECIAL_CLASSES = new Map([
  ["3003", "consumable"],
  ["3004", "consumable"],
  ["3007", "forge_tool"],
  ["3009", "forge_tool"],
  ["3016", "forge_tool"],
  ["3024", "forge_tool"],
  ["3028", "consumable"],
  ["3029", "consumable"],
  ["3030", "consumable"],
  ["3031", "forge_tool"],
]);

function stripMarkup(value) {
  return String(value ?? "")
    .replace(/<color=[^>]+>/gi, "")
    .replace(/<\/color>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeItemName(value) {
  return stripMarkup(value).replace(/\s+/g, "").toLowerCase();
}

function itemTypeOf(hardRow) {
  return stripMarkup(hardRow?.type || hardRow?.category || "");
}

function itemNameOf(hardRow, template) {
  return stripMarkup(hardRow?.name || template?.name || "");
}

export function visualGroupIdForTemplate(template) {
  const key = template?.icon_url || template?.local_path || `${template?.kind || "item"}:${template?.id || ""}`;
  const digest = createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
  return `${template?.kind || "item"}_icon:${digest}`;
}

export function inferItemClass(hardRow, template = {}) {
  if (!hardRow && template?.item_class) return template.item_class;
  const id = String(template?.id || hardRow?.id || "");
  const type = itemTypeOf(hardRow);
  const name = itemNameOf(hardRow, template);
  const tags = new Set([
    ...(Array.isArray(hardRow?.tags) ? hardRow.tags : []),
    ...(Array.isArray(hardRow?.effect_block?.tags) ? hardRow.effect_block.tags : []),
    ...(Array.isArray(hardRow?.effect_parse?.tags) ? hardRow.effect_parse.tags : []),
  ].map((tag) => String(tag).toLowerCase()));

  if (KNOWN_SPECIAL_CLASSES.has(id)) return KNOWN_SPECIAL_CLASSES.get(id);
  if (type.includes("基础装备") || tags.has("component")) return "component";
  if (type.includes("成型装备") || type.includes("成装") || tags.has("completed")) return "completed";
  if (type.includes("光明武器") || name.includes("光明版")) return "radiant";
  if (type.includes("神器装备") || name.includes("神器")) return "artifact";
  if (type.includes("转职纹章") || name.includes("纹章")) return "emblem";
  if (
    type.includes("特殊装备")
    || tags.has("consumable")
    || /拆卸器|重铸器|锻造器|复制器|打捞桶|宝箱|指令模块|原型|上行链路/.test(name)
  ) {
    return name.includes("锻造器") ? "forge_tool" : "consumable";
  }
  return type || "unknown";
}

export function templateSetsForItemClass(itemClass, hardRow, template = {}) {
  if (!hardRow && Array.isArray(template?.template_sets) && template.template_sets.length) {
    return [...template.template_sets];
  }
  const id = String(template?.id || hardRow?.id || "");
  const name = itemNameOf(hardRow, template);
  const sets = new Set();

  if (["component", "completed", "artifact", "radiant", "emblem", "consumable", "forge_tool", "special_item"].includes(itemClass)) {
    sets.add(ITEM_TEMPLATE_SETS.LEFT_ITEM_RAIL_INVENTORY);
  }
  if (itemClass === "component") sets.add(ITEM_TEMPLATE_SETS.BASIC_COMPONENT_FORGE);
  if (itemClass === "completed") sets.add(ITEM_TEMPLATE_SETS.COMPLETED_ITEM_FORGE);
  if (itemClass === "artifact") sets.add(ITEM_TEMPLATE_SETS.ARTIFACT_FORGE);
  if (itemClass === "radiant") sets.add(ITEM_TEMPLATE_SETS.RADIANT_ITEM);
  if (itemClass === "emblem") sets.add(ITEM_TEMPLATE_SETS.EMBLEM_ITEM);
  if (itemClass === "consumable" || itemClass === "forge_tool") sets.add(ITEM_TEMPLATE_SETS.CONSUMABLE_TOOL);

  if (id === "3007" || name === "基础装备锻造器") sets.add(ITEM_TEMPLATE_SETS.CONSUMABLE_TOOL);
  if (id === "3009" || id === "3031" || name.includes("神器装备锻造器")) sets.add(ITEM_TEMPLATE_SETS.CONSUMABLE_TOOL);
  if (itemClass === "unknown") sets.add(ITEM_TEMPLATE_SETS.SPECIAL_ITEM);
  return [...sets];
}

export function enrichItemTemplate(template, hardRow = null) {
  if (!template || template.kind !== "item") return template;
  const cleanName = itemNameOf(hardRow, template);
  const itemClass = inferItemClass(hardRow, template);
  const templateSets = templateSetsForItemClass(itemClass, hardRow, template);
  return {
    ...template,
    name: cleanName || template.name,
    clean_name: cleanName || template.name || null,
    normalized_name: normalizeItemName(cleanName || template.name),
    item_class: itemClass,
    template_sets: templateSets,
    visual_group_id: template.visual_group_id || visualGroupIdForTemplate(template),
    hard_data_type: hardRow?.type || null,
  };
}

export function attachSameIconGroups(templates) {
  const groups = new Map();
  for (const entry of templates || []) {
    if (entry?.kind !== "item") continue;
    const key = entry.visual_group_id || visualGroupIdForTemplate(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return (templates || []).map((entry) => {
    if (entry?.kind !== "item") return entry;
    const key = entry.visual_group_id || visualGroupIdForTemplate(entry);
    const possible = [...new Map((groups.get(key) || [entry]).map((row) => [String(row.id), row])).values()]
      .map((row) => ({
        id: String(row.id),
        name: row.clean_name || row.name || null,
        item_class: row.item_class || null,
        template_sets: row.template_sets || [],
        icon_url: row.icon_url || null,
      }));
    return {
      ...entry,
      visual_group_id: key,
      same_icon_possible_ids: possible,
    };
  });
}
