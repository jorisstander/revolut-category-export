import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWallets, pocketLabel } from '../src/core/wallets.js';
import {
  WALLETS_RESPONSE, PERSONAL_EUR_POCKET, PERSONAL_USD_POCKET,
  PERSONAL_WALLET, JOINT_POCKET, JOINT_WALLET
} from './fixtures/synthetic.js';

test('flattens every account type into pocket refs', () => {
  const pockets = parseWallets(WALLETS_RESPONSE);
  assert.equal(pockets.length, 3);
  assert.deepEqual(pockets.map(p => p.pocketId).sort(),
    [PERSONAL_EUR_POCKET, PERSONAL_USD_POCKET, JOINT_POCKET].sort());
});

test('carries account type and wallet id onto each pocket', () => {
  const pockets = parseWallets(WALLETS_RESPONSE);
  const joint = pockets.find(p => p.pocketId === JOINT_POCKET);
  assert.equal(joint.accountType, 'PERSONAL_JOINT');
  assert.equal(joint.walletId, JOINT_WALLET);
  const personal = pockets.find(p => p.pocketId === PERSONAL_EUR_POCKET);
  assert.equal(personal.accountType, 'PERSONAL');
  assert.equal(personal.walletId, PERSONAL_WALLET);
});

test('preserves currency, type and state', () => {
  const usd = parseWallets(WALLETS_RESPONSE).find(p => p.pocketId === PERSONAL_USD_POCKET);
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.state, 'INACTIVE');
  assert.equal(usd.pocketType, 'CURRENT');
  assert.equal(usd.closed, false);
});

test('includes sharedPockets', () => {
  const response = {
    PERSONAL: [{
      id: 'w', accountType: 'PERSONAL', pockets: [],
      sharedPockets: [{ id: 'shared-1', type: 'CURRENT', currency: 'EUR', state: 'ACTIVE', closed: false }]
    }]
  };
  assert.equal(parseWallets(response)[0].pocketId, 'shared-1');
});

test('ignores empty account types and tolerates missing input', () => {
  assert.deepEqual(parseWallets({ YOUTH: [], TEEN: [] }), []);
  assert.deepEqual(parseWallets({}), []);
  assert.deepEqual(parseWallets(null), []);
});

test('labels each known account type distinctly', () => {
  assert.match(pocketLabel({ accountType: 'PERSONAL_JOINT', currency: 'EUR', pocketType: 'CURRENT', state: 'ACTIVE' }), /^Joint/);
  assert.match(pocketLabel({ accountType: 'PERSONAL', currency: 'EUR', pocketType: 'CURRENT', state: 'ACTIVE' }), /^Personal/);
  assert.match(pocketLabel({ accountType: 'YOUTH', currency: 'EUR', pocketType: 'CURRENT', state: 'ACTIVE' }), /^Youth/);
  assert.match(pocketLabel({ accountType: 'TEEN', currency: 'EUR', pocketType: 'CURRENT', state: 'ACTIVE' }), /^Teen/);
});

test('label distinguishes currency, non-current pockets and inactive state', () => {
  assert.equal(pocketLabel({ accountType: 'PERSONAL', currency: 'USD', pocketType: 'CURRENT', state: 'INACTIVE' }), 'Personal · USD (inactive)');
  assert.match(pocketLabel({ accountType: 'PERSONAL_JOINT', currency: 'EUR', pocketType: 'SAVINGS_INTEREST_BEARING', state: 'ACTIVE' }), /savings interest bearing/);
});

test('label never throws on a malformed pocket', () => {
  // Called on the discovery failure path, so a throw here would hide every account.
  assert.doesNotThrow(() => pocketLabel({}));
  assert.doesNotThrow(() => pocketLabel(null));
  assert.doesNotThrow(() => pocketLabel({ accountType: 'WHAT_IS_THIS' }));
});
