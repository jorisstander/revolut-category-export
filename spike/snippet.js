// Paste into the DevTools console on https://app.revolut.com while logged in.
// Read-only: issues GETs only. Prints facts, downloads nothing.
(async () => {
  const cookie = Object.fromEntries(
    document.cookie.split(';').map(c => { const i = c.indexOf('='); return [c.slice(0, i).trim(), c.slice(i + 1)]; })
  );
  const headers = {
    'Accept': 'application/json',
    'x-browser-application': 'WEB_CLIENT',
    'x-client-version': '100.0',
    'x-device-id': cookie['revo_device_id'],
    'x-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  const get = async (path, params = {}) => {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const r = await fetch(`https://app.revolut.com${path}${qs ? `?${qs}` : ''}`, { credentials: 'include', headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const wallets = await get('/api/retail/wallets');
  console.log('wallets status', wallets.status, 'account types:', Object.keys(wallets.body ?? {}));

  // Account and wallet ids are shortened everywhere they are printed. Eight hex
  // characters are plenty to tell pockets apart while reading the output, and
  // this is a diagnostic people are asked to paste into public bug reports --
  // it should not hand over a full identifier to do that.
  const shortId = (id) => (id ? `${String(id).slice(0, 8)}…` : '(none)');

  const pockets = [];
  for (const [accountType, list] of Object.entries(wallets.body ?? {})) {
    for (const w of (list ?? [])) {
      for (const p of [...(w.pockets ?? []), ...(w.sharedPockets ?? [])]) {
        pockets.push({
          accountType,
          wallet: shortId(w.id),
          pocket: shortId(p.id),
          currency: p.currency,
          type: p.type,
          // Kept off the printed table, used only to drive the probes below.
          _walletId: w.id,
          _pocketId: p.id
        });
      }
    }
  }
  console.table(pockets.map(({ _walletId, _pocketId, ...shown }) => shown));

  for (const p of pockets) {
    for (const sel of ['internalPocketId', 'walletId']) {
      const value = sel === 'walletId' ? p._walletId : p._pocketId;
      const r = await get('/api/retail/user/current/transactions/last', { [sel]: value, count: 5 });
      const rows = Array.isArray(r.body) ? r.body : null;
      console.log(
        `${p.accountType}/${p.currency} via ${sel}:`,
        'status', r.status,
        'isArray', Array.isArray(r.body),
        'rows', rows?.length ?? '(not an array)',
        'accountIds', rows ? [...new Set(rows.map(t => shortId(t.account?.id)))] : '-',
        'categories', rows ? [...new Set(rows.map(t => t.category ?? '(none)'))] : '-'
      );
    }
  }
})();
