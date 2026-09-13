#!/usr/bin/env node
// Compare an export from this tool against Revolut's own CSV export.
// Usage: node scripts/reconcile.mjs ours.csv official.csv
import { readFileSync } from 'node:fs';

function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let quoted = false;
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\r' && body[i + 1] === '\n') { record.push(field); rows.push(record); record = []; field = ''; i++; }
    else if (ch === '\n') { record.push(field); rows.push(record); record = []; field = ''; }
    else field += ch;
  }
  if (field.length || record.length) { record.push(field); rows.push(record); }

  const [header, ...data] = rows.filter(r => r.length > 1);
  return data.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

const pick = (row, names) => names.map(n => row[n]).find(v => v !== undefined) ?? '';
const amountOf = (row) => {
  // Strip thousands separators before swapping a decimal comma: replacing only
  // the first comma turned "1,234.56" into "1.234.56", i.e. NaN, i.e. zero.
  const raw = String(pick(row, ['Amount', 'amount'])).trim().replace(/\s/g, '');
  const normalised = /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  const n = Number(normalised);
  if (!Number.isFinite(n)) throw new Error(`Could not read an amount from ${JSON.stringify(raw)}`);
  return n;
};
// Revolut's own export has no Transaction ID column; ours does. Keying each side
// on whatever it happens to carry puts them in disjoint key spaces, so every row
// reads as present on one side only -- a diff that can never match. The id is
// only usable when BOTH sides have one.
const composite = (row) =>
  `${pick(row, ['Started Date', 'Completed Date'])}|${pick(row, ['Amount'])}|${pick(row, ['Description'])}`;

const keyFactory = (a, b) => {
  const bothHaveIds = [a, b].every(rows => rows.length > 0 && rows.every(row => pick(row, ['Transaction ID'])));
  return bothHaveIds ? (row) => pick(row, ['Transaction ID']) : composite;
};

const [, , oursPath, officialPath] = process.argv;
if (!oursPath || !officialPath) {
  console.error('Usage: node scripts/reconcile.mjs <ours.csv> <official.csv>');
  process.exit(2);
}

const read = (path, label) => {
  try {
    return parseCsv(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`Could not read the ${label} CSV at ${path}: ${error.code === 'ENOENT' ? 'no such file' : error.message}`);
    process.exit(2);
  }
};

const ours = read(oursPath, 'exported');
const official = read(officialPath, 'official');

const sum = (rows) => rows.reduce((total, row) => total + amountOf(row), 0);
const round = (n) => Math.round(n * 100) / 100;

console.log(`ours     : ${ours.length} rows, sum ${round(sum(ours))}`);
console.log(`official : ${official.length} rows, sum ${round(sum(official))}`);

const keyOf = keyFactory(ours, official);
// Bucket rather than index: two rows can share a composite key (same instant,
// amount and description), and collapsing them would hide a real difference on
// whichever side held the duplicate.
const bucket = (rows) => {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (map.has(key)) map.get(key).push(row);
    else map.set(key, [row]);
  }
  return map;
};
// Rows on this side with no counterpart left on the other, duplicates included.
const unmatched = (mine, theirs) => {
  const out = [];
  for (const [key, rows] of mine) {
    const surplus = rows.length - (theirs.get(key)?.length ?? 0);
    for (let i = 0; i < surplus; i++) out.push(rows[i]);
  }
  return out;
};

const oursByKey = bucket(ours);
const officialByKey = bucket(official);
const onlyOurs = unmatched(oursByKey, officialByKey);
const onlyOfficial = unmatched(officialByKey, oursByKey);

if (onlyOurs.length) {
  console.log(`\nIn our export only (${onlyOurs.length}):`);
  for (const r of onlyOurs.slice(0, 20)) {
    console.log(`  ${pick(r, ['Started Date'])}  ${pick(r, ['Amount'])}  ${pick(r, ['State'])}  ${pick(r, ['Description'])}`);
  }
}
if (onlyOfficial.length) {
  console.log(`\nIn Revolut's export only (${onlyOfficial.length}):`);
  for (const r of onlyOfficial.slice(0, 20)) {
    console.log(`  ${pick(r, ['Started Date'])}  ${pick(r, ['Amount'])}  ${pick(r, ['State'])}  ${pick(r, ['Description'])}`);
  }
}

const byState = {};
for (const row of ours) byState[pick(row, ['State'])] = (byState[pick(row, ['State'])] ?? 0) + 1;
console.log('\nour rows by state:', byState);

const categories = new Set(ours.map(r => r.Category).filter(Boolean));
console.log(`distinct categories: ${categories.size}`, categories.size ? `(${[...categories].slice(0, 8).join(', ')})` : '');
if (categories.size <= 1) console.log('WARNING: one or zero distinct categories — the category column may not be populated.');

// The diff decides the verdict. Equal counts and an equal total are not a
// match: one row substituted for another clears both while the export is wrong,
// and a silently wrong export is the failure this whole project exists to catch.
const matches = onlyOurs.length === 0 && onlyOfficial.length === 0 &&
  ours.length === official.length && round(sum(ours)) === round(sum(official));
console.log(`\n${matches ? 'MATCH' : 'MISMATCH'}`);
process.exit(matches ? 0 : 1);
