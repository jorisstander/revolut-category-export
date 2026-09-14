import { rowsBelongingTo } from './account-scope.js';
import { assertContinuous, instantOf } from './continuity.js';
import { TRANSACTIONS_PATH } from './http.js';

const DEFAULT_PAGE_SIZE = 200;
// A budget, not just a loop guard. These requests go to someone's bank, and a
// server behaving unexpectedly could otherwise drive hundreds of them -- which
// is its own harm regardless of what comes back.
//
// Cost scales with the size of the range, because one request carries at most
// one page. Measured against this module at the default page size, for a month
// of the stated size against an account carrying ordinary history behind it: 20
// rows costs one request, 200 two, 400 three, 1000 six, 2000 eleven, 5000
// twenty-six. An account running at that volume continuously costs more, the
// margin below the range being as dense as the range itself. So this ceiling is
// also a limit on how large a range one export can cover -- roughly this many
// pages times the page size, around 8000 rows --
// and a range holding more than that refuses rather than paging on. That is the
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
// falls below `from` can leave it unread. The margin is free for an ordinary
// month -- those rows sit inside a page that would have been read anyway -- and
// costs about a week's transactions divided by the page size for a busy one:
// measured, nothing up to 400 rows a month, one request at 1000, three at 3000.
// Rows outside the range are discarded at the end either way.
const SETTLEMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

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
const keyOf = (row) => (row.id ?? `${row.startedDate}|${row.completedDate}|${row.amount}|${row.description}`);

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
  let cursor = to;
  let count = pageSize;
  let requests = 0;

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

  const collect = (rows) => {
    for (const row of rowsBelongingTo(rows, handle.pocketId)) mine.set(keyOf(row), row);
  };

  while (true) {
    const rows = await requestConfirmed(count, cursor);
    if (rows.length === 0) break; // confirmed twice: the feed has run out

    collect(rows);

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
    if (floor < from - SETTLEMENT_GRACE_MS) break;

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

    // Whether this page is nothing but the stalled instant. If it is, the page
    // is exactly the part of that group the server chose to hand over, and there
    // is no row below it on the page to show the group ended.
    const allAtFloor = completionsOf(rows).every(value => value === floor);

    let older = await requestConfirmed(pageSize, floor - 1);

    if (older.length === 0) {
      // Nothing older exists, so this group ends the feed. It is whole only if
      // the server had room to hand over all of it: a page filled to the ceiling
      // by a single instant may have been cut, and the remainder would sit at
      // the oldest end of the range where the balance chain is blind.
      if (allAtFloor && rows.length >= count) throw tooManyAtOneInstant();
      break;
    }
    collect(older);
    let olderFloor = oldestCompletion(older);

    // A probe page holding no completions at all proves nothing. A capped page
    // can be filled entirely by stale PENDING rows while settled history remains
    // below them -- reading that as "the feed has run out" returned 4 rows of
    // 132. Step below those rows and ask again rather than concluding from them.
    if (olderFloor === null) {
      const instants = older.map(instantOf).filter(value => typeof value === 'number');
      if (instants.length === 0) throw unreachable();
      older = await requestConfirmed(pageSize, Math.min(...instants) - 1);
      if (older.length === 0) break; // genuinely the end: only unsettled rows remained
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
