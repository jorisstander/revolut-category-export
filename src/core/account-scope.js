export class ForeignAccountError extends Error {
  constructor(requested, served) {
    super(
      `This selector returned transactions belonging to ${[...new Set(served)].join(', ')} ` +
      `and none belonging to ${requested}. Using it would have exported another account's data.`
    );
    this.name = 'ForeignAccountError';
    this.requested = requested;
    this.served = served;
  }
}

/**
 * Rows belonging to exactly this pocket.
 * A walletId selector returns the whole wallet, so this filter is normal
 * operation on every page, not an error path.
 * @param {Array<{account?: {id?: string}}>} rows
 * @param {string} pocketId
 */
export function rowsBelongingTo(rows, pocketId) {
  // Guard the undefined case explicitly. Without it, a handle whose pocket has
  // no id would match every row that also has no account -- counting
  // unattributed rows as the user's, which is the opposite of the job.
  if (pocketId === undefined || pocketId === null) return [];
  return rows.filter(row => row?.account?.id === pocketId);
}

/**
 * Probe-time check: does this selector actually address the requested account?
 *
 * Throws only in the unambiguous case — rows came back, none are ours, and at
 * least one belongs to another account we know about. Unrecognised ids prove
 * nothing and are ignored.
 *
 * @param {Array} rows
 * @param {{pocketId: string, knownPocketIds: Set<string>}} scope
 * @returns {Array} the same rows, when the selector is acceptable
 */
export function assertServedCorrectAccount(rows, { pocketId, knownPocketIds }) {
  if (rows.length === 0) return rows;
  if (rowsBelongingTo(rows, pocketId).length > 0) return rows;

  const served = rows
    .map(row => row?.account?.id)
    .filter(id => id !== undefined && id !== pocketId && knownPocketIds.has(id));

  if (served.length > 0) throw new ForeignAccountError(pocketId, served);
  return rows;
}
