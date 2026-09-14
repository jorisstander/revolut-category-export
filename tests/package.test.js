import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPackage, packageVersion, runtimeFiles, zipEntries } from '../scripts/package.mjs';

/**
 * The upload package is the one artefact a user cannot read before trusting it
 * with a bank session, so the claim made about it — same commit, same bytes,
 * anywhere — has to be worth something. These pin the two halves of that: the
 * bytes do not depend on the machine, and the contents do not depend on what
 * happens to be lying in the working tree.
 */

const entry = (path, text) => ({ path, data: Buffer.from(text, 'utf8') });

test('the same content produces the same bytes', () => {
  const first = zipEntries([entry('a.txt', 'alpha'), entry('b/c.txt', 'beta')]);
  const second = zipEntries([entry('a.txt', 'alpha'), entry('b/c.txt', 'beta')]);
  assert.deepEqual(first, second, 'two builds of the same content differed');
});

test('every entry is stamped with the epoch, not with the clock', () => {
  // Comparing two builds does NOT establish this, which is worth saying because
  // the first version of this file tried to: both run inside the same second, so
  // a wall-clock stamp agrees with itself and the test passes while the property
  // is gone. Read the constant out of the bytes instead.
  const DOS_EPOCH_TIME = 0;
  const DOS_EPOCH_DATE = (1 << 5) | 1;    // 1980-01-01
  const zip = zipEntries([entry('a.txt', 'alpha')]);

  assert.equal(zip.readUInt16LE(10), DOS_EPOCH_TIME, 'local header carries a clock time');
  assert.equal(zip.readUInt16LE(12), DOS_EPOCH_DATE, 'local header carries a clock date');

  // And again in the central directory, which has its own copy.
  const end = zip.length - 22;
  const directory = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(directory), 0x02014b50, 'no central directory header');
  assert.equal(zip.readUInt16LE(directory + 12), DOS_EPOCH_TIME, 'directory carries a clock time');
  assert.equal(zip.readUInt16LE(directory + 14), DOS_EPOCH_DATE, 'directory carries a clock date');

  // External attributes hold unix mode bits when a packer puts them there, and
  // those differ between a developer's checkout and CI's.
  assert.equal(zip.readUInt32LE(directory + 38), 0, 'external attributes are not zeroed');
});

test('content is stored, not compressed', () => {
  // Deflating would shrink the package and cost the point of it: zlib's output
  // is not guaranteed identical across zlib versions, so the same commit built
  // on two Nodes could differ and the published hash would prove nothing.
  // Method 0 lives at offset 8 of the local file header.
  const zip = zipEntries([entry('a.txt', 'alpha')]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'not a local file header');
  assert.equal(zip.readUInt16LE(8), 0, 'compression method is not STORED');
  assert.ok(zip.includes(Buffer.from('alpha', 'utf8')), 'stored content should appear verbatim');
});

test('the archive ends with a central directory naming every entry', () => {
  const paths = ['a.txt', 'b/c.txt', 'd/e/f.txt'];
  const zip = zipEntries(paths.map((p, i) => entry(p, `content ${i}`)));
  // End-of-central-directory is the last 22 bytes when there is no comment.
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50, 'no end-of-central-directory record');
  assert.equal(zip.readUInt16LE(end + 10), paths.length, 'central directory entry count is wrong');
  const size = zip.readUInt32LE(end + 12);
  const offset = zip.readUInt32LE(end + 16);
  assert.equal(offset + size, end, 'central directory does not run up to the end record');
});

test('an empty file is a valid entry rather than a crash', () => {
  const zip = zipEntries([entry('empty.txt', '')]);
  assert.equal(zip.readUInt32LE(18), 0, 'compressed size should be zero');
  assert.equal(zip.readUInt32LE(22), 0, 'uncompressed size should be zero');
});

test('only what the browser runs is shipped', () => {
  const files = runtimeFiles();

  for (const wanted of ['manifest.json', 'LICENSE', 'extension/popup.html', 'extension/popup.js',
                        'src/core/pipeline.js', 'icons/icon-128.png']) {
    assert.ok(files.includes(wanted), `${wanted} is missing from the package`);
  }

  // Everything else in the repository is for people reading the project. Any of
  // it in the package enlarges what a reviewer has to read without making the
  // extension work; `spike/snippet.js` in particular is a diagnostic pasted into
  // DevTools by hand and has no business in a shipped extension.
  const excluded = files.filter(path =>
    path.startsWith('tests/') || path.startsWith('docs/') || path.startsWith('scripts/') ||
    path.startsWith('spike/') || path.startsWith('.github/') ||
    ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json', '.gitignore'].includes(path));
  assert.deepEqual(excluded, [], `these do not belong in the package: ${excluded.join(', ')}`);

  // The SVG is the source the PNGs were drawn from; the manifest never asks for it.
  assert.ok(!files.includes('icons/icon.svg'), 'the icon source should not ship');
});

test('manifest.json sits at the root of the archive, where Chrome looks for it', () => {
  const { paths } = buildPackage();
  assert.ok(paths.includes('manifest.json'), 'manifest.json is not in the package');
  assert.ok(!paths.some(p => p.endsWith('/manifest.json')), 'manifest.json must not be nested');
});

test('the two files carrying a version agree', () => {
  // Chrome reads the manifest and nothing else, so a drifted package.json is
  // invisible until an upload is rejected for a version already published.
  assert.match(packageVersion(), /^\d+\.\d+\.\d+$/);
});
