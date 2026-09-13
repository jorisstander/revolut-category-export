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

// Excel, LibreOffice and Sheets parse a cell beginning = + - @ as a formula.
// Descriptions and comments come from the API, and the reference on an inbound
// transfer is written by whoever sent the money -- so that text is
// attacker-controlled. An apostrophe prefix marks the cell as literal text;
// spreadsheets consume it rather than showing it.
// Written as char codes to keep the intent readable: = + - @
const FORMULA_LEAD = new Set([0x3d, 0x2b, 0x2d, 0x40]);

// Amounts, fees and balances legitimately begin with a minus, and must not be
// escaped, or every numeric column would import as text and stop summing.
const PLAIN_NUMBER = /^-?[0-9]+([.][0-9]+)?$/;

function cell(value) {
  const raw = value == null ? '' : String(value);
  // Leading whitespace is not a defence: a spreadsheet trims it on import and
  // then parses what follows, so a space, tab or non-breaking space in front of
  // `=` is a way through rather than a reason to relax. Both tests below read
  // the same trimmed text, so the two halves cannot disagree about what counts
  // as blank -- an earlier version checked an ASCII-only set against a Unicode
  // trim, and let a non-breaking space through.
  const body = raw.trimStart();
  let s = raw;
  if (body && FORMULA_LEAD.has(body.charCodeAt(0)) && !PLAIN_NUMBER.test(body)) {
    s = "'" + raw;
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
