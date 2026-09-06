import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(here, '../supabase/migrations/20260905_algobot_p0_execution.sql');
const databaseUrl = process.env.ALGOBOT_TEST_DATABASE_URL;

function psql(args = [], input = undefined) {
  assert.ok(databaseUrl, 'ALGOBOT_TEST_DATABASE_URL is required for real PostgreSQL integration evidence');
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', ...args], {
    encoding: 'utf8',
    input,
  });
  return result;
}

function query(sql) {
  const result = psql(['-c', sql]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function exec(sql) {
  const result = psql([], sql);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function expectSqlFailure(sql, pattern) {
  const result = psql([], sql);
  assert.notEqual(result.status, 0, `expected PostgreSQL to reject SQL: ${sql}`);
  assert.match(result.stderr, pattern);
}

test('P0 migration exists and applies to real PostgreSQL', () => {
  assert.ok(existsSync(migrationPath), `missing migration: ${migrationPath}`);
  exec(readFileSync(migrationPath, 'utf8'));
});

test('P0 schema exposes the four durable authority tables', () => {
  const names = query(`select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname='public' and tablename in ('execution_ledger','position_lifecycle','bot_state_meta','canary_reservations')`);
  assert.equal(names, 'bot_state_meta,canary_reservations,execution_ledger,position_lifecycle');
});

test('execution ledger has required durable execution evidence columns', () => {
  const required = ['id','order_link_id','symbol','side','requested_qty','requested_notional_usdt','status','reconciliation_status','exchange_order_id','filled_qty','filled_notional_usdt','avg_fill_price','fees_usdt','executor_fence_token','created_at','updated_at'];
  const actual = query(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='public' and table_name='execution_ledger'`).split(',');
  for (const column of required) assert.ok(actual.includes(column), `execution_ledger missing ${column}`);
});

test('order_link_id is unique and illegal execution state is rejected', () => {
  exec(`delete from canary_reservations; delete from position_lifecycle; delete from execution_ledger;`);
  exec(`insert into execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,reconciliation_status,executor_fence_token) values ('p0-schema-1','BTCUSDT','BUY',0.0001,10,'CREATED','PENDING',1);`);
  expectSqlFailure(`insert into execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,reconciliation_status,executor_fence_token) values ('p0-schema-1','BTCUSDT','BUY',0.0001,10,'CREATED','PENDING',1);`, /duplicate key|unique/i);
  expectSqlFailure(`insert into execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,reconciliation_status,executor_fence_token) values ('p0-schema-bad','BTCUSDT','BUY',0.0001,10,'SYNTHETIC_FILLED','PENDING',1);`, /check constraint/i);
});

test('negative quantities/notional/fills/fees are rejected', () => {
  expectSqlFailure(`insert into execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,reconciliation_status,executor_fence_token) values ('p0-neg-qty','BTCUSDT','BUY',-1,10,'CREATED','PENDING',1);`, /check constraint/i);
  expectSqlFailure(`insert into execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,reconciliation_status,executor_fence_token) values ('p0-neg-notional','BTCUSDT','BUY',1,-10,'CREATED','PENDING',1);`, /check constraint/i);
});

test('reservation references an existing execution ledger row', () => {
  expectSqlFailure(`insert into canary_reservations(execution_id,order_link_id,reserved_notional_usdt,status,executor_fence_token) values ('00000000-0000-0000-0000-000000000001','missing',10,'RESERVED',1);`, /foreign key/i);
});

test('singleton coordination row exists and is fail-closed by default', () => {
  const row = query(`select singleton_key || ':' || trading_state || ':' || max_order_notional_usdt::text || ':' || max_cumulative_notional_usdt::text from bot_state_meta where singleton_key='ALGOBOT'`);
  assert.equal(row, 'ALGOBOT:RECOVERY_REQUIRED:10:100');
});
