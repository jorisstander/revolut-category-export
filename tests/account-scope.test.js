import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowsBelongingTo, assertServedCorrectAccount, ForeignAccountError } from '../src/core/account-scope.js';
import { makeTxn, JOINT_POCKET, JOINT_SAVINGS_POCKET, PERSONAL_EUR_POCKET, PERSONAL_USD_POCKET } from './fixtures/synthetic.js';

const known = new Set([JOINT_POCKET, PERSONAL_EUR_POCKET, PERSONAL_USD_POCKET]);
const ours = (id) => makeTxn({ id, account: { id: JOINT_POCKET, type: 'CURRENT' } });
const savings = (id) => makeTxn({ id, account: { id: JOINT_SAVINGS_POCKET, type: 'SAVINGS_INTEREST_BEARING' } });
const eur = (id) => makeTxn({ id, account: { id: PERSONAL_EUR_POCKET, type: 'CURRENT' } });

test('filters a wallet-scoped page down to the selected pocket', () => {
  const rows = [ours('a'), savings('b'), ours('c')];
  assert.deepEqual(rowsBelongingTo(rows, JOINT_POCKET).map(r => r.id), ['a', 'c']);
});

test('filter tolerates rows with no account information', () => {
  assert.deepEqual(rowsBelongingTo([makeTxn({ account: undefined })], JOINT_POCKET), []);
});

test('probe check passes when our rows are present', () => {
  const rows = [ours('a'), savings('b')];
  assert.deepEqual(assertServedCorrectAccount(rows, { pocketId: JOINT_POCKET, knownPocketIds: known }), rows);
});

test('probe check REJECTS a selector serving only a sibling pocket in the same wallet', () => {
  // The bug this rule exists for: resolving the USD pocket via walletId returns the
  // EUR pocket's rows. Same wallet, so a wallet-scoped rule would wave these through.
  assert.throws(
    () => assertServedCorrectAccount([eur('x')], { pocketId: PERSONAL_USD_POCKET, knownPocketIds: known }),
    ForeignAccountError
  );
});

test('probe check rejects a selector serving another wallet entirely', () => {
  assert.throws(
    () => assertServedCorrectAccount([eur('x')], { pocketId: JOINT_POCKET, knownPocketIds: known }),
    ForeignAccountError
  );
});

test('the error names both accounts so the cause is obvious', () => {
  assert.throws(
    () => assertServedCorrectAccount([eur('x')], { pocketId: JOINT_POCKET, knownPocketIds: known }),
    new RegExp(PERSONAL_EUR_POCKET)
  );
});

test('probe check accepts a page of only unrecognised ids', () => {
  // A savings-only page is legitimate mid-feed; it proves nothing either way.
  const rows = [savings('a')];
  assert.deepEqual(assertServedCorrectAccount(rows, { pocketId: JOINT_POCKET, knownPocketIds: known }), rows);
});

test('probe check accepts an empty page', () => {
  assert.deepEqual(assertServedCorrectAccount([], { pocketId: JOINT_POCKET, knownPocketIds: known }), []);
});

test('a handle with no pocket id matches nothing rather than everything unattributed', () => {
  const rows = [makeTxn({ id: 'x', account: undefined }), makeTxn({ id: 'y' })];
  assert.deepEqual(rowsBelongingTo(rows, undefined), []);
  assert.deepEqual(rowsBelongingTo(rows, null), []);
});
