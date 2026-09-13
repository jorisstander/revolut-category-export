import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toExportRows } from '../src/core/normalize.js';
import { makeTxn } from './fixtures/synthetic.js';

const TZ = 'Europe/Berlin';
const one = (overrides) => toExportRows([makeTxn(overrides)], { timeZone: TZ })[0];

test('converts minor units to decimal strings', () => {
  const row = one({ amount: -1544, fee: 25, balance: 10000 });
  assert.equal(row.amount, '-15.44');
  assert.equal(row.fee, '0.25');
  assert.equal(row.balance, '100.00');
});

test('respects the currency exponent', () => {
  assert.equal(one({ amount: 1234, currency: 'JPY' }).amount, '1234');
});

test('formats timestamps in the given timezone', () => {
  assert.equal(one({ completedDate: Date.UTC(2026, 7, 10, 9, 1, 0) }).completedDate, '2026-08-10 11:01:00');
});

test('carries the category through unchanged', () => {
  // A value the fixture does not already use, so the override cannot be a no-op.
  assert.equal(one({ category: 'utilities' }).category, 'utilities');
});

test('falls back to tag when category is absent or empty', () => {
  const withTag = makeTxn({ category: undefined });
  withTag.tag = 'transfers';
  assert.equal(toExportRows([withTag], { timeZone: TZ })[0].category, 'transfers');

  const emptyCategory = makeTxn({ category: '' });
  emptyCategory.tag = 'transport';
  assert.equal(toExportRows([emptyCategory], { timeZone: TZ })[0].category, 'transport');
});

test('renders a missing category as an empty field, never as "undefined"', () => {
  assert.equal(one({ category: null }).category, '');
  assert.equal(one({ category: undefined }).category, '');
});

test('includes the in-app comment and the transaction id', () => {
  const row = one({ comment: 'shared cost', id: 'txn-9' });
  assert.equal(row.comment, 'shared cost');
  assert.equal(row.transactionId, 'txn-9');
});

test('leaves completedDate empty when it is missing', () => {
  const row = one({ completedDate: undefined });
  assert.equal(row.completedDate, '');
  assert.equal(row.startedDate, '2026-08-10 11:00:00');
});

test('a value of the wrong type fails loudly rather than blanking the cell', () => {
  // A silently empty Amount column in an otherwise well-formed row is exactly
  // the kind of plausible-but-wrong output this project refuses to produce.
  assert.throws(() => toExportRows([makeTxn({ amount: '-1544' })], { timeZone: TZ }), TypeError);
  assert.throws(() => toExportRows([makeTxn({ completedDate: '2026-08-10' })], { timeZone: TZ }), TypeError);
});
