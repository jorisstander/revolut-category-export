import { parseWallets, pocketLabel } from './wallets.js';
import { resolveHandle } from './handles.js';
import { fetchRange } from './paginate.js';
import { toExportRows } from './normalize.js';
import { toCsv } from './serialize.js';
import { monthToRange } from './dates.js';
import { WALLETS_PATH, SessionExpiredError } from './http.js';

/**
 * Discover every account the user holds, and work out how to address each.
 *
 * Accounts are probed concurrently and settled independently: one that throws
 * is reported in `failures` while the others still resolve. Promise.all here
 * would leave the user with an empty picker because of one odd account type.
 *
 * @param {{get: Function}} deps
 * @returns {Promise<{accounts: import('./handles.js').AccountHandle[],
 *                    failures: Array<{label: string, error: Error}>}>}
 */
export async function discoverAccounts({ get }) {
  const pockets = parseWallets(await get(WALLETS_PATH));

  const settled = await Promise.allSettled(
    pockets.map(pocket => resolveHandle(pocket, { get, allPockets: pockets }))
  );

  const accounts = [];
  const failures = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') accounts.push(outcome.value);
    else failures.push({ label: pocketLabel(pockets[index]), error: outcome.reason });
  });

  // An expired session affects every account. Reporting it as N per-account
  // failures would render as "no accounts found" and hide the real cause.
  const expired = failures.find(f => f.error instanceof SessionExpiredError);
  if (expired) throw expired.error;

  return { accounts, failures };
}

/**
 * Export one account over an instant range.
 * @param {{get: Function, handle: Object, from: number, to: number,
 *          label: string, timeZone: string}} options
 * @returns {Promise<{csv: string, rowCount: number, filename: string}>}
 */
export async function exportRange({ get, handle, from, to, label, timeZone }) {
  if (!handle?.supported || !handle.selector) {
    throw new Error(`Account "${handle?.label ?? 'unknown'}" is not supported: no usable selector was found.`);
  }

  const raw = await fetchRange({ get, handle, from, to });
  const rows = toExportRows(raw, { timeZone });

  return { csv: toCsv(rows), rowCount: rows.length, filename: buildFilename(handle, label) };
}

/** Export one calendar month. A thin wrapper over exportRange. */
export async function exportMonth({ get, handle, year, month, timeZone }) {
  const { from, to } = monthToRange(year, month, timeZone);
  return exportRange({
    get, handle, from, to, timeZone,
    label: `${year}-${String(month).padStart(2, '0')}`
  });
}

// Hyphens only, and bounded. Underscores are excluded so an unfamiliar account
// type cannot reintroduce the `personal_joint` wart in an otherwise hyphenated
// name, and the length cap keeps an API-supplied value from producing a
// filename the browser will reject.
const safe = (value, fallback) =>
  String(value ?? fallback).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)                 // cut first: trimming before this leaves a
    .replace(/^-+|-+$/g, '')      // trailing hyphen when the cut lands on one
  || fallback;

export function buildFilename(handle, label) {
  // Named from the same label the picker shows, so the saved file matches the
  // account the user chose. Deriving it from the raw accountType instead gave
  // `personal_joint` -- an underscore in an otherwise hyphenated name, for an
  // account the UI calls "Joint", long enough to overflow the popup's file row.
  const pocket = handle?.pocket;
  const kind = safe(pocket ? pocketLabel({ ...pocket, currency: null, state: 'ACTIVE' }) : null, 'account');
  const currency = safe(pocket?.currency, 'cur');
  return `revolut-${kind}-${currency}-${safe(label, 'export')}.csv`;
}
