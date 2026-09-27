import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const registryPath = "docs/requirements/requirements-registry.json";
const modeContractPath = "data/runtime/jcc/runtime-ui-mode-contract.json";
const sensingContractPath = "data/runtime/jcc/runtime-mode-sensing-map.json";
const hostSignatureContractPath = "data/runtime/jcc/host-coach-signature-contract.json";
const hostContextLifecycleContractPath = "data/runtime/jcc/host-context-lifecycle-contract.json";
const hostInstructionContractPath = "data/runtime/jcc/host-coach-instruction-contract.json";
const seasonModuleContractPath = "data/runtime/jcc/runtime-season-module-contract.json";
const liveRankingContractPath = "data/live-rankings/jcc/runtime-strategy-signal-contract.json";
const seasonGovernanceRunbookPath = "docs/requirements/jcc-season-version-governance-runbook.md";
const productGatePath = "tools/verify-jcc-runtime-product-gate.mjs";
const MARKDOWN_SCAN_ROOTS = [
  ".codex/skills",
  "android-companion",
  "data/core-patches",
  "data/runtime/jcc/calibration-samples",
  "data/runtime/jcc/runtime-agent-wiki",
  "docs",
  "ui",
];
const MARKDOWN_SCAN_SKIP_DIRS = new Set([".git", ".gradle", ".jcc-runtime-data", ".omx", "build", "dist", "node_modules"]);

const REQUIRED_FIELDS = [
  "path",
  "doc_type",
  "status",
  "authority_tier",
  "contract_version",
  "last_reviewed",
  "owner",
];

const ALLOWED_TYPES = new Set(["registry", "current_requirement", "current_contract", "historical_spec", "paused_track", "generated_snapshot", "runbook", "design"]);
const ALLOWED_STATUS = new Set(["current", "historical", "paused", "generated"]);
const ALLOWED_TIERS = new Set(["source_of_truth", "authoritative", "supporting", "historical", "generated_reference"]);
const REQUIRED_AUTHORITY_DOMAIN_FIELDS = [
  "id",
  "authoritative_paths",
  "guidance_paths",
  "entrypoint_paths",
  "implementation_paths",
  "verifier_paths",
  "change_policy",
];

const REQUIRED_AUTHORITY_DOMAINS = {
  requirements_governance: {
    authoritative_paths: [registryPath],
    entrypoint_paths: ["AGENTS.md", ".codex/skills/jcc-runtime-agent/SKILL.md"],
    verifier_paths: ["tools/verify-jcc-requirements-authority.mjs", productGatePath],
  },
  host_coach_instructions: {
    authoritative_paths: [hostInstructionContractPath],
    implementation_paths: ["tools/jcc_host_coach_instruction_contract.mjs"],
    verifier_paths: ["tools/verify-jcc-host-coach-instruction-contract.mjs", "tools/verify-jcc-host-request-stage-snapshots.mjs", productGatePath],
  },
  season_versioning_and_active_rules: {
    authoritative_paths: [seasonModuleContractPath],
    guidance_paths: [seasonGovernanceRunbookPath],
    implementation_paths: ["tools/jcc_active_rules_contract.mjs", "tools/jcc_hard_data_target.mjs"],
    verifier_paths: ["tools/verify-jcc-active-rules-context.mjs", "tools/verify-jcc-season-version-isolation.mjs", "tools/verify-jcc-hard-data.mjs", productGatePath],
  },
  runtime_sensing_and_source_priority: {
    authoritative_paths: [sensingContractPath],
    implementation_paths: ["tools/capture-jcc-visual-frame.mjs", "tools/jcc-rapidocr-resident-worker.mjs", "tools/watch-jcc-mumu-runtime-logcat.mjs", "ui/electron/runtime-service.js"],
    verifier_paths: ["tools/verify-jcc-self-state-roi-capture-source-contract.mjs", "tools/verify-jcc-mumu-watch-item-source-diagnostics.mjs", "tools/verify-jcc-rapidocr-resident-worker-lifecycle.mjs", "tools/verify-jcc-runtime-sensing-artifact-retention.mjs", productGatePath],
  },
  response_task_and_host_delivery: {
    authoritative_paths: [hostSignatureContractPath],
    implementation_paths: ["ui/electron/host-adapters.js", "ui/electron/runtime-daemon.js", "ui/electron/runtime-service.js", "ui/src/runtimeBridge.ts"],
    verifier_paths: ["tools/verify-jcc-single-writer-canonical-state-contract.mjs", "tools/verify-jcc-response-task-delivery-contract.mjs", "tools/verify-jcc-renderer-event-delivery.mjs", productGatePath],
  },
  host_context_session_lifecycle: {
    authoritative_paths: [hostContextLifecycleContractPath],
    implementation_paths: ["ui/electron/host-adapters.js", "ui/electron/runtime-service.js"],
    verifier_paths: ["tools/verify-jcc-host-session-lifecycle-contract.mjs", "tools/verify-jcc-host-session-live-smoke.mjs", "tools/verify-jcc-runtime-mode-host-request-benchmark.mjs", "tools/verify-jcc-common-host-knowledge.mjs", "tools/verify-jcc-match-core-profile-binding.mjs", productGatePath],
  },
  live_rankings_resilience: {
    authoritative_paths: [seasonModuleContractPath, liveRankingContractPath],
    implementation_paths: [
      "tools/sync-jcc-live-rankings.mjs",
      "tools/jcc_live_rankings_promotion.mjs",
      "tools/jcc_canonical_lineup_identity.mjs",
      "tools/jcc_atomic_variant_comparator.mjs",
      "tools/jcc_mature_recipe_variant_packet.mjs",
      "tools/jcc_ranking_recipe_freshness.mjs",
      "tools/jcc_ranking_maintenance_preparation.mjs",
      "ui/electron/runtime-service.js",
    ],
    verifier_paths: [
      "tools/verify-jcc-live-rankings-sync-contract.mjs",
      "tools/verify-jcc-live-rankings-promotion.mjs",
      "tools/verify-jcc-rankings-status-runtime-contract.mjs",
      "tools/verify-jcc-live-rankings-history.mjs",
      "tools/verify-jcc-live-ranking-strategy-index.mjs",
      "tools/verify-jcc-live-ranking-strategy-runtime.mjs",
      "tools/verify-jcc-canonical-lineup-identity.mjs",
      "tools/verify-jcc-mature-recipe-variant-packet.mjs",
      "tools/verify-jcc-ranking-recipe-freshness.mjs",
      "tools/verify-jcc-ranking-maintenance-preparation.mjs",
      productGatePath,
    ],
  },
  proactive_cruise_decisioning: {
    authoritative_paths: [
      "data/runtime/jcc/runtime-ui-mode-contract.json",
      "data/runtime/jcc/cruise-strategy-semantics-contract.json",
      "data/runtime/jcc/cruise-strategy-scorer-contract.json",
      "data/runtime/jcc/common-choice-runtime-contract.json",
      "data/runtime/jcc/knowledge-profile-contract.json",
      "data/game-knowledge/jcc/common/complete-game-doctrine.json",
    ],
    implementation_paths: ["tools/run-jcc-cruise-runtime-pipeline.mjs", "ui/electron/runtime-service.js"],
    verifier_paths: ["tools/verify-jcc-cruise-profile-binding.mjs", productGatePath],
  },
};

const REQUIRED_REGISTRY_PATHS = [
  registryPath,
  "docs/requirements/README.md",
  "docs/requirements/CHANGELOG.md",
  "AGENTS.md",
  ".codex/skills/jcc-runtime-agent/SKILL.md",
  "ui/PRODUCT.md",
  "ui/IA.md",
  "ui/OPEN_DESIGN.md",
  "ui/README.md",
  "docs/runtime-ocr-inventory.md",
  "docs/runtime-ocr-redesign.md",
  "docs/repo-file-classification.md",
  "data/runtime/jcc/runtime-agent-wiki/README.md",
  "data/runtime/jcc/runtime-agent-wiki/official/quickstart.md",
  "docs/jcc-runtime-live-state-source-decision.md",
  "docs/jcc-runtime-companion-mvp.md",
  "android-companion/README.md",
  "docs/superpowers/specs/2026-06-07-jcc-mumu-runtime-model.md",
  "docs/superpowers/plans/2026-06-09-jcc-runtime-ui-modes-and-lineup-code.md",
  "docs/jcc-runtime-product-readiness.md",
  "docs/jcc-runtime-agent-skill-and-session-design.md",
  "ui/DESIGN.md",
  "data/runtime/jcc/runtime-agent-wiki/official/mumu-desktop-runtime.md",
  "data/runtime/jcc/runtime-agent-wiki/official/host-multimodal-visual-sensing-runbook.md",
  modeContractPath,
  sensingContractPath,
  hostSignatureContractPath,
  hostInstructionContractPath,
  seasonModuleContractPath,
  seasonGovernanceRunbookPath,
];

const EXPECTED_CLASSIFICATIONS = {
  "AGENTS.md": { status: "current", authority_tier: "authoritative" },
  ".codex/skills/jcc-runtime-agent/SKILL.md": { status: "current", authority_tier: "authoritative" },
  "ui/PRODUCT.md": { status: "current", authority_tier: "authoritative" },
  "ui/IA.md": { status: "current", authority_tier: "authoritative" },
  "docs/runtime-ocr-inventory.md": { status: "current", authority_tier: "authoritative" },
  "docs/jcc-runtime-live-state-source-decision.md": { status: "current", authority_tier: "authoritative" },
  "data/runtime/jcc/runtime-agent-wiki/official/mumu-desktop-runtime.md": { status: "current", authority_tier: "authoritative" },
  "data/runtime/jcc/runtime-agent-wiki/official/host-multimodal-visual-sensing-runbook.md": { status: "current", authority_tier: "authoritative" },
  "docs/jcc-runtime-companion-mvp.md": { status: "paused", authority_tier: "historical" },
  "android-companion/README.md": { status: "paused", authority_tier: "historical" },
  "docs/superpowers/specs/2026-06-07-jcc-mumu-runtime-model.md": { status: "historical", authority_tier: "historical" },
  "docs/superpowers/plans/2026-06-09-jcc-runtime-ui-modes-and-lineup-code.md": { status: "historical", authority_tier: "historical" },
  [modeContractPath]: { status: "current", authority_tier: "source_of_truth" },
  [sensingContractPath]: { status: "current", authority_tier: "source_of_truth" },
  [hostSignatureContractPath]: { status: "current", authority_tier: "source_of_truth" },
  [hostInstructionContractPath]: { status: "current", authority_tier: "source_of_truth" },
  [seasonModuleContractPath]: { status: "current", authority_tier: "source_of_truth" },
  [seasonGovernanceRunbookPath]: { status: "current", authority_tier: "authoritative" },
};

const HISTORICAL_OR_PAUSED_BANNERS = {
  "docs/jcc-runtime-companion-mvp.md": ["REQUIREMENTS-STATUS: paused"],
  "android-companion/README.md": ["REQUIREMENTS-STATUS: paused"],
  "docs/superpowers/specs/2026-06-07-jcc-mumu-runtime-model.md": ["REQUIREMENTS-STATUS: historical"],
  "docs/superpowers/plans/2026-06-09-jcc-runtime-ui-modes-and-lineup-code.md": ["REQUIREMENTS-STATUS: historical"],
};

const POSITIVE_OPPONENT_REQUIREMENT_PATTERNS = [
  /\bmust\s+(?:scan|capture|record|populate|write)\s+opponent/i,
  /\brequire(?:s|d)?\s+opponent\s+(?:scan|board|power|positioning)/i,
  /\bopponent\s+(?:scan|board|power|positioning)\s+(?:is|are)\s+(?:required|product|mainline|primary|supported)/i,
  /current\s+product\s+.*opponent\s+(?:scan|board|power|positioning)/i,
  /对手(?:棋盘|战力|站位|扫描).*(?:必须|需要|主路径|产品路径|发布门禁)/,
];

function normalizeSlash(value) {
  return String(value || "").replace(/\\/g, "/");
}

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

function findEntry(entries, relativePath) {
  return entries.find((entry) => normalizeSlash(entry.path) === relativePath);
}

function inheritedEntry(entries, relativePath) {
  return entries.find((entry) => {
    if (entry.covers_subtree !== true || !entry.scope_root) return false;
    const scopeRoot = normalizeSlash(entry.scope_root).replace(/\/$/, "");
    return relativePath === scopeRoot || relativePath.startsWith(`${scopeRoot}/`);
  });
}

async function collectMarkdownFiles(relativeRoot) {
  if (!(await exists(relativeRoot))) return [];
  const absoluteRoot = path.join(root, relativeRoot);
  const output = [];
  async function walk(absoluteDir) {
    for (const entry of await readdir(absoluteDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!MARKDOWN_SCAN_SKIP_DIRS.has(entry.name)) await walk(path.join(absoluteDir, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      output.push(normalizeSlash(path.relative(root, path.join(absoluteDir, entry.name))));
    }
  }
  await walk(absoluteRoot);
  return output;
}

function assertIncludes(text, needle, file) {
  assert(text.includes(needle), `${file} must include ${needle}`);
}

function assertNotMatches(text, patterns, file) {
  for (const pattern of patterns) {
    assert(!pattern.test(text), `${file} must not positively require removed opponent scan/board/power/positioning path: ${pattern}`);
  }
}

function flattenStrings(value, prefix = "") {
  const rows = [];
  if (typeof value === "string") rows.push({ path: prefix, value });
  else if (Array.isArray(value)) {
    value.forEach((item, index) => rows.push(...flattenStrings(item, `${prefix}[${index}]`)));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) rows.push(...flattenStrings(child, prefix ? `${prefix}.${key}` : key));
  }
  return rows;
}

async function main() {
  assert(await exists(registryPath), `${registryPath} must exist`);
  const registry = JSON.parse(await read(registryPath));
  assert.equal(registry.schema, "jcc-requirements-authority-registry-v2", "registry schema mismatch");
  assert(Array.isArray(registry.documents), "registry.documents must be an array");
  assert(Array.isArray(registry.authority_domains), "registry.authority_domains must be an array");

  const seen = new Set();
  for (const entry of registry.documents) {
    for (const field of REQUIRED_FIELDS) {
      assert(Object.hasOwn(entry, field), `registry entry ${entry.path || "<missing path>"} missing ${field}`);
    }
    const entryPath = normalizeSlash(entry.path);
    assert(!path.isAbsolute(entryPath), `registry path must be repo-relative: ${entryPath}`);
    assert(!entryPath.includes(".."), `registry path must not escape repo: ${entryPath}`);
    assert(!seen.has(entryPath), `duplicate registry entry: ${entryPath}`);
    seen.add(entryPath);
    assert(await exists(entryPath), `registry path does not exist: ${entryPath}`);
    assert(ALLOWED_TYPES.has(entry.doc_type), `${entryPath} has invalid doc_type ${entry.doc_type}`);
    assert(ALLOWED_STATUS.has(entry.status), `${entryPath} has invalid status ${entry.status}`);
    assert(ALLOWED_TIERS.has(entry.authority_tier), `${entryPath} has invalid authority_tier ${entry.authority_tier}`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.last_reviewed), `${entryPath} last_reviewed must be YYYY-MM-DD`);
    if (entry.status === "historical") assert(entry.superseded_by || entry.notes, `${entryPath} historical docs need superseded_by or notes`);
    if (entry.status === "paused") assert(entry.notes, `${entryPath} paused docs need notes`);
    if (entry.status === "generated") assert(entry.notes, `${entryPath} generated docs need notes`);
    if (entry.covers_subtree === true) {
      assert(entry.scope_root, `${entryPath} covers_subtree entries need scope_root`);
      assert.notEqual(entry.status, "current", `${entryPath} current requirements cannot inherit broad subtree authority`);
      const scopeRoot = normalizeSlash(entry.scope_root).replace(/\/$/, "");
      assert(entryPath === `${scopeRoot}/README.md` || entryPath === scopeRoot, `${entryPath} must be the scope root or its README`);
    }
  }

  const authorityDomains = new Map();
  for (const domain of registry.authority_domains) {
    for (const field of REQUIRED_AUTHORITY_DOMAIN_FIELDS) {
      assert(Object.hasOwn(domain, field), `authority domain ${domain.id || "<missing id>"} missing ${field}`);
    }
    assert.equal(typeof domain.id, "string", "authority domain id must be a string");
    assert(domain.id.trim(), "authority domain id must not be empty");
    assert(!authorityDomains.has(domain.id), `duplicate authority domain: ${domain.id}`);
    authorityDomains.set(domain.id, domain);
    assert.equal(typeof domain.change_policy, "string", `${domain.id}.change_policy must be a string`);
    assert(domain.change_policy.trim(), `${domain.id}.change_policy must not be empty`);

    for (const field of ["authoritative_paths", "guidance_paths", "entrypoint_paths", "implementation_paths", "verifier_paths"]) {
      assert(Array.isArray(domain[field]), `${domain.id}.${field} must be an array`);
      assert.equal(new Set(domain[field]).size, domain[field].length, `${domain.id}.${field} must not contain duplicates`);
      for (const referencedPath of domain[field]) {
        assert.equal(normalizeSlash(referencedPath), referencedPath, `${domain.id}.${field} paths must use forward slashes: ${referencedPath}`);
        assert(await exists(referencedPath), `${domain.id}.${field} path does not exist: ${referencedPath}`);
      }
    }
    assert(domain.authoritative_paths.length > 0, `${domain.id} must declare at least one authoritative path`);
    for (const authoritativePath of domain.authoritative_paths) {
      const entry = findEntry(registry.documents, authoritativePath);
      assert(entry, `${domain.id} authoritative path must be registered: ${authoritativePath}`);
      assert.equal(entry.status, "current", `${domain.id} authoritative path must be current: ${authoritativePath}`);
      assert.equal(entry.authority_tier, "source_of_truth", `${domain.id} authoritative path must be source_of_truth: ${authoritativePath}`);
    }
    for (const guidancePath of [...domain.guidance_paths, ...domain.entrypoint_paths]) {
      const entry = findEntry(registry.documents, guidancePath);
      assert(entry, `${domain.id} guidance/entrypoint path must be registered: ${guidancePath}`);
      assert.equal(entry.status, "current", `${domain.id} guidance/entrypoint path must be current: ${guidancePath}`);
    }
    for (const entrypointPath of domain.entrypoint_paths) {
      const entry = findEntry(registry.documents, entrypointPath);
      assert.equal(entry.entrypoint_only, true, `${domain.id} entrypoint must declare entrypoint_only=true: ${entrypointPath}`);
      assert.notEqual(entry.authority_tier, "source_of_truth", `${domain.id} entrypoint cannot masquerade as behavior source_of_truth: ${entrypointPath}`);
    }
  }

  for (const [domainId, required] of Object.entries(REQUIRED_AUTHORITY_DOMAINS)) {
    const domain = authorityDomains.get(domainId);
    assert(domain, `registry missing required authority domain ${domainId}`);
    for (const [field, expectedPaths] of Object.entries(required)) {
      for (const expectedPath of expectedPaths) {
        assert(domain[field].includes(expectedPath), `${domainId}.${field} missing ${expectedPath}`);
      }
    }
  }

  const productGateText = await read(productGatePath);
  for (const domain of authorityDomains.values()) {
    for (const verifierPath of domain.verifier_paths) {
      if (verifierPath === productGatePath) continue;
      assertIncludes(productGateText, verifierPath, `${productGatePath} (${domain.id})`);
    }
  }

  const markdownFiles = new Set(["AGENTS.md"]);
  for (const scanRoot of MARKDOWN_SCAN_ROOTS) {
    for (const file of await collectMarkdownFiles(scanRoot)) markdownFiles.add(file);
  }
  const unclassifiedMarkdown = [];
  for (const file of [...markdownFiles].sort()) {
    const exact = findEntry(registry.documents, file);
    const inherited = exact ? null : inheritedEntry(registry.documents, file);
    if (!exact && !inherited) unclassifiedMarkdown.push(file);
  }
  assert.deepEqual(unclassifiedMarkdown, [], `unclassified Markdown requirement surfaces: ${unclassifiedMarkdown.join(", ")}`);

  for (const requiredPath of REQUIRED_REGISTRY_PATHS) {
    assert(findEntry(registry.documents, requiredPath), `registry missing ${requiredPath}`);
  }

  for (const [file, expected] of Object.entries(EXPECTED_CLASSIFICATIONS)) {
    const entry = findEntry(registry.documents, file);
    assert.equal(entry.status, expected.status, `${file} status must be ${expected.status}`);
    assert.equal(entry.authority_tier, expected.authority_tier, `${file} authority_tier must be ${expected.authority_tier}`);
  }

  for (const [file, needles] of Object.entries(HISTORICAL_OR_PAUSED_BANNERS)) {
    const text = await read(file);
    for (const needle of needles) assertIncludes(text, needle, file);
  }

  const authorityReadme = await read("docs/requirements/README.md");
  for (const needle of ["Requirement change workflow", "CHANGELOG.md"]) {
    assertIncludes(authorityReadme, needle, "docs/requirements/README.md");
  }
  assert(/same\s+change/i.test(authorityReadme), "docs/requirements/README.md must require authority and implementation updates in the same change");
  assert(/not\s+a\s+current\s+requirement\s+until\s+it\s+has\s+a\s+registry\s+entry/i.test(authorityReadme), "docs/requirements/README.md must require a registry entry before a document becomes current authority");
  const decisionLog = await read("docs/requirements/CHANGELOG.md");
  assertIncludes(decisionLog, "append-only decision ledger", "docs/requirements/CHANGELOG.md");
  const engineeringEntrypoint = ".codex/skills/jcc-runtime-agent/SKILL.md";
  const engineeringEntrypointText = await read(engineeringEntrypoint);
  assertIncludes(engineeringEntrypointText, registryPath, engineeringEntrypoint);
  assertIncludes(engineeringEntrypointText, "authority_domains", engineeringEntrypoint);
  assertIncludes(engineeringEntrypointText, "historical", engineeringEntrypoint);
  assertIncludes(engineeringEntrypointText, "paused", engineeringEntrypoint);
  assertIncludes(engineeringEntrypointText, "generated", engineeringEntrypoint);
  assert(/not (?:a )?fallback product authorit/i.test(engineeringEntrypointText), `${engineeringEntrypoint} must say it is not fallback product authority`);

  const hostEntrypoint = "AGENTS.md";
  const hostEntrypointText = await read(hostEntrypoint);
  for (const needle of [
    "thin host model",
    "Do not inspect the full repository unless explicitly asked for code work",
    "Answer only from the INPUT_JSON selected context",
    "Do not load or rely on user-global Codex skills",
    "Return the exact JSON shape requested by the prompt",
  ]) {
    assertIncludes(hostEntrypointText, needle, hostEntrypoint);
  }
  assert(!hostEntrypointText.includes(registryPath), `${hostEntrypoint} must not inject engineering requirement governance into the production Host context`);

  const currentTextPaths = registry.documents
    .filter((entry) => entry.status === "current" && /\.(?:md|json)$/i.test(entry.path))
    .map((entry) => normalizeSlash(entry.path));
  for (const file of currentTextPaths) {
    const text = await read(file);
    assertNotMatches(text, POSITIVE_OPPONENT_REQUIREMENT_PATTERNS, file);
  }

  const liveStateDecision = await read("docs/jcc-runtime-live-state-source-decision.md");
  assertIncludes(liveStateDecision, ".jcc-runtime-data/app.sqlite", "docs/jcc-runtime-live-state-source-decision.md");
  assertIncludes(liveStateDecision, "legacy JSON", "docs/jcc-runtime-live-state-source-decision.md");
  assertIncludes(liveStateDecision, "RapidOCR", "docs/jcc-runtime-live-state-source-decision.md");
  assertIncludes(liveStateDecision, "host CLI multimodal", "docs/jcc-runtime-live-state-source-decision.md");
  assertIncludes(liveStateDecision, "4357", "docs/jcc-runtime-live-state-source-decision.md");
  assertIncludes(liveStateDecision, "4356", "docs/jcc-runtime-live-state-source-decision.md");
  assertIncludes(liveStateDecision, "fresh non-empty `4354`", "docs/jcc-runtime-live-state-source-decision.md");
  assertIncludes(liveStateDecision, "S=1", "docs/jcc-runtime-live-state-source-decision.md");
  assert(!liveStateDecision.includes("Companion semantic tier, practical for JCC"), "current live-state authority must not reactivate the paused Android companion track");

  const mumuRuntimeDoc = await read("data/runtime/jcc/runtime-agent-wiki/official/mumu-desktop-runtime.md");
  assert(!mumuRuntimeDoc.includes("Reliable equipment inventory/equipped item semantics through GI; use visual icon candidates."), "current MuMu authority must not retain visual-first equipment guidance");
  assertIncludes(mumuRuntimeDoc, "`4357` is the primary left item rail", "data/runtime/jcc/runtime-agent-wiki/official/mumu-desktop-runtime.md");

  const companionReadme = await read("android-companion/README.md");
  assertIncludes(companionReadme, "must not be used as a MuMu desktop release gate", "android-companion/README.md");

  const modeContract = JSON.parse(await read(modeContractPath));
  assert.equal(modeContract.schema, "jcc-runtime-ui-mode-contract-v1", "mode contract schema mismatch");
  assert(modeContract.modes?.lineup_card, "mode contract must define lineup_card");
  assert(!modeContract.modes?.opponent_power, "mode contract must not define opponent_power");
  assert(!modeContract.modes?.opponent_positioning, "mode contract must not define opponent_positioning");

  const productGate = await read(productGatePath);
  for (const gateId of [
    "self_state_roi_capture_source",
    "mumu_runtime_autodiscovery",
    "rapidocr_resident_worker_lifecycle",
    "runtime_sensing_artifact_retention",
    "response_task_delivery",
    "coach_response_delivery_dedup",
    "live_rankings_atomic_promotion",
  ]) {
    assertIncludes(productGate, `id: "${gateId}"`, productGatePath);
  }

  const docsToCheckForModeAuthority = [
    "docs/superpowers/plans/2026-06-09-jcc-runtime-ui-modes-and-lineup-code.md",
    "ui/DESIGN.md",
    "docs/jcc-runtime-product-readiness.md",
  ];
  for (const file of docsToCheckForModeAuthority) {
    assertIncludes(await read(file), modeContractPath, file);
  }

  const allCurrentText = (await Promise.all(currentTextPaths.map((file) => read(file)))).join("\n");
  for (const requiredPhrase of [
    "daemon",
    "SQLite",
    "RapidOCR",
    "4357",
    "4356",
    "lineup_card",
  ]) {
    assertIncludes(allCurrentText, requiredPhrase, `current docs aggregate`);
  }

  const registryStrings = flattenStrings(registry);
  const legacyJsonEntry = registryStrings.find((row) => /legacy JSON/i.test(row.value) && /mirror|debug/i.test(row.value));
  assert(legacyJsonEntry, "registry must record that legacy JSON is mirror/debug only");

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-requirements-authority-verifier-v2",
    checked: {
      registry_path: registryPath,
      registry_entries: registry.documents.length,
      authority_domains: authorityDomains.size,
      markdown_surfaces_classified: markdownFiles.size,
      required_paths: REQUIRED_REGISTRY_PATHS.length,
      current_text_surfaces_scanned_for_removed_opponent_requirements: currentTextPaths.length,
      historical_paused_generated_banners: Object.keys(HISTORICAL_OR_PAUSED_BANNERS).length,
      mode_contract_source: modeContractPath,
    },
    authority_claim: "requirements-registry v2 classifies requirement surfaces and maps critical governance domains to their machine authorities, implementations, and core-gated verifiers; the repo-local skill is the engineering authoring entrypoint while AGENTS is the isolated production Host contract.",
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    schema: "jcc-requirements-authority-verifier-v2",
    error: error?.message || String(error),
  }, null, 2));
  process.exit(1);
});
