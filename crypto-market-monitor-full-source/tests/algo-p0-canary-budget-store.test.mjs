import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createCanaryBudgetStore } from '../algo/canary-budget-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(here, '../supabase/migrations/20260905_algobot_p0_execution.sql');
const databaseUrl = process.env.ALGOBOT_TEST_DATABASE_URL;

// Minimal, dependency-free stand-in for a real driver-level connection pool
// (e.g. `pg.Pool`). It satisfies the same query(text, params) => { rows }
// contract so canary-budget-store.mjs never needs to know it is talking to
// psql under the hood; this repository's P0 PostgreSQL CI job does not run
// `npm install`, so no real Postgres driver package is available here.
function createPsqlPool() {
  return {
    query(text, params = []) {
      return new Promise((resolvePromise, rejectPromise) => {
        const substituted = text.replace(/\$(\d+)/g, (_match, index) => literal(params[Number(index) - 1]));
        const wrapped = `select coalesce(json_agg(row_to_json(__row)), '[]'::json) as rows from (${substituted}) as __row;`;
        const child = spawn(
          'psql',
          [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-c', wrapped],
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => {
          if (code !== 0) {
            rejectPromise(new Error((stderr || stdout).trim() || `psql exited with code ${code}`));
            return;
          }
          resolvePromise({ rows: JSON.parse(stdout.trim() || '[]') });
        });
      });
    },
  };
}

function literal(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psql(sql) {
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-c', sql], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function reset() {
  psql(`delete from canary_reservations; delete from execution_ledger; update bot_state_meta set max_order_notional_usdt=10,max_cumulative_notional_usdt=100,executor_owner_id='task2-store',executor_fence_token=1,lease_expires_at=now()+interval '1 hour';`);
}

function createExecution(orderLinkId, requestedNotional = 10) {
  psql(`insert into execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,reconciliation_status,executor_fence_token) values ('${orderLinkId}','BTCUSDT','BUY',0,${requestedNotional},'CREATED','PENDING',1);`);
}

function committedOrReservedSum() {
  return psql(`select coalesce(sum(reserved_notional_usdt),0) from canary_reservations where status in ('RESERVED','COMMITTED');`);
}

let pool;
let store;

test.before(() => {
  assert.ok(databaseUrl, 'ALGOBOT_TEST_DATABASE_URL is required');
  const migration = readFileSync(migrationPath, 'utf8');
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-q'], { input: migration, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  pool = createPsqlPool();
  store = createCanaryBudgetStore({ pool, maxOrderNotionalUsdt: 10, maxCumulativeNotionalUsdt: 100 });
});

test.beforeEach(reset);

test('rejects a reservation above the 10 USDT per-order cap', async () => {
  createExecution('store-over-order', 10.01);
  await assert.rejects(
    () => store.reserve({ orderLinkId: 'store-over-order', requestedNotionalUsdt: 10.01, executorFenceToken: 1 }),
    /max order|10|limit/i,
  );
  assert.equal(committedOrReservedSum(), '0');
});

test('a reservation made through one store instance is visible and counted from a fresh instance', async () => {
  createExecution('store-restart-a');
  const first = await store.reserve({ orderLinkId: 'store-restart-a', requestedNotionalUsdt: 10, executorFenceToken: 1 });
  assert.equal(first.reservedNotionalUsdt, 10);
  assert.equal(first.totalAuthorizedUsdt, 10);
  assert.ok(first.reservationId);

  // A brand new store bound to a brand new pool/connection proves the store
  // never relies on anything held in process memory as the safety authority.
  const freshStore = createCanaryBudgetStore({ pool: createPsqlPool(), maxOrderNotionalUsdt: 10, maxCumulativeNotionalUsdt: 100 });
  createExecution('store-restart-b');
  const second = await freshStore.reserve({ orderLinkId: 'store-restart-b', requestedNotionalUsdt: 10, executorFenceToken: 1 });
  assert.equal(second.totalAuthorizedUsdt, 20);
});

test('two concurrent workers racing for the final budget cannot oversubscribe 100 USDT', async () => {
  for (let i = 0; i < 9; i += 1) {
    const id = `store-fill-${i}`;
    createExecution(id);
    await store.reserve({ orderLinkId: id, requestedNotionalUsdt: 10, executorFenceToken: 1 });
  }
  createExecution('store-race-a');
  createExecution('store-race-b');

  const settled = await Promise.allSettled([
    store.reserve({ orderLinkId: 'store-race-a', requestedNotionalUsdt: 10, executorFenceToken: 1 }),
    store.reserve({ orderLinkId: 'store-race-b', requestedNotionalUsdt: 10, executorFenceToken: 1 }),
  ]);

  const fulfilled = settled.filter((s) => s.status === 'fulfilled');
  const rejected = settled.filter((s) => s.status === 'rejected');
  assert.equal(fulfilled.length, 1, JSON.stringify(settled));
  assert.equal(rejected.length, 1, JSON.stringify(settled));
  assert.equal(committedOrReservedSum(), '100.000000000000');
});

test('release after proven non-dispatch restores available budget', async () => {
  createExecution('store-release-a');
  const { reservationId } = await store.reserve({ orderLinkId: 'store-release-a', requestedNotionalUsdt: 10, executorFenceToken: 1 });
  await store.release({ reservationId, reason: 'proven_non_dispatch', executorFenceToken: 1 });
  assert.equal(committedOrReservedSum(), '0');

  createExecution('store-release-b');
  const next = await store.reserve({ orderLinkId: 'store-release-b', requestedNotionalUsdt: 10, executorFenceToken: 1 });
  assert.equal(next.totalAuthorizedUsdt, 10);
});

test('repeated commit is idempotent and never double-counts filled notional', async () => {
  createExecution('store-commit');
  const { reservationId } = await store.reserve({ orderLinkId: 'store-commit', requestedNotionalUsdt: 10, executorFenceToken: 1 });
  await store.commit({ reservationId, filledNotionalUsdt: 7.5, executorFenceToken: 1 });
  await store.commit({ reservationId, filledNotionalUsdt: 7.5, executorFenceToken: 1 });
  assert.equal(committedOrReservedSum(), '7.500000000000');
});

test('a stale executor fence token fails closed and leaves no reservation behind', async () => {
  createExecution('store-stale-fence');
  await assert.rejects(
    () => store.reserve({ orderLinkId: 'store-stale-fence', requestedNotionalUsdt: 10, executorFenceToken: 999 }),
    /fence|stale|token/i,
  );
  assert.equal(committedOrReservedSum(), '0');
  assert.equal(psql(`select count(*) from canary_reservations where order_link_id='store-stale-fence';`), '0');
});
