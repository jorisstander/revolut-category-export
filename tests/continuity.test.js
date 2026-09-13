import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContinuous, IncompleteExportError } from '../src/core/continuity.js';

/**
 * This is the part of the export that does not depend on being right about an
 * undocumented API. Whatever the paging walk believed, a break in the balance
 * chain proves a transaction is missing from the set.
 */

/** Rows newest-first with a coherent running balance, as the real feed returns. */
const ledger = (amounts, startingBalance = 100_000) => {
  let balance = startingBalance;
  return amounts.map((amount, i) => {
    const row = { id: `t${i}`, amount, fee: 0, balance };
    balance -= amount; // the balance the row before this one left behind
    return row;
  });
};

test('an unbroken chain passes', () => {
  const rows = ledger([-1240, -3500, 50000, -999]);
  assert.equal(assertContinuous(rows).length, 4);
});

test('a row removed from the middle is caught', () => {
  const rows = ledger([-1240, -3500, 50000, -999]);
  const gapped = [rows[0], rows[2], rows[3]]; // drop t1
  assert.throws(() => assertContinuous(gapped), IncompleteExportError);
});

test('the error names both rows either side of the gap', () => {
  const rows = ledger([-1240, -3500, 50000]);
  assert.throws(() => assertContinuous([rows[0], rows[2]]), /t0.*t2|t2.*t0/s);
});

test('a whole run removed from the middle is caught', () => {
  const rows = ledger([-100, -200, -300, -400, -500, -600]);
  assert.throws(() => assertContinuous([rows[0], rows[5]]), IncompleteExportError);
});

test('rows missing from either end cannot be detected, and must not false-alarm', () => {
  // Truncation at an end leaves the remaining chain intact. Catching that is the
  // paging walk's job -- it must reach the start of the range or prove the feed
  // ran out. This check covers the middle, and must stay silent here.
  const rows = ledger([-100, -200, -300, -400]);
  assert.doesNotThrow(() => assertContinuous(rows.slice(1)));
  assert.doesNotThrow(() => assertContinuous(rows.slice(0, -1)));
});

test('a fee accounted for separately from the amount still passes', () => {
  // No row with a non-zero fee has ever been observed, so both conventions are
  // accepted rather than guessed between.
  const rows = [
    { id: 'a', amount: -1000, fee: 25, balance: 98_975 },
    { id: 'b', amount: -500, fee: 0, balance: 100_000 }
  ];
  assert.doesNotThrow(() => assertContinuous(rows));
});

test('amountWithCharges is accepted where it explains the balance', () => {
  const rows = [
    { id: 'a', amount: -1000, amountWithCharges: -1025, fee: 25, balance: 98_975 },
    { id: 'b', amount: -500, fee: 0, balance: 100_000 }
  ];
  assert.doesNotThrow(() => assertContinuous(rows));
});

test('rows without balances are skipped rather than rejected', () => {
  // PENDING rows carry no settled balance; that is absence of evidence.
  const rows = [
    { id: 'a', amount: -100, balance: 900 },
    { id: 'pending', amount: -50, balance: null },
    { id: 'c', amount: -200, balance: 700 }
  ];
  assert.doesNotThrow(() => assertContinuous(rows));
});

test('a set with no balance movement proves nothing and is left alone', () => {
  // Synthetic or degraded data where every balance is identical carries no
  // ledger information. There is no chain to break, so there is nothing to say.
  const rows = [
    { id: 'a', amount: -100, balance: 500 },
    { id: 'b', amount: -200, balance: 500 },
    { id: 'c', amount: -300, balance: 500 }
  ];
  assert.doesNotThrow(() => assertContinuous(rows));
});

test('an empty or single-row set passes', () => {
  assert.deepEqual(assertContinuous([]), []);
  assert.equal(assertContinuous([{ id: 'only', amount: -100, balance: 5 }]).length, 1);
});
