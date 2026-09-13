export const API_ORIGIN = 'https://app.revolut.com';
export const WALLETS_PATH = '/api/retail/wallets';
export const TRANSACTIONS_PATH = '/api/retail/user/current/transactions/last';

// Verified against the live web client; see docs/api-notes.md.
const CLIENT_VERSION = '100.0';

export class SessionExpiredError extends Error {
  constructor() {
    super('Your Revolut session has expired. Open app.revolut.com, log in, then try again.');
    this.name = 'SessionExpiredError';
  }
}

export class ApiError extends Error {
  constructor(status, path, body) {
    super(`Revolut API returned ${status} for ${path}${body?.message ? `: ${body.message}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

/**
 * Build a GET function bound to the Revolut retail API.
 * @param {{fetchImpl?: Function, deviceId: string, timeZone: string}} options
 * @returns {(path: string, params?: Object) => Promise<any>}
 */
export function createClient({ fetchImpl = globalThis.fetch, deviceId, timeZone }) {
  if (!deviceId) throw new Error('createClient requires a deviceId (the revo_device_id cookie)');

  const headers = {
    'Accept': 'application/json',
    'x-browser-application': 'WEB_CLIENT',
    'x-client-version': CLIENT_VERSION,
    'x-device-id': deviceId,
    'x-timezone': timeZone
  };

  return async function get(path, params = {}) {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${API_ORIGIN}${path}${query ? `?${query}` : ''}`;

    const response = await fetchImpl(url, { method: 'GET', credentials: 'include', headers });
    if (response.status === 401) throw new SessionExpiredError();
    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch { /* body is not JSON */ }
      throw new ApiError(response.status, path, body);
    }
    return response.json();
  };
}
