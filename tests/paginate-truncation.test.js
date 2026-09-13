import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRange, PaginationError } from '../src/core/paginate.js';
import { txnIn, JOINT_POCKET, JOINT_WALLET } from './fixtures/synthetic.js';

/**
 * Silent row loss is the failure this project cares most about: the output gets
 * reconciled and trusted, so a short file that looks complete is worse than an
 * error. Each case below produced exactly that at the DEFAULT page size.
 *
 * `count` is a hint, not a limit — the API has been seen returning more rows
 * than asked for — so the number of rows on a page proves nothing about what the
 * server holds. A server-side cap is indistinguishable from an exhausted feed by
 * page length alone, which is why the last case has to ask a separate question.
 */

const handle = { selector: { name: 'walletId', value: JOINT_WALLET }, pocketId: JOINT_POCKET };
const at = (day, ms = 0) => Date.UTC(2026, 7, day, 12, 0, 0) + ms;
const FROM = at(1);
const TO = at(31);

const row = (day, id, ms = 0) => {
  const t = at(day, ms);
  return { ...txnIn(JOINT_POCKET, day, id), startedDate: t, completedDate: t };
};

/**
 * Newest-first, like the real feed, and with a running balance laid over the
 * result. Real rows carry the account balance after each transaction, and that
 * chain is what `assertContinuous` uses to prove nothing is missing. A fixture
 * with a flat balance carries no such proof, so these cases would pass while
 * dropping rows — which is exactly the bug they exist to catch.
 */

/**
 * The whole contract, in one assertion: return every row in range, or raise.
 * Which of the two is not the point — a short, well-formed file is the failure.
 */
async function assertEveryRowOrRaise(get, all) {
  const expected = all.filter(r => r.completedDate >= FROM && r.completedDate < TO).length;
  let out;
  try {
    out = await fetchRange({ get, handle, from: FROM, to: TO });
  } catch (error) {
    assert.match(error.message, /Refusing to write|missing between|Exceeded/,
      `raised, but not for a reason that tells the user to distrust the export: ${error.message}`);
    return;
  }
  assert.equal(out.length, expected,
    `returned ${out.length} of ${expected} rows without raising — a short file that looks complete`);
}

const desc = (rows) => {
  const ordered = [...rows].sort((a, b) => b.completedDate - a.completedDate);
  let balance = 1_000_000;
  for (const r of ordered) {
    r.balance = balance;      // balance AFTER this row
    balance -= r.amount;      // ... so the row before it held this much
  }
  return ordered;
};

test('a tie group larger than the page does not lose rows under exclusive `to`', async () => {
  // The batch begins a page, so stepping the cursor onto its instant before
  // reading the rest would drop the remainder permanently.
  const batch = Array.from({ length: 210 }, (_, i) => row(28, `batch${i}`));
  const older = Array.from({ length: 160 }, (_, i) => row(20 - (i % 18), `old${i}`));
  const all = desc([...batch, ...older]);
  const get = async (_p, params) => all.filter(r => r.completedDate < params.to).slice(0, params.count);

  const out = await fetchRange({ get, handle, from: FROM, to: TO });
  assert.equal(out.length, all.length, `expected every row, got ${out.length} of ${all.length}`);
});

test('a server page cap hiding part of a tie group raises rather than truncating', async () => {
  // The cap makes `rows.length < count` look like exhaustion while rows remain.
  const CAP = 100;
  const tie = Array.from({ length: 105 }, (_, i) => row(15, `tie${i}`));
  const older = Array.from({ length: 200 }, (_, i) => row(10 - (i % 8), `old${i}`));
  const all = desc([...tie, ...older]);
  const get = async (_p, params) =>
    all.filter(r => r.completedDate <= params.to).slice(0, Math.min(params.count, CAP));

  // Either outcome is acceptable; a short file is not. The walk may recover the
  // whole group, or the balance chain may catch the gap it could not.
  await assertEveryRowOrRaise(get, all);
});

test('a tie sitting exactly on `from` is not cut off by the boundary', async () => {
  // `oldest <= from` used to end the walk here, dropping the rest of a group
  // whose rows are all inside the range.
  const onBoundary = Array.from({ length: 5 }, (_, i) => row(1, `edge${i}`));
  const above = Array.from({ length: 199 }, (_, i) => row(2 + (i % 25), `above${i}`));
  const all = desc([...onBoundary, ...above]);
  const get = async (_p, params) => all.filter(r => r.completedDate <= params.to).slice(0, params.count);

  const out = await fetchRange({ get, handle, from: FROM, to: TO });
  assert.equal(out.length, all.length, `expected every row, got ${out.length} of ${all.length}`);
  assert.equal(out.filter(r => r.id.startsWith('edge')).length, 5, 'all rows on the boundary must survive');
});

test('a deep feed below `from` still terminates promptly', async () => {
  // The real endpoint holds history well below the requested range; termination
  // normally comes from crossing `from`, not from running out of rows.
  const inRange = Array.from({ length: 240 }, (_, i) => row(30 - (i % 29), `in${i}`));
  const below = Array.from({ length: 2000 }, (_, i) => ({
    ...row(1, `below${i}`),
    startedDate: FROM - (i + 1) * 36e5,
    completedDate: FROM - (i + 1) * 36e5
  }));
  const all = desc([...inRange, ...below]);
  let calls = 0;
  const get = async (_p, params) => {
    calls++;
    return all.filter(r => r.completedDate <= params.to).slice(0, params.count);
  };

  const out = await fetchRange({ get, handle, from: FROM, to: TO });
  assert.equal(out.length, inRange.length);
  assert.ok(calls <= 6, `expected few requests against a bank API, made ${calls}`);
});

test('a server cap that prevents the cursor advancing raises, with no tie group involved', async () => {
  // Every row has a distinct instant, so none of the tie-group logic applies.
  // A cap this tight means a re-fetch can only ever return rows already seen,
  // and the walk cannot reach the rest of the month. Declaring that "exhausted"
  // would hand back one row out of forty and call it a complete export.
  const CAP = 1;
  const all = desc(Array.from({ length: 40 }, (_, i) => row(30 - i % 28, `r${i}`, i)));
  const get = async (_p, params) =>
    all.filter(r => r.completedDate <= params.to).slice(0, Math.min(params.count, CAP));

  await assertEveryRowOrRaise(get, all);
});

test('a stall on a page of several distinct instants still checks for older rows', async () => {
  // The probe used to fire only for single-instant pages. A server that caps and
  // returns a spread of instants stalls the same way, and skipping the check
  // there silently drops everything older.
  const CAP = 3;
  const recent = [row(30, 'a', 1), row(29, 'b', 2), row(28, 'c', 3)];
  const older = Array.from({ length: 20 }, (_, i) => row(20 - (i % 18), `old${i}`, i));
  const all = desc([...recent, ...older]);
  // Ignores `to` entirely AND caps: the newest three rows come back every time.
  const get = async (_p, params) => all.slice(0, Math.min(params.count, CAP));

  await assert.rejects(
    () => fetchRange({ get, handle, from: FROM, to: TO }),
    (err) => {
      assert.ok(err instanceof PaginationError, `expected PaginationError, got ${err}`);
      return true;
    }
  );
});

test('a stale PENDING row from an earlier month does not end the walk', async () => {
  // No filter is applied on transaction state, so a pre-authorisation that never
  // completed rides along in the feed, placed by its start date. Folding that
  // start date into the page's minimum made a single request look like it had
  // reached the start of history: 201 of 400 rows were dropped, with no error
  // and an intact balance chain, because the loss was at the old end where the
  // chain is blind. Paging decisions are made on completion dates only.
  const all = desc(Array.from({ length: 400 }, (_, i) => row(30 - (i % 29), `in${i}`, i)));
  const stale = {
    ...txnIn(JOINT_POCKET, 15, 'stale-preauth'),
    state: 'PENDING',
    startedDate: Date.UTC(2026, 6, 15), // last month, never completed
    completedDate: null,
    balance: null
  };
  // `ORDER BY completed_date DESC` puts nulls first in PostgreSQL, so it leads
  // the feed -- but the walk must survive it appearing anywhere.
  for (const served of [[stale, ...all], [...all, stale]]) {
    const get = async (_p, params) =>
      served.filter(r => (r.completedDate ?? r.startedDate) <= params.to).slice(0, params.count);
    const out = await fetchRange({ get, handle, from: FROM, to: TO });
    assert.equal(out.length, all.length, `expected every row, got ${out.length} of ${all.length}`);
  }
});

test('a transient empty page does not truncate the export', async () => {
  // `docs/api-notes.md` records this endpoint answering 200 with an empty array
  // while the account still has transactions. Page length is not treated as
  // evidence anywhere else in the walk, and an empty page is page length.
  const all = desc(Array.from({ length: 500 }, (_, i) => row(30 - (i % 29), `r${i}`, i)));
  let calls = 0;
  const get = async (_p, params) => {
    calls++;
    if (calls === 2) return []; // one spurious empty answer, mid-walk
    return all.filter(r => r.completedDate <= params.to).slice(0, params.count);
  };

  const out = await fetchRange({ get, handle, from: FROM, to: TO });
  assert.equal(out.length, all.length, `expected every row, got ${out.length} of ${all.length}`);
});

test('a tie group larger than any page refuses rather than dropping its tail', async () => {
  // The walk widens to a ceiling; a group bigger than that ceiling cannot be
  // read whole by any request, and stepping past it drops the remainder at the
  // OLDEST end of the range -- the one place the balance chain is blind. This
  // returned 2030 of 2430 rows with no error.
  const t = Date.UTC(2026, 7, 15, 3);
  const tie = Array.from({ length: 2400 }, (_, i) => ({
    ...txnIn(JOINT_POCKET, 15, `tie${i}`), amount: -(100 + i), startedDate: t, completedDate: t
  }));
  const above = Array.from({ length: 30 }, (_, i) => row(25 - (i % 9), `above${i}`, i));
  const all = desc([...tie, ...above]);
  const get = async (_p, params) => all.filter(r => r.completedDate <= params.to).slice(0, params.count);

  await assert.rejects(
    () => fetchRange({ get, handle, from: FROM, to: TO }),
    (err) => {
      assert.ok(err instanceof PaginationError, `expected PaginationError, got ${err}`);
      assert.match(err.message, /Refusing to write a partial file/);
      return true;
    }
  );
});
