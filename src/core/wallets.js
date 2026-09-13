/**
 * Flattens GET /api/retail/wallets — an object keyed by account type — into a
 * flat list of pockets, each tagged with the wallet and account type it belongs to.
 */

/**
 * @typedef {Object} PocketRef
 * @property {string} walletId
 * @property {string} accountType
 * @property {string} pocketId
 * @property {string} currency
 * @property {string} pocketType
 * @property {string} state
 * @property {boolean} closed
 */

/** @returns {PocketRef[]} */
export function parseWallets(response) {
  const out = [];
  for (const [accountType, wallets] of Object.entries(response ?? {})) {
    if (!Array.isArray(wallets)) continue;
    for (const wallet of wallets) {
      const pockets = [...(wallet.pockets ?? []), ...(wallet.sharedPockets ?? [])];
      for (const pocket of pockets) {
        out.push({
          walletId: wallet.id,
          accountType,
          pocketId: pocket.id,
          currency: pocket.currency,
          pocketType: pocket.type,
          state: pocket.state,
          closed: Boolean(pocket.closed)
        });
      }
    }
  }
  return out;
}

const TYPE_LABELS = {
  PERSONAL: 'Personal',
  PERSONAL_JOINT: 'Joint',
  YOUTH: 'Youth',
  TEEN: 'Teen',
  FAMILY_CREDIT_CARD: 'Family credit card'
};

/**
 * Human label for a picker entry.
 * Never throws: this runs on the discovery failure path, where a throw would
 * hide every account instead of reporting the one that failed.
 * @param {Partial<PocketRef>|null|undefined} pocket
 * @returns {string}
 */
export function pocketLabel(pocket) {
  const p = pocket ?? {};
  const kind = TYPE_LABELS[p.accountType] ?? String(p.accountType ?? 'Account');
  const parts = [kind, String(p.currency ?? '?')];
  if (p.pocketType && p.pocketType !== 'CURRENT') {
    parts.push(String(p.pocketType).toLowerCase().replace(/_/g, ' '));
  }
  const suffix = p.state && p.state !== 'ACTIVE' ? ` (${String(p.state).toLowerCase()})` : '';
  return parts.join(' · ') + suffix;
}
