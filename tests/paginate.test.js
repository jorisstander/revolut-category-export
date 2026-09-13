import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRange, PaginationError } from '../src/core/paginate.js';
import { TRANSACTIONS_PATH } from '../src/core/http.js';
import { txnIn, JOINT_POCKET, JOINT_SAVINGS_POCKET, JOINT_WALLET } from './fixtures/synthetic.js';

const handle = {
  selector: { name: 'walletId', value: JOINT_WALLET },
  pocketId: JOINT_POCKET
};
const at = (day) => Date.UTC(2026, 7, day, 12, 0, 0);
const t = (day, id) => txnIn(JOINT_POCKET, day, id);

/** A fake feed that honours the `to` cursor, as the real API does. */
function feed(rows) {
  const calls = [];
  const get = async (_path, params) => {
    calls.push(params);
    const cutoff = params.to;
    const page = rows.filter(r => cutoff === undefined || r.completedDate <= cutoff);
    return page.slice(0, params.count ?? page.length);
  };
  return { get, calls };
}

test('requests the transactions path with the handle selector', async () => {
  const { get, calls } = feed([]);
  await fetchRange({ get, handle, from: at(1), to: at(31) });
  assert.ok(calls.length > 0);
  for (const call of calls) assert.equal(call.walletId, JOINT_WALLET);
});

test('de-duplicates rows that overlap a page boundary', async () => {
  const rows = [t(20, 'a'), t(15, 'b'), t(10, 'c'), t(5, 'd'), t(2, 'e')];
  const { get } = feed(rows);
  const out = await fetchRange({ get, handle, from: at(1), to: at(31), pageSize: 3 });
  assert.deepEqual(out.map(r => r.id), ['a', 'b', 'c', 'd', 'e']);
});

test('drops rows belonging to another pocket in the same wallet', async () => {
  // walletId is wallet-scoped: the joint wallet's savings pocket rides along.
  const rows = [t(20, 'mine'), txnIn(JOINT_SAVINGS_POCKET, 15, 'savings'), t(10, 'mine-2')];
  const { get } = feed(rows);
  const out = await fetchRange({ get, handle, from: at(1), to: at(31) });
  assert.deepEqual(out.map(r => r.id), ['mine', 'mine-2']);
});

test('stops shortly after rows are older than `from`, and keeps only the range', async () => {
  // The walk reads a settlement-lag margin past `from` rather than stopping at
  // the first completion below it: on a server that orders by start date, a
  // payment that cleared inside the range can sit below one that did not.
  // Rows outside the range are discarded here, so the margin costs requests,
  // never rows.
  const rows = [t(20, 'a'), t(10, 'b'), t(2, 'old')];
  const { get, calls } = feed(rows);
  const out = await fetchRange({ get, handle, from: at(9), to: at(31), pageSize: 2 });
  assert.deepEqual(out.map(r => r.id), ['a', 'b']);
  assert.ok(calls.length <= 6, `should settle quickly, took ${calls.length}`);
});

test('excludes rows outside the half-open range', async () => {
  const rows = [t(31, 'after'), t(20, 'inside'), t(1, 'boundary')];
  const { get } = feed(rows);
  const out = await fetchRange({ get, handle, from: at(1), to: at(31) });
  assert.deepEqual(out.map(r => r.id), ['inside', 'boundary']);
});

test('terminates cleanly when the whole history is newer than `from`', async () => {
  // The final page is pure overlap. This is exhaustion, not corruption.
  const rows = [t(20, 'a'), t(19, 'b')];
  const { get } = feed(rows);
  const out = await fetchRange({ get, handle, from: at(1), to: at(31), pageSize: 2 });
  assert.deepEqual(out.map(r => r.id), ['a', 'b']);
});

test('terminates when every row shares one timestamp', async () => {
  const same = [t(20, 'x'), t(20, 'y'), t(20, 'z')];
  const { get } = feed(same);
  const out = await fetchRange({ get, handle, from: at(1), to: at(31), pageSize: 3 });
  assert.deepEqual(out.map(r => r.id).sort(), ['x', 'y', 'z']);
});

test('stops on an empty page, but only once it has been confirmed', async () => {
  // This endpoint has been seen answering 200 with an empty array while the
  // account still has transactions, so a single empty answer is not proof the
  // feed ran out. The cost of asking twice is one request on an empty month;
  // the cost of believing the first answer is every row older than it.
  const { get, calls } = feed([]);
  await fetchRange({ get, handle, from: at(1), to: at(31) });
  assert.equal(calls.length, 2);
});

test('enforces a hard page cap', async () => {
  // A feed that always yields one new, older row never exhausts.
  let day = 30;
  const get = async () => [t(day, `id-${day--}`)];
  await assert.rejects(
    () => fetchRange({ get, handle, from: at(1), to: at(31), maxPages: 3 }),
    PaginationError
  );
});

test('rejects a non-array response instead of exporting nothing', async () => {
  const get = async () => ({ message: 'schema changed' });
  await assert.rejects(() => fetchRange({ get, handle, from: at(1), to: at(31) }), /array/i);
});

/**
 * Month membership is decided by the COMPLETION date, and the two tests below
 * exist to stop that being "corrected" to the started date. It was, once.
 *
 * Verified against a real Revolut PDF statement: it dates a payment made on the
 * last day of one month, but cleared on the 1st, into the *following* month —
 * and omits one made on the last day of the month that cleared after it. Keying
 * on completion reproduced the statement's spend, receipts and net exactly;
 * keying on the started date did not.
 *
 * There is also a structural reason: the `Balance` column is the balance *after
 * completion*, so ordering rows by anything else makes it incoherent. Re-keying
 * on the started date broke the balance chain on about half the rows.
 */
const straddling = (startDay, completeDay, id) => ({
  ...t(startDay, id),
  startedDate: at(startDay),
  completedDate: at(completeDay)
});

test('includes a row that completed in range even though it started before it', async () => {
  const rows = [t(20, 'ordinary'), straddling(0, 1, 'cleared-on-the-first')];
  const { get } = feed(rows);
  const out = await fetchRange({ get, handle, from: at(1), to: at(31) });
  assert.deepEqual(out.map(r => r.id), ['ordinary', 'cleared-on-the-first']);
});

test('excludes a row that started in range but completed after it', async () => {
  const rows = [straddling(30, 32, 'clears-next-month'), t(20, 'ordinary')];
  const { get } = feed(rows);
  const out = await fetchRange({ get, handle, from: at(1), to: at(31) });
  assert.deepEqual(out.map(r => r.id), ['ordinary']);
});

test('rejects a handle with no selector', async () => {
  const get = async () => [];
  await assert.rejects(
    () => fetchRange({ get, handle: { pocketId: JOINT_POCKET, selector: null }, from: at(1), to: at(31) }),
    PaginationError
  );
});

test('refuses to export when the `to` cursor is ignored', async () => {
  // The documented API quirk is that unrecognised parameters are dropped. If that
  // ever applies to `to`, page two replays page one, "no new rows" reads as an
  // exhausted feed, and the month silently truncates. Fail loudly instead.
  const all = [t(30, 'a'), t(20, 'b'), t(10, 'c'), t(5, 'd')];
  const get = async (_path, params) => all.slice(0, params.count ?? all.length);
  await assert.rejects(
    () => fetchRange({ get, handle, from: at(1), to: at(31), pageSize: 2 }),
    (err) => {
      assert.ok(err instanceof PaginationError);
      assert.match(err.message, /Refusing to write a partial file/);
      return true;
    }
  );
});
