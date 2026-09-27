import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function collectFiles(root, extensions = new Set([".md", ".json"])) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath, extensions));
    } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const roots = [
    path.join(repoRoot, "data/runtime/jcc"),
  ];
  const offenders = [];
  const invalidJson = [];
  for (const root of roots) {
    for (const file of await collectFiles(root)) {
      const text = await readFile(file, "utf8");
      const index = text.indexOf("\uFFFD");
      if (index >= 0) {
        offenders.push(path.relative(repoRoot, file).replaceAll(path.sep, "/"));
      }
      if (path.extname(file).toLowerCase() === ".json") {
        try {
          JSON.parse(text);
        } catch (error) {
          invalidJson.push({
            file: path.relative(repoRoot, file).replaceAll(path.sep, "/"),
            error: error?.message || String(error),
          });
        }
      }
    }
  }
  assert(!offenders.length, `runtime text contains replacement characters: ${offenders.join(", ")}`);
  assert(!invalidJson.length, `runtime JSON contracts are not parseable: ${invalidJson.map((entry) => `${entry.file}: ${entry.error}`).join("; ")}`);
  console.log(JSON.stringify({
    ok: true,
    checked_roots: roots.map((root) => path.relative(repoRoot, root).replaceAll(path.sep, "/")),
    json_parse_checked: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
