import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRange, PaginationError } from '../src/core/paginate.js';
import { txnIn, JOINT_POCKET, JOINT_WALLET } from './fixtures/synthetic.js';

/**
 * How this API filters `to` has never been established: not whether it is
 * inclusive or exclusive, not which field it compares, not its granularity.
 * `docs/api-notes.md` records the gap.
 *
 * So pagination must be correct under every plausible answer rather than one
 * guessed answer. Each server below is a different plausible answer, and the
 * rule is the same throughout: return every row in range, or raise. Never
 * return a short, well-formed file that looks complete.
 */

const handle = { selector: { name: 'walletId', value: JOINT_WALLET }, pocketId: JOINT_POCKET };
const at = (day, ms = 0) => Date.UTC(2026, 7, day, 12, 0, 0) + ms;
const FROM = at(1);
const TO = at(31);

/** A row at a given day, optionally sharing an exact instant with others. */
const row = (day, id, ms = 0) => {
  const t = at(day, ms);
  return { ...txnIn(JOINT_POCKET, day, id), startedDate: t, completedDate: t };
};

/**
 * Lay a running balance over a set of rows, newest first.
 *
 * Without this every fixture carries the one constant balance `makeTxn` sets,
 * `assertContinuous` finds no ledger signal and returns early, and this whole
 * file asserts "every row, or raise" with the net that makes that true switched
 * off. A PENDING row keeps a null balance: it has not settled, so it has not
 * moved one.
 */
const ledger = (rows) => {
  const instant = (row) => row.completedDate ?? row.startedDate;
  let balance = 500_000;
  for (const row of [...rows].sort((a, b) => instant(b) - instant(a))) {
    if (row.completedDate === null) { row.balance = null; continue; }
    row.balance = balance;
    balance -= row.amount;
  }
  return rows;
};

const serve = (rows, filter) => async (_path, params) =>
  rows.filter(r => filter(r, params.to)).slice(0, params.count ?? rows.length);

const ids = (out) => out.map(r => r.id).sort();

test('inclusive `to`: returns every row in range', async () => {
  const rows = ledger([row(30, 'a'), row(20, 'b'), row(10, 'c'), row(5, 'd')]);
  const get = serve(rows, (r, to) => r.completedDate <= to);
  assert.deepEqual(ids(await fetchRange({ get, handle, from: FROM, to: TO, pageSize: 2 })),
    ['a', 'b', 'c', 'd']);
});

test('exclusive `to`: returns every row in range', async () => {
  const rows = ledger([row(30, 'a'), row(20, 'b'), row(10, 'c'), row(5, 'd')]);
  const get = serve(rows, (r, to) => r.completedDate < to);
  assert.deepEqual(ids(await fetchRange({ get, handle, from: FROM, to: TO, pageSize: 2 })),
    ['a', 'b', 'c', 'd']);
});

test('exclusive `to`: a tie straddling a page boundary is not dropped', async () => {
  // 'b' and 'c' share an instant, and the page ends between them. Stepping the
  // cursor onto that instant under exclusive semantics would lose 'c' silently.
  const rows = ledger([row(30, 'a'), row(20, 'b'), row(20, 'c'), row(10, 'd'), row(5, 'e')]);
  const get = serve(rows, (r, to) => r.completedDate < to);
  assert.deepEqual(ids(await fetchRange({ get, handle, from: FROM, to: TO, pageSize: 2 })),
    ['a', 'b', 'c', 'd', 'e']);
});

test('inclusive `to`: a tie group larger than the page still completes', async () => {
  // Five rows share one instant with a page size of two, so the cursor cannot
  // advance until the page grows to cover the whole group.
  const tied = ['t1', 't2', 't3', 't4', 't5'].map(id => row(20, id));
  const rows = ledger([row(30, 'newest'), ...tied, row(5, 'oldest')]);
  const get = serve(rows, (r, to) => r.completedDate <= to);
  assert.deepEqual(ids(await fetchRange({ get, handle, from: FROM, to: TO, pageSize: 2 })),
    ['newest', 'oldest', 't1', 't2', 't3', 't4', 't5']);
});

test('`to` ignored entirely: raises rather than truncating', async () => {
  const rows = ledger([row(30, 'a'), row(20, 'b'), row(10, 'c'), row(5, 'd')]);
  const get = serve(rows, () => true);
  await assert.rejects(
    () => fetchRange({ get, handle, from: FROM, to: TO, pageSize: 2 }),
    (err) => {
      assert.ok(err instanceof PaginationError);
      assert.match(err.message, /Refusing to write a partial file/);
      return true;
    }
  );
});

test('`to` compared against the started date: refused, never mis-paged', async () => {
  // Completion trails start, so rows newer than the cutoff come back routinely
  // and the completion-based cursor stops advancing.
  //
  // The walk used to page past this by reaching below the oldest START date on
  // the page. That is the right question here and the wrong one for a server
  // that merely rounds its cutoff coarser than a millisecond, where it steps
  // over every row completing in between, silently -- see the coarse-cutoff
  // fixtures in paginate-truncation.test.js for that. The two
  // answer every probe identically: ordinary settlement lag makes the coarse
  // server satisfy each test for start-date keying that has been tried. Neither
  // model has ever been observed in this API, so the walk refuses rather than
  // pick one and be silently wrong about a month.
  //
  // The cost is that such a server could not be exported from at all. That is
  // the right way round: a refusal is visible and reportable, a short file that
  // reconciles wrongly is not.
  const rows = ledger([30, 20, 10, 5].map((d, i) => {
    const r = row(d, `r${i}`);
    r.completedDate = r.startedDate + 36e5; // cleared an hour later
    return r;
  }));
  const get = serve(rows, (r, to) => r.startedDate <= to);
  await assert.rejects(
    () => fetchRange({ get, handle, from: FROM, to: TO, pageSize: 2 }),
    (err) => {
      assert.ok(err instanceof PaginationError);
      assert.match(err.message, /Refusing to write a partial file/);
      return true;
    }
  );
});

test('`to` rounded coarser than a millisecond: refuses rather than guesses', async () => {
  // A server that widens the cutoff to a whole day keeps returning rows at the
  // oldest instant no matter how far back the cutoff is pushed. That looks
  // identical to a server ignoring `to` and replaying its newest page — which
  // hid all but one row of the forty-row fixture in paginate-truncation.test.js. The two cannot be told apart from
  // outside, so the walk takes the safe side: it refuses.
  //
  // The cost is that such a server cannot be exported from at all. That is the
  // right way round: a refusal is visible and reportable, a short file that
  // reconciles wrongly is not.
  const endOfDay = (t) => { const d = new Date(t); d.setUTCHours(23, 59, 59, 999); return d.getTime(); };
  const rows = ledger([row(30, 'a'), row(30, 'a2', 1000), row(20, 'b'), row(10, 'c'), row(5, 'd')]);
  const get = serve(rows, (r, to) => r.completedDate <= endOfDay(to));
  await assert.rejects(
    () => fetchRange({ get, handle, from: FROM, to: TO, pageSize: 2 }),
    (err) => {
      assert.ok(err instanceof PaginationError);
      assert.match(err.message, /Refusing to write a partial file/);
      return true;
    }
  );
});

test('rows with no completion date ride along: no false failure', async () => {
  // PENDING rows carry a null completedDate; instantOf falls back to startedDate.
  const pending = { ...row(25, 'pending'), completedDate: null };
  const rows = ledger([row(30, 'a'), pending, row(10, 'c'), row(5, 'd')]);
  const get = serve(rows, (r, to) => (r.completedDate ?? r.startedDate) <= to);
  const out = await fetchRange({ get, handle, from: FROM, to: TO, pageSize: 2 });
  assert.deepEqual(ids(out), ['a', 'c', 'd', 'pending']);
});

test('a small account settles in a handful of requests', async () => {
  // An account whose history runs out above `from` ends on the stall path, which
  // costs several extra requests: the walk asks whether anything older exists rather
  // than inferring it from page length. That inference was wrong three separate
  // ways, so the request is the cheaper mistake.
  const rows = ledger([row(20, 'a'), row(19, 'b')]);
  let calls = 0;
  const get = async (_p, params) => { calls++; return rows.filter(r => r.completedDate <= params.to); };
  const out = await fetchRange({ get, handle, from: FROM, to: TO, pageSize: 200 });
  assert.deepEqual(ids(out), ['a', 'b']);
  assert.ok(calls <= 6, `expected to settle quickly, took ${calls} calls`);
});

test('a payment that started before the range and cleared inside it survives', async () => {
  // Month membership is the COMPLETION date, so this row belongs here. On a
  // server ordered and filtered by START date it sits below one that started
  // later and cleared at once, and stopping at the first completion below `from`
  // leaves it unread. The walk reads a settlement margin past the start of the
  // range for exactly this; with that margin at zero the row disappears.
  const mk = (id, started, completed) => ({
    ...txnIn(JOINT_POCKET, 2, id), startedDate: started, completedDate: completed
  });
  const rows = ledger([
    ...Array.from({ length: 6 }, (_, i) => mk(`aug${i}`, at(5 + i), at(5 + i))),
    mk('cleared-on-the-2nd', Date.UTC(2026, 6, 31, 10), at(2)),
    mk('same-day-31st', Date.UTC(2026, 6, 31, 17), Date.UTC(2026, 6, 31, 17))
  ]);
  const get = async (_path, params) => [...rows]
    .filter(r => r.startedDate <= params.to)
    .sort((a, b) => b.startedDate - a.startedDate)
    .slice(0, params.count ?? rows.length);

  const out = await fetchRange({ get, handle, from: FROM, to: TO, pageSize: 2 });
  assert.ok(out.some(r => r.id === 'cleared-on-the-2nd'),
    `the row that cleared inside the range is missing: ${out.map(r => r.id).join(', ')}`);
});
