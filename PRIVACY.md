# Privacy Policy

**Category Export for Revolut** — last updated 15 September 2026.

## The short version

The extension sends your data nowhere. It has no server, no analytics, no
telemetry, no error reporting and no update pings. Your transactions travel from
Revolut's API to a CSV file on your own disk, and nowhere else.

Every claim below is a property of code you can read. Where a claim can be
checked with a command, the command is given.

## What the extension handles

When you click **Export CSV**, it reads, inside your browser:

- **Your accounts** — from `GET /api/retail/wallets`: account types, wallet and
  pocket identifiers, currencies and labels.
- **Your transactions for the month you chose** — from
  `GET /api/retail/user/current/transactions/last`: dates, amounts, fees,
  currency, state, running balance, description, category, comment and
  transaction id.
- **One cookie** — `revo_device_id`, requested by name. Revolut's API requires
  its value as an `x-device-id` header. It is a device identifier, not a
  credential or a session token.

It never asks for your passcode, PIN, card details or Revolut credentials. It
reuses the browser session you created by logging in to `app.revolut.com`
yourself.

## Where that data goes

Into a CSV file, saved by Chrome's own download prompt, to a location you pick.

That is the only destination. The extension makes network requests to
`https://app.revolut.com` and to no other host, and every one of them is a
`GET`. It cannot move money.

You can verify both properties rather than take them on faith:

```bash
grep -rnE "fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource" extension/ src/
```

Four of those lines matter, and they are the whole of the extension's network
surface: `extension/popup.js` hands the browser's `fetch` to the one client
(`fetchImpl: fetch`), and `src/core/http.js` declares it, calls it once, and
builds the URL from a single hard-coded origin —

```bash
grep -rn "API_ORIGIN" src/core/http.js     # the constant, and the one URL built from it
```

— with `method: 'GET'` written literally at the call. The remaining matches are
the word "fetch" inside `paginate.js` comments and its exported `fetchRange`,
which pages through results using the client above and opens no connection of
its own.

The project's continuous integration fails the build if a second host appears
anywhere in the source, or if any network call is added outside that one module.

## What is stored, and for how long

Nothing persistent. The extension uses no `chrome.storage`, no `localStorage`,
no `sessionStorage`, no IndexedDB and no cache:

```bash
grep -rnE "chrome\.storage|localStorage|sessionStorage|indexedDB" extension/ src/
```

Your transactions exist in the popup's memory while the export runs, and are
released when the popup closes. The CSV is handed to Chrome as a blob reference
rather than a `data:` URL, specifically so the file's contents do not end up
recorded in your browser's download history.

## Permissions, and why each one exists

| Permission | Why |
| --- | --- |
| `cookies` | To read the single cookie `revo_device_id`, whose value Revolut's API requires as a request header. There is exactly one `chrome.cookies.get` call in the codebase. |
| `downloads` | To save the CSV, and to release the blob once the download finishes. |
| `https://app.revolut.com/*` | The only host the extension may contact, and the only host whose cookies it may read. |

Being straight about the limit of that: the `cookies` permission Chrome grants
*would* allow reading your Revolut session cookies, including `HttpOnly` ones
that page JavaScript cannot reach. The extension does not. That is a property of
the code you can read, not something the browser enforces on your behalf — which
is why the code is kept small enough to read.

## The screenshots

No real account data appears anywhere in this repository, and that includes the
pictures. The screenshot in the README and the one on the store listing are
renders of the actual popup — its real markup and stylesheet — with the fields
filled in by hand: a joint EUR account, August 2026, thirty-eight transactions.
Those figures are invented. They illustrate the interface and describe nobody's
money.

An earlier screenshot was a photograph of a real account's real month. It was
replaced for this reason.

## Third parties

There are none. No dependencies, no libraries, no fonts, no CDNs, no
third-party services of any kind. Nothing is shared with anyone, and there is
nothing to sell.

## Your data rights

The extension holds no data about you, so there is nothing to request, correct
or delete. The CSV it produces is your file, on your disk.

## Not affiliated with Revolut

This is an independent, unofficial tool. It is not affiliated with, endorsed by,
or connected to Revolut Ltd or any of its group companies. "Revolut" is used
only to say which service the tool reads.

## Contact

Questions about privacy, or anything in this document:
<https://github.com/jorisstander/revolut-category-export/issues>

Suspected vulnerabilities should go through
[SECURITY.md](SECURITY.md) rather than a public issue.

## Changes

This policy is versioned with the code. Its history — every change, with the
commit that made it — is at
<https://github.com/jorisstander/revolut-category-export/commits/main/PRIVACY.md>.
