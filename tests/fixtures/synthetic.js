/**
 * Synthetic fixtures. Every id, merchant and amount here is invented.
 * Never replace these with a real API capture: this repository is public.
 */

export const PERSONAL_WALLET      = '11111111-1111-4111-8111-111111111111';
export const PERSONAL_EUR_POCKET  = '22222222-2222-4222-8222-222222222222';
export const PERSONAL_USD_POCKET  = '33333333-3333-4333-8333-333333333333';
export const JOINT_WALLET         = '44444444-4444-4444-8444-444444444444';
export const JOINT_POCKET         = '55555555-5555-4555-8555-555555555555';
export const JOINT_SAVINGS_POCKET = '66666666-6666-4666-8666-666666666666';

export const WALLETS_RESPONSE = {
  PERSONAL: [{
    id: PERSONAL_WALLET,
    accountType: 'PERSONAL',
    baseCurrency: 'EUR',
    state: 'ACTIVE',
    pockets: [
      { id: PERSONAL_EUR_POCKET, type: 'CURRENT', currency: 'EUR', state: 'ACTIVE', closed: false },
      { id: PERSONAL_USD_POCKET, type: 'CURRENT', currency: 'USD', state: 'INACTIVE', closed: false }
    ],
    sharedPockets: []
  }],
  PERSONAL_JOINT: [{
    id: JOINT_WALLET,
    accountType: 'PERSONAL_JOINT',
    baseCurrency: 'EUR',
    state: 'ACTIVE',
    pockets: [
      { id: JOINT_POCKET, type: 'CURRENT', currency: 'EUR', state: 'ACTIVE', closed: false }
    ]
  }],
  YOUTH: [],
  TEEN: [],
  FAMILY_CREDIT_CARD: []
};

/** @returns {import('../../src/core/normalize.js').RawTxn} */
export function makeTxn(overrides = {}) {
  return {
    id: 'txn-0001',
    type: 'CARD_PAYMENT',
    state: 'COMPLETED',
    startedDate: Date.UTC(2026, 7, 10, 9, 0, 0),
    completedDate: Date.UTC(2026, 7, 10, 9, 1, 0),
    currency: 'EUR',
    amount: -1544,
    fee: 0,
    balance: 10000,
    description: 'Test Merchant',
    comment: '',
    category: 'groceries',
    account: { id: JOINT_POCKET, type: 'CURRENT' },
    ...overrides
  };
}

/** A transaction belonging to a specific pocket, dated on a given day of Aug 2026. */
export function txnIn(pocketId, day, id, overrides = {}) {
  const at = Date.UTC(2026, 7, day, 12, 0, 0);
  return makeTxn({ id, startedDate: at, completedDate: at, account: { id: pocketId, type: 'CURRENT' }, ...overrides });
}
