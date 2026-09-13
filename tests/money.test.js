import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minorToDecimal, currencyExponent } from '../src/core/money.js';

test('two-decimal currencies', () => {
  assert.equal(minorToDecimal(-42518, 'EUR'), '-425.18');
  assert.equal(minorToDecimal(1544, 'EUR'), '15.44');
  assert.equal(minorToDecimal(0, 'EUR'), '0.00');
  assert.equal(minorToDecimal(5, 'EUR'), '0.05');
  assert.equal(minorToDecimal(-5, 'EUR'), '-0.05');
});

test('zero-decimal currencies are not divided', () => {
  assert.equal(minorToDecimal(1234, 'JPY'), '1234');
  assert.equal(minorToDecimal(-5, 'JPY'), '-5');
  for (const code of ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'BIF', 'DJF', 'GNF', 'KMF', 'VUV', 'XPF']) {
    assert.equal(currencyExponent(code), 0, `${code} should have exponent 0`);
  }
});

test('three-decimal currencies', () => {
  assert.equal(minorToDecimal(1234, 'KWD'), '1.234');
  assert.equal(minorToDecimal(5, 'KWD'), '0.005');
  for (const code of ['BHD', 'KWD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']) {
    assert.equal(currencyExponent(code), 3, `${code} should have exponent 3`);
  }
});

test('unknown currencies default to two decimals', () => {
  assert.equal(currencyExponent('ZZZ'), 2);
  assert.equal(minorToDecimal(100, 'ZZZ'), '1.00');
});

test('does not inherit exponents from Object.prototype', () => {
  assert.equal(currencyExponent('constructor'), 2);
  assert.equal(currencyExponent('toString'), 2);
});

test('rejects non-integer minor units', () => {
  assert.throws(() => minorToDecimal(12.5, 'EUR'), TypeError);
  assert.throws(() => minorToDecimal(undefined, 'EUR'), TypeError);
});

test('currency codes are matched case-insensitively', () => {
  // A lowercase code missing the table would default to two decimals and render
  // a zero-decimal currency 100 times too small.
  assert.equal(currencyExponent('jpy'), 0);
  assert.equal(currencyExponent('Kwd'), 3);
  assert.equal(minorToDecimal(1234, 'jpy'), '1234');
});

test('rejects an integer too large to render without exponential notation', () => {
  // String(1e21) is "1e+21"; digit-slicing it would silently produce nonsense.
  assert.throws(() => minorToDecimal(1e21, 'EUR'), TypeError);
  assert.equal(minorToDecimal(Number.MAX_SAFE_INTEGER, 'EUR'), '90071992547409.91');
});
