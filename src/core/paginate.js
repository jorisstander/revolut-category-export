import { rowsBelongingTo } from './account-scope.js';
import { assertContinuous, instantOf } from './continuity.js';
import { TRANSACTIONS_PATH } from './http.js';

const DEFAULT_PAGE_SIZE = 200;
// A budget, not just a loop guard. These requests go to someone's bank, and a
// server behaving unexpectedly could otherwise drive hundreds of them -- which
// is its own harm regardless of what comes back.
//
// Cost scales with the size of the range, because one request carries at most
// one page. Measured against this module at the default page size, for an
// account whose history runs at about the rate of the month being exported: 20
// rows costs one request, 200 two, 400 four, 1000 ten, 2000 twenty. So this ceiling is
// also a limit on how large a range one export can cover -- roughly this many
// pages times the page size. Where it falls depends on what surrounds the
// range, because the margins either side are read at whatever density they
// hold: measured, a little under 8000 rows where the history behind the range is
// sparse, and about 4000 where it runs at the same rate as the range itself.
// A range holding more than that refuses rather than paging on. That is the
// intended trade: a personal account does not see 8000 transactions in a month,
// and a visible refusal beats an unbounded run of requests against a bank.
const DEFAULT_MAX_PAGES = 40;

// Ceiling for the page-size escalation used when one timestamp fills a page.
const MAX_PAGE_SIZE = 2000;

// How far below `from` the walk keeps reading before it calls the range covered.
//
// A transaction is placed in a month by when it COMPLETED, but the server may
// order and filter the feed by when each one STARTED -- that is one of the
// behaviours this module refuses to guess about. Under that ordering a payment
// started on the 31st and cleared on the 2nd sits below a same-day payment that
// started later and cleared immediately, so stopping the moment a completion
// falls below `from` can leave it unread.
//
// A week of margin was not enough. A hotel or car-hire authorisation is held for
// weeks and captured later, so it starts well before the month it settles in --
// and on a start-ordered feed it sits below everything the walk reads, never
// fetched, its loss a contiguous run at the oldest end where the balance chain
// is blind. Measured on such a server: 120 rows of 420 gone without a word, and
// five held authorisations were enough to lose five rows. Thirty days covers the
// holds that actually occur.
//
// It cannot cover an unbounded one, and no fixed number can. What it can do is
// notice: where a row already in hand was held past this margin, the walk stops
// on a start-ordered feed rather than guessing that nothing longer lies below.
// See the stop condition itself for that.
//
// It is not free, though it is cheaper than it reads. Measured against history
// running at the exported month's own rate, this margin adds nothing at all up
// to 200 rows in the month -- those rows sit inside a page that would have been
// read anyway -- one request at 400, four at 900 and nine at 2000. Rows outside
// the range are discarded at the end either way, so the margin buys nothing
// except the right to stop.
const SETTLEMENT_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

// How far ABOVE the range the walk starts, which is a different question with a
// different answer. Below the range it is chasing settlement lag, which runs to
// days. Above it, it is only covering a cutoff read more coarsely than it was
// given -- a whole day at the worst seen -- and every extra hour up here is rows
// fetched and thrown away. A week of it cost six requests on a 5000-row month
// and put the export budget out of reach at 5600.
const CUTOFF_ROUNDING_MS = 2 * 24 * 60 * 60 * 1000;

// How wide a completion inversion has to be before it is read as evidence that
// the server sorts by start date. Below this it is ordinary tie-breaking:
// measured, a completion-ordered server bucketing its sort key to the day
// inverts adjacent completions by 0.10 days on a busy month and 0.78 on a sparse
// one, timezone-shifted buckets included. Above it, a genuinely start-ordered
// feed inverts by tens of days.
//
// The same number as CUTOFF_ROUNDING_MS today, deliberately not the same
// constant: that one trades request cost against a coarsely-read cutoff, and
// tuning it for that reason must not quietly retune this.
const ORDERING_NOISE_MS = 2 * 24 * 60 * 60 * 1000;

export class PaginationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaginationError';
  }
}

/**
 * The completion dates on a page.
 *
 * Every paging decision is made on these and nothing else. A row that never
 * completed is placed by its start date, and no state filter is applied to the
 * feed, so a stale PENDING pre-authorisation from an earlier month rides along
 * in the results. Letting it into the page's minimum dragged that minimum below
 * `from` and ended the walk after a single request -- with the rest of the
 * month unread, no error, and an intact balance chain, because the loss was at
 * the old end where the chain cannot see it.
 */
const completionsOf = (rows) => rows.map(row => row.completedDate).filter(value => typeof value === 'number');

/**
 * What identifies a row across the overlapping pages the walk reads.
 *
 * The id, where there is one. `normalize.js` treats a missing id as ordinary
 * rather than an error, and keying those on `undefined` collapsed every one of
 * them into a single entry -- so they fall back to what the row is made of.
 */
const keyOf = (row) => {
  // Every transaction this API has been seen to return carries an id, and the
  // walk needs one: pages overlap by design, so rows are recognised across them
  // by identity. Falling back to what the row is made of looked safe and is not
  // -- two zero-amount authorisations at the same instant with the same
  // description are identical in every field, collapse into one entry, and the
  // balance chain cannot see the loss because neither moved the balance.
  if (row.id === undefined || row.id === null || row.id === '') {
    throw new PaginationError(
      `A transaction came back with no id, so it cannot be told apart from another like it ` +
      `across the overlapping pages this walk reads, and this export would be at risk of ` +
      `dropping one of them silently. Refusing to write a file that may be missing rows.`
    );
  }
  return row.id;
};

/**
 * A label for a row the walk is only keeping track of, not exporting.
 *
 * Identity has to be exact for rows that reach the file, and `keyOf` refuses
 * without it. Rows from the other pockets in the wallet never reach the file --
 * they are filtered out before anything is written -- so a malformed one among
 * them must not be able to refuse somebody's month.
 *
 * A collision here makes the bookkeeping below WEAKER, not safer: two rows
 * collapse into one entry, so `shown` under-counts and both the capping check
 * and the coarse-cutoff detector have less to contradict the server with. It
 * costs sensitivity, never correctness — which is the right way round, but not
 * the "more conservative" this comment claimed for several revisions.
 */
const labelOf = (row) => (
  row.id || `${row.startedDate}|${row.completedDate}|${row.amount}|${row.description}`
);

/** The oldest completion on a page, or null when nothing on it has settled. */
const oldestCompletion = (rows) => {
  const completions = completionsOf(rows);
  return completions.length > 0 ? Math.min(...completions) : null;
};

/**
 * Page backwards through the transaction feed until `from` is passed.
 *
 * `count` is a hint, never a page size: the API returns more rows than asked
 * for, and consecutive pages overlap, so rows are de-duplicated by id.
 *
 * Progress is measured across *all* rows seen, not just ours: a `walletId`
 * selector returns other pockets' rows too, and those still advance the cursor.
 *
 * @param {{get: Function, handle: Object, from: number, to: number,
 *          pageSize?: number, maxPages?: number}} options
 * @returns {Promise<Array>} rows of this account within [from, to), newest first
 */
export async function fetchRange({ get, handle, from, to, pageSize = DEFAULT_PAGE_SIZE, maxPages = DEFAULT_MAX_PAGES }) {
  if (!handle?.selector) throw new PaginationError('account handle has no usable selector');

  const mine = new Map();
  let gaveUpOnTopMargin = false;
  // Whether any page has come back out of COMPLETION order. A server ordering by
  // start date gives itself away as soon as settlement lags differ, and it
  // matters because the walk stops on a page's oldest completion -- which, on
  // such a feed, is not where the server's own cursor has reached.
  //
  // Set from the main loop's pages only, not from the probe pages read by
  // `cutoffWasMoved`, `cappingConfirmed` or the stall path. That asymmetry costs
  // sensitivity and nothing else -- a feed whose ordering only ever shows on a
  // probe page goes unnoticed and the walk behaves as it did before this existed.
  let notCompletionOrdered = false;
  // The walk starts a margin ABOVE the range, for the same reason it reads a
  // margin below it. A server rounding its cutoff to whole days is as plausible
  // as one rounding up, and month boundaries are local rather than UTC, so the
  // range end is rarely midnight anywhere: rounding it down hides the last day
  // of the month. That loss sits at the NEWEST end, where the balance chain is
  // as blind as it is at the oldest -- six rows of a 200-row month went missing,
  // measured. (Said that way round on purpose: elsewhere in this project "38
  // rows of 40" counts what came BACK, and the same mechanism is described both
  // ways in two files that cite each other.) Rows above the range are discarded
  // at the end either way.
  let cursor = to + CUTOFF_ROUNDING_MS;
  let count = pageSize;
  let requests = 0;

  // Whether the server has been caught capping its pages.
  //
  // A page shorter than the count asked for is an assertion: there is nothing
  // more at or below that cutoff. It is the only claim page length makes that is
  // worth anything -- and it can be checked, because the walk goes on to read
  // overlapping pages. Hold more rows below that cutoff than the answer allowed
  // for and the server has contradicted itself, which it can only do by holding
  // rows back.
  //
  // Rows are counted STRICTLY below the cutoff, which every server model would
  // have had to include: an inclusive `to` returns those and more, an exclusive
  // one returns exactly those, a coarse one rounding the cutoff UP takes in more
  // still, and one keyed on start dates sees a start no later than the instant
  // used here. So a contradiction is a contradiction whichever of those is true.
  // A cutoff rounded DOWN is the one shape this argument does not cover; such a
  // server is refused by the balance chain at any volume where it would matter,
  // and never silently shortened, but it could in principle be accused here.
  const shown = new Map();   // every row the server has produced, any pocket
  const claims = [];         // { cutoff, reached, atMost } from each short answer
  let capping = false;

  const noteAnswer = (page, size, cutoff) => {
    // Only SETTLED rows are counted, on both sides of the comparison. An
    // unsettled row's instant is its start date and is not stable: a
    // pre-authorisation released between two requests leaves a row recorded here
    // that the server will never show again, and the walk then accuses an honest
    // server of holding rows back. A settled transaction does not move.
    const settled = page.filter(row => typeof row.completedDate === 'number');
    for (const row of settled) {
      shown.set(labelOf(row), { completed: row.completedDate, started: row.startedDate });
    }
    // An EMPTY answer makes the same assertion, but it is the one this API is
    // documented to make falsely, so it is never recorded as a claim -- only
    // answers that came back with something, and with less than was asked for.
    // Restricting the count to settled rows is not enough on its own: a SETTLED
    // row can leave the feed too. A zero-amount card authorisation that reverts
    // between two requests does exactly that, and `shown` is never pruned, so it
    // was counted against every later claim for the rest of the walk.
    //
    // A short page asserts "nothing more at or below this cutoff", and it is
    // truncated from its OLDEST end -- so anything it withheld lies at or below
    // its own oldest instant. Count the contradiction THERE rather than across
    // the whole window under the cutoff: a row that has vanished from the part
    // of the window the page did reach has left the feed, and is not evidence of
    // capping. Counting the whole window refused a complete first-month export
    // over one reverted authorisation -- 9 of 36 shapes, on a server reading the
    // cutoff exactly and capping nothing -- and did it with a message blaming a
    // shared timestamp that was not there.
    //
    // The bound is `<= reached`, not `< reached`: a page withholding rows sheds
    // them from the group sitting AT its oldest instant before it sheds anything
    // below, so excluding that instant stops the real capping cases being seen.
    if (page.length > 0 && page.length < size) {
      const reached = settled.length > 0 ? Math.min(...settled.map(row => row.completedDate)) : cutoff;
      claims.push({ cutoff, reached, atMost: settled.filter(row => row.completedDate <= reached).length });
    }
    if (capping) return;
    for (const claim of claims) {
      let below = 0;
      for (const seen of shown.values()) {
        if (seen.completed < claim.cutoff && seen.completed <= claim.reached) below++;
      }
      if (below > claim.atMost) { capping = true; return; }
    }
  };

  const request = async (size, cutoff) => {
    if (requests >= maxPages) {
      throw new PaginationError(
        `Exceeded ${maxPages} pages without reaching the start of the range. Refusing to write a partial file.`
      );
    }
    requests++;
    const page = await get(TRANSACTIONS_PATH, {
      [handle.selector.name]: handle.selector.value,
      count: size,
      to: cutoff
    });
    if (!Array.isArray(page)) {
      throw new PaginationError(
        `Expected an array of transactions from ${TRANSACTIONS_PATH}, received ${page === null ? 'null' : typeof page}. ` +
        `The API's response shape may have changed; refusing to write a file.`
      );
    }
    noteAnswer(page, size, cutoff);
    return page;
  };

  // An empty answer is asked again before it is believed. This endpoint has been
  // observed returning 200 with an empty array while the account still has
  // transactions (docs/api-notes.md), and page length is not treated as evidence
  // anywhere else in this walk -- it cannot be the one exception here, because
  // believing a spurious empty page mid-walk drops everything older than it.
  // The second ask is deliberately not byte-identical: an empty answer produced
  // by throttling or a cache is the least likely to differ when the question is
  // repeated exactly, and one extra row costs nothing.
  const requestConfirmed = async (size, cutoff) => {
    const page = await request(size, cutoff);
    return page.length > 0 ? page : request(size + 1, cutoff);
  };

  /**
   * Whether the server answered a cutoff other than the one it was given.
   *
   * A page is newest-first and truncated at `count`, so it can only ever leave
   * out rows OLDER than the ones it carries. A row already known to the walk
   * that is newer than everything on the page, and still below the cutoff asked
   * for, cannot have been dropped that way: the server must have moved the
   * cutoff down -- rounding it to a whole day or hour, say. Every cursor step
   * then skips the rows between where the cutoff was asked and where it landed.
   *
   * Reading a margin above the range covers a cutoff rounded down at the range
   * end. This is the same behaviour met in the middle of the walk, where the
   * margin cannot help, and it is refused rather than guessed at.
   */
  const cutoffWasMoved = async (page, cutoff) => {
    const settled = page.map(row => row.completedDate).filter(value => typeof value === 'number');
    // An EMPTY answer is the same contradiction taken to its limit: rows already
    // handed over at a higher cutoff must still be at or below this one. It is
    // checked before the walk reads an empty page as the end of the feed, which
    // is how a rounded-down cursor step lost the last ten rows of a batch.
    // The window this page covers, under EITHER ordering. A page is truncated
    // from its oldest end, so a row above the page's minimum cannot have been
    // dropped that way -- but which field "oldest" means depends on what the
    // server sorted by, and that is not established either. A row above both
    // minima is inside the covered window whichever it was.
    //
    // Measuring the window from the page's newest COMPLETION instead was wrong:
    // on a server ordering by start date, one row with ordinary settlement lag
    // sits low by start and high by completion, lifting that mark above anything
    // a rounded cutoff had hidden. The loss it permits is small -- three rows in
    // seven hundred and fifty-six, across twenty-five thousand randomised
    // servers -- and the premise was wrong either way, which is the reason for
    // the change rather than the size of what it caught.
    const starts = page.map(row => row.startedDate).filter(value => typeof value === 'number');
    const floorCompleted = settled.length > 0 ? Math.min(...settled) : -Infinity;
    const floorStarted = starts.length > 0 ? Math.min(...starts) : -Infinity;
    const onPage = new Set(page.map(labelOf));

    const missing = [];
    for (const [label, seen] of shown) {
      if (onPage.has(label)) continue;
      if (!(seen.completed < cutoff && typeof seen.started === 'number' && seen.started < cutoff)) continue;
      if (seen.completed > floorCompleted && seen.started > floorStarted) {
        missing.push({ label, instant: seen.completed });
      }
    }
    if (missing.length === 0) return false;

    // Something that was handed over before is not here now, and there are two
    // reasons for that: the server is reading the cutoff more coarsely than it
    // was given, or the transaction has left the feed -- a card authorisation
    // reverted between two requests does exactly this.
    //
    // Counting them cannot tell those apart. Requiring two accepted a coarse
    // cutoff that hid a single row, and requiring one accused an honest server
    // over a reverted authorisation; a zero-amount row makes the balance chain
    // blind either way, so whichever it was would have been the only thing the
    // user ever saw. So ask. A row that has left the feed stays gone when the
    // question is put again above it; one the server is holding back comes
    // straight back.
    // The question has to clear the rounding window, or it is distorted the same
    // way the original was: asked one millisecond above the row, a server reading
    // cutoffs to the day rounds that back down and hides it again, and the walk
    // concludes it has left the feed. Asked a margin above, the row survives the
    // rounding and comes back.
    // Asked through `requestConfirmed`, because this is the one place the walk
    // reads an answer's LENGTH as evidence: an empty answer here says "the row
    // is gone" and waves the alarm off. That made it the single exception to the
    // rule stated above, and a spurious empty page landing on exactly this
    // request let a coarse cutoff through -- 200 rows of 270 came back with no
    // error, the whole batch at the oldest end, where the balance chain is blind.
    // (That is the fixture in `tests/paginate-truncation.test.js` which pins
    // this. It read 438 for two commits, copied from a scratch reproduction
    // instead of the fixture that ships, and survived one commit that claimed to
    // have fixed it because a restore step put the old text back unnoticed.)
    const highest = Math.max(...missing.map(row => row.instant));
    const again = await requestConfirmed(MAX_PAGE_SIZE, highest + CUTOFF_ROUNDING_MS);
    const labels = new Set(again.map(labelOf));
    if (missing.some(row => labels.has(row.label))) return true;

    // It did not come back. That settles it if the answer reached down to where
    // the row should have been, or if it was not truncated -- a server handing
    // over everything it holds below a cutoff has said there is nothing there.
    // Only a truncated answer that never got that far says nothing either way,
    // and saying nothing is not permission to carry on.
    const reached = again.some(row => typeof row.completedDate === 'number' && row.completedDate <= highest);
    return !reached && again.length >= MAX_PAGE_SIZE;
  };

  const collect = (rows) => {
    for (const row of rowsBelongingTo(rows, handle.pocketId)) mine.set(keyOf(row), row);
  };

  /**
   * Whether the server has been caught capping, asking one more question first.
   *
   * A server capping at or above the page size never returns a page short of
   * what was asked for during the walk, so it never contradicts itself and the
   * check above never fires: a batch at the oldest instant of a first month came
   * back 250 rows of 350, and at a cap of 899, 949 of 950 -- one row short, well
   * formed, and past the balance chain because the loss sits where it is blind.
   *
   * Every hypothesis agrees about the stalled instant. They disagree about the
   * whole range, which is why this re-asks the range end at the ceiling: an
   * honest server hands back everything it holds, a capping one hands back its
   * cap, and that answer is short of what was asked and contradicts what the
   * walk already has. It runs only on the end-of-feed stall path.
   */
  const cappingConfirmed = async () => {
    if (!capping) collect(await requestConfirmed(MAX_PAGE_SIZE, to));
    return capping;
  };

  while (true) {
    const rows = await requestConfirmed(count, cursor);

    if (await cutoffWasMoved(rows, cursor)) {
      throw new PaginationError(
        `The server answered a cutoff of ${new Date(cursor).toISOString()} with nothing newer than ` +
        `the rows it returned, while transactions are known to lie in between. It is reading the ` +
        `cutoff more coarsely than it was given, so paging cannot cover the range without gaps. ` +
        `Refusing to write a partial file.`
      );
    }

    if (rows.length === 0) break; // confirmed twice, and nothing known contradicts it

    collect(rows);

    for (let i = 1; i < rows.length; i++) {
      const newer = rows[i - 1].completedDate;
      const older = rows[i].completedDate;
      // Only an inversion big enough to HIDE A HOLD counts. Treating any
      // inversion at all as evidence was far too sensitive: a completion-keyed
      // server reading the cutoff exactly and capping nothing, which merely
      // sorted on a timestamp truncated to the second and returned rows within
      // that second oldest-first, refused a complete 340-row month. Delivery
      // order is not ledger order -- `continuity.js` had to learn the same thing
      // about batch settlements -- so it cannot carry a refusal on its own.
      //
      // Measured on one feed: genuinely start-ordered inverts by 31.5 days; a
      // completion-ordered server truncating its sort key to the DAY inverts by
      // 0.10 days; to the second or hour, not at all.
      if (typeof newer === 'number' && typeof older === 'number' &&
          older - newer > ORDERING_NOISE_MS) {
        notCompletionOrdered = true;
        break;
      }
    }

    // The other way round, because inversion size alone misses the shape that
    // matters most. A CAPTURE RUN -- authorisations started across the weeks
    // before the month and settled together just inside it -- arrives on a
    // start-ordered feed as one contiguous block of near-identical completions.
    // There is no inversion to measure: the widest the walk saw on such a feed
    // was ONE MILLISECOND, while it lost the oldest row of the month in silence.
    //
    // So read the evidence the other way. A completion-ordered server shuffles
    // the start dates as soon as settlement lags differ, so a page that is still
    // perfectly ordered by START while the lags on it spread wider than the
    // margin is a start-ordered feed. The lag-spread condition is what keeps an
    // ordinary page out of it: where every row settled in about the same time,
    // the two orderings agree and neither can hide anything from the other.
    let startsDescending = true;
    let minLag = Infinity;
    let maxLag = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      const started = rows[i].startedDate;
      const completed = rows[i].completedDate;
      if (typeof started === 'number' && typeof completed === 'number') {
        minLag = Math.min(minLag, completed - started);
        maxLag = Math.max(maxLag, completed - started);
      }
      const previous = i > 0 ? rows[i - 1].startedDate : null;
      if (typeof started === 'number' && typeof previous === 'number' && started > previous) {
        startsDescending = false;
      }
    }
    if (startsDescending && maxLag - minLag > SETTLEMENT_GRACE_MS) notCompletionOrdered = true;

    const completions = completionsOf(rows);
    if (completions.length === 0) {
      // Nothing settled on this page, so there is no sound way to step the
      // cursor. Widen first; a page of nothing but pending rows is not a state
      // this API has ever been seen in, and guessing a step here is how rows
      // get skipped.
      if (count < MAX_PAGE_SIZE) { count = MAX_PAGE_SIZE; continue; }
      throw new PaginationError(
        `A full page of ${rows.length} transactions contained no completed ones, so there is no ` +
        `settled date to page by. Refusing to write a partial file.`
      );
    }

    const floor = Math.min(...completions);

    // Strictly older, not `<=`. Rows landing exactly on `from` are inside the
    // range, and a page can be cut part-way through a group of them.
    if (floor < from - SETTLEMENT_GRACE_MS) {
      // The margin is a fixed guess at how long a hold can run, and no fixed
      // guess covers an unbounded one. On a COMPLETION-ordered feed that costs
      // nothing: such a row is returned on its completion date regardless of how
      // long it was held. On a start-ordered one it sits below everything the
      // walk reads, and the loss lands at the oldest end of the range, where the
      // balance chain is blind -- one row of three hundred, well formed, silent.
      //
      // The account says whether that is a live risk. A row already in hand
      // whose hold reaches past the margin proves this account holds
      // authorisations at least that long, and the walk has stopped at exactly
      // that depth, so a longer one below is possible and cannot be ruled out
      // from here. Refuse instead of guessing. Where no such row exists the
      // margin has not been tested and the walk stops as before.
      const heldPastTheMargin = [...mine.values()].some(row =>
        typeof row.completedDate === 'number' && row.completedDate >= from && row.completedDate < to &&
        typeof row.startedDate === 'number' && row.startedDate < from - SETTLEMENT_GRACE_MS);
      if (notCompletionOrdered && heldPastTheMargin) {
        throw new PaginationError(
          `This account holds transactions for longer than the ${SETTLEMENT_GRACE_MS / 86400000} days ` +
          `of history read below the range, and the server is ordering by start date rather than ` +
          `completion date — so a transaction held longer still would sit below everything paging ` +
          `can reach, and its absence would not show in the balances. Refusing to write a file that ` +
          `may be missing the oldest transactions in the range.`
        );
      }
      break;
    }

    // Step one millisecond PAST the oldest completion rather than onto it, so a
    // group sharing a timestamp is re-fetched whether the cutoff is inclusive or
    // exclusive. The id map de-duplicates the repeats.
    if (floor + 1 < cursor) {
      cursor = floor + 1;
      count = pageSize;
      continue;
    }

    // The cursor is pinned: one timestamp covers the page, or the cutoff is
    // being treated more coarsely than a millisecond. Widen before concluding
    // anything -- reading the rest of the group is what lets the walk move on.
    //
    // Straight to the ceiling rather than up in steps. Each step is another
    // request to someone's bank, and a ladder of them asks the same pinned
    // question five times over; one larger read settles it once.
    if (count < MAX_PAGE_SIZE) {
      count = MAX_PAGE_SIZE;
      continue;
    }

    // Stalled ABOVE the range, in the margin read to cover a rounded cutoff.
    // Those rows are not in the export at all, so a batch sitting up here must
    // not be able to refuse the month below it -- the same principle the margin
    // below the range already follows. Give up on the margin and start again at
    // the range end; the walk has read nothing of the month yet, so it cannot
    // simply stop the way it can down below.
    if (floor > to) {
      // Once, and only once. The escape sets the cursor to the range end, so a
      // server still answering above it puts the walk in exactly the state it
      // was already in: it asked the same cutoff 37 times out of a 40-request
      // budget before failing with a message about range size. These requests
      // go to someone's bank.
      if (gaveUpOnTopMargin) {
        throw new PaginationError(
          `The server keeps answering with transactions from after ${new Date(to).toISOString()}, ` +
          `so the walk cannot reach the range being exported. Refusing to write a partial file.`
        );
      }
      gaveUpOnTopMargin = true;
      cursor = to;
      count = pageSize;
      continue;
    }

    // Past the range proper. Everything from `from` upward has already been
    // read, and what is left below is only the settlement margin. A stalled
    // batch down here says nothing about the month being exported, so the walk
    // ends rather than refusing over activity outside the range: a 2400-row
    // batch a few days below `from` used to turn a clean export into an error.
    if (floor < from) break;

    const unreachable = () => new PaginationError(
      `Paging cannot get past ${new Date(floor).toISOString()}: asking for older transactions ` +
      `returns the same ones, so the rest of the range is unreachable. Refusing to write a partial file.`
    );

    // Widening did not help. Ask the server directly for something older rather
    // than inferring an answer from the page: page length cannot distinguish an
    // exhausted feed from a server capping its response.
    //
    // The first cutoff goes one millisecond below the oldest COMPLETION here.
    // Reaching below the oldest START date instead looked safer, because it
    // excludes these rows whichever field the server compares -- but on a
    // completion-keyed server it steps clean over every row that completed
    // between that start date and this instant. The walk then resumes below
    // `from` and stops, and the loss lands at the oldest end of the range, where
    // the balance chain cannot see it -- 700 rows of 1100 against the fixture in
    // tests/paginate-truncation.test.js, and fewer the tighter the server caps.
    const tooManyAtOneInstant = () => new PaginationError(
      `More transactions share the timestamp ${new Date(floor).toISOString()} than one request ` +
      `can return, so the rest of them cannot be reached. Refusing to write a partial file.`
    );

    let older = await requestConfirmed(pageSize, floor - 1);

    if (older.length === 0) {
      // Nothing older exists, so this group ends the feed. It is whole only if
      // the server had room to hand over all of it: a page filled to the ceiling
      // by a single instant may have been cut, and the remainder would sit at
      // the oldest end of the range where the balance chain is blind.
      //
      // A server caught capping has already shown it withholds rows while
      // claiming to have none left, so its silence here proves nothing either.
      // Was this page filled to what was asked for? If so the server may have
      // cut it part-way through the oldest instant on it, and nothing older
      // exists to show otherwise. An earlier version asked instead whether the
      // whole page sat at that instant -- but the instant IS the page's minimum
      // by construction, so a single row a millisecond above the batch answered
      // no and disarmed the guard: 2300 rows of 2700, at the end of the range
      // where the balance chain is blind.
      if (rows.length >= count || await cappingConfirmed()) throw tooManyAtOneInstant();
      break;
    }
    collect(older);
    let olderFloor = oldestCompletion(older);

    // A probe page holding no completions at all proves nothing. A capped page
    // can be filled entirely by stale PENDING rows while settled history remains
    // below them -- reading that as "the feed has run out" returned 4 of the 130
    // settled rows in range, out of 132 served, the other two being the unsettled
    // ones. Step below those rows and ask again rather than concluding from them.
    if (olderFloor === null) {
      const instants = older.map(instantOf).filter(value => typeof value === 'number');
      if (instants.length === 0) throw unreachable();
      older = await requestConfirmed(pageSize, Math.min(...instants) - 1);
      if (older.length === 0) {
        // The end of the feed, reached through unsettled rows -- and the same
        // question still has to be asked as on any other end-of-feed exit: was
        // the group at this instant handed over whole? Leaving it out here let a
        // few stale pre-authorisations at the bottom of a feed carry the walk
        // straight past a truncated batch, on a server that was not even capping:
        // 2022 rows of 2420. Removing the pre-authorisations from the same feed
        // made it refuse, which is what gave the omission away.
        if (rows.length >= count || await cappingConfirmed()) throw tooManyAtOneInstant();
        break;
      }
      collect(older);
      olderFloor = oldestCompletion(older);
      if (olderFloor === null) throw unreachable(); // still cannot see past them
    }

    // Rows came back, but none of them older by completion. Either the feed ends
    // here, or `to` is not being compared against the completion date at all --
    // a server keyed on START dates, or one rounding the cutoff coarser than a
    // millisecond, both answer exactly this way.
    //
    // Earlier versions tried to page past it by reaching below the oldest START
    // date on the page. That is the right question for a start-date-keyed server
    // and the wrong one for a coarse-rounded server, where it steps over every
    // row completing in between: three weeks of a month went unread and 100 rows
    // of 540 came back with no error. The two cannot be told apart -- ordinary
    // settlement lag makes a coarse server satisfy every test for start-date
    // keying that has been tried here -- and neither has ever been observed in
    // this API. So the walk refuses rather than pick one and be silently wrong.
    if (olderFloor >= floor) throw unreachable();

    // Older rows are now known to exist, so the group at this instant can be
    // shown to have been read whole before the cursor steps past it. Ask for the
    // largest page the API will give at `floor + 1`: that cutoff takes in the
    // instant under an inclusive `to` and an exclusive one alike. A server with
    // older rows to offer would have carried on into them; an answer holding
    // nothing older than this instant means it stopped short, and the remainder
    // would land at the oldest end of the range where the chain cannot see it.
    //
    // Measuring this at all replaced a test on page length, which the rest of
    // this walk rejects as evidence and which a server capping below the ceiling
    // slipped straight under: 170 rows of 350.
    //
    // The cutoff is then the whole point, and both shortcuts tried here failed
    // on it. At `floor`, an exclusive `to` excludes the very group being
    // measured, so the guard could never fire and lost those same 170 rows in
    // silence. Reading the answer off the page already in hand is no better --
    // that page spans more than one instant whenever the cutoff is rounded
    // coarsely, and then nothing checks the group at all: 100 rows of 540.
    // Neither survives not knowing the semantics, which is the whole problem.
    const whole = await requestConfirmed(MAX_PAGE_SIZE, floor + 1);
    collect(whole);
    if (!completionsOf(whole).some(value => value < floor)) throw tooManyAtOneInstant();

    cursor = olderFloor + 1;
    count = pageSize;
  }

  const rows = [...mine.values()]
    .filter(row => typeof instantOf(row) === 'number' && instantOf(row) >= from && instantOf(row) < to)
    .sort((a, b) => instantOf(b) - instantOf(a));

  // The walk above is careful, but every rule in it is a belief about an
  // undocumented API. This is the part that does not depend on being right:
  // a gap in the balance chain proves a transaction is missing, whatever the
  // server did to cause it.
  return assertContinuous(rows);
}
