# Observed API facts

Captured 2026-08-09 from a real account via `spike/snippet.js`, and **re-verified
unchanged on 2026-09-13**: same client version, same account-type keys, same response
envelope, same selector behaviour, every row still carrying a category.

Re-verify if the tool starts failing — these are undocumented endpoints and Revolut
changes them without notice. Running `spike/snippet.js` takes a minute and tells you
immediately whether the cause is here or in the code.

This file records behaviour, never data. It carries no account identifier, amount or
merchant, and **none should ever be pasted in** — it is published. The only dates here
are when the API was last observed.

## Response shape

- `transactions/last` returns a **bare JSON array**. `isArray` was `true` on every probe.
- `x-client-version`: **`100.0`** — confirmed by capturing the value the live web client
  sends, not guessed. Matches the constant in `src/core/http.js`.

## Accounts

`GET /api/retail/wallets` returns an object keyed by account type. The keys observed are
`PERSONAL`, `PERSONAL_JOINT`, `YOUTH`, `TEEN` and `FAMILY_CREDIT_CARD`; each holds zero or
more wallets, and each wallet holds one pocket per currency.

## Selector behaviour — the important part

Probing pockets with both candidate selectors produces these outcomes. Which one a given
pocket hits depends on its account type and on whether it has any transactions, so the
extension determines it per account rather than assuming:

| Selector | Possible result |
| --- | --- |
| `internalPocketId` | the pocket's own rows, **plus** rows from other pockets in the wallet |
| `internalPocketId` | `200` with an **empty array**, even though the pocket has transactions |
| `walletId` | every pocket in the wallet, including ones the account list omits |
| `walletId` | **none of the requested pocket's own rows**, when it is empty and shares a wallet |

Four behaviours this confirms, each of which the code already handles:

1. **`internalPocketId` is not pocket-scoped either.** Even the "correct" selector returns
   sibling pockets' rows. Filtering every page down to the selected pocket is therefore
   required for *all* accounts, not only for `walletId`-resolved ones.
2. **A joint-account pocket returns an empty array for `internalPocketId`** and answers
   only to `walletId`. This is the silent-failure mode the probe logic exists for.
3. **`walletId` can return none of the requested pocket's own rows** — when the pocket is
   empty and shares a wallet with a busier one, the response is entirely its sibling's.
   This is the case `assertServedCorrectAccount` rejects; had it been accepted, a file
   named for one currency would have contained another's transactions. `internalPocketId`
   usually resolves first, so the rejection is a second line of defence rather than the
   only one.
4. **Savings pockets are not enumerated by `/api/retail/wallets`.** Wallets can hold a
   pocket (`SAVINGS`, `SAVINGS_INTEREST_BEARING`) that appears in the transaction feed but
   not in `pockets[]`. They are unrecognised ids: tolerated by the probe check, dropped by
   the filter.

## Categories

Every row carries a `category`, and a legacy `tag` holding the same value. They are
lowercase enum strings drawn from Revolut's built-in set — `groceries`, `restaurants`,
`transport`, `shopping`, `utilities`, `transfers`, `topup` and similar. No row was
observed with an absent, null or empty `category`, though the code treats all three as an
empty field regardless.

`GET /api/retail/transaction-categories/custom` returns an array of user-defined
categories, and was empty when probed. If it is ever non-empty, expect
`category` to carry a UUID that needs resolving against it — the current code does not do
that, and would emit the raw value.

## Extension-origin authentication

The spike runs on `app.revolut.com`'s own origin. The extension popup is a different
origin, and whether session cookies are sent from there is the one assumption that would
invalidate the extension's architecture.

**Confirmed working.** The unpacked extension's popup discovered the available accounts
and produced a complete, reconciled export, so session cookies are sent from the
extension origin and no content script is needed.

If a future browser or Revolut change breaks that, the symptom is a 401 or an empty
account picker in the popup while `spike/snippet.js` still works on the page itself. The
fix would then be a content script injected into `app.revolut.com` that does the fetching
and messages results back.

## Reconciliation — verified against a real statement

A full month's export was reconciled against Revolut's own PDF statement for the same
period. **Total spent, total received and the net figure all matched exactly**, and the
balance column chained without a single break.

The only difference was one extra row on our side: a **zero-amount card authorisation**,
which the API returns and the statement omits. Worth remembering — if a future
reconciliation is off by a row with no money attached, that is very likely why.

### Month membership uses `completedDate` — verified, do not change

Revolut's statement keys on the **completion** date, not the started date. Three
observations from the statement, all pointing the same way:

- A payment started on the last day of the previous month and cleared on the 1st appears
  in *this* month's statement, dated by its clearing date.
- A payment started on the last day of the month and cleared on the 1st of the next is
  **absent** from this month's statement entirely.
- Statement entries are consistently dated one to two days after the transaction was
  made — i.e. by completion.

This was briefly changed to `startedDate` on the assumption that Revolut keyed that way.
It does not. The change broke the reconciliation that had previously matched exactly, and
broke the balance chain on roughly half the rows — because `Balance` is the balance
*after completion*, and is only coherent in completion order. Reverted, with two
regression tests in `tests/paginate.test.js` guarding both directions of the boundary.

Consequence worth knowing: a transaction near a month boundary lands in the month it
*cleared*, not the month it happened. That is what makes an export agree with the
statement for the same period.

### The `to` parameter's semantics are unverified

`to=<epochMs>` pages backwards, but nothing establishes whether it is inclusive or
exclusive, which field it compares against, or its granularity. The spike never sends it.

Neither is `count`. It is documented above as a hint — the API has returned more rows than
asked for — so the number of rows on a page says nothing about what the server holds. A
server-side cap and an exhausted feed look identical by page length.

`src/core/paginate.js` therefore assumes neither. It steps the cursor one millisecond past
the oldest row, so a group sharing a timestamp is re-fetched whether `to` is inclusive or
exclusive. It widens the page rather than stepping over an unread remainder. And when the
walk stalls above the start of the range, it does not infer from page length whether the
feed is finished — it issues one more request asking whether anything older exists, and
raises if the answer is yes.

That last request is the difference between a guess and a measurement. Several earlier
versions guessed, in several different ways, and each returned a well-formed file missing
part of a month. It costs one request, and only on the path where an account's history
runs out before the range does. A normal month over deep history costs three to five
requests in total; the walk stops as soon as a page reaches past the start of the range.

### Completeness is verified, not assumed

Every rule in the walk above is still a belief about an undocumented API, so the result is
checked independently of all of them. Each transaction carries the account balance
immediately after it settled, which means consecutive rows must satisfy

```
balance(newer) - amount(newer) === balance(older)
```

A break in that chain proves a transaction moved the balance between two rows and is not
in the set — whatever the server did to cause it. `src/core/continuity.js` runs that check
before any file is written, and raises rather than returning a short export.

It catches gaps in the middle. It cannot see rows missing from either *end* of the range,
so the walk still has to reach past the start or prove the feed ran out; those two
together are the completeness guarantee.

Two deliberate limits. A server that rounds its cutoff coarser than a millisecond cannot
be walked safely — the signature is identical to one ignoring the parameter entirely, so
the tool refuses rather than guess. And the request budget is 40 pages: these calls go to
someone's bank, and a server behaving oddly should not be able to drive hundreds of them.

`tests/paginate-semantics.test.js` holds the walk to "every row, or raise" under inclusive,
exclusive, started-date-keyed, day-granular, ignored, and null-completion-date servers.
`tests/paginate-truncation.test.js` covers the silent-loss cases specifically, including
server page caps with and without a tie group.

If the semantics are ever established, record them here — several of those cases could
then be simplified away.

### Remaining differences, both deliberate

- No filter is applied on transaction `state`, so `PENDING` / `REVERTED` rows would
  appear. None were present in the reconciled month.
- `amount` is used rather than `amountWithCharges`. Identical wherever fees were zero.
