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
 * What a group of rows sharing one instant proves about the balance.
 *
 * Rows sharing an instant come back in whatever order the server happened to
 * use -- there is no documented tiebreaker, and an overnight batch settlement
 * can put hundreds of rows on one timestamp. Their ledger order is unknown, so
 * checking them pairwise as delivered raises on a complete export.
 *
 * Order is not needed. Read each row as a step from the balance before it to the
 * balance after it, and the group is complete exactly when those steps form one
 * unbroken run that uses every row once. Two things have to hold: the steps must
 * all belong to a single connected run, and at every balance the number of steps
 * arriving must match the number leaving, save at the two ends.
 *
 * @returns {{kind: 'path', enter: number, leave: number}
 *          |{kind: 'circuit', balances: number[]}
 *          |{kind: 'broken'}
 *          |{kind: 'unknown'}}
 */
function analyseGroup(group) {
  const net = new Map();          // balance -> (steps arriving) - (steps leaving)
  const neighbours = new Map();   // balance -> balances one step away
  const touch = (value) => { if (!neighbours.has(value)) neighbours.set(value, []); };
  const bump = (value, delta) => net.set(value, (net.get(value) ?? 0) + delta);

  for (const row of group) {
    const amount = settlementOf(row);
    if (amount === null) return { kind: 'unknown' }; // nothing to conclude from
    const after = num(row.balance);
    const before = after - amount;
    bump(after, 1);
    bump(before, -1);
    touch(before);
    touch(after);
    neighbours.get(before).push(after);
    neighbours.get(after).push(before);
  }

  // A fee accounted for separately from the amount shifts a step by the fee, and
  // that is indistinguishable from a missing row. A lone row is given that
  // latitude by balancesBefore, so a row must not lose it merely by sharing an
  // instant: where any fee is non-zero this declines to conclude rather than
  // accuse.
  const feeInPlay = group.some(row => (num(row.fee) ?? 0) !== 0);
  const inconclusive = () => (feeInPlay ? { kind: 'unknown' } : { kind: 'broken' });

  // One connected run, or rows are missing between the pieces. Counting alone
  // cannot see this: a valid run beside a separate loop balances out exactly.
  const seen = new Set();
  const stack = [neighbours.keys().next().value];
  while (stack.length > 0) {
    const balance = stack.pop();
    if (seen.has(balance)) continue;
    seen.add(balance);
    for (const next of neighbours.get(balance)) stack.push(next);
  }
  if (seen.size !== neighbours.size) return inconclusive();

  const enter = [];
  const leave = [];
  for (const [balance, count] of net) {
    for (let i = 0; i < count; i++) enter.push(balance);
    for (let i = 0; i < -count; i++) leave.push(balance);
  }

  if (enter.length === 1 && leave.length === 1) return { kind: 'path', enter: enter[0], leave: leave[0] };

  // Everything cancels: the group ends on the balance it began from. A payment
  // settling beside its own reversal does this, and so does a pair of zero-amount
  // card authorisations, which this feed is known to emit. The group is complete;
  // it simply had no net effect, and which balance it sat at is settled by the
  // rows around it rather than by the group itself.
  if (enter.length === 0 && leave.length === 0) return { kind: 'circuit', balances: [...neighbours.keys()] };

  return inconclusive();
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

  let expected = null;   // balances the next group may open at, from the one before
  let previous = null;   // the group that set them

  const missingBetween = (group, enter) => new IncompleteExportError(
    `Transactions are missing between ${describe(previous)} and ${describe(group)}: the balance ` +
    `after ${describe(previous)} implies the one before it was ${expected[0]}, but the next row ` +
    `recorded ${enter}. At least one transaction moved the balance in between and is not in this ` +
    `export. Refusing to write a file that would reconcile wrongly.`
  );

  for (const group of groupByInstant(settled)) {
    if (group.length === 1) {
      const enter = num(group[0].balance);
      if (expected !== null && !expected.includes(enter)) throw missingBetween(group, enter);
      expected = balancesBefore(group[0]);
      previous = group;
      continue;
    }

    const analysis = analyseGroup(group);

    if (analysis.kind === 'broken') {
      throw new IncompleteExportError(
        `Transactions are missing from the group settled together at ` +
        `${new Date(instantOf(group[0])).toISOString()} (${describe(group)}): their balances do not ` +
        `form one unbroken run, so at least one transaction from that batch is not in this export. ` +
        `Refusing to write a file that would reconcile wrongly.`
      );
    }

    if (analysis.kind === 'unknown') {
      expected = null; // cannot chain across it, and will not accuse on it either
    } else if (analysis.kind === 'path') {
      if (expected !== null && !expected.includes(analysis.enter)) throw missingBetween(group, analysis.enter);
      expected = [analysis.leave];
    } else {
      // No net effect: the group leaves the balance where it found it. Every
      // candidate still standing is carried forward whole. Narrowing to the
      // first of them looks harmless -- the group entered and left at the same
      // balance, so any one of them would do -- but it discards the true one
      // whenever more than one survives, and the next group is then measured
      // against a guess. That refused complete exports.
      const agreed = expected === null ? null : expected.filter(value => analysis.balances.includes(value));
      if (agreed !== null && agreed.length === 0) throw missingBetween(group, analysis.balances[0]);
      expected = agreed === null ? analysis.balances : agreed;
    }
    previous = group;
  }

  return rows;
}
