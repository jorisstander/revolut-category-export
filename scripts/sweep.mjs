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

/**
 * A server is built from four independent choices, because a real one is too.
 *
 * Treating each behaviour as its own self-contained model was a mistake: the
 * shape that mattered was a server ORDERING by start date while a rounded cutoff
 * hid a batch, and no single model could express it. A row with ordinary
 * settlement lag sits low by start date and high by completion, which is exactly
 * what defeats a check written for a completion-ordered page.
 */
const COMPARES = ['completed', 'started'];
const ORDERS = ['completed', 'started'];
const INCLUSIVE = [true, false];
const ROUNDINGS = {
  exact: (t) => t,
  'up-hour': (t) => { const d = new Date(t); d.setUTCMinutes(59, 59, 999); return d.getTime(); },
  'up-day': (t) => { const d = new Date(t); d.setUTCHours(23, 59, 59, 999); return d.getTime(); },
  'down-hour': (t) => { const d = new Date(t); d.setUTCMinutes(0, 0, 0); return d.getTime(); },
  'down-day': (t) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
};

const fieldOf = (row, field) => (field === 'started' ? row.startedDate : instant(row));

/** Every combination of those choices, as one answering function each. */
const SERVERS = [];
for (const compare of COMPARES) {
  for (const order of ORDERS) {
    // A server sorts by the field it filters on. Filtering by one and ordering
    // by another is not a machine anybody builds, and catching it would mean
    // firing on evidence that accuses an ordinary server -- the two pull in
    // opposite directions. It is out of scope here, and said so rather than
    // quietly omitted.
    if (compare !== order) continue;
    for (const inclusive of INCLUSIVE) {
      for (const [rounding, round] of Object.entries(ROUNDINGS)) {
        SERVERS.push({
          name: `compare=${compare} order=${order} ${inclusive ? 'incl' : 'excl'} ${rounding}`,
          // "Exact" means it reads the cutoff as given. A start-date-keyed
          // server is refused once the cursor stalls -- a documented decision --
          // so only the completion-keyed one is held to never being refused.
          exact: rounding === 'exact' && compare === 'completed',
          answer(all, to, count, cap) {
            const cutoff = round(to);
            const matched = all.filter(row => {
              const value = fieldOf(row, compare);
              return typeof value === 'number' && (inclusive ? value <= cutoff : value < cutoff);
            });
            matched.sort((a, b) => fieldOf(b, order) - fieldOf(a, order));
            return matched.slice(0, cap ? Math.min(count, cap) : count);
          }
        });
      }
    }
  }
}

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
  { name: 'batch-and-pending', rows: 150, tie: 60, pending: 2, tieAt: 'oldest' },
  // Authorisations held for weeks and captured inside the month. They start well
  // before it and settle inside it, so on a start-ordered feed they sit below
  // everything else -- a minority of rows that are outliers in lag, which a
  // single lag rule applied to every row can never produce.
  { name: 'held-auths', rows: 300, holds: 120, holdLagDays: 21 },
  { name: 'few-held-auths', rows: 300, holds: 5, holdLagDays: 21 },
  // Rows ABOVE the range, spread across the two-day margin the walk starts from
  // and past it. Every other shape here stops at `TO`, so the margin above the
  // range and the escape that gives up on it were built, reasoned about, and
  // never once driven by this sweep. Measured: of the 165,840 rows this sweep
  // now places at or above `TO`, every single one comes from this shape. Adding
  // it found a silent short on its first run.
  { name: 'above-range', rows: 300, above: 120 },
  // A capture run reaching PAST the margin: authorisations started across weeks
  // and settled together just inside the month. On a start-ordered feed they
  // arrive as one contiguous block of near-identical completions, so there is no
  // inversion to measure -- the widest one seen was a single millisecond -- while
  // the oldest row of the month went missing in silence. Every other shape here
  // either keeps its holds inside the margin or spreads their completions, so
  // this class was invisible to the sweep while it cost a real row.
  { name: 'capture-run-deep', rows: 300, holds: 60, holdLagDays: 0, holdSpreadDays: 45,
    historyBelowDays: 50, deepHoldDays: 70 },
  // A dormant pocket with ONE authorisation held past the margin -- a holiday
  // account with a hotel booking on it. Its rows settle instantly, so on an
  // honest completion-ordered server every page is start-descending as well,
  // and the single hold spreads the lags on that page across a month. That is
  // the exact combination that made a start-ordering check accuse an honest
  // server and refuse a complete 41-row month.
  { name: 'lone-deep-hold', rows: 40, holds: 1, holdLagDays: 45, historyBelowDays: 50 }
];

const CAPS = [0, 120, 200, 500, 2000];
const LAGS = [0, 2, 21];
/** A batch landing on one instant, and the same batch spread over a few. */
const SMEARS = [1, 2, 5];

function feed({ rows: n, tie = 0, tieAt = 'oldest', pending = 0, history, lagDays = 0, smear = 1,
                holds = 0, holdLagDays = 0, holdSpreadDays = 0, historyBelowDays = 0,
                deepHoldDays = 0, above = 0 }) {
  const all = [];
  const gap = MONTH / Math.max(n, 1);
  // A lag that VARIES per row. A uniform one keeps start order and completion
  // order identical, which is the one case where the two can never disagree --
  // and disagreeing is the whole point of asking a start-date-keyed server.
  const lagOf = (i) => (lagDays === 0 ? 0 : ((i % 4) + 1) * lagDays * 864e5 / 2);
  let seq = 0;
  const add = (id, t, amount) => all.push({
    id, amount, fee: 0, startedDate: t - lagOf(seq++), completedDate: t, account: { id: POCKET }
  });

  for (let i = 0; i < n; i++) add(`in${i}`, TO - 1 - Math.floor(i * gap), -(10 + (i % 40)));
  if (tie) {
    const at = tieAt === 'oldest' ? FROM + 36e5 : FROM + Math.floor(MONTH / 2);
    // `smear` spreads the batch over a few consecutive milliseconds instead of
    // landing it all on one. A settlement run is not obliged to share an exact
    // instant, and a guard that asks "is this whole page one instant?" is
    // disarmed by a single row a millisecond above the rest.
    for (let i = 0; i < tie; i++) add(`tie${i}`, at + (i % smear), -7);
  }
  for (let i = 0; i < pending; i++) {
    all.push({
      id: `pend${i}`, amount: -3, fee: 0, startedDate: FROM + 36e5 * i,
      completedDate: null, balance: null, account: { id: POCKET }
    });
  }
  for (let i = 0; i < holds; i++) {
    // `holdSpreadDays` spreads when they STARTED. Bunched into one minute, every
    // hold carries the same lag, and a page of them cannot show the lag spread
    // that gives a start-ordered feed away.
    const back = holdSpreadDays === 0 ? i * 1000 : Math.floor(i * holdSpreadDays * 864e5 / Math.max(holds, 1));
    all.push({
      id: `hold${i}`, amount: -(20 + (i % 15)), fee: 0,
      startedDate: FROM - holdLagDays * 864e5 - back,
      completedDate: FROM + 3e5 + i, account: { id: POCKET }
    });
  }
  // Hourly, so some land inside the two-day margin the walk reads above `to` and
  // the rest above it.
  for (let i = 0; i < above; i++) add(`up${i}`, TO + 36e5 * (i + 1), -(12 + (i % 30)));
  // One authorisation held longer than everything else and settled as the OLDEST
  // row of the month, below even the history. On a start-ordered feed nothing
  // reaches it, and it lands where the balance chain has nothing beneath it to
  // break against -- so losing it is silent. The rows above it are what make it
  // catchable: they prove this account holds authorisations past the margin.
  if (deepHoldDays) {
    all.push({
      id: 'deep-hold', amount: -33, fee: 0,
      startedDate: FROM - deepHoldDays * 864e5,
      completedDate: FROM + 1, account: { id: POCKET }
    });
  }
  const behind = history === undefined ? Math.max(n, 100) : history;
  // `historyBelowDays` pushes the older history below a capture run instead of
  // interleaving with it. Where it interleaves, the walk stops on those rows'
  // completions before it has read a single held one -- so it ends with no
  // evidence of any hold at all, which is the one arrangement nothing can catch.
  const behindFrom = FROM - historyBelowDays * 864e5;
  for (let i = 0; i < behind; i++) add(`old${i}`, behindFrom - 1 - Math.floor(i * gap), -5);

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

async function run(all, server, cap) {
  const expected = all.filter(r => instant(r) >= FROM && instant(r) < TO).length;
  let calls = 0;
  const get = async (_path, params) => {
    calls++;
    return server.answer(all, params.to, params.count, cap);
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
for (const server of SERVERS) {
  const name = server.name;
  for (const cap of CAPS) {
    for (const shape of SHAPES) {
      for (const lagDays of LAGS) for (const smear of SMEARS) {
        const result = await run(feed({ ...shape, lagDays, smear }), server, cap);
        total++;
        if (result.refused) refused++;
        else if (result.short) {
          short++;
          shortCases.push(`${name} cap=${cap || 'none'} ${shape.name} lag=${lagDays}d smear=${smear} -> ${result.got}/${result.expected}`);
        } else {
          complete++;
          worst = Math.max(worst, result.calls);
        }
        if (verbose) {
          const verdict = result.refused ? `refused ${result.refused}` : `${result.got}/${result.expected}`;
          console.log(`  ${name} cap=${cap || 'none'} ${shape.name} lag=${lagDays}d smear=${smear} -> ${verdict}`);
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
/** Server models that read `to` exactly. None of these may refuse an honest feed. */
const EXACT = new Set(SERVERS.filter(s => s.exact).map(s => s.name));

let honest = 0, honestRefused = 0, honestShort = 0;
const honestRefusals = [];
const wrongRefusals = [];
for (const server of SERVERS) {
  const name = server.name;
  for (const shape of SHAPES) {
    // Every lag setting, not just one. This half carries the only rule that
    // forbids refusing a complete month, and it ran solely at `lagDays: 2` --
    // which gives every ordinary row a different lag and so breaks start order
    // on every page. Any false refusal needing instantly-settling rows was
    // therefore invisible to it by construction, and one shipped.
    for (const overshoot of [0, 5]) for (const smear of SMEARS) for (const honestLag of LAGS) {
      const all = feed({ ...shape, smear, lagDays: honestLag });
      const expected = all.filter(r => instant(r) >= FROM && instant(r) < TO).length;
      const get = async (_path, params) =>
        server.answer(all, params.to, params.count + overshoot, 0);
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
        // A tool that refuses everything is no use either, and only the other
        // half of this run was ever enforced. Refusing a coarse cutoff is a
        // documented decision; refusing a server that reads `to` exactly is a
        // bug, and one that would otherwise sit here climbing quietly.
        if (EXACT.has(name)) wrongRefusals.push(`${name} ${shape.name} smear=${smear}`);
      }
    }
  }
}

console.log(`\nhonest servers: ${honest} configurations`);
console.log(`  ${honestRefused} refused   ${honestShort} SHORT WITHOUT ERROR`);
if (verbose) for (const line of honestRefusals) console.log(`  refused: ${line}`);

for (const line of wrongRefusals) console.log(`  *** refused an exact-cutoff server: ${line}`);

// A third question the two sections above cannot ask: what if the server is not
// merely SHAPED oddly, but UNRELIABLE mid-walk? Every model above is a filter
// and a slice, so each empty page it returns is a genuine end of feed -- 3020 of
// the 75,422 those two sections serve, measured, most of them the ordering
// probe's own answers, and not one spurious -- and no row it has once shown
// ever stops being shown. Both of those gaps turned out to be hiding
// a real defect this sweep was reporting as clean.
// Every shape, not a chosen handful. The first version of this section ran four
// of them and missed the very defect it was written for: the shapes that catch a
// believed empty page are the ones carrying PENDING rows, and those were the two
// it left out. A sample of a fixture set is not the fixture set.
const FLAKY_SHAPES = SHAPES;

let flaky = 0, flakyShort = 0, flakyRefused = 0;
const flakyCases = [];
for (const server of SERVERS) {
  for (const shape of FLAKY_SHAPES) {
    for (const emptyAt of [1, 2, 3, 4, 5, 6]) {
      const all = feed({ ...shape, lagDays: 2 });
      const expected = all.filter(row => instant(row) >= FROM && instant(row) < TO).length;
      let n = 0;
      // One spurious empty answer, then honest again. This endpoint has been
      // observed answering 200 with an empty array while the account still holds
      // transactions, so this is a shape it genuinely takes.
      const get = async (_path, params) => {
        n++;
        return n === emptyAt ? [] : server.answer(all, params.to, params.count, 0);
      };
      flaky++;
      try {
        const out = await fetchRange({ get, handle, from: FROM, to: TO });
        if (out.length < expected) {
          flakyShort++;
          flakyCases.push(`${server.name} ${shape.name} empty-at-#${emptyAt} -> ${out.length}/${expected}`);
        }
      } catch { flakyRefused++; }
    }
  }
}

// And a row that LEAVES the feed: a zero-amount card authorisation reverting
// between two requests. Its amount is zero and it carries the balance of the row
// below it, so the ledger reads the same with or without it and only the paging
// walk can object. A server reading the cutoff exactly and capping nothing must
// still hand over the whole month -- refusing a complete month is a bug too.
let reverting = 0;
const revertingFailures = [];
for (const server of SERVERS.filter(model => model.exact)) {
  for (const shape of FLAKY_SHAPES) {
    const all = feed({ ...shape, lagDays: 2 });
    const expected = all.filter(row => instant(row) >= FROM && instant(row) < TO);
    // Between the two newest SETTLED rows: an unsettled one carries no balance,
    // so hanging the ghost off it would build a chain that cannot be read.
    const settled = all.filter(row => typeof row.completedDate === 'number');
    const at = settled[0].completedDate - 1;
    const ghost = { id: 'ghost', amount: 0, fee: 0, startedDate: at, completedDate: at,
                    balance: settled[1].balance, account: { id: POCKET } };
    const withGhost = [ghost, ...all].sort((a, b) => instant(b) - instant(a));
    let n = 0;
    const get = async (_path, params) => {
      n++;
      return server.answer(n === 1 ? withGhost : all, params.to, params.count, 0);
    };
    reverting++;
    try {
      const out = await fetchRange({ get, handle, from: FROM, to: TO });
      const ids = new Set(out.map(row => row.id));
      const lost = expected.filter(row => !ids.has(row.id)).length;
      if (lost > 0) revertingFailures.push(`${server.name} ${shape.name} -> lost ${lost} of ${expected.length}`);
    } catch (error) {
      revertingFailures.push(`${server.name} ${shape.name} -> refused ${error.name} on a complete month`);
    }
  }
}

console.log(`\nunreliable servers: ${flaky} configurations with one spurious empty page`);
console.log(`  ${flakyRefused} refused   ${flakyShort} SHORT WITHOUT ERROR`);
for (const line of flakyCases) console.log(`  *** ${line}`);
console.log(`  ${reverting} configurations with an authorisation reverting mid-walk, on exact-cutoff servers`);
for (const line of revertingFailures) console.log(`  *** ${line}`);

const failed = short > 0 || honestShort > 0 || wrongRefusals.length > 0 ||
  flakyShort > 0 || revertingFailures.length > 0;
console.log(`
${failed
  ? 'FAIL: ' + (short + honestShort + flakyShort > 0
      ? 'a short file was returned without an error.'
      : 'a complete month was refused on a server that reads the cutoff exactly.')
  : 'OK: no short file went unreported, and no exact-cutoff server refused a complete month.'}`);
process.exit(failed ? 1 : 0);
