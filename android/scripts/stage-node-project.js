'use strict';

// What the Android app runs, as one zip in its assets — TASK-049.
//
//   node scripts/stage-node-project.js <out-dir>      (the Gradle build runs this)
//
// Writes <out-dir>/nodejs-project.zip containing:
//
//   main.js, package.json   android/node — the entry point, and nothing else of its own
//   src/                    the server, unchanged, without src/tests
//   public/                 the renderer, unchanged
//   node_modules/           the production dependencies only, read from package-lock.json,
//                           so the tablet carries express and not Electron
//
// better-sqlite3's native parts (build/, deps/, src/) are left out: the APK has its own
// addon, compiled by Android Studio for the tablet's CPU (app/src/main/cpp), and the
// server is told where it is (AGRIVET_SQLITE_ADDON, src/config/sqlite.js). The one built
// here by npm is for the build machine and could not load on a phone anyway.
//
// A zip rather than a folder of assets because Android's asset packager drops dot-files
// and directories beginning with an underscore, and node_modules contains both.

const fs = require('fs');
const path = require('path');

const ANDROID = path.join(__dirname, '..');
const ROOT = path.join(ANDROID, '..');
const zip = require(path.join(ROOT, 'src', 'config', 'zip'));

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: node scripts/stage-node-project.js <out-dir>\n');
  process.exit(2);
}

/** Every file under dir, as paths relative to base, skipping what `skip` refuses. */
function walk(dir, base, skip = () => false) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (skip(rel, entry)) continue;
    if (entry.isDirectory()) found.push(...walk(full, base, skip));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

const entries = [];
const add = (name, content) => entries.push({ name, content });
const addTree = (from, prefix, skip) => {
  for (const rel of walk(from, from, skip)) add(`${prefix}/${rel}`, fs.readFileSync(path.join(from, rel)));
};

// ── The entry point ──────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
add('main.js', fs.readFileSync(path.join(ANDROID, 'node', 'main.js')));
add('package.json', `${JSON.stringify({
  name: `${pkg.name}-android`, version: pkg.version, private: true, main: 'main.js',
}, null, 2)}\n`);

// ── The server and the renderer ──────────────────────────────────────────────
addTree(path.join(ROOT, 'src'), 'src', (rel) => rel === 'tests' || rel.startsWith('tests/'));
addTree(path.join(ROOT, 'public'), 'public');

// ── Production dependencies ──────────────────────────────────────────────────
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const production = Object.entries(lock.packages || {})
  // Top-level packages only: a nested node_modules comes with its parent's folder.
  .filter(([key, meta]) => /^node_modules\/(@[^/]+\/)?[^/]+$/.test(key) && !meta.dev)
  .map(([key]) => key);

if (production.length === 0) throw new Error('package-lock.json lists no production packages');
const NATIVE = new Set(['build', 'deps', 'src']);
for (const key of production) {
  const dir = path.join(ROOT, key);
  if (!fs.existsSync(dir)) {
    throw new Error(`${key} is not installed. Run \`npm install\` in ${ROOT} first.`);
  }
  const nativeParts = key === 'node_modules/better-sqlite3';
  addTree(dir, key, (rel, entry) => (entry.isDirectory() && rel === '.bin')
    || (nativeParts && NATIVE.has(rel.split('/')[0])));
}

fs.mkdirSync(out, { recursive: true });
const archive = zip.zipMany(entries);
fs.writeFileSync(path.join(out, 'nodejs-project.zip'), archive);
process.stdout.write(`nodejs-project.zip: ${entries.length} files, ${production.length} packages, `
  + `${(archive.length / 1048576).toFixed(1)} MB\n`);
