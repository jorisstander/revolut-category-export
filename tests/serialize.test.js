import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, CSV_COLUMNS } from '../src/core/serialize.js';

const row = {
  type: 'CARD_PAYMENT',
  startedDate: '2026-08-01 11:20:00',
  completedDate: '2026-08-01 11:21:00',
  description: 'Test Merchant',
  amount: '-15.44',
  fee: '0.00',
  currency: 'EUR',
  state: 'COMPLETED',
  balance: '100.00',
  category: 'groceries',
  comment: '',
  transactionId: 'aaaa-1111'
};

const body = (csv) => csv.slice(1).split('\r\n');

test('emits a BOM so Excel reads UTF-8 correctly', () => {
  assert.equal(toCsv([row]).charCodeAt(0), 0xFEFF);
});

test('header matches the documented column order', () => {
  assert.equal(
    body(toCsv([row]))[0],
    'Type,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance,Category,Comment,Transaction ID'
  );
  assert.equal(body(toCsv([row]))[0], CSV_COLUMNS.map(c => c[0]).join(','));
});

test('writes values in column order', () => {
  assert.equal(
    body(toCsv([row]))[1],
    'CARD_PAYMENT,2026-08-01 11:20:00,2026-08-01 11:21:00,Test Merchant,-15.44,0.00,EUR,COMPLETED,100.00,groceries,,aaaa-1111'
  );
});

test('quotes fields containing a comma, quote or newline', () => {
  const tricky = { ...row, description: 'Shop, "The" Best\nPlace' };
  assert.ok(toCsv([tricky]).includes('"Shop, ""The"" Best\nPlace"'));
});

test('renders null and undefined as empty fields', () => {
  const sparse = { ...row, comment: undefined, category: null };
  assert.ok(body(toCsv([sparse]))[1].endsWith('100.00,,,aaaa-1111'));
});

test('emits header only for an empty row set', () => {
  assert.equal(toCsv([]).slice(1), CSV_COLUMNS.map(c => c[0]).join(',') + '\r\n');
});

test('neutralises formula-leading text so a spreadsheet cannot execute it', () => {
  // The reference on an inbound transfer is written by whoever sent the money.
  const hostile = { ...row, description: '=HYPERLINK("elsewhere","click")', comment: '@SUM(1+1)' };
  const line = body(toCsv([hostile]))[1];
  assert.ok(line.includes(`'=HYPERLINK`), line);
  assert.ok(line.includes(`'@SUM(1+1)`), line);
});

test('a formula hidden behind leading whitespace is still neutralised', () => {
  // Spreadsheets trim a leading space or tab and then parse what follows, so
  // testing only the character at index 0 let this straight through.
  const payloads = [' =HYPERLINK("elsewhere","click")', String.fromCharCode(9) + '=1+1', '  @SUM(1+1)'];
  for (const description of payloads) {
    const line = body(toCsv([{ ...row, description }]))[1];
    assert.ok(line.includes("'"), 'not neutralised: ' + JSON.stringify(line));
  }
});

test('leaves negative amounts alone, so numeric columns still sum', () => {
  const line = body(toCsv([{ ...row, amount: '-15.44', balance: '-0.01', fee: '0.00' }]))[1];
  assert.ok(line.includes(',-15.44,'), line);
  assert.ok(line.includes(',-0.01,'), line);
  assert.ok(!line.includes("'-"), 'numbers must not be apostrophe-escaped: ' + line);
});

test('escapes a minus-leading value that is not a number', () => {
  const line = body(toCsv([{ ...row, description: '-1+1' }]))[1];
  assert.ok(line.includes(`'-1+1`), line);
});
