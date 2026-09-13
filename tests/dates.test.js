import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInstant, monthToRange } from '../src/core/dates.js';

test('formats an instant in a named timezone', () => {
  // 2026-08-01T09:30:00Z is 11:30 in Berlin (CEST, UTC+2)
  assert.equal(formatInstant(Date.UTC(2026, 7, 1, 9, 30, 0), 'Europe/Berlin'), '2026-08-01 11:30:00');
});

test('formats midnight as 00, not 24', () => {
  assert.equal(formatInstant(Date.UTC(2026, 7, 1, 0, 0, 0), 'UTC'), '2026-08-01 00:00:00');
});

test('month range covers local midnight to local midnight', () => {
  const { from, to } = monthToRange(2026, 8, 'Europe/Berlin');
  assert.equal(from, Date.UTC(2026, 6, 31, 22, 0, 0)); // 1 Aug 00:00 CEST
  assert.equal(to, Date.UTC(2026, 7, 31, 22, 0, 0));   // 1 Sep 00:00 CEST
});

test('month range handles a winter month with a different offset', () => {
  const { from, to } = monthToRange(2026, 1, 'Europe/Berlin');
  assert.equal(from, Date.UTC(2025, 11, 31, 23, 0, 0)); // 1 Jan 00:00 CET (UTC+1)
  assert.equal(to, Date.UTC(2026, 0, 31, 23, 0, 0));
});

test('month range spans the spring DST transition correctly', () => {
  // March 2026: starts CET (+1), ends CEST (+2).
  const { from, to } = monthToRange(2026, 3, 'Europe/Berlin');
  assert.equal(from, Date.UTC(2026, 1, 28, 23, 0, 0)); // 1 Mar 00:00 CET
  assert.equal(to, Date.UTC(2026, 2, 31, 22, 0, 0));   // 1 Apr 00:00 CEST
});

test('month range rolls over December correctly', () => {
  const { to } = monthToRange(2026, 12, 'UTC');
  assert.equal(to, Date.UTC(2027, 0, 1, 0, 0, 0));
});
