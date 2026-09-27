const CATEGORY_PATTERNS = Object.freeze([
  ["combat", /(?:伤害|攻击力|攻击速度|攻速|法术强度|法强|生命值|最大生命|护甲|魔抗|耐久|治疗|回复|护盾|控制|战斗开始|阵亡|暴击|穿透|damage|attack|health|armor|resist|heal|shield|combat)/iu],
  ["economy", /(?:金币|利息|经验|购买经验|升级时|收入|gold|interest|experience|\bxp\b)/iu],
  ["equipment", /(?:装备|神器|光明装备|散件|锻造器|重铸|拆卸|无用大棒|暴风之剑|反曲之弓|女神之泪|锁子甲|负极斗篷|巨人腰带|拳套|金铲铲|金锅锅|item|artifact|anvil|reforge)/iu],
  ["trait", /(?:羁绊|特质|职业|纹章|转职|trait|emblem)/iu],
  ["tempo", /(?:队伍规模|人口上限|[1-5]费弈子|每个[1-5]费弈子|免费刷新|商店刷新|复制器|升星|复制体|team size|shop refresh|reroll|star.?up)/iu],
  ["exclusive", /(?:英雄专属|弈子专属|羁绊激活|指定英雄|指定弈子|指定羁绊|被【[^】]+】标记|第二个被|召唤物|champion-specific|trait-specific)/iu],
  ["special", /(?:随机|概率|几率|投掷|骰子|倒计时|改变基础规则|选择第二个|召唤.*复制体|random|chance|countdown|rule change)/iu],
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function semanticText(entity) {
  return [
    entity?.name,
    entity?.desc,
    entity?.description,
    entity?.effects?.source_text,
    ...asArray(entity?.effects?.structured_terms),
    ...asArray(entity?.effects?.conditional_tags),
    ...asArray(entity?.tags),
  ].filter(Boolean).join(" ").normalize("NFKC");
}

export function inferAugmentCategoryIds(entity) {
  const text = semanticText(entity);
  return CATEGORY_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([category]) => category);
}
