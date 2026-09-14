#!/usr/bin/env node
// Drive the paging walk against many simulated servers and report what it does.
//
// The test suite pins specific failures that were found and fixed. This asks the
// broader question those tests cannot: across the server behaviours nobody has
// established for this API, does the walk ever return a SHORT FILE WITHOUT SAYING
// SO? That is the only outcome treated as a failure here. Refusing is a pass:
// the walk is allowed to decide it cannot prove a month complete.
//
// It also checks the other direction, because a tool that refuses everything is
// no use either: feeds an honest server would hand over whole must come back
// whole, or be refused only for a reason already documented.
//
// Usage: node scripts/sweep.mjs [--verbose]
import { fetchRange } from '../src/core/paginate.js';

const POCKET = '55555555-5555-4555-8555-555555555555';
const WALLET = '44444444-4444-4444-8444-444444444444';
const handle = { selector: { name: 'walletId', value: WALLET }, pocketId: POCKET };
const verbose = process.argv.includes('--verbose');

// A calendar month with local boundaries, as the extension actually asks for:
// rarely midnight UTC, which is what makes a rounded cutoff visible.
const FROM = Date.UTC(2026, 6, 31, 22);
const TO = Date.UTC(2026, 7, 31, 22);
const MONTH = TO - FROM;

const endOf = (unit) => (t) => {
  const d = new Date(t);
  if (unit === 'day') d.setUTCHours(23, 59, 59, 999);
  if (unit === 'hour') d.setUTCMinutes(59, 59, 999);
  return d.getTime();
};
const startOf = (unit) => (t) => {
  const d = new Date(t);
  if (unit === 'day') d.setUTCHours(0, 0, 0, 0);
  if (unit === 'hour') d.setUTCMinutes(0, 0, 0);
  return d.getTime();
};
const instant = (row) => row.completedDate ?? row.startedDate;

/** How a server might read `to`. None of these has been established; all are plausible. */
const SEMANTICS = {
  inclusive: (r, to) => instant(r) <= to,
  exclusive: (r, to) => instant(r) < to,
  'started-inclusive': (r, to) => r.startedDate <= to,
  'started-exclusive': (r, to) => r.startedDate < to,
  'rounded-up-day': (r, to) => instant(r) <= endOf('day')(to),
  'rounded-up-hour': (r, to) => instant(r) <= endOf('hour')(to),
  'rounded-down-day': (r, to) => instant(r) <= startOf('day')(to),
  'rounded-down-hour': (r, to) => instant(r) <= startOf('hour')(to)
};

/** Shapes of account this has to survive. Every value below is invented. */
const SHAPES = [
  { name: 'quiet', rows: 40 },
  { name: 'ordinary', rows: 400 },
  { name: 'busy', rows: 900 },
  { name: 'batch-oldest', rows: 300, tie: 250, tieAt: 'oldest' },
  { name: 'batch-middle', rows: 300, tie: 250, tieAt: 'middle' },
  { name: 'batch-small', rows: 200, tie: 40, tieAt: 'oldest' },
  { name: 'first-month', rows: 300, tie: 250, tieAt: 'oldest', history: 0 },
  { name: 'with-pending', rows: 200, pending: 3 },
  { name: 'batch-and-pending', rows: 150, tie: 60, pending: 2, tieAt: 'oldest' }
];

const CAPS = [0, 50, 120, 200, 250, 500, 1000, 2000];
const LAGS = [0, 2, 21];

function feed({ rows: n, tie = 0, tieAt = 'oldest', pending = 0, history, lagDays = 0 }) {
  const all = [];
  const gap = MONTH / Math.max(n, 1);
  const lag = lagDays * 864e5;
  const add = (id, t, amount) => all.push({
    id, amount, fee: 0, startedDate: t - lag, completedDate: t, account: { id: POCKET }
  });

  for (let i = 0; i < n; i++) add(`in${i}`, TO - 1 - Math.floor(i * gap), -(10 + (i % 40)));
  if (tie) {
    const at = tieAt === 'oldest' ? FROM + 36e5 : FROM + Math.floor(MONTH / 2);
    for (let i = 0; i < tie; i++) add(`tie${i}`, at, -7);
  }
  for (let i = 0; i < pending; i++) {
    all.push({
      id: `pend${i}`, amount: -3, fee: 0, startedDate: FROM + 36e5 * i,
      completedDate: null, balance: null, account: { id: POCKET }
    });
  }
  const behind = history === undefined ? Math.max(n, 100) : history;
  for (let i = 0; i < behind; i++) add(`old${i}`, FROM - 1 - Math.floor(i * gap), -5);

  all.sort((a, b) => instant(b) - instant(a));
  // A running balance, so the completeness check has something to verify.
  let balance = 9_000_000;
  for (const row of all) {
    if (row.completedDate === null) continue;
    row.balance = balance;
    balance -= row.amount;
  }
  return all;
}

async function run(all, filter, cap) {
  const expected = all.filter(r => instant(r) >= FROM && instant(r) < TO).length;
  let calls = 0;
  const get = async (_path, params) => {
    calls++;
    const matched = all.filter(r => filter(r, params.to));
    return cap ? matched.slice(0, Math.min(params.count, cap)) : matched.slice(0, params.count);
  };
  try {
    const out = await fetchRange({ get, handle, from: FROM, to: TO });
    return { calls, short: out.length < expected, got: out.length, expected };
  } catch (error) {
    return { calls, refused: error.name };
  }
}

console.log('Paging walk against simulated servers. A short file with no error is the only failure.\n');

let total = 0, complete = 0, refused = 0, short = 0, worst = 0;
const shortCases = [];
for (const [name, filter] of Object.entries(SEMANTICS)) {
  for (const cap of CAPS) {
    for (const shape of SHAPES) {
      for (const lagDays of LAGS) {
        const result = await run(feed({ ...shape, lagDays }), filter, cap);
        total++;
        if (result.refused) refused++;
        else if (result.short) {
          short++;
          shortCases.push(`${name} cap=${cap || 'none'} ${shape.name} lag=${lagDays}d -> ${result.got}/${result.expected}`);
        } else {
          complete++;
          worst = Math.max(worst, result.calls);
        }
        if (verbose) {
          const verdict = result.refused ? `refused ${result.refused}` : `${result.got}/${result.expected}`;
          console.log(`  ${name} cap=${cap || 'none'} ${shape.name} lag=${lagDays}d -> ${verdict}`);
        }
      }
    }
  }
}

console.log(`server models: ${total} configurations`);
console.log(`  ${complete} exported complete   ${refused} refused   ${short} SHORT WITHOUT ERROR`);
console.log(`  worst request count on a completed export: ${worst}`);
for (const line of shortCases) console.log(`  *** ${line}`);

// The other direction: an honest server that hands over everything it is asked
// for. None of these may come back short, and refusals here are worth reading.
let honest = 0, honestRefused = 0, honestShort = 0;
const honestRefusals = [];
for (const [name, filter] of Object.entries(SEMANTICS)) {
  for (const shape of SHAPES) {
    for (const overshoot of [0, 5]) {
      const all = feed(shape);
      const expected = all.filter(r => instant(r) >= FROM && instant(r) < TO).length;
      const get = async (_path, params) =>
        all.filter(r => filter(r, params.to)).slice(0, params.count + overshoot);
      honest++;
      try {
        const out = await fetchRange({ get, handle, from: FROM, to: TO });
        if (out.length < expected) {
          honestShort++;
          console.log(`  *** honest ${name} ${shape.name} -> ${out.length}/${expected}`);
        }
      } catch (error) {
        honestRefused++;
        honestRefusals.push(`${name} ${shape.name}`);
      }
    }
  }
}

console.log(`\nhonest servers: ${honest} configurations`);
console.log(`  ${honestRefused} refused   ${honestShort} SHORT WITHOUT ERROR`);
if (verbose) for (const line of honestRefusals) console.log(`  refused: ${line}`);

const failed = short > 0 || honestShort > 0;
console.log(`\n${failed ? 'FAIL: a short file was returned without an error.' : 'OK: no short file went unreported.'}`);
process.exit(failed ? 1 : 0);
