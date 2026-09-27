import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { syncReleaseSources, verifyReleaseSources, verifyReleaseDependencies } = await import('./jcc-release-source-sync.mjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'jcc-release-sync-'));
try {
  const source = path.join(temp, 'source');
  const target = path.join(temp, 'target');
  await mkdir(path.join(source, 'ui', 'src'), { recursive: true });
  await mkdir(path.join(target, 'ui', 'src'), { recursive: true });
  await writeFile(path.join(source, 'ui/src/App.tsx'), 'current source');
  await writeFile(path.join(target, 'ui/src/App.tsx'), 'old source');
  const files = ['ui/src/App.tsx'];
  await syncReleaseSources(source, target, files);
  await verifyReleaseSources(source, target, files);
  assert.equal(await readFile(path.join(target, files[0]), 'utf8'), 'current source');
  await writeFile(path.join(target, files[0]), 'drift');
  await assert.rejects(verifyReleaseSources(source, target, files), /mismatch/);
  await assert.rejects(syncReleaseSources(source, source, files), /different/);
  await assert.rejects(syncReleaseSources(source, target, ['../escape']), /Unsafe/);
  await writeFile(path.join(source, 'ui/package.json'), JSON.stringify({ dependencies: { electron: '^39.2.7' } }));
  await writeFile(path.join(target, 'ui/package.json'), JSON.stringify({ devDependencies: { electron: '^39.2.7', 'electron-builder': '^26.0.12' } }));
  await verifyReleaseDependencies(source, target);
  await writeFile(path.join(target, 'ui/package.json'), JSON.stringify({ devDependencies: { electron: '^38.0.0', 'electron-builder': '^26.0.12' } }));
  await assert.rejects(verifyReleaseDependencies(source, target), /dependency mismatch/);
  console.log('Release source sync regression passed');
} finally {
  await rm(temp, { recursive: true, force: true });
}
