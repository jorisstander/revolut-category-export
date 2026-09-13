import { rowsBelongingTo } from './account-scope.js';
import { assertContinuous, instantOf } from './continuity.js';
import { TRANSACTIONS_PATH } from './http.js';

const DEFAULT_PAGE_SIZE = 200;
// A budget, not just a loop guard. These requests go to someone's bank, and a
// server behaving unexpectedly could otherwise drive hundreds of them -- which
// is its own harm regardless of what comes back. Measured: a quiet month costs
// one request, a normal month two, a busy month of 400 rows three, and the
// dearest path -- an account whose history runs out inside the range -- five or
// six. Anything near this ceiling is not a large month, it is something wrong.
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
// falls below `from` can leave it unread. Reading a week further costs at most
// an extra page and removes the guess; rows outside the range are discarded at
// the end either way.
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
  const requestConfirmed = async (size, cutoff) => {
    const page = await request(size, cutoff);
    return page.length > 0 ? page : request(size, cutoff);
  };

  const collect = (rows) => {
    for (const row of rowsBelongingTo(rows, handle.pocketId)) mine.set(row.id, row);
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

    // The page came back full at the ceiling with the cursor still pinned, so
    // there may be more rows at this instant than any single request can return.
    // Stepping past them would drop the remainder at the oldest end of the
    // range, which is exactly where the balance chain cannot see a loss -- so
    // this refuses instead. A refusal is visible; a short file is not.
    if (rows.length >= MAX_PAGE_SIZE) {
      throw new PaginationError(
        `More than ${MAX_PAGE_SIZE} transactions share the timestamp ` +
        `${new Date(floor).toISOString()}, which is more than one page can return, so the rest of ` +
        `them cannot be reached. Refusing to write a partial file.`
      );
    }

    // Widening did not help. Ask the server directly for something older rather
    // than inferring an answer from the page: page length cannot distinguish an
    // exhausted feed from a server capping its response.
    //
    // The cutoff goes one millisecond below the EARLIEST date on the settled
    // rows, not below `floor`. Which field the server compares is unknown, and a
    // cutoff below every date on those rows excludes them under either choice --
    // whereas `floor - 1` still includes them on a server keyed to start dates.
    const earliest = Math.min(...rows
      .filter(row => typeof row.completedDate === 'number')
      .flatMap(row => [row.startedDate, row.completedDate])
      .filter(value => typeof value === 'number'));

    const older = await requestConfirmed(pageSize, (Number.isFinite(earliest) ? earliest : floor) - 1);
    if (older.length === 0) break;

    collect(older);
    const olderCompletions = completionsOf(older);

    // The probe asked for settled transactions older than this page and the
    // server returned none. Anything unsettled it did return has been collected
    // above; there is no more settled history to page into. Raising here would
    // make an account un-exportable because of a stale pre-authorisation sitting
    // at the bottom of its feed.
    if (olderCompletions.length === 0) break;

    const olderFloor = Math.min(...olderCompletions);

    if (olderFloor >= floor) {
      throw new PaginationError(
        `Paging cannot get past ${new Date(floor).toISOString()}: asking for older transactions ` +
        `returns the same ones, so the rest of the range is unreachable. Refusing to write a partial file.`
      );
    }

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
