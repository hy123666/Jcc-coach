import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DEX = ".omx/runtime-evidence/mumu-gameassist-jkchess/apk/classes.dex";
const DEFAULT_OUT = "data/runtime/jcc/mumu-dex-usage-map.json";

const INVOKE_OPCODES = new Set([0x6e, 0x6f, 0x70, 0x71, 0x72, 0x74, 0x75, 0x76, 0x77, 0x78]);
const CONST_STRING_OPCODES = new Set([0x1a, 0x1b]);
const FIELD_OPCODES = new Set([
  0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d,
  0x5e, 0x5f, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67,
]);

const TARGET_CALLEE = /com\/mumu\/gameassist\/games\/jcc\/data\/|com\/mumu\/gameassist\/api\/(XYPosition|ChessPositionApi|PositionApiData)|com\/benjaminwan\/ocrlibrary\/|android\/window\/ScreenCapture|android\/media\/projection|android\/media\/ImageReader|android\/media\/MediaCodec|android\/graphics\/Bitmap|android\/hardware\/display\/VirtualDisplay/i;
const TARGET_STRING = /cfg|lus|X23B|RapidOcr|ch_PP-OCR|ocr|screenShot|captureDisplay|Buy hex|roundOcrText|toolbox\/item\/config|libLTc|libcrypto|board|bench|position|heroId|coreHeroId|heroEntityId/i;
const TARGET_FIELD = /heroId|coreHeroId|heroEntityId|position|basicHeroInfo|roundOcrText|screenShot|outerPositionData|positionData/i;

function usage() {
  return [
    "Usage:",
    "  node tools/analyze-jcc-mumu-dex-usage.mjs [--dex <classes.dex>] [--out <json>]",
    "",
    "Builds a lightweight DEX method/string usage map for MuMu JCC gameassist evidence.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { dex: DEFAULT_DEX, out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dex") options.dex = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function u1(buffer, offset) {
  return buffer.readUInt8(offset);
}

function u2(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function u4(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function readUleb128(buffer, offset) {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (true) {
    const byte = buffer[cursor++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, next: cursor };
}

function readString(buffer, offset) {
  const length = readUleb128(buffer, offset);
  let cursor = length.next;
  const bytes = [];
  while (cursor < buffer.length && buffer[cursor] !== 0) bytes.push(buffer[cursor++]);
  return Buffer.from(bytes).toString("utf8");
}

function descriptorToShort(descriptor) {
  return descriptor
    .replace(/^L/, "")
    .replace(/;$/, "")
    .replaceAll("/", ".");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function capArray(values, limit = 80) {
  return unique(values).slice(0, limit);
}

function parseTypeList(buffer, offset, types) {
  if (!offset) return [];
  const size = u4(buffer, offset);
  const out = [];
  let cursor = offset + 4;
  for (let index = 0; index < size; index += 1) {
    out.push(types[u2(buffer, cursor)] || null);
    cursor += 2;
  }
  return out;
}

function parseDex(buffer) {
  if (buffer.subarray(0, 3).toString("latin1") !== "dex") {
    throw new Error("Input is not a DEX file");
  }
  const header = {
    stringIdsSize: u4(buffer, 0x38),
    stringIdsOff: u4(buffer, 0x3c),
    typeIdsSize: u4(buffer, 0x40),
    typeIdsOff: u4(buffer, 0x44),
    protoIdsSize: u4(buffer, 0x48),
    protoIdsOff: u4(buffer, 0x4c),
    fieldIdsSize: u4(buffer, 0x50),
    fieldIdsOff: u4(buffer, 0x54),
    methodIdsSize: u4(buffer, 0x58),
    methodIdsOff: u4(buffer, 0x5c),
    classDefsSize: u4(buffer, 0x60),
    classDefsOff: u4(buffer, 0x64),
  };

  const strings = [];
  for (let index = 0; index < header.stringIdsSize; index += 1) {
    strings.push(readString(buffer, u4(buffer, header.stringIdsOff + index * 4)));
  }

  const types = [];
  for (let index = 0; index < header.typeIdsSize; index += 1) {
    types.push(strings[u4(buffer, header.typeIdsOff + index * 4)] || null);
  }

  const protos = [];
  for (let index = 0; index < header.protoIdsSize; index += 1) {
    const off = header.protoIdsOff + index * 12;
    protos.push({
      shorty: strings[u4(buffer, off)] || null,
      returnType: types[u4(buffer, off + 4)] || null,
      parameters: parseTypeList(buffer, u4(buffer, off + 8), types),
    });
  }

  const fields = [];
  for (let index = 0; index < header.fieldIdsSize; index += 1) {
    const off = header.fieldIdsOff + index * 8;
    fields.push({
      class: types[u2(buffer, off)] || null,
      type: types[u2(buffer, off + 2)] || null,
      name: strings[u4(buffer, off + 4)] || null,
    });
  }

  const methods = [];
  for (let index = 0; index < header.methodIdsSize; index += 1) {
    const off = header.methodIdsOff + index * 8;
    const proto = protos[u2(buffer, off + 2)] || {};
    const cls = types[u2(buffer, off)] || null;
    const name = strings[u4(buffer, off + 4)] || null;
    methods.push({
      index,
      class: cls,
      name,
      proto,
      signature: `${cls || "?"}->${name || "?"}(${(proto.parameters || []).join("")})${proto.returnType || "?"}`,
      short: `${descriptorToShort(cls || "?")}#${name || "?"}`,
    });
  }

  const classDefs = [];
  for (let index = 0; index < header.classDefsSize; index += 1) {
    const off = header.classDefsOff + index * 32;
    classDefs.push({
      class: types[u4(buffer, off)] || null,
      accessFlags: u4(buffer, off + 4),
      superclass: types[u4(buffer, off + 8)] || null,
      interfacesOff: u4(buffer, off + 12),
      sourceFile: strings[u4(buffer, off + 16)] || null,
      annotationsOff: u4(buffer, off + 20),
      classDataOff: u4(buffer, off + 24),
      staticValuesOff: u4(buffer, off + 28),
    });
  }

  return { header, strings, types, protos, fields, methods, classDefs };
}

function parseClassData(buffer, classDef, methods) {
  if (!classDef.classDataOff) return [];
  let cursor = classDef.classDataOff;
  const staticFieldsSize = readUleb128(buffer, cursor); cursor = staticFieldsSize.next;
  const instanceFieldsSize = readUleb128(buffer, cursor); cursor = instanceFieldsSize.next;
  const directMethodsSize = readUleb128(buffer, cursor); cursor = directMethodsSize.next;
  const virtualMethodsSize = readUleb128(buffer, cursor); cursor = virtualMethodsSize.next;

  for (let index = 0, fieldIndex = 0; index < staticFieldsSize.value; index += 1) {
    const diff = readUleb128(buffer, cursor); cursor = diff.next; fieldIndex += diff.value;
    const flags = readUleb128(buffer, cursor); cursor = flags.next; void flags;
  }
  for (let index = 0, fieldIndex = 0; index < instanceFieldsSize.value; index += 1) {
    const diff = readUleb128(buffer, cursor); cursor = diff.next; fieldIndex += diff.value;
    const flags = readUleb128(buffer, cursor); cursor = flags.next; void flags;
  }

  const out = [];
  for (const kind of ["direct", "virtual"]) {
    const size = kind === "direct" ? directMethodsSize.value : virtualMethodsSize.value;
    let methodIndex = 0;
    for (let index = 0; index < size; index += 1) {
      const diff = readUleb128(buffer, cursor); cursor = diff.next; methodIndex += diff.value;
      const accessFlags = readUleb128(buffer, cursor); cursor = accessFlags.next;
      const codeOff = readUleb128(buffer, cursor); cursor = codeOff.next;
      const method = methods[methodIndex];
      if (method) out.push({ ...method, kind, accessFlags: accessFlags.value, codeOff: codeOff.value, ownerClass: classDef.class });
    }
  }
  return out;
}

function inspectCode(buffer, method, dex) {
  if (!method.codeOff) return null;
  const codeOff = method.codeOff;
  const insnsSize = u4(buffer, codeOff + 12);
  const insnsOff = codeOff + 16;
  const invokedMethods = [];
  const stringRefs = [];
  const fieldRefs = [];
  const newInstances = [];
  for (let cursor = 0; cursor < insnsSize; cursor += 1) {
    const unit = u2(buffer, insnsOff + cursor * 2);
    const opcode = unit & 0xff;
    if (INVOKE_OPCODES.has(opcode) && cursor + 1 < insnsSize) {
      const methodIndex = u2(buffer, insnsOff + (cursor + 1) * 2);
      const callee = dex.methods[methodIndex];
      if (callee) invokedMethods.push(callee.signature);
    } else if (opcode === 0x1a && cursor + 1 < insnsSize) {
      const stringIndex = u2(buffer, insnsOff + (cursor + 1) * 2);
      if (dex.strings[stringIndex]) stringRefs.push(dex.strings[stringIndex]);
    } else if (opcode === 0x1b && cursor + 2 < insnsSize) {
      const stringIndex = u2(buffer, insnsOff + (cursor + 1) * 2) | (u2(buffer, insnsOff + (cursor + 2) * 2) << 16);
      if (dex.strings[stringIndex]) stringRefs.push(dex.strings[stringIndex]);
    } else if (opcode === 0x22 && cursor + 1 < insnsSize) {
      const typeIndex = u2(buffer, insnsOff + (cursor + 1) * 2);
      if (dex.types[typeIndex]) newInstances.push(dex.types[typeIndex]);
    } else if (FIELD_OPCODES.has(opcode) && cursor + 1 < insnsSize) {
      const fieldIndex = u2(buffer, insnsOff + (cursor + 1) * 2);
      const field = dex.fields[fieldIndex];
      if (field) fieldRefs.push(`${field.class || "?"}->${field.name || "?"}:${field.type || "?"}`);
    }
  }
  return {
    method: method.signature,
    owner_class: method.ownerClass,
    code_off: method.codeOff,
    invoked_methods: capArray(invokedMethods, 160),
    string_refs: capArray(stringRefs, 160),
    field_refs: capArray(fieldRefs, 160),
    new_instances: capArray(newInstances, 80),
  };
}

function classifyMethodUsage(usage) {
  const text = [
    usage.method,
    usage.owner_class,
    ...usage.invoked_methods,
    ...usage.string_refs,
    ...usage.field_refs,
    ...usage.new_instances,
  ].join("\n");
  const tags = [];
  if (/ScreenCapture|captureDisplay|takeScreenShot|screenShot|Bitmap/i.test(text)) tags.push("screen_capture");
  if (/OcrEngine|OcrResult|TextBlock|RapidOcr|ch_PP-OCR|roundOcrText|Buy hex ocr/i.test(text)) tags.push("ocr_loop");
  if (/BuyHeroInfo|WaitHeroInfo|SellHeroInfo|GiHeroInfo|GiWaitHeroList|GiHeroList|PlayerBattleInfo|GiGameStatus/i.test(text)) tags.push("jcc_live_candidate_model");
  if (/XYPosition|ChessPositionApi|PositionApiData|positionData|outerPositionData/i.test(text)) tags.push("position_model");
  if (/(^|[\/\\])cfg$|(^|[\/\\])lus$|X23B|libLTc|libcrypto|toolbox\/item\/config|app_libs_rapidocr|ch_pp_ocrv3/i.test(text)) tags.push("config_or_asset_loading");
  if (/board_units|bench_units|live_board|live_bench|current_board|current_bench/i.test(text)) tags.push("direct_live_snapshot_token");
  return tags;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const dexPath = path.resolve(options.dex);
  const buffer = await readFile(dexPath);
  const dex = parseDex(buffer);
  const encodedMethods = [];
  for (const classDef of dex.classDefs) {
    encodedMethods.push(...parseClassData(buffer, classDef, dex.methods));
  }

  const inspected = [];
  for (const method of encodedMethods.filter((entry) => entry.codeOff)) {
    const usage = inspectCode(buffer, method, dex);
    if (!usage) continue;
    const tags = classifyMethodUsage(usage);
    const hasTargetCallee = usage.invoked_methods.some((callee) => TARGET_CALLEE.test(callee));
    const hasTargetString = usage.string_refs.some((value) => TARGET_STRING.test(value));
    const hasTargetField = usage.field_refs.some((value) => TARGET_FIELD.test(value));
    const hasTargetNewInstance = usage.new_instances.some((value) => TARGET_CALLEE.test(value));
    if (tags.length || hasTargetCallee || hasTargetString || hasTargetField || hasTargetNewInstance) {
      inspected.push({
        ...usage,
        tags: capArray(tags),
        invoked_methods: capArray(usage.invoked_methods.filter((callee) => TARGET_CALLEE.test(callee) || /Asset|File|SQLite|Moshi|Json|Bitmap|Rect|Screen|Capture|Ocr|MediaProjection|ImageReader|MediaCodec/i.test(callee)), 80),
        string_refs: capArray(usage.string_refs.filter((value) => TARGET_STRING.test(value)), 80),
        field_refs: capArray(usage.field_refs.filter((value) => TARGET_FIELD.test(value)), 80),
        new_instances: capArray(usage.new_instances.filter((value) => TARGET_CALLEE.test(value) || /Bitmap|Rect|ArrayList|HashMap/i.test(value)), 80),
      });
    }
  }

  const byTag = {};
  for (const entry of inspected) {
    for (const tag of entry.tags) {
      byTag[tag] ||= [];
      byTag[tag].push(entry);
    }
  }
  for (const tag of Object.keys(byTag)) byTag[tag] = byTag[tag].slice(0, 80);

  const directLiveSnapshotTokenMethods = inspected.filter((entry) => entry.tags.includes("direct_live_snapshot_token"));
  const analysis = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    dex_path: path.relative(process.cwd(), dexPath).replaceAll("\\", "/"),
    parser: "lightweight_dex_table_and_code_scan",
    counts: {
      strings: dex.strings.length,
      types: dex.types.length,
      methods: dex.methods.length,
      class_defs: dex.classDefs.length,
      encoded_methods: encodedMethods.length,
      inspected_target_methods: inspected.length,
    },
    evidence_summary: {
      method_level_screen_capture_usage_observed: Boolean(byTag.screen_capture?.length),
      method_level_ocr_usage_observed: Boolean(byTag.ocr_loop?.length),
      method_level_jcc_candidate_model_usage_observed: Boolean(byTag.jcc_live_candidate_model?.length),
      method_level_position_model_usage_observed: Boolean(byTag.position_model?.length),
      config_or_asset_loading_usage_observed: Boolean(byTag.config_or_asset_loading?.length),
      direct_live_board_or_bench_snapshot_method_observed: directLiveSnapshotTokenMethods.length > 0,
      note: "This is a DEX bytecode table scan, not full Java decompilation. It is suitable for locating candidate call sites and strings, not proving high-level semantics alone.",
    },
    target_methods_by_tag: byTag,
    current_claims: {
      can_claim: [
        "JCC candidate data models are constructed or referenced inside DEX methods.",
        "Screen capture/OCR related calls are method-level observable.",
        "Config/asset loading candidate methods can be located for later full decompilation or instrumentation.",
      ],
      cannot_claim: [
        "Method tags alone prove the exact ROI/state-machine format.",
        "A direct board_units/bench_units snapshot API exists.",
        "The X23B payload is decoded.",
      ],
    },
  };

  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    out,
    counts: analysis.counts,
    evidence_summary: analysis.evidence_summary,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
