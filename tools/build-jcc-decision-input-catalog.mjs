import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileGameKnowledge } from "./jcc_game_knowledge_compiler.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = { seasonId: null, patchId: null, out: null, write: false };
  const explicit = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--write") options.write = true;
    else if (arg === "--no-write") options.write = false;
    else if (arg === "--season") { options.seasonId = argv[++index]; explicit.add("season"); }
    else if (arg === "--patch") { options.patchId = argv[++index]; explicit.add("patch"); }
    else if (arg === "--candidate-manifest" || arg === "--candidate-profile") { options.candidateProfilePath = path.resolve(argv[++index]); explicit.add("candidate-manifest"); }
    else if (arg === "--expected-core-profile-id") { options.expectedCoreProfileId = argv[++index]; explicit.add("expected-core-profile-id"); }
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const required = options.write
    ? ["candidate-manifest", "expected-core-profile-id", "season", "patch"]
    : ["season", "patch"];
  const missing = required.filter((field) => !explicit.has(field));
  if (missing.length > 0) throw new Error(`${options.write ? "Production catalog writes" : "Catalog reads"} require explicit ${missing.join(", ")}`);
  if (options.out && !options.write) throw new Error("--out requires an explicit --write build");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-decision-input-catalog.mjs --no-write --season <sN> --patch <sN_N>",
    "  node tools/build-jcc-decision-input-catalog.mjs --write --candidate-manifest <candidate.json> --expected-core-profile-id <sha256> --season <sN> --patch <sN_N> [--out <compatibility-copy.json>]",
    "",
    "Compiles the candidate Core Profile, including its immutable decision-input catalog and augment-stage authority.",
    "The command never promotes the candidate. --out is an explicit compatibility export only.",
  ].join("\n");
}

async function writeCompatibilityCopy(sourceFile, outFile) {
  const resolved = path.resolve(repoRoot, outFile);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, await readFile(sourceFile));
    await rename(temp, resolved);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return resolved;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
} else {
  const result = await compileGameKnowledge({
    repoRoot,
    seasonId: options.seasonId,
    patchId: options.patchId,
    candidateProfilePath: options.candidateProfilePath,
    expectedCoreProfileId: options.expectedCoreProfileId,
    write: options.write,
  });
  const compatibilityCopy = options.out
    ? await writeCompatibilityCopy(result.decisionInputCatalogFile, options.out)
    : null;
  console.log(JSON.stringify({
    ok: true,
    core_profile_id: result.combinedFingerprint,
    candidate_profile: result.candidateProfilePath,
    decision_input_catalog: result.decisionInputCatalogFile,
    augment_stage_authority: result.augmentStageAuthorityFile,
    compatibility_copy: compatibilityCopy,
    promoted: false,
    write_status: result.writeStatus,
    counts: result.decisionInputCatalog.counts,
  }, null, 2));
}
