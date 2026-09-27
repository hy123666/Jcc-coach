#!/usr/bin/env node
import { pruneLiveRankingHistory, DEFAULT_HISTORY_KEEP_DATES } from "./jcc_live_rankings_history.mjs";

function parseArgs(argv) {
  const args = { keepDates: DEFAULT_HISTORY_KEEP_DATES, rootDir: undefined, signalsDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") args.keepDates = argv[++index];
    else if (arg === "--root") args.rootDir = argv[++index];
    else if (arg === "--signals-dir") args.signalsDir = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node tools/prune-jcc-live-ranking-history.mjs [--keep 14] [--root data/live-rankings/jcc]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

try {
  const result = await pruneLiveRankingHistory(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
