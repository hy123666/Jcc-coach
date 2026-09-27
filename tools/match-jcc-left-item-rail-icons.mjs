import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { attachSameIconGroups, enrichItemTemplate, ITEM_TEMPLATE_SETS } from "./jcc_item_icon_catalog.mjs";

const DEFAULT_MANIFEST = "data/runtime/jcc/visual-icons/manifest.json";
const SOURCE = "left_item_rail_roi_icon";

function parseArgs(argv) {
  const options = { manifest: DEFAULT_MANIFEST, top: 5, templateSet: ITEM_TEMPLATE_SETS.LEFT_ITEM_RAIL_INVENTORY };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--crop-tasks") options.cropTasks = argv[++index];
    else if (arg === "--manifest") options.manifest = argv[++index];
    else if (arg === "--template-set") options.templateSet = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--top") options.top = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/match-jcc-left-item-rail-icons.mjs --crop-tasks <roi-crop-task-batches.json> [--manifest <manifest.json>] [--out <matches.json>]",
    "",
    "Matches only items.item_bench ROI crops against item icon templates. It does not locate ROIs, OCR text, or inspect any non-left-rail field.",
    "The matcher is scene-scoped by --template-set. Default: left_item_rail_inventory.",
  ].join("\n");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function resolveLocalPath(candidatePath) {
  if (!candidatePath) return candidatePath;
  return path.isAbsolute(candidatePath) ? candidatePath : path.resolve(candidatePath);
}

function parsePngRgba(buffer) {
  if (!buffer || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  let offset = 8;
  let width = null;
  let height = null;
  let colorType = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) return null;
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0 || ![2, 6].includes(colorType)) return null;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || !idat.length) return null;
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const rgba = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++];
    const raw = Buffer.from(inflated.subarray(inputOffset, inputOffset + stride));
    inputOffset += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? raw[x - channels] : 0;
      const up = prev[x] || 0;
      const upLeft = x >= channels ? prev[x - channels] || 0 : 0;
      if (filter === 1) raw[x] = (raw[x] + left) & 0xff;
      else if (filter === 2) raw[x] = (raw[x] + up) & 0xff;
      else if (filter === 3) raw[x] = (raw[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        raw[x] = (raw[x] + predictor) & 0xff;
      } else if (filter !== 0) return null;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
      rgba[target + 3] = channels === 4 ? raw[source + 3] : 255;
    }
    prev = raw;
  }
  return { width, height, rgba };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cropImage(image, region) {
  const x0 = clamp(Math.floor(region.x * image.width), 0, image.width - 1);
  const y0 = clamp(Math.floor(region.y * image.height), 0, image.height - 1);
  const x1 = clamp(Math.ceil((region.x + region.w) * image.width), x0 + 1, image.width);
  const y1 = clamp(Math.ceil((region.y + region.h) * image.height), y0 + 1, image.height);
  const width = x1 - x0;
  const height = y1 - y0;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((y0 + y) * image.width + x0) * 4;
    const targetStart = y * width * 4;
    image.rgba.copy(rgba, targetStart, sourceStart, sourceStart + width * 4);
  }
  return { width, height, rgba };
}

function inset(region, x, y, w, h) {
  return {
    x: clamp(x, 0, 0.99),
    y: clamp(y, 0, 0.99),
    w: clamp(w, 0.001, 1),
    h: clamp(h, 0.001, 1),
  };
}

function itemCropVariants(image) {
  return [
    { label: "slot_full", image },
    { label: "slot_inner", image: cropImage(image, inset(null, 0.08, 0.08, 0.84, 0.84)) },
    { label: "slot_core", image: cropImage(image, inset(null, 0.16, 0.14, 0.68, 0.72)) },
    { label: "slot_tight", image: cropImage(image, inset(null, 0.23, 0.20, 0.54, 0.60)) },
  ];
}

function itemTemplateVariants(image) {
  return [
    { label: "template_full", image },
    { label: "template_inner", image: cropImage(image, inset(null, 0.08, 0.08, 0.84, 0.84)) },
    { label: "template_core", image: cropImage(image, inset(null, 0.16, 0.14, 0.68, 0.72)) },
    { label: "template_tight", image: cropImage(image, inset(null, 0.23, 0.20, 0.54, 0.60)) },
  ];
}

function samplePixel(image, sx, sy) {
  const x = clamp(Math.floor(sx), 0, image.width - 1);
  const y = clamp(Math.floor(sy), 0, image.height - 1);
  const offset = (y * image.width + x) * 4;
  return [image.rgba[offset], image.rgba[offset + 1], image.rgba[offset + 2], image.rgba[offset + 3]];
}

function downsampleLuma(image, size = 16) {
  const values = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = samplePixel(image, ((x + 0.5) / size) * image.width, ((y + 0.5) / size) * image.height);
      values.push(((r + g + b) / 3) * (a / 255));
    }
  }
  return values;
}

function averageHash(image, size = 16) {
  const values = downsampleLuma(image, size);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => (value >= avg ? 1 : 0)).join("");
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) distance += 1;
  return distance;
}

function isSalientIconPixel(r, g, b, a) {
  if (a < 32) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  const luma = (r * 0.299) + (g * 0.587) + (b * 0.114);
  return saturation >= 0.18 || luma >= 92;
}

function colorHistogram(image, bins = 6, options = {}) {
  const hist = new Array(bins * bins * bins).fill(0);
  let total = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [r, g, b, a] = samplePixel(image, x, y);
      if (a < 32) continue;
      if (options.salientOnly && !isSalientIconPixel(r, g, b, a)) continue;
      const rb = clamp(Math.floor((r / 256) * bins), 0, bins - 1);
      const gb = clamp(Math.floor((g / 256) * bins), 0, bins - 1);
      const bb = clamp(Math.floor((b / 256) * bins), 0, bins - 1);
      hist[(rb * bins * bins) + (gb * bins) + bb] += 1;
      total += 1;
    }
  }
  return total > 0 ? hist.map((value) => value / total) : hist;
}

function histIntersection(a, b) {
  let sum = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) sum += Math.min(a[index], b[index]);
  return sum;
}

function makeDescriptor(image) {
  return {
    hash16: averageHash(image, 16),
    histogram6: colorHistogram(image, 6),
    salient_histogram6: colorHistogram(image, 6, { salientOnly: true }),
  };
}

function maskedIconSimilarity(targetImage, templateImage, size = 18) {
  let totalWeight = 0;
  let totalSimilarity = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = (x + 0.5) / size;
      const sy = (y + 0.5) / size;
      const [tr, tg, tb, ta] = samplePixel(templateImage, sx * templateImage.width, sy * templateImage.height);
      if (ta < 48) continue;
      const [r, g, b, a] = samplePixel(targetImage, sx * targetImage.width, sy * targetImage.height);
      if (a < 16) continue;
      const colorDistance = Math.sqrt(((r - tr) ** 2) + ((g - tg) ** 2) + ((b - tb) ** 2));
      const colorSimilarity = 1 - (colorDistance / 441.6729559300637);
      const weight = ta / 255;
      totalWeight += weight;
      totalSimilarity += clamp(colorSimilarity, 0, 1) * weight;
    }
  }
  return totalWeight > 0 ? Number((totalSimilarity / totalWeight).toFixed(4)) : 0;
}

function iconPresenceStats(image) {
  let count = 0;
  let salient = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [r, g, b, a] = samplePixel(image, x, y);
      const luma = (r * 0.299) + (g * 0.587) + (b * 0.114);
      count += 1;
      sum += luma;
      sumSquares += luma * luma;
      if (isSalientIconPixel(r, g, b, a)) salient += 1;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? (sumSquares / count) - (mean * mean) : 0;
  return {
    luma_mean: Number(mean.toFixed(2)),
    luma_stddev: Number(Math.sqrt(Math.max(0, variance)).toFixed(2)),
    salient_ratio: count > 0 ? Number((salient / count).toFixed(4)) : 0,
  };
}

function itemIconPresenceStatus(stats) {
  if (!stats) return { status: "unknown", reject: false, reason: "presence_stats_missing" };
  if (stats.luma_stddev < 8) return { status: "empty_or_background_slot", reject: true, reason: "very_low_luma_variance" };
  if (stats.luma_stddev < 10 && stats.salient_ratio < 0.025) return { status: "empty_or_background_slot", reject: true, reason: "low_luma_variance_and_low_salience" };
  if (stats.salient_ratio < 0.012) return { status: "empty_or_background_slot", reject: true, reason: "very_low_salience" };
  return { status: "occupied_or_uncertain", reject: false, reason: "icon_like_pixels_present" };
}

function scoreDescriptor(target, template, targetImage, templateImage) {
  const hashDistance = hamming(target.hash16, template.hash16);
  const hashScore = Number.isFinite(hashDistance) ? 1 - (hashDistance / 256) : 0;
  const histScore = histIntersection(target.histogram6, template.histogram6);
  const salientHistScore = histIntersection(target.salient_histogram6, template.salient_histogram6);
  const maskedScore = maskedIconSimilarity(targetImage, templateImage);
  const legacyScore = (hashScore * 0.55) + (histScore * 0.45);
  const maskedBlendScore = (hashScore * 0.25) + (histScore * 0.18) + (salientHistScore * 0.17) + (maskedScore * 0.40);
  const score = Math.max(legacyScore, maskedBlendScore);
  return {
    score: Number(score.toFixed(4)),
    descriptor_profile: "left_item_rail_item_masked",
    legacy_score: Number(legacyScore.toFixed(4)),
    masked_blend_score: Number(maskedBlendScore.toFixed(4)),
    hash_distance: hashDistance,
    hash_score: Number(hashScore.toFixed(4)),
    histogram_score: Number(histScore.toFixed(4)),
    salient_histogram_score: Number(salientHistScore.toFixed(4)),
    masked_icon_score: maskedScore,
  };
}

function enrichManifestItems(manifest) {
  return attachSameIconGroups((manifest.templates || []).map((entry) => (
    entry.kind === "item" ? enrichItemTemplate(entry, null) : entry
  )));
}

function rowInTemplateSet(row, templateSet) {
  if (!templateSet) return true;
  return Array.isArray(row.template_sets) && row.template_sets.includes(templateSet);
}

async function templateDescriptors(manifest, templateSet) {
  const rows = enrichManifestItems(manifest)
    .filter((entry) => entry.kind === "item" && entry.local_exists && rowInTemplateSet(entry, templateSet));
  const descriptors = [];
  for (const row of rows) {
    try {
      const image = parsePngRgba(await readFile(resolveLocalPath(row.local_path)));
      if (!image) continue;
      for (const variant of itemTemplateVariants(image)) {
        descriptors.push({
          ...row,
          image: variant.image,
          descriptor: makeDescriptor(variant.image),
          template_variant_label: variant.label,
        });
      }
    } catch {
      // Manifest availability is verified elsewhere; ignore broken local templates here.
    }
  }
  return attachVisualGroups(descriptors);
}

function attachVisualGroups(templates) {
  const groups = new Map();
  for (const template of templates) {
    const key = template.visual_group_id || template.icon_url || template.local_path || `item:${template.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(template);
  }
  return templates.map((template) => {
    const key = template.visual_group_id || template.icon_url || template.local_path || `item:${template.id}`;
    const visualGroup = [...new Map((groups.get(key) || [template]).map((entry) => [String(entry.id), entry])).values()]
      .map((entry) => ({
        id: entry.id,
        name: entry.clean_name || entry.name,
        kind: entry.kind,
        item_class: entry.item_class || null,
        template_sets: entry.template_sets || [],
        icon_url: entry.icon_url || null,
      }));
    return { ...template, visual_group_key: key, visual_group: visualGroup };
  });
}

function topMatches(targetImage, templates, top) {
  const descriptor = makeDescriptor(targetImage);
  const scored = templates
    .map((template) => ({
      kind: template.kind,
      id: template.id,
      name: template.clean_name || template.name,
      item_class: template.item_class || null,
      template_sets: template.template_sets || [],
      template_variant_label: template.template_variant_label || null,
      visual_group_key: template.visual_group_key || template.icon_url || template.local_path || `item:${template.id}`,
      visual_group_id: template.visual_group_id || template.visual_group_key || null,
      icon_url: template.icon_url,
      ...scoreDescriptor(descriptor, template.descriptor, targetImage, template.image),
    }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, top);
}

function distinctVisualGroupGap(candidates) {
  const top1 = candidates?.[0] || null;
  if (!top1) return null;
  const nextDifferent = (candidates || []).find((candidate) => candidate.visual_group_key !== top1.visual_group_key);
  return nextDifferent ? Number((top1.score - nextDifferent.score).toFixed(4)) : null;
}

function confidenceStatus(candidates, presenceStatus) {
  const top1 = candidates?.[0] || null;
  if (presenceStatus?.reject) {
    return { status: "empty_or_background_slot", confidence: 0, gap: null, reason: presenceStatus.reason };
  }
  if (!top1) return { status: "missing_template_candidates", confidence: 0, gap: null };
  const gap = distinctVisualGroupGap(candidates);
  if (top1.score >= 0.72 && (gap === null || gap >= 0.08)) {
    return { status: "visual_icon_candidate_high_confidence", confidence: Number(Math.min(0.95, top1.score).toFixed(4)), gap };
  }
  if (top1.score >= 0.62 && (gap === null || gap >= 0.05)) {
    return { status: "visual_icon_candidate_medium_confidence", confidence: Number(Math.min(0.85, top1.score).toFixed(4)), gap };
  }
  return { status: "low_confidence_roi_or_template_mismatch", confidence: Number(Math.min(0.55, top1.score).toFixed(4)), gap };
}

function possibleIdsForTop(top1, templates) {
  if (!top1) return [];
  const group = templates.find((template) => template.id === top1.id && template.visual_group_key === top1.visual_group_key)?.visual_group || [];
  return group.map((entry) => ({
    id: entry.id,
    name: entry.name,
      kind: entry.kind,
      item_class: entry.item_class || null,
      template_sets: entry.template_sets || [],
      icon_url: entry.icon_url || null,
    }));
}

function bestTaskMatch(task, templates, top, templateSet) {
  const image = parsePngRgba(readFileSync(task.crop_image));
  if (!image) {
    return {
      task_id: task.task_id,
      field: task.field,
      kind: "item",
      status: "crop_unreadable",
      confidence: 0,
      candidates: [],
      source: SOURCE,
      evidence: { ...(task.evidence || {}), crop_image: task.crop_image },
    };
  }
  const variants = itemCropVariants(image).map((variant) => {
    const candidates = topMatches(variant.image, templates, top);
    const presenceStats = iconPresenceStats(variant.image);
    const presenceStatus = itemIconPresenceStatus(presenceStats);
    const confidence = confidenceStatus(candidates, presenceStatus);
    return {
      variant_label: variant.label,
      candidates,
      confidence,
      top_score: candidates[0]?.score || 0,
      presence_stats: presenceStats,
      presence_status: presenceStatus,
    };
  }).sort((a, b) => {
    if (b.confidence.confidence !== a.confidence.confidence) return b.confidence.confidence - a.confidence.confidence;
    return b.top_score - a.top_score;
  });
  const best = variants[0] || { candidates: [], confidence: { status: "missing_template_candidates", confidence: 0, gap: null } };
  const top1 = best.candidates[0] || null;
  return {
    task_id: task.task_id,
    field: task.field,
    kind: "item",
    template_set: templateSet || null,
    slot: task.evidence?.slot ?? slotFromField(task.field),
    status: best.confidence.status,
    confidence: best.confidence.confidence,
    confidence_reason: best.confidence.reason || null,
    top_gap: best.confidence.gap,
    candidates: best.candidates,
    possible_ids: possibleIdsForTop(top1, templates),
    visual_group_status: top1 && possibleIdsForTop(top1, templates).length > 1 ? "ambiguous_same_icon_group" : "single_visual_group",
    disambiguation_needed: Boolean(top1 && possibleIdsForTop(top1, templates).length > 1),
    source: SOURCE,
    recognition_source: SOURCE,
    evidence: {
      ...(task.evidence || {}),
      crop_image: task.crop_image,
      crop_variant: best.variant_label,
      coordinate_space: "crop_task_pixels",
      source_contract: "roi_left_item_rail_crop_only_then_scene_scoped_item_icon_matcher",
      presence_stats: best.presence_stats,
      presence_status: best.presence_status,
    },
  };
}

function slotFromField(field) {
  const match = String(field || "").match(/^items\.item_bench\.(\d+)$/);
  return match ? Number(match[1]) : null;
}

function applySecondColumnGuard(matches) {
  return matches.map((match) => ({
    ...match,
    evidence: {
      ...(match.evidence || {}),
      second_column_policy: Number(match.slot) >= 10
        ? {
            status: "per_slot_presence_checked",
            reason: "second column is not globally suppressed; each slot must pass its own occupancy and confidence gates",
          }
        : undefined,
    },
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.cropTasks) throw new Error("--crop-tasks is required");
  const startedAt = performance.now();
  const cropTasksPayload = await readJson(options.cropTasks);
  const tasks = (cropTasksPayload.tasks || [])
    .filter((task) => task.field && String(task.field).startsWith("items.item_bench.") && task.kind === "item_icon");
  const manifest = await readJson(options.manifest);
  const templates = await templateDescriptors(manifest, options.templateSet);
  const matches = applySecondColumnGuard(tasks.map((task) => bestTaskMatch(task, templates, options.top, options.templateSet)));
  const payload = {
    ok: true,
    schema: "jcc-left-item-rail-icon-match-batch-v1",
    source: SOURCE,
    frame: cropTasksPayload.frame || null,
    matches,
    timing_ms: {
      total: Number((performance.now() - startedAt).toFixed(3)),
    },
    policy: {
      scope: "items.item_bench_only",
      template_set: options.templateSet,
      no_ocr: true,
      no_roi_detection: true,
      no_augments: true,
      no_equipped_items: true,
      no_opponent_items: true,
    },
  };
  if (options.out) await writeJson(path.resolve(options.out), payload);
  console.log(JSON.stringify(payload, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("match-jcc-left-item-rail-icons.mjs")) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
