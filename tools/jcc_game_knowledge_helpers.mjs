import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export function assertGameKnowledge(condition, message) {
  if (!condition) throw new Error(`JCC game knowledge: ${message}`);
}

export function stableJson(value, space = 2) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input)
          .sort((left, right) => left.localeCompare(right))
          .map((key) => [key, normalize(input[key])]),
      );
    }
    return input;
  };
  return `${JSON.stringify(normalize(value), null, space)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isContained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveContainedPath(root, candidatePath, label) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(candidatePath);
  assertGameKnowledge(isContained(absoluteRoot, absoluteTarget), `${label} escapes its allowed root: ${candidatePath}`);
  return absoluteTarget;
}

export async function resolveContainedExistingPath(root, relativePath, label) {
  assertGameKnowledge(typeof relativePath === "string" && relativePath.length > 0, `${label} path must be a non-empty string`);
  assertGameKnowledge(!path.isAbsolute(relativePath), `${label} path must be relative: ${relativePath}`);
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(lexicalRoot, relativePath);
  assertGameKnowledge(isContained(lexicalRoot, lexicalTarget), `${label} escapes its allowed root: ${relativePath}`);

  let targetStat;
  try {
    targetStat = await lstat(lexicalTarget);
  } catch (error) {
    throw new Error(`JCC game knowledge: ${label} does not exist: ${relativePath}`, { cause: error });
  }
  assertGameKnowledge(targetStat.isFile(), `${label} must resolve to a file: ${relativePath}`);

  const [physicalRoot, physicalTarget] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
  assertGameKnowledge(isContained(physicalRoot, physicalTarget), `${label} resolves outside its allowed root: ${relativePath}`);
  return lexicalTarget;
}

export async function readJsonArtifact(root, relativePath, label) {
  const absolutePath = await resolveContainedExistingPath(root, relativePath, label);
  const bytes = await readFile(absolutePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`JCC game knowledge: ${label} is not valid JSON: ${relativePath}`, { cause: error });
  }
  return {
    absolutePath,
    relativePath: relativePath.replaceAll("\\", "/"),
    value,
    byte_size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    assertGameKnowledge(typeof value === "string" && value.length > 0, `${label} contains an empty identifier`);
    assertGameKnowledge(!seen.has(value), `${label} collision: ${value}`);
    seen.add(value);
  }
}

export function collectNamedIdentifiers(value, output = [], pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectNamedIdentifiers(item, output, [...pathParts, String(index)]));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    if (["id", "logical_id", "mechanic_id"].includes(key) && typeof child === "string") {
      output.push({ path: childPath.join("."), value: child });
    }
    collectNamedIdentifiers(child, output, childPath);
  }
  return output;
}

export function assertNoForeignLocalSeasonIdentifiers(documents, expectedSeasonId) {
  assertGameKnowledge(/^s\d+$/.test(String(expectedSeasonId || "")), "expected local season id is invalid");
  for (const document of documents) {
    for (const identifier of collectNamedIdentifiers(document.value)) {
      const seasonTokens = [...identifier.value.matchAll(/(?:^|[._-])(s\d+)(?=$|[._-])/ig)]
        .map((match) => match[1].toLowerCase());
      for (const seasonToken of seasonTokens) {
        assertGameKnowledge(
          seasonToken === expectedSeasonId.toLowerCase(),
          `${document.label} has foreign local season id ${seasonToken} at ${identifier.path}: ${identifier.value}`,
        );
      }
    }
  }
}
