# Verifying a release

This extension reads a bank account, and the argument for trusting it has always
been that it is small enough to read. Loading it unpacked, you *are* reading it:
the files Chrome runs are the files in front of you.

Installing from the Chrome Web Store removes that. What you get is a package
somebody else built, and the only honest response is to make it checkable. This
page is how.

## What is guaranteed

**The package is reproducible.** `scripts/package.mjs` builds it from
`git ls-files`, stores every entry uncompressed, and stamps every timestamp with
the 1980 epoch. The same commit therefore produces the same bytes on any
machine and any supported Node — the release workflow builds it twice and
refuses to publish if the two differ.

**Everything in it is in the repository.** The file list comes from git, so a
file that is not committed cannot be in the package. The release workflow checks
that too, against the built artefact rather than against the intention.

**Nothing is compressed away.** Entries are stored, not deflated, so the bytes
of every file appear verbatim in the zip. This costs about 50 KB and buys the
reproducibility above: zlib's output is not guaranteed identical between
versions, so a compressed package could differ between machines for no reason
you could see.

## Checking a GitHub release

Each release publishes a zip and its SHA-256.

```bash
# Compare the published hash against the file you downloaded
sha256sum revolut-category-export-0.1.0.zip

# Or rebuild it yourself from the tag and compare
git clone https://github.com/jorisstander/revolut-category-export
cd revolut-category-export
git checkout v0.1.0
node scripts/package.mjs
```

Both hashes should match the one in the release notes. If they do, the zip is
the tag.

## Checking what Chrome actually installed

**The Store re-signs what it distributes**, so the copy Chrome installs is *not*
byte-identical to the published zip, and comparing hashes will not work. What
you can compare is the files.

Find the installed copy. The extension ID is shown on `chrome://extensions` with
Developer mode on; the profile directory is usually `Default`, or `Profile 1`
and upward if you have several.

| OS | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\<profile>\Extensions\<id>\<version>_0\` |
| macOS | `~/Library/Application Support/Google/Chrome/<profile>/Extensions/<id>/<version>_0/` |
| Linux | `~/.config/google-chrome/<profile>/Extensions/<id>/<version>_0/` |

Then diff it against the matching tag:

```bash
git clone https://github.com/jorisstander/revolut-category-export /tmp/cxr
cd /tmp/cxr && git checkout v0.1.0

# INSTALLED is the directory from the table above
diff -r --exclude=_metadata "$INSTALLED" . \
  | grep -v '^Only in \.'
```

`_metadata/` is excluded because Chrome adds it — it holds the signatures Chrome
generated, which by definition are not in the source. `Only in .` lines are
filtered out because the repository contains the tests, docs and tooling that
the package deliberately leaves behind.

**What you want to see is no output at all.** Any other difference means the
installed files are not the published source, and is worth reporting.

## Confirming it is the right extension

A tool that reads a bank is worth impersonating. Anyone can fork this, add a few
lines that send your transactions somewhere, and publish it under a name a
letter or two different.

**The extension is not on the Chrome Web Store yet** — a listing is in review at
the time of writing. Until it is published there is no official ID, and the only
supported way to install is unpacked from this repository, which is also the way
you can read every line first.

Once it is listed, the official ID will be published in the README and checkable
on `chrome://extensions`. Check the ID rather than the name: the name is the
part an impostor copies.

## If something does not match

Open an issue, or if you think it is a compromise rather than a mistake, follow
[SECURITY.md](../SECURITY.md) instead of posting publicly.
