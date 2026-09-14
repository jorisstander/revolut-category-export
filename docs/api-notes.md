# Observed API facts

Captured 2026-08-09 from a real account, and **re-verified unchanged on 2026-09-13**:
same client version, same account-type keys, same response envelope, same selector
behaviour, every row still carrying a category.

Most of it comes from `spike/snippet.js`, which you can run yourself. Two things do
not, and the difference matters if you are reproducing this: the request headers were
read off the live web client's own network log — the snippet *sends* `x-client-version`
rather than reading it back — and the custom-categories endpoint below was called by
hand. Everything else in this file is something the snippet prints.

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

Neither is `count`. It is a hint and not a limit: the endpoint has been observed returning
**more rows than were asked for**, so the number of rows on a page says nothing about what
the server holds. A server-side cap and an exhausted feed look identical by page length.
That single observation is why page length is inadmissible as evidence everywhere in the
walk — including for an empty page, which is only page length again.

`src/core/paginate.js` therefore assumes neither. It steps the cursor one millisecond past
the oldest row, so a group sharing a timestamp is re-fetched whether `to` is inclusive or
exclusive. It widens the page rather than stepping over an unread remainder. And when the
walk stalls above the start of the range, it does not infer from page length whether the
feed is finished — it issues one more request asking whether anything older exists. If the
answer is yes it carries on from there. It raises only when the answer is no and the same
rows keep coming back, because that is what says the rest of the range cannot be reached.

Those requests are the difference between a guess and a measurement. Several earlier
versions guessed, in several different ways, and each returned a well-formed file missing
part of a month. They are only reached when the walk stalls — an account whose history runs
out inside the range, a server capping its pages, a cutoff read more coarsely than asked —
and the stall path costs two to four requests more than a clean one.

Two further rules follow from the same principle, that page shape is not evidence:

- **Paging decisions are made on completion dates only.** No filter is applied on
  transaction `state`, so a `PENDING` pre-authorisation that never completed rides along,
  placed by its start date. Folding that start date into a page's minimum made a single
  request look like it had reached the start of history, dropping 201 of 400 rows with no
  error — the loss sits at the old end, where the balance chain cannot see it.
- **An empty page is asked again before it is believed.** This endpoint has been observed
  answering `200` with an empty array while the account still has transactions (above).
  Page length is not evidence anywhere else in the walk, so it cannot be the one exception
  here: a spurious empty page mid-walk would drop everything older than it.

The walk also reads a month below the start of the range before calling it covered. A
transaction belongs to a month by when it *completed*, but the server may order the feed by
when each one *started*; under that ordering a payment started on the 31st and cleared on
the 2nd sits below one that started later and cleared at once.

A week of margin was not enough, and the case that broke it is ordinary: an authorisation
held by a hotel or a car-hire desk for several weeks and captured later starts well before
the month it settles in. On a start-ordered feed it sits below everything the walk reads and
is never fetched, and because the loss is a contiguous run at the oldest end, the balance
chain cannot see it. Measured on such a server, 120 rows of 420 went missing without a word,
and five held authorisations were enough to lose five rows. Thirty days covers the holds that
occur in practice; it cannot cover an unbounded one, and no fixed margin can.

What it can do is notice when it has been outrun. A row already in hand whose hold reaches
past the margin proves this account holds authorisations at least that long, and the walk has
stopped at exactly that depth — so a longer one below is possible and cannot be ruled out
from where it is standing. On a **completion-ordered** feed that costs nothing and the walk
carries on, because such a row arrives on its completion date however long it was held. On a
**start-ordered** one it refuses. Measured: with the check disabled the sweep returns 255 short
files in its server-model section and 60 more among the honest feeds, every one start-ordered,
each losing rows at the oldest end of the month where the balance chain has nothing beneath it
to break against. Turning it on converts all of those into refusals and costs a further 1287
configurations that used to export whole; the completion-keyed half is **identical either way**
at 3300 complete and 2550 refused, and that is the half the observed API belongs to.

Deciding a feed is start-ordered takes two separate readings, because either one alone misses a
shape that costs real rows.

The first is an inversion in the delivered completions wider than two days. Any inversion at
all was too sensitive to ship: delivery order is not ledger order, and a completion-keyed
server that merely sorted on a timestamp truncated to the second refused a complete 340-row
month. Measured on one feed, a genuinely start-ordered server inverts adjacent completions by
31.5 days while a completion-ordered one truncating its sort key to the day inverts by 0.10.

The second exists because the first cannot see a **capture run** — authorisations started
across the weeks before a month and settled together just inside it. They arrive as one
contiguous block of near-identical completions, so the widest inversion seen anywhere on such a
walk was a single millisecond, while the oldest row of the month went missing in silence. Read
it the other way instead: a completion-ordered server shuffles the start dates as soon as
settlement lags differ, so a page still perfectly ordered by *start* while the lags on it
spread wider than the margin is a start-ordered feed. That reading removed 90 silent short
files and cost nothing measurable — the sweep's complete count is 5864 with and without it.

One arrangement defeats both, and is written down here rather than left implied: a capture run
lying *entirely* below the margin, with the account's older history interleaved above it. The
walk stops on that history before it has read a single held row, so it ends holding no evidence
that any hold exists — nothing in the responses distinguishes it from an ordinary account. No
fixed margin makes that visible; a larger one only moves the boundary.

It is not free. For an account whose history runs at about the rate of the month being
exported, a quiet month still costs one request and an ordinary one two to four, because
those rows sit inside a page that would have been read anyway — but a busy month pays for the
margin at its own density: measured, ten requests at 1000 rows a month and twenty at 2000.
Those are **totals**, not what the margin added. `src/core/paginate.js` states the same
measurement the other way round, as the increment — nothing up to 200 rows, one request at
400, four at 900, nine at 2000 — the same measurement, not a disagreement. The
distinction is worth keeping straight: reading those totals as increments is how the code
comment came to claim a small month cost "about three requests more" when it costs none.
Rows outside the range are discarded either way, so the margin buys nothing but the right to
stop. A stall *inside* that margin ends the walk rather than raising: it is
activity outside the month being exported, and it should not be able to abort it.

When the walk stalls, each question it asks the server is shaped by the answer to the last
one. The first probe reaches one millisecond below the oldest *completion* on the page.
Reaching below the oldest *start* date instead looks safer — it excludes those rows whichever
field the server compares — but against a completion-keyed server it steps over every row
that completed in between, and the walk then resumes below the range and stops. Against the
fixture in `tests/paginate-truncation.test.js` that returned 700 rows of 1100 with no error,
and fewer again the tighter the server caps its pages. Three things are then measured rather
than assumed:

- **That there is no second guess when the first probe finds nothing older.** Two server
  models answer that way: one keyed on *start* dates, and one merely rounding the cutoff
  coarser than a millisecond. The walk used to page past it by reaching below the oldest start
  date on the page — the right question for the first model and the wrong one for the second,
  where it steps over every row completing in between: three weeks of a month unread, 100 rows
  of 540, no error. The two cannot be told apart. Ordinary settlement lag makes the coarse
  server satisfy every test for start-date keying tried here, and neither model has ever been
  observed in this API. So the walk refuses instead of picking one. The cost is that a
  start-date-keyed server could not be exported from at all once the cursor stalls; that is
  the right way round, because a refusal is visible and a short file is not.
- **That the group at the stalled instant was read whole**, before the cursor steps past it.
  The group is re-read at `floor + 1`, at the largest size the API will give — a cutoff that
  takes the instant in under an inclusive `to` and an exclusive one alike. Older rows are
  known to exist by that point, and a server with them to offer would have carried on into
  them; an answer holding nothing older than the instant means it stopped short.

  Both shortcuts tried here failed. Reading at `floor` is what an exclusive cutoff excludes by
  construction, so the guard measured nothing and 170 rows of 350 went missing without a word.
  Reading the answer off the page already in hand is no better: that page spans more than one
  instant whenever the cutoff is rounded coarsely, and then nothing checks the group at all —
  100 rows of 540. Neither survives not knowing the semantics, which is the whole problem.
  Measuring it at all replaced a test on page length, which a server capping below the ceiling
  slipped straight under.
- **That a probe answering with nothing settled has been stepped past**, not believed. A
  capped page can be filled entirely by stale `PENDING` rows while settled history remains
  below them; reading that as the end of the feed returned 4 of the 130 settled rows in range
  (out of 132 served, two of them unsettled).

One case stays undecidable from outside, and is therefore refused: more rows sharing a single
timestamp than one request can return. Whether the group ends there or the server truncated it
cannot be told apart, and the remainder would land at the oldest end of the range where the
balance chain is blind.

A narrower version of it has no older rows to lean on, and needed a different measurement.
If a tie group sits at the very oldest instant of the *entire feed* — an account's first month
— there is nothing below it to carry on into, and a server capping its pages below the size of
that group answers every question exactly as a feed that simply ends there would. Asking for
more returns the same rows, and asking for older returns nothing, whichever is true. Left
alone, a 300-row batch behind a 120-row cap exported 170 of 350 rows in silence, under both an
inclusive and an exclusive cutoff.

The request log settles it. A page shorter than the count asked for asserts that there is
nothing more at or below that cutoff — the only claim page length makes that is worth anything,
and one the walk can check, because it goes on to read overlapping pages. Holding more rows
below that cutoff than the answer allowed for is a contradiction, and only a server holding
rows back can produce it. Rows are counted strictly below the cutoff, which every server model
considered here would have had to include, so the contradiction holds whichever is true. An
empty answer makes the same assertion and is never recorded, because that is the one this API
is documented to make falsely.

Once the server has contradicted itself this way, its silence stops being evidence and a tie
group at the bottom of the feed is refused rather than trusted. A complete month that happens
to share one timestamp makes the same short answers but never contradicts them, so it still
exports — `scripts/sweep.mjs` drives every feed an honest server would hand over whole, and
the check refuses none of them that were not already refused for the documented
coarse-cutoff reason.

Cost scales with the size of the range, because one request carries at most one page.
Measured against the module at the default page size, for a month of the stated size against
an account whose history runs at about the same rate as the month: 20 rows is one request,
200 is two, 400 is four, 1000 is ten, 2000 is twenty. A stall can add a probe that asks for
a full page, so a feed that keeps stalling costs roughly double; the sweep's worst completed
export is twenty requests. An account whose
history runs out inside the range costs two to four more, because that is the path that asks
the extra question rather than assuming the answer. The 40-page budget is therefore also a
ceiling on how large a range one export can cover, and a range holding more than that refuses
rather than paging on. Where the ceiling falls depends on what surrounds the range, because
the margins either side are read at whatever density they hold: measured, a little under 8000 rows
where the history behind the range is sparse, and about 4000 where it runs at the same rate
as the range itself — the month-deep margin is read at whatever density it holds.

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

Rows that share an instant are checked as a group rather than in the order they arrived.
There is no documented tiebreaker, so the delivery order of an overnight batch settlement
is not its ledger order, and comparing those rows pairwise as delivered raised
`IncompleteExportError` on a complete export — the file became impossible to write.
Order is not needed to prove nothing is missing. Read each row as a step from the balance
before it to the balance after it: the group is complete exactly when those steps form one
unbroken run using every row once. That takes two tests — the steps must all belong to a
single connected run, and at each balance the number of steps arriving must match the number
leaving, save at the two ends. Counting alone is not enough, because a valid run sitting
beside an unconnected loop cancels out exactly, and the rows missing between them would pass
unseen.

A group whose steps cancel completely is complete too: it ends on the balance it began from.
A payment settling beside its own reversal does that, and so does a pair of zero-amount
authorisations, which this feed is known to emit. Treating that as an accusation refused
8.2% of randomly generated complete batches, which made those months impossible to export at
all. Which balance such a group sat at is decided by the rows around it rather than by the
group itself.

Four things narrow what the check can conclude, each deliberate and each worth knowing:

- A row carrying no settled balance takes no part. A `PENDING` row has not moved the
  balance, so the settled rows either side must still chain directly across it — which is
  what closed the hole where a pending row sitting exactly at a paging gap concealed it.
- A row with no `amount` cannot be subtracted, so the chain cannot be continued across it.
- Where any row in a group carries a non-zero `fee`, a *broken* verdict is softened to
  *unknown* rather than raised. A fee accounted for separately from the amount shifts a step
  by exactly the fee, which cannot be told apart from a missing row; a lone row is given that
  latitude, so a row must not lose it merely by sharing an instant with another. Note the
  limit: this prevents a false accusation, it does **not** switch the check off. A
  fee-carrying group can still be read as a path and chained on the single
  `amountWithCharges ?? amount` convention. No row with a non-zero fee has ever been observed.
- A set whose balances never move carries no ledger information at all. Pockets that
  report no `balance` field therefore get no completeness check, and the guarantee above
  quietly does not apply to them.

A cutoff can also be read *more* coarsely than it is given, and that is refused rather than
walked. A page comes back newest-first and truncated at `count`, so it can only ever leave
out rows OLDER than the ones it carries; a row already seen that is newer than everything on
the page, and still below the cutoff asked for, cannot have been dropped that way. The server
moved the cutoff. An empty answer is the same contradiction at its limit, and is checked
before the walk reads one as the end of the feed — that is how a rounded-down cursor step lost
the last ten rows of a batch.

That check needs something already read to contradict, and at the first request there is
nothing. So the walk also starts a margin ABOVE the range, for the same reason it reads one
below: month boundaries are local rather than UTC, so the range end is rarely midnight
anywhere, and a cutoff rounded down to the day hides the last day of the month. A quiet month
over deep history finishes on that first request and would never notice — 38 rows of 40, at
the newest end, where the balance chain is as blind as it is at the oldest. Rows above the
range are discarded at the end either way.

Four deliberate limits, the first of them the refusal just described: a cutoff read more
coarsely than it was given cannot be paged without gaps, and is refused. A server that rounds
its cutoff coarser than a millisecond is
usually walked to completion regardless — a day-granular cutoff exports a 1000-row month in
seven requests, every row — but where the coarseness actually pins the cursor, the signature
is identical to a server ignoring the parameter entirely, and the tool refuses rather than
guess. More transactions sharing a single timestamp than one
page can return cannot be read whole by any request, so that refuses too: stepping past
them would drop the remainder at the oldest end of the range, where the balance chain
cannot see it. And the request budget is 40 pages: these calls go to someone's bank, and a
server behaving oddly should not be able to drive hundreds of them.

`scripts/sweep.mjs` asks the broader question the tests cannot: across the cutoff semantics,
page caps, account shapes and settlement lags nobody has established for this API, does the
walk ever return a short file without saying so? It builds each server from four independent choices — the field it compares, the field it
orders by, whether the comparison is inclusive, and how coarsely it reads the cutoff — because
a real one is built that way too, and the shapes that hurt come from the combinations. It runs
11700 of them plus 1560 feeds an honest server would hand over whole, and exits non-zero if any
comes back short in silence, or if a server reading the cutoff exactly refuses a complete month.
It is where the round-down cases above were found, where a batch spread over two milliseconds
was found to walk straight through the guard meant to stop it, and where treating each
behaviour as its own self-contained model was found to be the reason none of that had shown up
sooner.

A third section asks what the first two cannot: what happens when the server is not merely
shaped oddly but *unreliable* mid-walk. 1560 configurations inject one spurious empty page, and
26 revert a zero-amount authorisation between two requests. It runs every account shape: the
first version sampled four of them and missed the defect it was written for, because the shapes
that catch a believed empty page are the ones carrying `PENDING` rows and those were the two
left out. Both were added after the fact,
because both were hiding a real defect the sweep was reporting as clean. Every server model
in the first two sections is a filter and a slice: measured, 472 of the 55,747 pages those
two serve come back empty and not one of those is spurious, and no row they have once shown
ever stops being shown. A harness that only ever meets well-behaved servers proves less than its
configuration count suggests.

One combination is deliberately not built: a server that filters on one field and sorts by
another. Nobody builds that, and catching it would mean firing on evidence that accuses an
ordinary server — the two pull in opposite directions. Excluding it hides 276 short files in
the server-model matrix, 21 among the honest feeds and 23 among the unreliable ones, so it is
a limit rather than a clean bill: on such a server the export would be short rather than refused. It is left out
because it cannot be built, not because it is safe.

That figure was wrong here for a while, and the way it went wrong is worth recording: it read
96 for several revisions, which was correct when it was measured and stopped being correct the
moment two new account shapes were added to the sweep in the same commit. A number measured
against a fixture set is only true of that fixture set, and nothing re-measures it.

`tests/paginate-semantics.test.js` holds the walk to "every row, or raise" under inclusive,
exclusive, started-date-keyed, day-granular, ignored, and null-completion-date servers —
"every row" for the ones that can be paged soundly, "or raise" for the ones that cannot.
`tests/paginate-truncation.test.js` covers the silent-loss cases specifically, including
server page caps with and without a tie group.

If the semantics are ever established, record them here — several of those cases could
then be simplified away.

### Remaining differences, both deliberate

- No filter is applied on transaction `state`, so `PENDING` / `REVERTED` rows would
  appear. None were present in the reconciled month.
- `amount` is used rather than `amountWithCharges`. Identical wherever fees were zero.
