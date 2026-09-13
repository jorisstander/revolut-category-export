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
 * This checks the answer instead. Each settled transaction carries the account
 * balance immediately after it settled, so consecutive rows must satisfy
 *
 *     balance(newer) - amount(newer) === balance(older)
 *
 * A break in that chain means a transaction moved the balance between the two
 * rows and is not in the set. It does not matter why the walk missed it.
 */

/** The instant a row belongs to. A PENDING row has not completed, so it is
 *  placed by when it started. Paging keys on this too, hence the export. */
export const instantOf = (row) => row.completedDate ?? row.startedDate;

export class IncompleteExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompleteExportError';
  }
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** What the row moved the settled balance by. */
const settlementOf = (row) => num(row.amountWithCharges) ?? num(row.amount);

/**
 * Every balance the row before this one could have left behind, under any of the
 * conventions the API might use for fees. `amount` has been observed to be
 * inclusive of charges, but no row with a non-zero fee has ever been seen, so
 * the variants are accepted rather than guessed between.
 */
function balancesBefore(row) {
  const balance = num(row.balance);
  const amount = num(row.amount);
  const withCharges = num(row.amountWithCharges);
  const fee = num(row.fee) ?? 0;
  if (amount === null && withCharges === null) return null; // nothing to subtract

  const values = [];
  if (amount !== null) values.push(balance - amount, balance - (amount - fee), balance - (amount + fee));
  if (withCharges !== null) values.push(balance - withCharges);
  return values;
}

/**
 * The two ends of a group of rows that share an instant.
 *
 * Rows sharing an instant come back in whatever order the server happened to
 * use -- there is no documented tiebreaker, and an overnight batch settlement
 * can put hundreds of rows on one timestamp. Their ledger order is therefore
 * unknown, and checking them pairwise as delivered raises on a complete export.
 *
 * Order is not needed to prove nothing is missing. However the group is
 * ordered, each row's balance is the previous row's "balance before" except for
 * the newest, and each "balance before" is some row's balance except for the
 * oldest. Cancelling the two multisets leaves exactly those two ends.
 *
 * @returns {{enter: number, leave: number}|null} null when the rows do not form
 *   one unbroken chain, or an amount is missing and nothing can be concluded.
 */
function endsOfGroup(group) {
  const counts = new Map();
  const bump = (value, delta) => counts.set(value, (counts.get(value) ?? 0) + delta);

  for (const row of group) {
    const amount = settlementOf(row);
    if (amount === null) return null; // unplaceable row: absence of evidence
    bump(num(row.balance), 1);
    bump(num(row.balance) - amount, -1);
  }

  const enter = [];
  const leave = [];
  for (const [value, count] of counts) {
    for (let i = 0; i < count; i++) enter.push(value);
    for (let i = 0; i < -count; i++) leave.push(value);
  }
  if (enter.length !== 1 || leave.length !== 1) return null;
  return { enter: enter[0], leave: leave[0] };
}

/** Consecutive rows sharing an instant, in delivery order. */
function groupByInstant(rows) {
  const groups = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && instantOf(last[0]) === instantOf(row) && instantOf(row) !== undefined) last.push(row);
    else groups.push([row]);
  }
  return groups;
}

const describe = (group) => group.map(row => row.id).join(', ');

/**
 * @param {Array} rows one account's rows, newest first
 * @returns {Array} the same rows, when the chain is unbroken
 * @throws {IncompleteExportError} naming the gap
 */
export function assertContinuous(rows) {
  // Only rows carrying a settled balance take part. A PENDING row has no settled
  // balance and has not moved one, so it proves nothing -- and, crucially, must
  // not be left sitting in the chain where its null balance would satisfy the
  // link across it. That is precisely where a paging gap tends to land.
  const settled = rows.filter(row => num(row.balance) !== null);

  // Nothing to verify unless the balances actually move. A set where every
  // balance is identical carries no ledger information, so there is no chain to
  // break and nothing this can prove.
  if (new Set(settled.map(row => num(row.balance))).size < 2) return rows;

  const groups = groupByInstant(settled);
  let expected = null;      // what the next group must open at, from the one before
  let previous = null;      // the group that set it

  for (const group of groups) {
    const ends = group.length > 1 ? endsOfGroup(group) : null;

    if (group.length > 1 && ends === null) {
      throw new IncompleteExportError(
        `Transactions are missing from the group settled together at ` +
        `${new Date(instantOf(group[0])).toISOString()} (${describe(group)}): their balances do not ` +
        `form one unbroken run, so at least one transaction from that batch is not in this export. ` +
        `Refusing to write a file that would reconcile wrongly.`
      );
    }

    const enter = ends ? ends.enter : num(group[0].balance);
    if (expected !== null && !expected.includes(enter)) {
      throw new IncompleteExportError(
        `Transactions are missing between ${describe(previous)} and ${describe(group)}: the balance ` +
        `after ${describe(previous)} implies the one before it was ${expected[0]}, but the next row ` +
        `recorded ${enter}. At least one transaction moved the balance in between and is not in this ` +
        `export. Refusing to write a file that would reconcile wrongly.`
      );
    }

    const next = ends ? [ends.leave] : balancesBefore(group[0]);
    expected = next; // null when the amount is unknown: cannot chain across it
    previous = group;
  }

  return rows;
}
