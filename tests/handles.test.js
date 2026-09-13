import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHandle } from '../src/core/handles.js';
import { parseWallets } from '../src/core/wallets.js';
import { SessionExpiredError } from '../src/core/http.js';
import {
  WALLETS_RESPONSE, txnIn,
  PERSONAL_EUR_POCKET, PERSONAL_USD_POCKET, PERSONAL_WALLET,
  JOINT_POCKET, JOINT_SAVINGS_POCKET, JOINT_WALLET
} from './fixtures/synthetic.js';

const pockets = parseWallets(WALLETS_RESPONSE);
const personal = pockets.find(p => p.pocketId === PERSONAL_EUR_POCKET);
const usd = pockets.find(p => p.pocketId === PERSONAL_USD_POCKET);
const joint = pockets.find(p => p.pocketId === JOINT_POCKET);

/** Mirrors the real API, including both silent-failure modes. */
function fakeApi() {
  return async (_path, params) => {
    if (params.internalPocketId === PERSONAL_EUR_POCKET) return [txnIn(PERSONAL_EUR_POCKET, 10, 'eur-1')];
    if (params.internalPocketId === PERSONAL_USD_POCKET) return [];        // genuinely quiet
    if (params.internalPocketId === JOINT_POCKET) return [];               // silent empty
    if (params.walletId === PERSONAL_WALLET) return [txnIn(PERSONAL_EUR_POCKET, 10, 'eur-1')];
    if (params.walletId === JOINT_WALLET) {
      return [txnIn(JOINT_POCKET, 10, 'j-1'), txnIn(JOINT_SAVINGS_POCKET, 9, 's-1')];
    }
    return [];
  };
}

test('personal pockets resolve to internalPocketId', async () => {
  const h = await resolveHandle(personal, { get: fakeApi(), allPockets: pockets });
  assert.equal(h.selector.name, 'internalPocketId');
  assert.equal(h.selector.value, PERSONAL_EUR_POCKET);
  assert.equal(h.verified, true);
});

test('the joint account resolves to walletId, not the empty internalPocketId', async () => {
  const h = await resolveHandle(joint, { get: fakeApi(), allPockets: pockets });
  assert.equal(h.selector.name, 'walletId');
  assert.equal(h.selector.value, JOINT_WALLET);
  assert.equal(h.verified, true);
});

test('never resolves a pocket to a selector serving its sibling', async () => {
  // The USD pocket is empty; walletId would return the EUR pocket's rows.
  // Accepting that would export EUR transactions in a file labelled USD.
  const h = await resolveHandle(usd, { get: fakeApi(), allPockets: pockets });
  assert.equal(h.verified, false);
  assert.notEqual(h.selector?.name, 'walletId');
  assert.equal(h.selector?.name, 'internalPocketId');
});

test('an account with no transactions is supported but unverified', async () => {
  const h = await resolveHandle(usd, { get: fakeApi(), allPockets: pockets });
  assert.equal(h.supported, true);
  assert.equal(h.verified, false);
});

test('carries the pocket id and the known-pocket set for later filtering', async () => {
  const h = await resolveHandle(joint, { get: fakeApi(), allPockets: pockets });
  assert.equal(h.pocketId, JOINT_POCKET);
  assert.ok(h.knownPocketIds.includes(PERSONAL_EUR_POCKET));
  assert.ok(typeof h.label === 'string' && h.label.length > 0);
});

test('an expired session propagates instead of marking the account unsupported', async () => {
  const get = async () => { throw new SessionExpiredError(); };
  await assert.rejects(() => resolveHandle(joint, { get, allPockets: pockets }), SessionExpiredError);
});

test('surfaces a real error when every selector fails', async () => {
  const get = async () => { throw new Error('upstream exploded'); };
  await assert.rejects(() => resolveHandle(joint, { get, allPockets: pockets }), /upstream exploded/);
});

test('rejects a non-array response rather than treating it as empty', async () => {
  const get = async () => ({ message: 'schema changed' });
  await assert.rejects(() => resolveHandle(joint, { get, allPockets: pockets }), /array/i);
});
