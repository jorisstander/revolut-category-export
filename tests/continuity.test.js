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

test('a PENDING row rides along without breaking the chain around it', () => {
  // A PENDING row carries no settled balance because it has not moved one. The
  // settled rows either side must still chain directly across it.
  const rows = [
    { id: 'a', amount: -100, balance: 900 },
    { id: 'pending', amount: -50, balance: null },
    { id: 'c', amount: -200, balance: 1000 }
  ];
  assert.doesNotThrow(() => assertContinuous(rows));
});

test('a PENDING row sitting exactly at a gap does not hide it', () => {
  // The row that causes a paging gap is often the row that lands in it: the
  // cursor jumps to a stale pre-authorisation's start date, and the block it
  // skipped is bounded by that same row. Letting a null balance satisfy the
  // link across it put the one blind spot exactly where gaps appear.
  const rows = [
    { id: 'a', amount: -100, balance: 900 },
    { id: 'pending', amount: -50, balance: null },
    { id: 'c', amount: -200, balance: 700 }  // 900 - (-100) = 1000, not 700
  ];
  assert.throws(() => assertContinuous(rows), IncompleteExportError);
});

test('a batch settled at one instant is not order-dependent', () => {
  // Rows sharing an instant come back in whatever order the server used; there
  // is no documented tiebreaker. Checking them pairwise as delivered raised on
  // a complete export -- an overnight batch made the file impossible to write.
  // 400 -> +100 -> +200 -> +300 -> 1000, then the newer row takes it to 1050.
  const batch = [
    { id: 'b1', amount: 100, balance: 500 },
    { id: 'b2', amount: 200, balance: 700 },
    { id: 'b3', amount: 300, balance: 1000 }
  ].map(row => ({ ...row, completedDate: 5_000 }));
  const outer = [
    { id: 'newer', amount: 50, balance: 1050, completedDate: 9_000 },
    { id: 'older', amount: -10, balance: 400, completedDate: 1_000 }
  ];
  // every delivery order of the batch must behave identically
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [0, 2, 1], [2, 0, 1], [1, 2, 0]]) {
    const rows = [outer[0], ...order.map(i => batch[i]), outer[1]];
    assert.doesNotThrow(() => assertContinuous(rows), `order ${order.join('')} raised`);
  }
});

test('a row missing from a batch settled at one instant is still caught', () => {
  // Order-independence must not become blindness: the batch has to account for
  // the balance it consumed, whatever order its rows arrive in.
  const rows = [
    { id: 'newer', amount: 50, balance: 1050, completedDate: 9_000 },
    { id: 'b1', amount: 100, balance: 500, completedDate: 5_000 },
    { id: 'b3', amount: 300, balance: 1000, completedDate: 5_000 },  // b2 dropped
    { id: 'older', amount: -10, balance: 400, completedDate: 1_000 }
  ];
  assert.throws(() => assertContinuous(rows), IncompleteExportError);
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

test('a payment settling beside its own reversal is not called a gap', () => {
  // The pair cancels, so the batch ends on the balance it began from. Reading
  // that as "nothing entered or left" made the whole month impossible to
  // export: 8.2% of random complete batches were refused this way.
  const rows = [
    { id: 'newer', amount: -50, balance: 950, completedDate: 9_000 },
    { id: 'reversal-1', amount: 200, balance: 1000, completedDate: 5_000 },
    { id: 'payment-1', amount: -200, balance: 800, completedDate: 5_000 },
    { id: 'older', amount: -10, balance: 1000, completedDate: 1_000 }
  ];
  assert.doesNotThrow(() => assertContinuous(rows));
});

test('two zero-amount authorisations sharing an instant are not called a gap', () => {
  // `docs/api-notes.md` records this feed emitting zero-amount authorisations.
  const rows = [
    { id: 'newer', amount: -50, balance: 950, completedDate: 9_000 },
    { id: 'auth-a', amount: 0, balance: 1000, completedDate: 5_000 },
    { id: 'auth-b', amount: 0, balance: 1000, completedDate: 5_000 },
    { id: 'older', amount: -10, balance: 1000, completedDate: 1_000 }
  ];
  assert.doesNotThrow(() => assertContinuous(rows));
});

test('a run beside a separate loop is caught, though the counts balance', () => {
  // Counting arrivals against departures is not enough on its own: a valid run
  // and an unconnected loop cancel exactly, and the rows missing between them
  // would pass unseen. The two must also form ONE connected run.
  const rows = [
    { id: 'newer', amount: -50, balance: 950, completedDate: 9_000 },
    { id: 'p1', amount: 100, balance: 1000, completedDate: 5_000 },  // run:  900 -> 1000
    { id: 'c1', amount: 40, balance: 500, completedDate: 5_000 },    // loop: 460 -> 500
    { id: 'c2', amount: -40, balance: 460, completedDate: 5_000 },   // loop: 500 -> 460
    { id: 'older', amount: -10, balance: 900, completedDate: 1_000 }
  ];
  assert.throws(() => assertContinuous(rows), IncompleteExportError);
});

test('a fee accounted for separately keeps its latitude inside a group', () => {
  // A lone row is allowed either fee convention. Sharing an instant with another
  // row must not silently withdraw that, or a complete export starts raising.
  const rows = [
    { id: 'newer', amount: -50, fee: 0, balance: 950, completedDate: 9_000 },
    { id: 'f1', amount: -1000, fee: 25, balance: 1000, completedDate: 5_000 },
    { id: 'f2', amount: -500, fee: 0, balance: 2025, completedDate: 5_000 },
    { id: 'older', amount: -10, fee: 0, balance: 2525, completedDate: 1_000 }
  ];
  assert.doesNotThrow(() => assertContinuous(rows));
});

test('two cancelling pairs on consecutive instants do not accuse each other', () => {
  // A group that cancels leaves the balance where it found it, so every balance
  // still standing remains possible. Narrowing that set to its first member
  // looked harmless -- any of them would do -- but it discards the true one when
  // more than one survives, and the next group is then measured against a guess.
  const rows = [
    { id: 't4', amount: 200, balance: 99950, completedDate: 1_020_000 },
    { id: 't3', amount: -200, balance: 99750, completedDate: 1_020_000 },
    { id: 't2', amount: 200, balance: 99950, completedDate: 1_010_000 },
    { id: 't1', amount: -200, balance: 99750, completedDate: 1_010_000 },
    { id: 't0', amount: -50, balance: 99950, completedDate: 1_000_000 }
  ];
  assert.doesNotThrow(() => assertContinuous(rows));
});

test('a gap immediately above a batch is caught at the point the batch opens', () => {
  // The balance a group opens at has to match what the row above it implies.
  // Nothing else covers that link: the group is internally consistent and its
  // closing balance matches the row below, so if the opening check is not made
  // the gap directly above it passes unseen.
  const rows = [
    { id: 'newer', amount: -100, balance: 1000, completedDate: 9_000 },
    // a transaction moving the balance from 1300 to 1100 is missing here
    { id: 'b1', amount: 100, balance: 1300, completedDate: 5_000 },
    { id: 'b2', amount: 200, balance: 1200, completedDate: 5_000 },
    { id: 'older', amount: -10, balance: 1000, completedDate: 1_000 }
  ];
  assert.throws(() => assertContinuous(rows), IncompleteExportError);
});
