import { createClient, SessionExpiredError } from '../src/core/http.js';
import { discoverAccounts, exportMonth, buildFilename } from '../src/core/pipeline.js';

// Repository URL for the footer link. Empty: the link is not shown.
const SOURCE_URL = 'https://github.com/jorisstander/revolut-category-export';

const accountEl = document.getElementById('account');
const monthEl = document.getElementById('month');
const monthLabelEl = document.getElementById('month-label');
const monthPrevEl = document.getElementById('month-prev');
const monthNextEl = document.getElementById('month-next');
const filenameEl = document.getElementById('filename');
const buttonEl = document.getElementById('export');
const buttonLabelEl = document.getElementById('export-label');
const statusEl = document.getElementById('status');
const statusDetailEl = document.getElementById('status-detail');
const loginLinkEl = document.getElementById('login-link');
const rowsEl = document.getElementById('rows');

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let handles = [];

class NoSessionError extends Error {}

function say(message, className = '', detail = '') {
  statusEl.textContent = message;
  statusEl.className = className;
  statusDetailEl.textContent = detail;
  loginLinkEl.hidden = true;
}

/** Drive the button's spinner and label together, so they can never disagree. */
function setBusy(busy, label = 'Export CSV') {
  buttonEl.disabled = busy;
  buttonEl.classList.toggle('is-busy', busy);
  buttonLabelEl.textContent = label;
}

async function client() {
  const cookie = await chrome.cookies.get({ url: 'https://app.revolut.com', name: 'revo_device_id' });
  if (!cookie?.value) {
    throw new NoSessionError('No Revolut session found. Open app.revolut.com and log in, then reopen this popup.');
  }
  return createClient({ fetchImpl: fetch, deviceId: cookie.value, timeZone });
}

const toMonthValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

function defaultMonth() {
  const now = new Date();
  return toMonthValue(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

function currentMonth() {
  return toMonthValue(new Date());
}

/** Parse the month input's YYYY-MM into numbers; null when it holds nothing usable. */
function selectedMonth() {
  const [year, month] = (monthEl.value ?? '').split('-').map(Number);
  return year && month ? { year, month } : null;
}

function shiftMonth(delta) {
  const picked = selectedMonth();
  if (!picked) return;
  const next = new Date(picked.year, picked.month - 1 + delta, 1);
  const value = toMonthValue(next);
  if (value > currentMonth()) return;
  monthEl.value = value;
  renderMonth();
}

function renderMonth() {
  const picked = selectedMonth();
  monthLabelEl.textContent = picked
    ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(picked.year, picked.month - 1, 1))
    : 'Pick a month';
  monthNextEl.disabled = !picked || monthEl.value >= currentMonth();
  renderFilename();
}

function renderFilename() {
  const handle = handles[Number(accountEl.value)];
  const picked = selectedMonth();
  filenameEl.textContent = handle && picked
    ? buildFilename(handle, `${picked.year}-${String(picked.month).padStart(2, '0')}`)
    : '—';
}

function renderFooter() {
  const el = document.getElementById('source-link');
  el.hidden = !SOURCE_URL;
  if (SOURCE_URL) el.href = SOURCE_URL;
}

function toDataUrl(csv) {
  const bytes = new TextEncoder().encode(csv);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:text/csv;charset=utf-8;base64,${btoa(binary)}`;
}

function showError(error) {
  say(error.message, 'error');
  // Both "never logged in" and "logged in, but it lapsed" are fixed the same way.
  if (error instanceof NoSessionError || error instanceof SessionExpiredError) loginLinkEl.hidden = false;
}

async function init() {
  renderFooter();
  monthEl.max = currentMonth();
  monthEl.value = defaultMonth();
  renderMonth();

  try {
    const get = await client();
    const { accounts, failures } = await discoverAccounts({ get });
    handles = accounts;

    if (handles.length === 0) {
      accountEl.innerHTML = '<option>no accounts</option>';
      say('No accounts found.', 'error');
      return;
    }

    accountEl.innerHTML = '';
    handles.forEach((handle, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      // Unsupported accounts stay visible but unselectable: silently dropping one
      // reads as "this tool doesn't support my account" rather than "it failed".
      option.disabled = !handle.supported;
      option.textContent = handle.supported
        ? (handle.verified ? handle.label : `${handle.label} [unverified]`)
        : `${handle.label} [can't be read]`;
      accountEl.append(option);
    });

    const firstUsable = handles.findIndex(h => h.supported);
    if (firstUsable >= 0) accountEl.value = String(firstUsable);
    accountEl.disabled = false;
    setBusy(false);
    buttonEl.disabled = firstUsable < 0;
    renderFilename();

    say(
      failures.length ? `${failures.length} account(s) could not be read: ${failures.map(f => f.label).join(', ')}.` : '',
      failures.length ? 'warn' : ''
    );
  } catch (error) {
    accountEl.innerHTML = '<option>no accounts</option>';
    rowsEl.classList.add('is-inert');
    showError(error);
  }
}

accountEl.addEventListener('change', renderFilename);
monthEl.addEventListener('change', renderMonth);
monthPrevEl.addEventListener('click', () => shiftMonth(-1));
monthNextEl.addEventListener('click', () => shiftMonth(1));
monthLabelEl.addEventListener('click', () => {
  // Chrome 99+, and it throws without a user gesture; the stepper is always there as the fallback.
  try { monthEl.showPicker(); } catch { /* stepper remains */ }
});

buttonEl.addEventListener('click', async () => {
  const handle = handles[Number(accountEl.value)];
  const picked = selectedMonth();
  if (!picked) return say('Pick a month first.', 'error');

  setBusy(true, 'Fetching…');
  say('');
  try {
    const get = await client();
    const { csv, rowCount, filename } = await exportMonth({ get, handle, ...picked, timeZone });

    if (rowCount === 0) {
      say('That account returned no transactions for this month. Nothing was downloaded — check the account and month before assuming it was a quiet month.', 'warn');
      return;
    }

    await chrome.downloads.download({ url: toDataUrl(csv), filename, saveAs: true });
    say(`Exported ${rowCount} transaction${rowCount === 1 ? '' : 's'}.`, 'ok', filename);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

init();
