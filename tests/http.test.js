import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, SessionExpiredError, ApiError, WALLETS_PATH, TRANSACTIONS_PATH } from '../src/core/http.js';

function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return response; };
  return { impl, calls };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const client = (impl) => createClient({ fetchImpl: impl, deviceId: 'device-123', timeZone: 'Europe/Berlin' });

test('exposes the API paths so other modules need not hardcode them', () => {
  assert.equal(WALLETS_PATH, '/api/retail/wallets');
  assert.equal(TRANSACTIONS_PATH, '/api/retail/user/current/transactions/last');
});

test('sends the device and application headers Revolut requires', async () => {
  const { impl, calls } = fakeFetch(ok([]));
  await client(impl)(WALLETS_PATH);
  const { headers } = calls[0].init;
  assert.equal(headers['x-device-id'], 'device-123');
  assert.equal(headers['x-browser-application'], 'WEB_CLIENT');
  assert.equal(headers['x-timezone'], 'Europe/Berlin');
  assert.ok(headers['x-client-version']);
});

test('sends cookies with the request', async () => {
  const { impl, calls } = fakeFetch(ok([]));
  await client(impl)(WALLETS_PATH);
  assert.equal(calls[0].init.credentials, 'include');
});

test('builds the absolute URL and query string', async () => {
  const { impl, calls } = fakeFetch(ok([]));
  await client(impl)(TRANSACTIONS_PATH, { walletId: 'w-1', count: 25 });
  assert.equal(calls[0].url, `https://app.revolut.com${TRANSACTIONS_PATH}?walletId=w-1&count=25`);
});

test('omits undefined and null query parameters', async () => {
  const { impl, calls } = fakeFetch(ok([]));
  await client(impl)('/x', { a: 1, b: undefined, c: null });
  assert.equal(calls[0].url, 'https://app.revolut.com/x?a=1');
});

test('401 raises SessionExpiredError with actionable text', async () => {
  const { impl } = fakeFetch({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => client(impl)('/x'), (err) => {
    assert.ok(err instanceof SessionExpiredError);
    assert.match(err.message, /app\.revolut\.com/);
    return true;
  });
});

test('other failures raise ApiError carrying the status', async () => {
  const { impl } = fakeFetch({ ok: false, status: 500, json: async () => ({ message: 'nope' }) });
  await assert.rejects(() => client(impl)('/x'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 500);
    return true;
  });
});

test('refuses to build a client without a device id', () => {
  assert.throws(() => createClient({ fetchImpl: async () => {}, deviceId: '', timeZone: 'UTC' }), /deviceId/);
});
