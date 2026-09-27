import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
if (process.argv.slice(2).length !== 3) throw new Error('Expected staging, installed app, output');
const [root, installed, out] = process.argv.slice(2).map(v => path.resolve(v));
const require = createRequire(path.join(root, 'ui/package.json'));
const asar = require('@electron/asar');
const archive = path.join(installed, 'resources/app.asar');
const entries = asar.listPackage(archive).map(s => s.replaceAll('\\', '/').replace(/^\//, ''));
const inventory = { schema: 'jcc-third-party-inventory-v1', notices: [], npm: [], python: [], models: [], adb: [] };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function save(name, bytes, origin) {
  const dest = path.join(out, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes);
  inventory.notices.push({ file: name.replaceAll('\\', '/'), source: origin, sha256: sha(bytes) });
}
function walk(base, prefix, origin) {
  if (!fs.existsSync(base)) return;
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    const p = path.join(base, e.name);
    if (e.isDirectory()) walk(p, path.join(prefix, e.name), origin);
    else if (e.isFile() && /^(licen[sc]e|copying|notice|copyright|authors)([._-]|$)/i.test(e.name)) save(path.join(prefix, e.name), fs.readFileSync(p), origin);
  }
}
for (const file of entries.filter(f => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package.json$/.test(f))) {
  const pkg = JSON.parse(asar.extractFile(archive, file.split('/').join(path.sep)));
  inventory.npm.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? null });
}
for (const file of entries.filter(f => /node_modules\//.test(f) && /\/(license|licence|notice|copying|copyright)([._-][^/]*)?$/i.test(f))) {
  try { save('npm/' + file, asar.extractFile(archive, file.split('/').join(path.sep)), 'installed app.asar'); }
  catch (e) { throw new Error(`Cannot collect ${file}: ${e.message}`); }
}
for (const f of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) save('electron/' + f, fs.readFileSync(path.join(installed, f)), 'installed Electron distribution');
const py = path.join(root, 'resources/ocr/python');
save('python/LICENSE.txt', fs.readFileSync(path.join(py, 'LICENSE.txt')), 'bundled Python');
const site = path.join(py, 'Lib/site-packages');
for (const dir of fs.readdirSync(site).filter(n => n.endsWith('.dist-info'))) {
  const meta = fs.readFileSync(path.join(site, dir, 'METADATA'), 'utf8');
  const value = n => meta.match(new RegExp('^' + n + ': (.*)$', 'm'))?.[1] ?? null;
  inventory.python.push({ name: value('Name'), version: value('Version'), license: value('License-Expression') ?? value('License'), metadataDirectory: dir });
}
walk(site, 'python/site-packages', 'bundled Python site-packages');
walk(path.join(py, 'tcl'), 'python/tcl', 'bundled Python Tcl');
const modelIndex = fs.readFileSync(path.join(site, 'rapidocr/default_models.yaml'), 'utf8');
for (const f of fs.readdirSync(path.join(root, 'resources/ocr/models/ppocrv5-mobile'))) {
  const bytes = fs.readFileSync(path.join(root, 'resources/ocr/models/ppocrv5-mobile', f));
  const match = modelIndex.match(new RegExp('model_dir: (https:[^\\n]*' + f.replaceAll('.', '\\.') + ')\\r?\\n\\s+SHA256: ([a-f0-9]+)'));
  inventory.models.push({ file: f, sha256: sha(bytes), source: match?.[1]?.trim() ?? null, matchesUpstreamIndex: match?.[2] === sha(bytes) });
}
for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) inventory.adb.push({ file: f, sha256: sha(fs.readFileSync(path.join(root, 'tools/bin', f))), status: 'Official same-version binary comparison differs; exact distribution provenance unresolved' });
fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ notices: inventory.notices.length, npm: inventory.npm.length, python: inventory.python.length, models: inventory.models, adb: inventory.adb }));
