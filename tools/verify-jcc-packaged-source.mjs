import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { verifyReleaseSources } from './jcc-release-source-sync.mjs';

const [source, staging, appDir] = process.argv.slice(2);
if (!source || !staging || !appDir) throw new Error('Usage: packaged-source <source> <staging> <win-unpacked>');
const manifest = await verifyReleaseSources(source, staging);
const sealed = JSON.parse(await readFile(path.join(staging, 'release-source-manifest.json'), 'utf8'));
assert.deepEqual(manifest, sealed, 'Source changed after release synchronization');
const resources = path.join(appDir, 'resources');
const require = createRequire(path.resolve(staging, 'ui/package.json'));
const asar = require('@electron/asar');
const archive = path.join(resources, 'app.asar');
let checked = 0;
for (const file of Object.keys(manifest.files)) {
  if (!/^(tools\/|ui\/electron\/|data\/runtime\/|AGENTS\.md$|CLAUDE\.md$)/.test(file)) continue;
  const expected = await readFile(path.join(source, file));
  assert(expected.equals(await readFile(path.join(resources, file))), `Installed resource mismatch: ${file}`);
  // electron-builder excludes type declarations from the executable archive;
  // the external resource copy above still verifies those development types.
  if (file.startsWith('ui/electron/') && !file.endsWith('.d.ts')) {
    assert(expected.equals(asar.extractFile(archive, path.normalize(file.slice(3)))), `Archive source mismatch: ${file}`);
  }
  checked++;
}
async function verifyDist(relative = 'dist') {
  for (const entry of await readdir(path.join(staging, 'ui', relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) await verifyDist(file);
    else if (!entry.name.startsWith('.')) {
      assert((await readFile(path.join(staging, 'ui', file))).equals(asar.extractFile(archive, file)), `Archive renderer mismatch: ${file}`);
      checked++;
    }
  }
}
await verifyDist();
for (const file of ['LICENSE', 'NOTICE.md']) {
  assert((await readFile(path.join(source, 'docs/public', file))).equals(await readFile(path.join(resources, file))), `Packaged project notice mismatch: ${file}`);
  checked++;
}
for (const file of Object.keys(manifest.files).filter(f => f.startsWith('third-party-notices/'))) {
  assert((await readFile(path.join(source, file))).equals(await readFile(path.join(resources, file))), `Packaged third-party notice mismatch: ${file}`);
  checked++;
}
const expectedPackage = JSON.parse(await readFile(path.join(source, 'ui/package.json'), 'utf8'));
const packagedPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(packagedPackage.version, expectedPackage.version, 'Packaged version mismatch');
assert.deepEqual(packagedPackage.dependencies, expectedPackage.dependencies, 'Packaged dependency declarations mismatch');
console.log(JSON.stringify({ ok: true, checked, test: 'packaged-source-parity' }));
