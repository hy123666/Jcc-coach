import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/analyze-jcc-mumu-live-command-coverage.mjs --bridge-map <json> --events <jsonl> [--out <json>]",
    "",
    "Compares statically known MuMu gi_plugin_jkchess commands with live observed logcat events.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--bridge-map") options.bridgeMap = argv[++index];
    else if (arg === "--events") options.events = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function payloadKeys(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload).sort();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  assert(options.bridgeMap, "Missing --bridge-map");
  assert(options.events, "Missing --events");
  const bridgeMap = JSON.parse(await readFile(options.bridgeMap, "utf8"));
  const events = parseJsonl(await readFile(options.events, "utf8"));
  const giEvents = events.filter((event) => event.type === "mumu_gi_message" || event.source === "adb_logcat_nemuinit_gi_plugin_jkchess");

  const byCommand = new Map();
  for (const event of giEvents) {
    const command = Number(event.command);
    if (!Number.isInteger(command)) continue;
    const bucket = byCommand.get(command) || {
      count: 0,
      first_observed_at: event.observed_at,
      last_observed_at: event.observed_at,
      sample_payload_keys: [],
      sample_payload: null,
    };
    bucket.count += 1;
    bucket.last_observed_at = event.observed_at || bucket.last_observed_at;
    if (!bucket.sample_payload) {
      bucket.sample_payload = event.payload || null;
      bucket.sample_payload_keys = payloadKeys(event.payload);
    }
    byCommand.set(command, bucket);
  }

  const commandRows = (bridgeMap.commands || [])
    .filter((command) => command.observed_in_dispatcher)
    .map((command) => {
      const live = byCommand.get(command.command);
      return {
        command: command.command,
        hex: command.hex,
        name: command.name,
        runtime_target: command.runtime_target,
        static_status: "observed_in_dispatcher",
        live_status: live ? "live_observed" : "not_observed_in_supplied_events",
        live_count: live?.count || 0,
        first_observed_at: live?.first_observed_at || null,
        last_observed_at: live?.last_observed_at || null,
        payload_root_key: command.payload_root_key || null,
        sample_payload_keys: live?.sample_payload_keys || [],
        sample_payload: live?.sample_payload || null,
        promotion: command.promotion,
      };
    });

  const unknownLiveCommands = [...byCommand.keys()]
    .filter((command) => !commandRows.some((row) => row.command === command))
    .sort((a, b) => a - b)
    .map((command) => ({ command, ...byCommand.get(command) }));

  const result = {
    schema: "jcc-mumu-live-command-coverage-v1",
    generated_at: new Date().toISOString(),
    source: {
      bridge_map: options.bridgeMap,
      events: options.events,
    },
    summary: {
      static_dispatcher_command_count: commandRows.length,
      live_observed_command_count: commandRows.filter((row) => row.live_status === "live_observed").length,
      unknown_live_command_count: unknownLiveCommands.length,
    },
    commands: commandRows,
    unknown_live_commands: unknownLiveCommands,
    interpretation: {
      verified_now: commandRows.filter((row) => row.live_status === "live_observed").map((row) => row.command),
      still_needs_scenario: commandRows
        .filter((row) => row.live_status !== "live_observed")
        .filter((row) => ![1, 2, 3].includes(row.command))
        .map((row) => row.command),
      note: "Commands absent from supplied events are not disproven; they need the matching live scenario, such as carousel, item/equipment changes, match start/end, or lineup config refresh.",
    },
  };

  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
