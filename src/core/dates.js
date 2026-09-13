/** Timezone-aware date helpers built on Intl, with no dependencies. */

function partsIn(epochMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  return Object.fromEntries(
    dtf.formatToParts(epochMs).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
  );
}

/**
 * @param {number} epochMs
 * @param {string} timeZone IANA zone, e.g. 'Europe/Berlin'
 * @returns {string} 'YYYY-MM-DD HH:MM:SS' in that zone
 */
export function formatInstant(epochMs, timeZone) {
  const p = partsIn(epochMs, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Offset of `timeZone` from UTC at a given instant, in ms. */
function offsetAt(epochMs, timeZone) {
  const p = partsIn(epochMs, timeZone);
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asIfUtc - epochMs;
}

/** The UTC instant of local midnight on a given calendar day. */
function localMidnightUtc(year, month, day, timeZone) {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Two passes converge across DST transitions.
  let guess = naive - offsetAt(naive, timeZone);
  guess = naive - offsetAt(guess, timeZone);
  return guess;
}

/**
 * Half-open range [from, to) covering a calendar month in a timezone.
 * @param {number} year
 * @param {number} month 1-12
 * @param {string} timeZone
 * @returns {{from: number, to: number}} epoch ms
 */
export function monthToRange(year, month, timeZone) {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    from: localMidnightUtc(year, month, 1, timeZone),
    to: localMidnightUtc(nextYear, nextMonth, 1, timeZone)
  };
}
