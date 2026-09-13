import { pocketLabel } from './wallets.js';
import { TRANSACTIONS_PATH, SessionExpiredError } from './http.js';
import { rowsBelongingTo, assertServedCorrectAccount, ForeignAccountError } from './account-scope.js';

/**
 * @typedef {Object} AccountHandle
 * @property {import('./wallets.js').PocketRef} pocket
 * @property {string} label
 * @property {string} pocketId
 * @property {string[]} knownPocketIds
 * @property {{name: 'internalPocketId'|'walletId', value: string}|null} selector
 * @property {boolean} supported
 * @property {boolean} verified
 */

/** Candidate selectors, in the order they are tried. */
const SELECTORS = [
  { name: 'internalPocketId', from: (pocket) => pocket.pocketId },
  { name: 'walletId', from: (pocket) => pocket.walletId }
];

// Larger than 1: a wallet-scoped feed may open with another pocket's rows.
const PROBE_COUNT = 25;

/**
 * Determine which query parameter actually addresses this pocket, by probing.
 * @param {import('./wallets.js').PocketRef} pocket
 * @param {{get: Function, allPockets: Array}} deps
 * @returns {Promise<AccountHandle>}
 */
export async function resolveHandle(pocket, { get, allPockets = [] }) {
  const knownPocketIds = new Set(allPockets.map(p => p.pocketId));
  const base = {
    pocket,
    label: pocketLabel(pocket),
    pocketId: pocket.pocketId,
    knownPocketIds: [...knownPocketIds]
  };

  let fallback = null;
  let lastError = null;

  for (const selector of SELECTORS) {
    const value = selector.from(pocket);
    if (!value) continue;

    let rows;
    try {
      rows = await get(TRANSACTIONS_PATH, { [selector.name]: value, count: PROBE_COUNT });
    } catch (error) {
      // An expired session is fatal for every account; anything else may just
      // mean this selector is wrong for this one, so try the next.
      if (error instanceof SessionExpiredError) throw error;
      lastError = error;
      continue;
    }

    if (!Array.isArray(rows)) {
      throw new Error(
        `Expected an array of transactions from ${TRANSACTIONS_PATH}, received ${rows === null ? 'null' : typeof rows}.`
      );
    }

    try {
      assertServedCorrectAccount(rows, { pocketId: pocket.pocketId, knownPocketIds });
    } catch (error) {
      if (error instanceof ForeignAccountError) continue;  // addresses a different account
      throw error;
    }

    if (rowsBelongingTo(rows, pocket.pocketId).length > 0) {
      return { ...base, selector: { name: selector.name, value }, supported: true, verified: true };
    }

    // Returned nothing of ours and nothing incriminating: a weak candidate.
    fallback ??= { name: selector.name, value };
  }

  if (!fallback && lastError) throw lastError;

  return { ...base, selector: fallback, supported: Boolean(fallback), verified: false };
}
