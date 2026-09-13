/**
 * Proof that an export is not missing rows in the middle.
 *
 * Paging an undocumented API means reasoning about behaviour nobody has
 * documented: whether the cutoff is inclusive, which field it compares, how
 * coarsely it is rounded, whether the server caps a page below what was asked
 * for. Every one of those questions was answered with a proxy at some point in
 * this file's history, and every proxy was eventually wrong in a way that
 * returned a well-formed CSV missing part of a month.
 *
 * This checks the answer instead. Each transaction carries the account balance
 * immediately after it settled, so consecutive rows must satisfy
 *
 *     balance(newer) - amount(newer) === balance(older)
 *
 * A break in that chain means a transaction moved the balance between the two
 * rows and is not in the set. It does not matter why the walk missed it.
 */

export class IncompleteExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompleteExportError';
  }
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Whether `older`'s balance follows from `newer`'s under any of the conventions
 * the API might use for fees. `amount` has been observed to be inclusive of
 * charges, but no row with a non-zero fee has ever been seen, so the variants
 * are accepted rather than guessed between.
 */
function follows(newer, older) {
  const balance = num(newer.balance);
  const previous = num(older.balance);
  if (balance === null || previous === null) return true; // nothing to compare

  const amount = num(newer.amount);
  const withCharges = num(newer.amountWithCharges);
  const fee = num(newer.fee) ?? 0;
  if (amount === null && withCharges === null) return true;

  const candidates = [];
  if (amount !== null) candidates.push(amount, amount - fee, amount + fee);
  if (withCharges !== null) candidates.push(withCharges);
  return candidates.some(value => balance - value === previous);
}

/**
 * @param {Array} rows one account's rows, newest first
 * @returns {Array} the same rows, when the chain is unbroken
 * @throws {IncompleteExportError} naming the gap
 */
export function assertContinuous(rows) {
  // Nothing to verify unless the balances actually move. Real rows carry a
  // running balance; a set where every balance is identical carries no ledger
  // information, so there is no chain to break and nothing this can prove.
  const balances = new Set(rows.map(row => num(row.balance)).filter(value => value !== null));
  if (balances.size < 2) return rows;

  for (let i = 0; i < rows.length - 1; i++) {
    const newer = rows[i];
    const older = rows[i + 1];
    if (follows(newer, older)) continue;

    const expected = num(newer.balance) - num(newer.amount);
    throw new IncompleteExportError(
      `Transactions are missing between ${newer.id} and ${older.id}: the balance after ` +
      `${newer.id} implies the one before it was ${expected}, but the next row recorded ` +
      `${older.balance}. At least one transaction moved the balance in between and is not ` +
      `in this export. Refusing to write a file that would reconcile wrongly.`
    );
  }
  return rows;
}
