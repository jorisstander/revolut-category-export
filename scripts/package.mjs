#!/usr/bin/env node
// Build the Chrome Web Store upload package, byte-for-byte reproducibly.
//
// Loading this extension unpacked, a user can read every line before trusting
// it with a bank session. The Web Store takes that away: what they install is a
// package they cannot see, and the README's whole argument -- it is small
// enough to read, so read it -- goes with it, unless the package can be checked
// against the source.
//
// So this is deterministic. The same commit produces the same bytes on any
// machine, on any supported Node, so a published SHA-256 is a claim anyone can
// falsify. See README's "Verifying a release" for how a user checks the copy
// Chrome actually installed, which is not the same artefact -- the Store
// re-signs, so the `.crx` they receive is not this zip.
//
// Usage: node scripts/package.mjs [--out <dir>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * What ships. Everything else in the repository -- tests, the sweep, the API
 * notes, the DevTools spike -- is for people reading the project, not for the
 * browser running it, and shipping it would enlarge what a reviewer has to read
 * without making the extension work any better.
 *
 * LICENSE is here because MIT requires the notice to travel with the copies.
 */
const SHIPPED = [
  (path) => path === 'manifest.json',
  (path) => path === 'LICENSE',
  (path) => path.startsWith('extension/'),
  (path) => path.startsWith('src/'),
  (path) => path.startsWith('icons/') && path.endsWith('.png')
];

/**
 * Tracked files only, from git rather than from a directory walk.
 *
 * A walk picks up whatever happens to be lying in the working tree -- an
 * editor's backup, a half-finished file, a `.env` somebody dropped in `src/`.
 * Asking git means every path in the package is also in the commit, which is
 * the property the verification instructions depend on: what shipped is a
 * subset of what was published, and nothing else can get in.
 */
export function runtimeFiles(cwd = process.cwd()) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  return tracked.filter(path => SHIPPED.some(matches => matches(path))).sort();
}

// Table-driven CRC-32, because the zip format needs one and Node does not carry
// one. The polynomial is the standard reflected 0xEDB88320.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The zip epoch is 1980, and every entry is stamped with the start of it. Real
// modification times are the usual reason two builds of identical content
// differ, and they carry nothing a reader of this package wants.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;   // 1980-01-01

/**
 * A zip holding `entries` exactly as given, in the order given.
 *
 * STORED, not deflated. Compression would shrink 126 KB to perhaps 40, and
 * would cost the only property this file exists to provide: zlib's output is
 * not guaranteed identical between zlib versions, so a deflated package built
 * on one Node could differ from the same commit built on another, and the
 * published hash would then be evidence of nothing.
 *
 * @param {{path: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
export function zipEntries(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { path, data } of entries) {
    const name = Buffer.from(path, 'utf8');
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed to extract
    local.writeUInt16LE(0, 6);            // flags: none, so no data descriptor
    local.writeUInt16LE(0, 8);            // method 0: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18); // compressed size == uncompressed
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field: it is where mtimes and uids hide
    locals.push(local, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);   // central directory header signature
    entry.writeUInt16LE(20, 4);           // version made by
    entry.writeUInt16LE(20, 6);           // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);           // extra
    entry.writeUInt16LE(0, 32);           // comment
    entry.writeUInt16LE(0, 34);           // disk number
    entry.writeUInt16LE(0, 36);           // internal attributes
    entry.writeUInt32LE(0, 38);           // external attributes: zeroed, so no unix mode bits
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory signature
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // no archive comment

  return Buffer.concat([...locals, directory, end]);
}

/** The package for the working tree, and the paths that went into it. */
export function buildPackage(cwd = process.cwd()) {
  const paths = runtimeFiles(cwd);
  if (paths.length === 0) throw new Error('No files matched the shipping list — is this a git checkout?');
  const entries = paths.map(path => ({ path, data: readFileSync(join(cwd, path)) }));
  return { zip: zipEntries(entries), paths };
}

/**
 * The version Chrome will show, having checked nothing else disagrees with it.
 *
 * Two files carry a version and only one of them reaches users. They drift the
 * moment a release is cut by hand, and the symptom is an upload rejected for a
 * version that was already published.
 */
export function packageVersion(cwd = process.cwd()) {
  const manifest = JSON.parse(readFileSync(join(cwd, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `manifest.json says version ${manifest.version} and package.json says ${pkg.version}. ` +
      `Chrome uses the manifest; make them agree before releasing.`
    );
  }
  return manifest.version;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('package.mjs')) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex === -1 ? 'dist' : process.argv[outIndex + 1];

  const version = packageVersion();
  const { zip, paths } = buildPackage();
  const target = join(outDir, `revolut-category-export-${version}.zip`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, zip);

  const digest = createHash('sha256').update(zip).digest('hex');
  for (const path of paths) console.log(`  ${path}`);
  console.log(`\n${paths.length} files, ${zip.length} bytes`);
  console.log(`${target}`);
  console.log(`sha256  ${digest}`);
}
