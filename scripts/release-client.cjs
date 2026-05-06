// Snapshot the current public/ directory into client-releases/<version>/
// and rewrite client-releases/manifest.json to point there.
//
// Usage:
//   node scripts/release-client.cjs            # uses package.json's version
//   node scripts/release-client.cjs 0.1.2      # override version
//   npm run release-client
//   npm run release-client -- 0.2.0
//
// After this runs, commit the new directory + manifest to the GitHub repo
// configured in client-config.json's `updateRepo`. Running EXEs check the
// manifest periodically and will pick up the new version on their next poll.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const RELEASES_DIR = path.join(ROOT, 'client-releases');

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

async function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

async function copyFile(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

async function sha256OfFile(p) {
  const buf = await fsp.readFile(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const argVersion = process.argv[2];
  const version = (argVersion && argVersion.trim()) || readPackageVersion();
  if (!version) throw new Error('no version (package.json or argv)');
  if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/.test(version)) {
    throw new Error(`version "${version}" doesn't look like semver`);
  }

  const versionDir = path.join(RELEASES_DIR, version);
  if (fs.existsSync(versionDir)) {
    throw new Error(`client-releases/${version}/ already exists. Bump the version in package.json (or pass a different one).`);
  }

  console.log(`Snapshotting public/ → client-releases/${version}/`);
  const files = await walkFiles(PUBLIC_DIR);
  const records = [];
  for (const rel of files) {
    const src = path.join(PUBLIC_DIR, rel);
    const dst = path.join(versionDir, rel);
    await copyFile(src, dst);
    records.push({ path: rel, sha256: await sha256OfFile(dst) });
  }

  // Read serverUrl from client-config.json so the manifest carries it forward.
  let serverUrl = '';
  try {
    serverUrl = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-config.json'), 'utf8')).serverUrl || '';
  } catch {}

  const manifest = {
    version,
    releasedAt: new Date().toISOString(),
    serverUrl,
    files: records,
    notes: process.env.RELEASE_NOTES || null,
  };
  await fsp.writeFile(
    path.join(RELEASES_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  console.log(`  ${records.length} file(s)`);
  console.log(`  manifest.json points at ${version}`);
  console.log('');
  console.log('Next: commit + push client-releases/ to your GitHub repo.');
  console.log('Running EXEs will pick up this version on their next poll.');
}

main().catch((e) => { console.error('release-client failed:', e.message); process.exit(1); });
