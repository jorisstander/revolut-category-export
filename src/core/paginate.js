import { rowsBelongingTo } from './account-scope.js';
import { assertContinuous } from './continuity.js';
import { TRANSACTIONS_PATH } from './http.js';

const DEFAULT_PAGE_SIZE = 200;
// A budget, not just a loop guard. These requests go to someone's bank, and a
// server behaving unexpectedly could otherwise drive hundreds of them -- which
// is its own harm regardless of what comes back. A normal month costs three to
// five; anything past this is not a large month, it is something wrong.
const DEFAULT_MAX_PAGES = 40;

// Ceiling for the page-size escalation used when one timestamp fills a page.
const MAX_PAGE_SIZE = 2000;

export class PaginationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaginationError';
  }
}

const instantOf = (row) => row.completedDate ?? row.startedDate;

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

  const fetchPage = (count, cutoff) => get(TRANSACTIONS_PATH, {
    [handle.selector.name]: handle.selector.value,
    count,
    to: cutoff
  });

  const mine = new Map();
  let cursor = to;
  let count = pageSize;
  let pages = 0;
  let reachedStart = false;

  while (pages < maxPages) {
    pages++;
    const rows = await fetchPage(count, cursor);

    if (!Array.isArray(rows)) {
      throw new PaginationError(
        `Expected an array of transactions from ${TRANSACTIONS_PATH}, received ${rows === null ? 'null' : typeof rows}. ` +
        `The API's response shape may have changed; refusing to write a file.`
      );
    }
    if (rows.length === 0) { reachedStart = true; break; }

    for (const row of rowsBelongingTo(rows, handle.pocketId)) mine.set(row.id, row);

    const dated = rows.map(instantOf).filter(value => typeof value === 'number');
    if (dated.length === 0) {
      throw new PaginationError(`Page ${pages} contained no rows with a usable date; cannot page further.`);
    }

    const oldest = Math.min(...dated);

    // Strictly older, not `<=`. Rows landing exactly on `from` are inside the
    // range, and a page can be cut part-way through a group of them.
    if (oldest < from) { reachedStart = true; break; }

    // Step one millisecond PAST the oldest row rather than onto it, so a group
    // sharing a timestamp is re-fetched whether the cutoff is inclusive or
    // exclusive. The id map de-duplicates the repeats.
    if (oldest + 1 < cursor) {
      cursor = oldest + 1;
      count = pageSize;
      continue;
    }

    // The cursor is pinned: one timestamp covers the page, or the cutoff is
    // being treated more coarsely than a millisecond. Widen before concluding
    // anything -- reading the rest of the group is what lets the walk move on.
    if (count < MAX_PAGE_SIZE) {
      count = Math.min(count * 4, MAX_PAGE_SIZE);
      continue;
    }

    // Widening did not help. Ask the server directly for something older rather
    // than inferring an answer from the page: page length cannot distinguish an
    // exhausted feed from a server capping its response.
    //
    // The cutoff is one millisecond before the EARLIEST instant on the page, not
    // before `oldest`. Which field the server compares is unknown, and a cutoff
    // below every instant on these rows excludes them under either choice --
    // whereas `oldest - 1` still includes them on a server keyed to start dates.
    const earliest = Math.min(...rows.flatMap(row => [row.startedDate, row.completedDate])
      .filter(value => typeof value === 'number'));
    pages++;
    const older = await fetchPage(pageSize, (Number.isFinite(earliest) ? earliest : oldest) - 1);
    if (!Array.isArray(older)) {
      throw new PaginationError(
        `Expected an array of transactions from ${TRANSACTIONS_PATH}; refusing to write a file.`
      );
    }
    if (older.length === 0) { reachedStart = true; break; }

    for (const row of rowsBelongingTo(older, handle.pocketId)) mine.set(row.id, row);
    const olderDated = older.map(instantOf).filter(value => typeof value === 'number');
    const olderMin = olderDated.length > 0 ? Math.min(...olderDated) : oldest;

    if (olderMin >= oldest) {
      throw new PaginationError(
        `Paging cannot get past ${new Date(oldest).toISOString()}: asking for older transactions ` +
        `returns the same ones, so the rest of the range is unreachable. Refusing to write a partial file.`
      );
    }

    cursor = olderMin + 1;
    count = pageSize;
  }

  if (!reachedStart) {
    throw new PaginationError(
      `Exceeded ${maxPages} pages without reaching the start of the range. Refusing to write a partial file.`
    );
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
