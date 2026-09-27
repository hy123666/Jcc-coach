import { readFile, writeFile } from "node:fs/promises";
import { normalizeMumuHeroId } from "./jcc-mumu-hero-id.mjs";

function usage() {
  return [
    "Usage:",
    "  node tools/normalize-jcc-mumu-gi-message.mjs --cmd <number> --payload <json|string> [--match-session-id <id>] [--out <json>]",
    "",
    "Normalizes one MuMu gi_plugin_jkchess payload into our runtime event shape.",
    "Input payload can be a JSON string or a path to a file containing JSON.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--cmd") options.cmd = Number(argv[++index]);
    else if (arg === "--payload") options.payload = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readPayload(input) {
  assert(input, "Missing --payload");
  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  return JSON.parse(await readFile(input, "utf8"));
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function unitFromGiHero(entry, area) {
  const hero = normalizeMumuHeroId(entry?.i);
  return {
    ...hero,
    x: numberOrNull(entry?.x),
    y: numberOrNull(entry?.y),
    position: {
      source: "mumu_gi_xy",
      x: numberOrNull(entry?.x),
      y: numberOrNull(entry?.y),
      area,
    },
    area,
    confidence: 0.9,
    semantic_status: "mumu_structured_candidate",
    evidence_source: "gi_plugin_jkchess",
  };
}

function shopUnitFromGiBuy(entry, index) {
  const hero = normalizeMumuHeroId(entry?.i);
  return {
    slot_index: index,
    ...hero,
    rect: {
      left: numberOrNull(entry?.l),
      top: numberOrNull(entry?.t),
      right: numberOrNull(entry?.r),
      bottom: numberOrNull(entry?.b),
    },
    chosen_rects: Array.isArray(entry?.c)
      ? entry.c.map((rect) => ({
          left: numberOrNull(rect?.l),
          top: numberOrNull(rect?.t),
          right: numberOrNull(rect?.r),
          bottom: numberOrNull(rect?.b),
        }))
      : [],
    confidence: 0.9,
    semantic_status: "mumu_structured_candidate",
    evidence_source: "gi_plugin_jkchess",
  };
}

function equipFromGi(entry, index, area) {
  return {
    slot_index: index,
    item_id: numberOrNull(entry?.i),
    equip_id: numberOrNull(entry?.i),
    rect: {
      left: numberOrNull(entry?.l),
      top: numberOrNull(entry?.t),
      right: numberOrNull(entry?.r),
      bottom: numberOrNull(entry?.b),
    },
    area,
    confidence: 0.85,
    semantic_status: "mumu_structured_candidate",
    evidence_source: "gi_plugin_jkchess",
  };
}

function carouselUnitFromGi(entry, index) {
  const hero = normalizeMumuHeroId(entry?.i);
  return {
    slot_index: index,
    ...hero,
    item_id: numberOrNull(entry?.e),
    equip_id: numberOrNull(entry?.e),
    position: {
      source: "mumu_gi_xy",
      x: numberOrNull(entry?.x),
      y: numberOrNull(entry?.y),
      area: "carousel",
    },
    confidence: 0.85,
    semantic_status: "mumu_structured_candidate",
    evidence_source: "gi_plugin_jkchess",
  };
}

function normalize(cmd, payload, matchSessionId = null) {
  const base = {
    schema: "jcc-mumu-gi-runtime-event-v1",
    source: "mumu_nemuinit_gi_plugin_jkchess",
    command: cmd,
    command_hex: `0x${cmd.toString(16)}`,
    match_session_id: matchSessionId,
    received_at: new Date().toISOString(),
    raw_payload: payload,
    promotion_policy: "candidate_until_bridge_access_and_local_scope_proven",
  };

  if (cmd === 4096) {
    return {
      ...base,
      type: "match_start",
      match_patch: {
        status: "in_game",
        game_start_time: base.received_at,
      },
      promotion_policy: "match_session_boundary",
    };
  }
  if (cmd === 8192) {
    return {
      ...base,
      type: "match_end",
      match_patch: {
        status: "ended",
        game_end_time: base.received_at,
      },
      promotion_policy: "match_session_boundary",
    };
  }
  if (cmd === 4352) {
    return {
      ...base,
      type: "bench_units_candidate",
      bench_patch: {
        bench_units: Array.isArray(payload?.wl) ? payload.wl.map((entry) => unitFromGiHero(entry, "bench")) : [],
      },
    };
  }
  if (cmd === 4353) {
    return {
      ...base,
      type: "current_view_units_candidate",
      current_view_patch: {
        current_view_units: Array.isArray(payload?.hl) ? payload.hl.map((entry) => unitFromGiHero(entry, "current_view")) : [],
      },
      promotion_policy: "candidate_until_current_view_and_local_scope_proven",
    };
  }
  if (cmd === 4354) {
    return {
      ...base,
      type: "shop_units_candidate",
      shop_patch: {
        shop_units: Array.isArray(payload?.bl) ? payload.bl.map(shopUnitFromGiBuy) : [],
      },
    };
  }
  if (cmd === 4355) {
    return {
      ...base,
      type: "carousel_units_candidate",
      carousel_patch: {
        active: true,
        available_units: Array.isArray(payload?.hl) ? payload.hl.map(carouselUnitFromGi) : [],
      },
    };
  }
  if (cmd === 4356 || cmd === 4357) {
    const area = cmd === 4356 ? "board_or_current_equipment" : "inventory_equipment";
    return {
      ...base,
      type: cmd === 4356 ? "equipped_items_candidate" : "item_bench_candidate",
      items_patch: {
        [cmd === 4356 ? "equipped_items" : "item_bench"]: Array.isArray(payload?.el)
          ? payload.el.map((entry, index) => equipFromGi(entry, index, area))
          : [],
      },
      promotion_policy: "candidate_until_equipment_slot_semantics_proven",
    };
  }
  if (cmd === 4358) {
    return {
      ...base,
      type: "game_status_candidate",
      phase_patch: {
        mumu_status_code: numberOrNull(payload?.s),
        phase: "unknown",
      },
      promotion_policy: "candidate_until_status_enum_calibrated",
    };
  }

  return {
    ...base,
    type: "unknown_mumu_gi_command",
    promotion_policy: "debug_only_unknown_command",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  assert(Number.isInteger(options.cmd), "Missing or invalid --cmd");
  const payload = await readPayload(options.payload);
  const event = normalize(options.cmd, payload, options.matchSessionId || null);
  const json = `${JSON.stringify(event, null, 2)}\n`;
  if (options.out) await writeFile(options.out, json, "utf8");
  else process.stdout.write(json);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
