# Changelog

Notable changes, newest first. Versions follow semantic versioning; the same
number appears in `manifest.json`, and the release workflow refuses to publish a
tag that disagrees with it.

## Unreleased

Nothing that changes the extension. `manifest.json` is still 0.1.0 and the
package built from this commit is byte-identical to the one released as v0.1.0.

- `PRIVACY.md` records that the screenshots are renders of the popup with
  invented figures rather than pictures of a real account, and no longer calls
  the extension by the name it was renamed away from.
- `docs/verifying-a-release.md` no longer tells readers to check an extension ID
  against one published in the README. There is no ID until the Chrome Web Store
  listing is approved, and nothing in the README to check against.
- The store listing copy and the generated listing image are no longer tracked.
  They restated `PRIVACY.md` and the README, and a second copy of a claim is
  somewhere for it to drift from the first. `scripts/store-screenshot.mjs`
  rebuilds the image, and both it and its input are still tracked.

## 0.1.0 — 2026-09-15

First release. Exports a month of Revolut transactions to CSV with the
`Category`, `Comment` and `Transaction ID` columns the official export omits.

### Added

- **Category, Comment and Transaction ID columns.** The categories are returned
  by the same API the Revolut web app uses and dropped only on the export path.
- **Per-account and per-currency selection.** Personal accounts, joint accounts
  and each currency pocket are listed separately. An account the extension
  cannot read is shown greyed out and marked rather than hidden, so it does not
  look unsupported when it is merely unreadable.
- **Completeness proved from the ledger, not assumed.** Every settled row
  carries the balance immediately after it, so consecutive rows must add up.
  Where they do not, the export raises instead of writing a file — the check
  depends on no assumption about how the API pages, which matters because the
  API is undocumented and several such assumptions turned out to be wrong.
- **Refusal in preference to a short file.** A CSV silently missing part of a
  month gets reconciled and believed, which is worse than an error. The paging
  walk asks the server rather than inferring from page shape wherever the two
  differ, and stops with a message when it cannot prove a month complete.
- **Amounts as decimal strings**, never floats, so nothing is silently rounded;
  UTF-8 with a BOM so Excel opens accented merchant names on the first try;
  RFC 4180 quoting with formula-leading text neutralised, because an inbound
  transfer's reference is written by whoever sent the money.
- **`scripts/reconcile.mjs`** to diff an export against Revolut's own CSV.
- **`scripts/sweep.mjs`**, which drives the paging walk against 12,600 simulated
  server models, 5,040 honest feeds and 1,680 unreliable ones, and fails if any
  returns a short file without saying so.
- **Reproducible packaging.** `scripts/package.mjs` builds the store zip
  deterministically, and releases publish its SHA-256. See
  [docs/verifying-a-release.md](docs/verifying-a-release.md).
- **[PRIVACY.md](PRIVACY.md)** — nothing leaves the browser, with the command to
  check each claim.

### Known limits

Each is refused visibly rather than guessed at, except where noted.

- A server reading the `to` cutoff more coarsely than it was given cannot be
  paged without gaps, and is refused.
- More transactions sharing one timestamp than a single request can return
  cannot be read whole, and is refused.
- Savings-pocket interest is not included: those pockets are not enumerated by
  the accounts endpoint.
- A capture run lying entirely below the settlement margin, with the account's
  older history interleaved above it, is **not** detectable — the walk stops
  before reading any held row, so it ends with no evidence one exists. No fixed
  margin makes it visible. Recorded in
  [docs/api-notes.md](docs/api-notes.md) rather than left implied.
