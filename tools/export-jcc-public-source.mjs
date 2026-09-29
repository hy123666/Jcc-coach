import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, realpath, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Export current reviewed files, never the staging checkout's private history.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: export-jcc-public-source.mjs <staging> <new-empty-target>');
const source = await realpath(input);
const target = path.resolve(output);
if (await lstat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) {
  throw new Error('Target must not exist; no existing checkout will be overwritten');
}
const parent = await realpath(path.dirname(target));
if (parent.toLowerCase() !== path.dirname(target).toLowerCase()) throw new Error('Target parent must be canonical');
if (target.toLowerCase().startsWith(source.toLowerCase() + path.sep)) throw new Error('Target cannot be inside source');
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: source, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean))].sort();
const excluded = /^(resources\/ocr\/(python|models)\/|tools\/bin\/|\.omx\/|\.jcc-runtime-data\/|\.git\/|\.tools\/|ui\/(node_modules|dist|release[^/]*)\/|node_modules\/|docs\/(public|superpowers)\/|docs\/release\/(source-export\.json|TEST-BASELINE\.md)|(?:release|public)-source-manifest\.json)/;
const manifest = {}, findings = [];
let bytes = 0;
for (const file of files) {
  if (excluded.test(file) || /(?:^|\/)(?:auth\.json|\.env(?:\..*)?)$|\.(?:sqlite(?:-shm|-wal)?|log|lnk|exe|dll|pyd|onnx|pyc)$/i.test(file)) continue;
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error(`Unsafe path: ${file}`);
  let cursor = source;
  for (const part of file.split('/')) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Link excluded: ${file}`);
  }
  const data = await readFile(cursor);
  if (data.length >= 100 * 1024 * 1024) throw new Error(`GitHub oversized file: ${file}`);
  if (!data.includes(0)) {
    const text = data.toString('utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bsk-[A-Za-z0-9_-]{32,}/.test(text)) findings.push(file);
  }
  manifest[file] = createHash('sha256').update(data).digest('hex');
  bytes += data.length;
}
if (findings.length) throw new Error(`Potential credentials require review (values withheld): ${findings.join(', ')}`);
await mkdir(target);
for (const file of Object.keys(manifest)) {
  const dest = path.join(target, file);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(path.join(source, file), dest);
  if (createHash('sha256').update(await readFile(dest)).digest('hex') !== manifest[file]) throw new Error(`Source changed during export: ${file}`);
}
await writeFile(path.join(target, 'public-source-manifest.json'), JSON.stringify({
  schema: 'jcc-public-source-v1', files: manifest,
  audit: { credentialPatternMatches: 0, fullHistoryIncluded: false, bundledEnvironmentsIncluded: false,
    note: 'Pattern scan is not proof of absence of all personal data; review before publication.' }
}, null, 2) + '\n');
console.log(JSON.stringify({ target, files: Object.keys(manifest).length, bytes, excluded: files.length - Object.keys(manifest).length }));
