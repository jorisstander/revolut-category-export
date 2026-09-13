import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverAccounts, exportMonth, exportRange } from '../src/core/pipeline.js';
import { WALLETS_PATH, SessionExpiredError } from '../src/core/http.js';
import {
  WALLETS_RESPONSE, txnIn,
  PERSONAL_EUR_POCKET, PERSONAL_USD_POCKET, PERSONAL_WALLET,
  JOINT_POCKET, JOINT_SAVINGS_POCKET, JOINT_WALLET
} from './fixtures/synthetic.js';

const TZ = 'Europe/Berlin';

/** Honours the `to` cursor, as the real API does. */
function api({ jointRows = [] } = {}) {
  return async (path, params = {}) => {
    if (path === WALLETS_PATH) return WALLETS_RESPONSE;
    const page = (rows) => {
      const visible = params.to === undefined ? rows : rows.filter(r => r.completedDate <= params.to);
      return visible.slice(0, params.count ?? visible.length);
    };
    if (params.internalPocketId === PERSONAL_EUR_POCKET) return page([txnIn(PERSONAL_EUR_POCKET, 10, 'eur-1')]);
    if (params.walletId === PERSONAL_WALLET) return page([txnIn(PERSONAL_EUR_POCKET, 10, 'eur-1')]);
    if (params.walletId === JOINT_WALLET) return page(jointRows);
    return [];
  };
}

test('discovery returns a handle per account', async () => {
  const { accounts, failures } = await discoverAccounts({ get: api({ jointRows: [txnIn(JOINT_POCKET, 10, 'j-1')] }) });
  assert.equal(accounts.length, 3);
  assert.equal(failures.length, 0);
  assert.equal(accounts.find(h => h.pocketId === JOINT_POCKET).selector.name, 'walletId');
});

test('probes each discovered account distinctly', async () => {
  const probed = [];
  const get = async (path, params = {}) => {
    if (path === WALLETS_PATH) return WALLETS_RESPONSE;
    probed.push(params.internalPocketId ?? params.walletId);
    return [];
  };
  await discoverAccounts({ get });
  assert.ok(new Set(probed).size >= 3, `expected 3 distinct accounts probed, saw ${new Set(probed).size}`);
});

test('one failing account does not take down the others', async () => {
  const get = async (path, params = {}) => {
    if (path === WALLETS_PATH) return WALLETS_RESPONSE;
    if (params.internalPocketId === PERSONAL_EUR_POCKET || params.walletId === PERSONAL_WALLET) {
      throw new Error('account exploded');
    }
    if (params.walletId === JOINT_WALLET) return [txnIn(JOINT_POCKET, 10, 'j-1')];
    return [];
  };
  const { accounts, failures } = await discoverAccounts({ get });
  assert.equal(failures.length, 1);
  assert.match(failures[0].error.message, /account exploded/);
  assert.ok(failures[0].label.length > 0);
  assert.ok(accounts.some(h => h.pocketId === JOINT_POCKET));
});

test('an expired session surfaces as itself, not as "no accounts found"', async () => {
  const get = async (path) => {
    if (path === WALLETS_PATH) return WALLETS_RESPONSE;
    throw new SessionExpiredError();
  };
  await assert.rejects(() => discoverAccounts({ get }), SessionExpiredError);
});

test('export produces CSV containing the category column', async () => {
  const jointRows = [txnIn(JOINT_POCKET, 10, 'j-1', { category: 'groceries' })];
  const get = api({ jointRows });
  const { accounts } = await discoverAccounts({ get });
  const joint = accounts.find(h => h.pocketId === JOINT_POCKET);

  const { csv, rowCount } = await exportMonth({ get, handle: joint, year: 2026, month: 8, timeZone: TZ });
  assert.equal(rowCount, 1);
  assert.match(csv, /Category/);
  assert.match(csv, /groceries/);
});

test('export excludes the savings pocket that shares the joint wallet', async () => {
  const jointRows = [txnIn(JOINT_POCKET, 10, 'j-1'), txnIn(JOINT_SAVINGS_POCKET, 9, 'savings-1')];
  const get = api({ jointRows });
  const { accounts } = await discoverAccounts({ get });
  const joint = accounts.find(h => h.pocketId === JOINT_POCKET);

  const { csv, rowCount } = await exportMonth({ get, handle: joint, year: 2026, month: 8, timeZone: TZ });
  assert.equal(rowCount, 1);
  assert.ok(csv.includes('j-1'));
  assert.ok(!csv.includes('savings-1'));
});

test('export filters to the requested month', async () => {
  const jointRows = [txnIn(JOINT_POCKET, 10, 'inside'), { ...txnIn(JOINT_POCKET, 10, 'outside'), completedDate: Date.UTC(2026, 6, 10), startedDate: Date.UTC(2026, 6, 10) }];
  const get = api({ jointRows });
  const { accounts } = await discoverAccounts({ get });
  const joint = accounts.find(h => h.pocketId === JOINT_POCKET);

  const { csv } = await exportMonth({ get, handle: joint, year: 2026, month: 8, timeZone: TZ });
  assert.ok(csv.includes(',inside\r\n'), 'expected the in-month transaction id in the last column');
  assert.ok(!csv.includes(',outside\r\n'));
});

test('export refuses an unsupported account', async () => {
  const handle = { pocket: {}, label: 'x', pocketId: 'x', selector: null, supported: false, verified: false };
  await assert.rejects(
    () => exportMonth({ get: api(), handle, year: 2026, month: 8, timeZone: 'UTC' }),
    /not supported/i
  );
});

test('exportRange takes instants, so a date range needs no core change', async () => {
  const jointRows = [txnIn(JOINT_POCKET, 10, 'j-1')];
  const get = api({ jointRows });
  const { accounts } = await discoverAccounts({ get });
  const joint = accounts.find(h => h.pocketId === JOINT_POCKET);

  const { rowCount, filename } = await exportRange({
    get, handle: joint,
    from: Date.UTC(2026, 7, 1), to: Date.UTC(2026, 7, 31),
    label: '2026-08-01_2026-08-30', timeZone: TZ
  });
  assert.equal(rowCount, 1);
  assert.equal(filename, 'revolut-joint-eur-2026-08-01-2026-08-30.csv');
});

test('filenames are sanitised', async () => {
  const jointRows = [txnIn(JOINT_POCKET, 10, 'j-1')];
  const get = api({ jointRows });
  const { accounts } = await discoverAccounts({ get });
  const joint = { ...accounts.find(h => h.pocketId === JOINT_POCKET) };
  joint.pocket = { ...joint.pocket, accountType: '../../etc', currency: 'e u/r' };

  const { filename } = await exportMonth({ get, handle: joint, year: 2026, month: 8, timeZone: TZ });
  assert.ok(!filename.includes('/'), filename);
  assert.ok(!filename.includes('..'), filename);
});

test('the saved filename matches the account label the picker showed', async () => {
  // Naming the file from the raw accountType produced `personal_joint` for an
  // account the UI calls "Joint" — a mismatch a user would notice immediately,
  // and long enough to overflow the popup's file row.
  const { buildFilename } = await import('../src/core/pipeline.js');
  const { pocketLabel } = await import('../src/core/wallets.js');
  const pocket = { accountType: 'PERSONAL_JOINT', currency: 'EUR', pocketType: 'CURRENT', state: 'ACTIVE' };
  assert.equal(pocketLabel(pocket), 'Joint · EUR');
  assert.equal(buildFilename({ pocket }, '2026-08'), 'revolut-joint-eur-2026-08.csv');
});

test('an unknown account type still yields a safe filename', async () => {
  const { buildFilename } = await import('../src/core/pipeline.js');
  const pocket = { accountType: '../../etc/passwd', currency: 'e u/r', pocketType: 'CURRENT', state: 'ACTIVE' };
  const name = buildFilename({ pocket }, '2026-08');
  assert.match(name, /^revolut-[a-z0-9_-]*-[a-z0-9_-]*-2026-08\.csv$/, name);
  assert.ok(!name.includes('/') && !name.includes('..'), name);
});
