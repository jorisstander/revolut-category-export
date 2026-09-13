import { minorToDecimal } from './money.js';
import { formatInstant } from './dates.js';

/**
 * @typedef {Object} RawTxn
 * @property {string} id
 * @property {string} type
 * @property {string} state
 * @property {number} startedDate
 * @property {number} completedDate
 * @property {string} currency
 * @property {number} amount
 * @property {number} fee
 * @property {number} balance
 * @property {string} description
 * @property {string} [comment]
 * @property {string} category
 * @property {string} [tag] legacy duplicate of `category`; see docs/api-notes.md
 * @property {{id: string, type: string}} account
 */

/**
 * @typedef {Object} ExportRow
 * @property {string} type
 * @property {string} startedDate
 * @property {string} completedDate
 * @property {string} description
 * @property {string} amount
 * @property {string} fee
 * @property {string} currency
 * @property {string} state
 * @property {string} balance
 * @property {string} category
 * @property {string} comment
 * @property {string} transactionId
 */

// Absent is fine -- a PENDING row has no completion date, and an empty cell is
// the honest rendering. A value of the wrong TYPE is not fine: it means the API
// changed shape, and silently blanking the cell would hand back a file that
// looks complete. A non-integer amount already threw; these now match it.
const instant = (value, timeZone) => {
  if (value == null) return '';
  if (typeof value !== 'number') {
    throw new TypeError(`expected an epoch timestamp in milliseconds, got ${typeof value}`);
  }
  return formatInstant(value, timeZone);
};

const money = (value, currency) => {
  if (value == null) return '';
  if (typeof value !== 'number') {
    throw new TypeError(`expected an amount in minor units as a number, got ${typeof value}`);
  }
  return minorToDecimal(value, currency);
};

/**
 * @param {RawTxn[]} rows
 * @param {{timeZone: string}} options
 * @returns {ExportRow[]}
 */
export function toExportRows(rows, { timeZone }) {
  return rows.map(row => ({
    type: row.type ?? '',
    startedDate: instant(row.startedDate, timeZone),
    completedDate: instant(row.completedDate, timeZone),
    description: row.description ?? '',
    amount: money(row.amount, row.currency),
    fee: money(row.fee, row.currency),
    currency: row.currency ?? '',
    state: row.state ?? '',
    balance: money(row.balance, row.currency),
    category: row.category || row.tag || '',
    comment: row.comment ?? '',
    transactionId: row.id ?? ''
  }));
}
