import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function safePath(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error(`Unsafe release path: ${relative}`);
  }
  return path.join(root, relative);
}

async function roots(source, target) {
  source = await realpath(source);
  target = await realpath(target);
  const a = source.toLowerCase(), b = target.toLowerCase();
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
    throw new Error('Source and release roots must be different, non-nested directories');
  }
  return [source, target];
}

async function rejectLinks(root, relative) {
  let current = root;
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Unsafe release link: ${current}`);
  }
}

export function releaseSourceFiles(source) {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: source, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(file => (
    /^(ui\/(src|electron|assets|scripts|installer)\/|data\/runtime\/jcc\/)/.test(file)
    || /^(AGENTS\.md|CLAUDE\.md|\.codex\/skills\/jcc-runtime-agent\/SKILL\.md)$/.test(file)
    || /^docs\/(requirements|release)\/.*\.(json|md)$/.test(file)
    || /^docs\/public\//.test(file)
    || /^third-party-notices\//.test(file)
    || /^tools\/[^/]+\.(mjs|js|cjs|py|ps1)$/.test(file)
    || /^tools\/fixtures\/.*\.(nsi|json|mjs|py)$/.test(file)
    || /^ui\/(package(-lock)?\.json|index\.html|vite\.config\.ts|tsconfig[^/]*\.json|electron-builder\.yml)$/.test(file)
  )))].sort();
}

export async function verifyReleaseDependencies(source, target) {
  const a = JSON.parse(await readFile(path.join(source, 'ui/package.json'), 'utf8'));
  const b = JSON.parse(await readFile(path.join(target, 'ui/package.json'), 'utf8'));
  const expected = { ...a.dependencies, ...a.devDependencies };
  const actual = { ...b.dependencies, ...b.devDependencies };
  for (const [name, version] of Object.entries(expected)) {
    if (actual[name] !== version) throw new Error(`Release dependency mismatch: ${name}`);
  }
  if (!actual['electron-builder']) throw new Error('Release requires electron-builder');
}

export async function syncReleaseSources(source, target, files = releaseSourceFiles(source)) {
  [source, target] = await roots(source, target);
  // Validate every destination before copying any file. No recursive deletion.
  for (const file of files) {
    safePath(source, file); safePath(target, file);
    await rejectLinks(source, file); await rejectLinks(target, file);
    if (!(await lstat(safePath(source, file))).isFile()) throw new Error(`Missing source file: ${file}`);
  }
  for (const file of files) {
    const to = safePath(target, file);
    await mkdir(path.dirname(to), { recursive: true });
    const from = safePath(source, file);
    const sourceBytes = await readFile(from);
    const targetBytes = await readFile(to).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // Release roots may contain files held by an installed/runtime process.
    // Avoid an unnecessary replacement when the published bytes are already identical.
    if (targetBytes?.equals(sourceBytes)) continue;
    await copyFile(from, to);
  }
  return verifyReleaseSources(source, target, files);
}

export async function verifyReleaseSources(source, target, files = releaseSourceFiles(source)) {
  [source, target] = await roots(source, target);
  const hashes = {};
  for (const file of files) {
    const bytes = await readFile(safePath(source, file));
    const actual = await readFile(safePath(target, file));
    if (!bytes.equals(actual)) throw new Error(`Release source mismatch: ${file}`);
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
  }
  return { schema: 'jcc-release-source-manifest-v1', files: hashes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, target, mode = 'verify'] = process.argv.slice(2);
  if (!source || !target || !['sync', 'verify'].includes(mode)) throw new Error('Usage: source-sync <source> <target> [sync|verify]');
  const manifest = await (mode === 'sync' ? syncReleaseSources : verifyReleaseSources)(source, target);
  await verifyReleaseDependencies(source, target);
  if (mode === 'sync') await writeFile(path.join(target, 'release-source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  else {
    const sealed = JSON.parse(await readFile(path.join(target, 'release-source-manifest.json'), 'utf8'));
    if (JSON.stringify(sealed) !== JSON.stringify(manifest)) throw new Error('Release source changed since synchronization');
  }
  console.log(JSON.stringify({ ok: true, mode, files: Object.keys(manifest.files).length }));
}
