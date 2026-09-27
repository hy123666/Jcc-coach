import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const userCodexHome = path.resolve(process.env.JCC_SOURCE_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const userSkillsDir = path.join(userCodexHome, "skills");
const runtimeCodexHome = path.resolve(process.env.JCC_CODEX_RUNTIME_HOME || path.join(repoRoot, ".jcc-runtime-data", "host-cli", "codex-home"));
const runtimeSkillsDir = path.join(runtimeCodexHome, "skills");
const userOrWorkflowSkillNames = new Set([
  "awesome-design-md",
  "ui-ux-pro-max-skill",
  "design-taste-frontend",
  "impeccable",
  "ralph",
  "ralplan",
  "ultrawork",
  "team",
]);

function hasUtf8Bom(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function skillNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readSkillFiles(dir) {
  return skillNames(dir)
    .map((name) => path.join(dir, name, "SKILL.md"))
    .filter((file) => existsSync(file));
}

const userSkillFiles = readSkillFiles(userSkillsDir);
const badUserSkills = [];
for (const file of userSkillFiles) {
  const bytes = readFileSync(file);
  if (hasUtf8Bom(bytes)) badUserSkills.push({ file, reason: "utf8_bom_before_frontmatter" });
  const text = bytes.toString("utf8");
  if (!text.startsWith("---")) badUserSkills.push({ file, reason: "missing_frontmatter_at_byte_0" });
}

assert.deepEqual(
  badUserSkills,
  [],
  `User Codex skills can break non-isolated host CLI startup and should be repaired separately: ${JSON.stringify(badUserSkills, null, 2)}`,
);

const runtimeSkillNames = skillNames(runtimeSkillsDir);
const leakedRuntimeSkills = runtimeSkillNames.filter((name) => userOrWorkflowSkillNames.has(name));
assert.deepEqual(
  leakedRuntimeSkills,
  [],
  `JCC clean CODEX_HOME must not contain user/global workflow skills: ${leakedRuntimeSkills.join(", ")}`,
);
assert(
  runtimeSkillNames.every((name) => name === ".system"),
  `JCC clean CODEX_HOME should only contain Codex-managed .system skills, found: ${runtimeSkillNames.join(", ")}`,
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-host-cli-global-skill-hygiene-v2",
  user_codex_home: userCodexHome,
  user_skill_files_checked: userSkillFiles.length,
  runtime_clean_home: runtimeCodexHome,
  runtime_skill_names: runtimeSkillNames,
}, null, 2)}\n`);
