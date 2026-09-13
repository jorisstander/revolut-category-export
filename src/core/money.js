/** ISO 4217 currencies whose minor unit is not 1/100. */
const EXPONENTS = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3
};

export function currencyExponent(code) {
  // Upper-cased first: a lowercase 'jpy' would otherwise miss the table and
  // default to two decimals, rendering a JPY amount 100 times too small.
  const key = typeof code === 'string' ? code.toUpperCase() : code;
  return Object.prototype.hasOwnProperty.call(EXPONENTS, key) ? EXPONENTS[key] : 2;
}

/**
 * Convert minor units to a decimal string.
 * Returns a string so no float rounding can touch a monetary value.
 * @param {number} minor
 * @param {string} currency
 * @returns {string}
 */
export function minorToDecimal(minor, currency) {
  // isSafeInteger, not isInteger: 1e21 is an integer, but String(1e21) is
  // exponential and the digit-slicing below would silently mangle it.
  if (!Number.isSafeInteger(minor)) {
    throw new TypeError(`amount must be a safe integer in minor units, got ${minor}`);
  }
  const exponent = currencyExponent(currency);
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0');
  if (exponent === 0) return sign + digits;
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
