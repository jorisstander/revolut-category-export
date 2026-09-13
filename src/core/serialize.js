/** [header, ExportRow property] in output order. */
export const CSV_COLUMNS = [
  ['Type', 'type'],
  ['Started Date', 'startedDate'],
  ['Completed Date', 'completedDate'],
  ['Description', 'description'],
  ['Amount', 'amount'],
  ['Fee', 'fee'],
  ['Currency', 'currency'],
  ['State', 'state'],
  ['Balance', 'balance'],
  ['Category', 'category'],
  ['Comment', 'comment'],
  ['Transaction ID', 'transactionId']
];

// U+FEFF, written as an escape because an invisible character in source is unreviewable.
const BOM = String.fromCharCode(0xFEFF);

// Excel, LibreOffice and Sheets parse a cell beginning = + - @ (or a leading
// tab or carriage return) as a formula. Descriptions and comments come from
// the API, and the reference on an inbound transfer is written by whoever sent
// the money -- so that text is attacker-controlled. An apostrophe prefix marks
// the cell as literal text; spreadsheets consume it rather than showing it.
// Written as char codes to keep the intent readable: = + - @ TAB CR.
const FORMULA_LEAD = new Set([0x3d, 0x2b, 0x2d, 0x40, 0x09, 0x0d]);

// Amounts, fees and balances legitimately begin with a minus, and must not be
// escaped, or every numeric column would import as text and stop summing.
const PLAIN_NUMBER = /^-?[0-9]+([.][0-9]+)?$/;

function cell(value) {
  let s = value == null ? '' : String(value);
  if (s && FORMULA_LEAD.has(s.charCodeAt(0)) && !PLAIN_NUMBER.test(s)) {
    s = "'" + s;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {import('./normalize.js').ExportRow[]} rows
 * @returns {string} RFC 4180 CSV, CRLF line endings, UTF-8 BOM
 */
export function toCsv(rows) {
  const lines = [CSV_COLUMNS.map(c => cell(c[0])).join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map(c => cell(row[c[1]])).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}
