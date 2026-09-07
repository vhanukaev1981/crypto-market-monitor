import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(here, '../supabase/migrations/20260905_algobot_p0_execution.sql');
const databaseUrl = process.env.ALGOBOT_TEST_DATABASE_URL;

function psql(sql) {
  assert.ok(databaseUrl, 'ALGOBOT_TEST_DATABASE_URL is required for real PostgreSQL integration evidence');
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-c', sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function psqlAsync(sql) {
  return new Promise((resolvePromise) => {
    const child = spawn('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-c', sql]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function reset() {
  psql(`delete from canary_reservations; delete from execution_ledger; update bot_state_meta set max_order_notional_usdt=10,max_cumulative_notional_usdt=100,executor_owner_id='task2',executor_fence_token=1,lease_expires_at=now()+interval '1 hour';`);
}

function createExecution(orderLinkId, requestedNotional = 10) {
  return psql(`insert into execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,reconciliation_status,executor_fence_token) values ('${orderLinkId}','BTCUSDT','BUY',0,${requestedNotional},'CREATED','PENDING',1) returning id;`);
}

function reserveSql(orderLinkId, requestedNotional = 10) {
  return `select reservation_id::text || ':' || reserved_notional_usdt::text || ':' || total_authorized_usdt::text from algobot_reserve_canary('${orderLinkId}',${requestedNotional},1);`;
}

function commitSql(reservationId, filledNotional) {
  return `select algobot_commit_canary_reservation('${reservationId}',${filledNotional},1);`;
}

function releaseSql(reservationId) {
  return `select algobot_release_canary_reservation('${reservationId}','proven_non_dispatch',1);`;
}

test.before(() => {
  assert.ok(databaseUrl, 'ALGOBOT_TEST_DATABASE_URL is required');
  const migration = readFileSync(migrationPath, 'utf8');
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-q'], { input: migration, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test.beforeEach(reset);

test('rejects a CANARY reservation above 10 USDT per order', () => {
  createExecution('task2-over-order', 10.01);
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', reserveSql('task2-over-order', 10.01)], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /max order|10|limit/i);
});

test('reservation survives a fresh process and remains counted', () => {
  createExecution('task2-restart-a');
  const first = psql(reserveSql('task2-restart-a'));
  assert.match(first, /:10(?:\.0+)?:10(?:\.0+)?$/);
  createExecution('task2-restart-b');
  const second = psql(reserveSql('task2-restart-b'));
  assert.match(second, /:10(?:\.0+)?:20(?:\.0+)?$/);
});

test('two concurrent workers racing for the final budget cannot oversubscribe 100 USDT', async () => {
  for (let i = 0; i < 9; i += 1) {
    const id = `task2-fill-${i}`;
    createExecution(id);
    psql(reserveSql(id));
  }
  createExecution('task2-race-a');
  createExecution('task2-race-b');
  const [a, b] = await Promise.all([psqlAsync(reserveSql('task2-race-a')), psqlAsync(reserveSql('task2-race-b'))]);
  const successes = [a, b].filter((result) => result.code === 0);
  const failures = [a, b].filter((result) => result.code !== 0);
  assert.equal(successes.length, 1, JSON.stringify({ a, b }));
  assert.equal(failures.length, 1, JSON.stringify({ a, b }));
  assert.equal(psql(`select coalesce(sum(reserved_notional_usdt),0) from canary_reservations where status in ('RESERVED','COMMITTED');`), '100.000000000000');
});

test('release after proven non-dispatch restores available budget', () => {
  createExecution('task2-release-a');
  const reservationId = psql(reserveSql('task2-release-a')).split(':')[0];
  psql(releaseSql(reservationId));
  createExecution('task2-release-b');
  const next = psql(reserveSql('task2-release-b'));
  assert.match(next, /:10(?:\.0+)?:10(?:\.0+)?$/);
});

test('repeated commit is idempotent and never double-counts filled notional', () => {
  createExecution('task2-commit');
  const reservationId = psql(reserveSql('task2-commit')).split(':')[0];
  psql(commitSql(reservationId, 7.5));
  psql(commitSql(reservationId, 7.5));
  assert.equal(psql(`select reserved_notional_usdt from canary_reservations where id='${reservationId}' and status='COMMITTED';`), '7.500000000000');
  assert.equal(psql(`select coalesce(sum(reserved_notional_usdt),0) from canary_reservations where status in ('RESERVED','COMMITTED');`), '7.500000000000');
});
// ---------------------------------------------------------------------------
// ChatGPT independent-review follow-up (PR #18)
//
// Finding 1: commit() must reject a filled notional greater than the amount
//            originally reserved -- a commit can never authorize more CANARY
//            budget than was reserved for that order.
// Finding 2: commit()/release() must FAIL CLOSED for a nonexistent reservation
//            id or an illegal state transition, instead of silently updating
//            zero rows and returning success.
// ---------------------------------------------------------------------------

const MISSING_RESERVATION_ID = '00000000-0000-0000-0000-000000000000';

function tryPsql(sql) {
  return spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', sql], { encoding: 'utf8' });
}

function reservedOrCommittedSum() {
  return psql(`select coalesce(sum(reserved_notional_usdt),0) from canary_reservations where status in ('RESERVED','COMMITTED');`);
}

test('commit rejects a filled notional above the reserved amount', () => {
  createExecution('task2-overfill');
  const reservationId = psql(reserveSql('task2-overfill')).split(':')[0];
  const result = tryPsql(commitSql(reservationId, 12));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /exceed|reserved/i);
  // Accounting is untouched: still RESERVED at the original 10 USDT.
  assert.equal(reservedOrCommittedSum(), '10.000000000000');
  assert.equal(psql(`select status from canary_reservations where id='${reservationId}';`), 'RESERVED');
});

test('commit rejects a non-positive filled notional with a clear message', () => {
  createExecution('task2-zero-fill');
  const reservationId = psql(reserveSql('task2-zero-fill')).split(':')[0];
  const result = tryPsql(commitSql(reservationId, 0));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /positive/i);
  assert.equal(psql(`select status from canary_reservations where id='${reservationId}';`), 'RESERVED');
});

test('commit fails closed on a nonexistent reservation id', () => {
  const result = tryPsql(commitSql(MISSING_RESERVATION_ID, 5));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /no CANARY reservation|not found/i);
});

test('release fails closed on a nonexistent reservation id', () => {
  const result = tryPsql(releaseSql(MISSING_RESERVATION_ID));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /no CANARY reservation|not found/i);
});

test('commit fails closed on an already RELEASED reservation', () => {
  createExecution('task2-rel-then-commit');
  const reservationId = psql(reserveSql('task2-rel-then-commit')).split(':')[0];
  psql(releaseSql(reservationId));
  const result = tryPsql(commitSql(reservationId, 10));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /RELEASED/i);
  assert.equal(reservedOrCommittedSum(), '0');
});

test('release fails closed on an already COMMITTED reservation', () => {
  createExecution('task2-commit-then-rel');
  const reservationId = psql(reserveSql('task2-commit-then-rel')).split(':')[0];
  psql(commitSql(reservationId, 8));
  const result = tryPsql(releaseSql(reservationId));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /COMMITTED/i);
  assert.equal(reservedOrCommittedSum(), '8.000000000000');
});

test('commit replay with a conflicting filled notional fails closed', () => {
  createExecution('task2-conflicting-replay');
  const reservationId = psql(reserveSql('task2-conflicting-replay')).split(':')[0];
  psql(commitSql(reservationId, 7.5));
  const result = tryPsql(commitSql(reservationId, 6));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /already committed|conflicting/i);
  assert.equal(reservedOrCommittedSum(), '7.500000000000');
});

test('commit replay with the identical filled notional stays idempotent', () => {
  createExecution('task2-identical-replay');
  const reservationId = psql(reserveSql('task2-identical-replay')).split(':')[0];
  psql(commitSql(reservationId, 7.5));
  // Same evidence twice must remain a no-op, not a fail-closed error.
  psql(commitSql(reservationId, 7.5));
  assert.equal(reservedOrCommittedSum(), '7.500000000000');
  assert.equal(psql(`select status from canary_reservations where id='${reservationId}';`), 'COMMITTED');
});
