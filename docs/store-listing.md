# Chrome Web Store listing

Everything the developer dashboard asks for, written down here so a submission
is a copy-and-paste rather than a fresh act of authorship each time, and so a
change to what we tell users is reviewable like any other change.

**Verify the current field limits and policy wording in Google's own developer
documentation before submitting.** The numbers below were right when written and
Google moves them.

## Identity

| Field | Value |
| --- | --- |
| Name | `Category Export for Revolut` |
| Category | Productivity |
| Language | English (UK) |
| Website | `https://github.com/jorisstander/revolut-category-export` |
| Support URL | `https://github.com/jorisstander/revolut-category-export/issues` |
| Privacy policy URL | `https://github.com/jorisstander/revolut-category-export/blob/main/PRIVACY.md` |

The name is deliberately *"for Revolut"* rather than *"Revolut …"*. It refers to
the service the tool reads without leading with the mark, which is the
conventional way to name an unaffiliated tool. See **Trademark** below.

The privacy policy URL points at the file in this repository. That is a public,
stable, version-controlled address, and its history is visible to anyone. GitHub
Pages would give a prettier URL at the cost of another thing to keep alive;
either is acceptable to the Store.

## Short description

132 characters maximum. This is 113:

```
Adds the Category column Revolut's own CSV export leaves out. Reads only your own data, locally. Unofficial tool.
```

## Detailed description

```
Revolut's own CSV and PDF exports drop the category you assigned to every
transaction. If you categorise your spending in the app and then export it, the
work vanishes and you re-do it by hand in a spreadsheet.

The categories are not lost. They are returned by the same API the Revolut web
app itself uses, and dropped only on the export path. This extension reads them
from the session you are already logged into and writes a CSV that includes
them.

WHAT YOU GET

A CSV with the same fields as Revolut's own export, plus three it does not give
you: Category, your in-app Comment, and a stable Transaction ID. Personal
accounts, joint accounts and each currency pocket can be exported separately.

Amounts are written as decimal strings rather than floating point, so nothing is
silently rounded. The file is UTF-8 with a byte-order mark, so Excel opens
accented merchant names correctly the first time.

IT CHECKS ITS OWN WORK

A spreadsheet quietly missing a few transactions is worse than an error,
because you reconcile against it and believe it. Every settled transaction
carries the account balance immediately after it, so consecutive rows have to
add up. Where they do not, the export stops and tells you, instead of writing a
file that looks fine.

PRIVACY

Your transactions are never sent anywhere. There is no server, no analytics, no
telemetry and no error reporting. The extension talks to app.revolut.com and no
other host, issues GET requests only, and cannot move money. It never sees your
passcode: it reuses the browser session you created by logging in yourself.

It has no dependencies at all, which keeps it small enough that you can read it
before trusting it with a bank session. The full source, and instructions for
checking that what you installed matches it, are on GitHub:
https://github.com/jorisstander/revolut-category-export

NOT AFFILIATED WITH REVOLUT

This is an independent, unofficial tool. It is not affiliated with, endorsed by
or connected to Revolut Ltd or any of its group companies. "Revolut" is used
only to say which service the extension works with.

Revolut's API is undocumented and can change without notice. When it does, the
extension is designed to stop and say so rather than produce a wrong file.
```

## Permission justifications

The dashboard asks for one per permission. Expect the `cookies` entry to draw
scrutiny — an extension reading cookies on a banking domain is exactly the
shape a reviewer is trained to look at twice. Lead with the narrowness.

**`cookies`**

```
Revolut's API rejects requests that do not carry an x-device-id header. Its
value comes from a single cookie, revo_device_id, which is a device identifier
rather than a credential or session token.

The extension requests that one cookie by name. There is exactly one
chrome.cookies.get call in the entire codebase, at extension/popup.js:40, and it
names the cookie and the URL literally. It reads no other cookie and never
touches session or authentication cookies.
```

**`downloads`**

```
To save the exported CSV via Chrome's own download prompt, so the user chooses
the destination.

The file is handed to Chrome as a blob URL rather than a data: URL,
specifically so the contents of the statement are not recorded in the browser's
download history. The extension also listens for the download to finish so it
can release that blob.
```

**Host permission — `https://app.revolut.com/*`**

```
The only host the extension contacts. It reads the user's account list from
/api/retail/wallets and their transactions from
/api/retail/user/current/transactions/last, both with GET.

The host permission also bounds which cookies the extension may read. There is
one network call site in the codebase, src/core/http.js, with a single
hard-coded origin and the literal method 'GET'. Continuous integration fails the
build if a second host appears anywhere in the source, or if a network call is
added outside that module.
```

**Single purpose**

```
Exporting the signed-in user's own Revolut transactions to a CSV file that
includes the transaction category, which Revolut's own export omits.
```

## Test instructions

The dashboard asks how a reviewer should test the item, and this is the section
most likely to get a bank-adjacent extension bounced: a reviewer cannot exercise
it at all without a Revolut account, and there is no acceptable way to give them
one.

**Do not send credentials.** Not yours, not a throwaway's. Sharing bank login
details is a breach of the account terms in its own right, and an extension that
arrives with bank credentials attached invites exactly the scrutiny this listing
is trying to avoid. Say plainly why they are not provided and describe what the
reviewer can verify without them.

```
This extension reads the signed-in user's own Revolut account, so exercising the
export requires a Revolut login. I cannot supply credentials for a bank account,
and I would not ask a reviewer to use someone else's banking session, so none are
attached.

What you can verify without an account:

1. Install and open the popup. With no Revolut session in the profile it shows
   "No Revolut session found" and a link to app.revolut.com. This is the whole
   behaviour of the extension when it has nothing to read.
2. The extension makes no request anywhere until the user clicks Export CSV, and
   then only to app.revolut.com. There is one network call site in the source,
   src/core/http.js, with a hard-coded origin and the literal method 'GET'.
3. Nothing is stored. There is no use of chrome.storage, localStorage,
   sessionStorage or IndexedDB anywhere in the package.
4. The single cookie read is revo_device_id, requested by name at
   extension/popup.js, whose value Revolut's API requires as a request header.

The complete source is public and the uploaded package is built reproducibly
from it, so the two can be compared directly:
https://github.com/jorisstander/revolut-category-export

With a Revolut account, testing is: log in at app.revolut.com, open the popup,
pick an account and a month, click Export CSV, and a CSV downloads.
```

## Distribution

- **Visibility:** Public.
- **Regions:** All. Revolut operates across the UK, EEA and elsewhere, and there
  is no reason to keep the tool from someone whose account it can read.
- **Pricing:** Free. No in-app purchases, no payments, nothing to declare.

## Data use disclosures

Answer the dashboard's data questionnaire as follows, all of which is true and
checkable:

- **Financial and payment information** — collected? **No.** The extension reads
  the user's transactions inside their own browser and writes them to a file on
  their own disk. Nothing is transmitted to the developer or to any third party.
- Every other category — **No**.
- **Not sold to third parties**, **not used for anything other than the single
  purpose**, **not used for creditworthiness or lending** — certify all three.

There is no server, so there is nothing to disclose about retention or transfer.

## Screenshots

`docs/store-assets/store-1280x800.png` is ready to upload. Rebuild it after any
change to the popup with:

```bash
node scripts/store-screenshot.mjs
```

It centres `docs/screenshot.png` on a canvas of the size the Store accepts.

**Both images are renders of the real popup, not captures of a real account.**
`extension/popup.html` is loaded, its fields are filled with representative
values — a joint EUR account, August 2026, thirty-eight transactions — and the
result is rasterised. That is deliberate twice over. It keeps the promise made
everywhere else here that no real account data appears in this repository, and
it means the screenshot can be regenerated when the popup changes instead of
depending on somebody having the right month of real transactions to hand.

The figures shown are invented. They illustrate the interface; they are not a
claim about anyone's account.

Worth adding a second and third shot eventually: the account picker with several
accounts, and a refusal message — "it stops rather than writing a wrong file" is
the strongest thing about the tool and no screenshot shows it.

## Trademark

Using "Revolut" to say which service the tool reads is ordinary referential use:
the tool cannot be described without naming it, the name uses no more of the
mark than that requires, and nothing about the listing suggests sponsorship. The
disclaimer appears in the name's positioning, the short description, the
detailed description, `PRIVACY.md` and the extension's own popup.

That is the reasoning, not a legal opinion, and it is not a substitute for one.
See `docs/legal/` — untracked, deliberately — for where that question is being
worked out.

## Before the first submission

- [ ] Settle the terms-of-service question. Nothing else here matters if the
      answer is no.
- [ ] Screenshot at 1280×800.
- [ ] Decide whether to pin the extension ID by generating a key and putting its
      public half in `manifest.json`. Without it, Chrome assigns the ID at first
      upload, and `docs/verifying-a-release.md` cannot name the ID users should
      check until after that.
- [ ] Register the developer account and complete identity verification. Check
      whether the address given becomes publicly visible for an individual
      account before choosing the account type.
- [ ] Publish the extension ID in the README once it exists.
