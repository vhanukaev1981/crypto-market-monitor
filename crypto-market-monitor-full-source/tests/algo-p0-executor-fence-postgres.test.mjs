import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const migration = resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations/20260905_algobot_p0_execution.sql');
const db = process.env.ALGOBOT_TEST_DATABASE_URL;
function run(sql) {
  assert.ok(db, 'ALGOBOT_TEST_DATABASE_URL required: real PostgreSQL only');
  return spawnSync('psql', [db, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', '-c', sql], { encoding: 'utf8' });
}
function ok(sql) { const r=run(sql); assert.equal(r.status,0,r.stderr||r.stdout); return r.stdout.trim(); }
function reject(sql, pattern=/fence|lease|owner|expired|active|invalid|token/i) {
  const r=run(sql); assert.notEqual(r.status,0,sql); assert.match(r.stderr,pattern);
}
function asyncRun(sql) { return new Promise((resolvePromise,rejectPromise)=> {
  const child=spawn('psql',[db,'-X','-v','ON_ERROR_STOP=1','-q','-A','-t','-c',sql]);
  let stdout='',stderr='';
  child.on('error',rejectPromise);
  child.stdout.on('data',x=>stdout+=x); child.stderr.on('data',x=>stderr+=x);
  child.on('close',code=>resolvePromise({code,stdout:stdout.trim(),stderr:stderr.trim()}));
}); }
function acquire(owner='worker-a',ms=30000) {
  return ok("select owner_id || ':' || fence_token::text from public.algobot_acquire_executor('"+owner+"',"+ms+");");
}
function reset() {
  ok("delete from public.canary_reservations; delete from public.execution_ledger; update public.bot_state_meta set trading_state='RECOVERY_REQUIRED',executor_owner_id=null,executor_fence_token=0,lease_expires_at=null where singleton_key='ALGOBOT';");
}
test.before(()=> {
  assert.ok(db,'ALGOBOT_TEST_DATABASE_URL required: real PostgreSQL only');
  const r=spawnSync('psql',[db,'-X','-v','ON_ERROR_STOP=1','-q'],{input:readFileSync(migration,'utf8'),encoding:'utf8'});
  assert.equal(r.status,0,r.stderr||r.stdout);
});
test.beforeEach(reset);

test('two concurrent workers have exactly one live executor',async()=> {
  const sqlA="select owner_id || ':' || fence_token::text from public.algobot_acquire_executor('race-a',30000);";
  const sqlB="select owner_id || ':' || fence_token::text from public.algobot_acquire_executor('race-b',30000);";
  const [a,b]=await Promise.all([asyncRun(sqlA),asyncRun(sqlB)]);
  assert.equal([a,b].filter(x=>x.code===0).length,1,JSON.stringify({a,b}));
  assert.equal([a,b].filter(x=>x.code!==0).length,1,JSON.stringify({a,b}));
  assert.equal(ok('select executor_fence_token from public.bot_state_meta where singleton_key=\'ALGOBOT\';'),'1');
  assert.equal(ok("select trading_state from public.bot_state_meta where singleton_key='ALGOBOT';"),'RECOVERY_REQUIRED');
});

test('expiry revokes authorizations before replacement and stale writer cannot reserve',()=> {
  assert.equal(acquire(),'worker-a:1');
  ok("insert into public.execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,executor_fence_token) values ('task3-expired','BTCUSDT','BUY',0,5,'CREATED',1);");
  ok("update public.bot_state_meta set lease_expires_at=now()-interval '1 second' where singleton_key='ALGOBOT';");
  reject('select public.algobot_assert_executor_fence(1);');
  reject("select * from public.algobot_reserve_canary('task3-expired',5,1);");
  assert.equal(ok("select count(*) from public.canary_reservations where order_link_id='task3-expired';"),'0');
  assert.equal(acquire('worker-b'),'worker-b:2');
  reject('select public.algobot_renew_executor_lease(1,30000);');
  reject('select public.algobot_release_executor(1);');
  reject('select public.algobot_assert_executor_fence(1);');
  ok('select public.algobot_assert_executor_fence(2);');
});

test('release invalidates old token and new owner increments generation',()=> {
  assert.equal(acquire(),'worker-a:1');
  ok('select public.algobot_release_executor(1);');
  reject('select public.algobot_assert_executor_fence(1);');
  assert.equal(acquire('worker-b'),'worker-b:2');
  reject('select public.algobot_renew_executor_lease(1,30000);');
  assert.equal(ok("select trading_state from public.bot_state_meta where singleton_key='ALGOBOT';"),'RECOVERY_REQUIRED');
});

test('invalid and NULL tokens never authorize database mutations',()=> {
  assert.equal(acquire(),'worker-a:1');
  reject('select public.algobot_assert_executor_fence(null);');
  reject('select public.algobot_release_executor(null);');
  reject('select public.algobot_renew_executor_lease(null,30000);');
  reject('select public.algobot_renew_executor_lease(1,0);');
  reject("select * from public.algobot_acquire_executor('',30000);");
  ok("insert into public.execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,executor_fence_token) values ('task3-null','BTCUSDT','BUY',0,5,'CREATED',1);");
  reject("select * from public.algobot_reserve_canary('task3-null',5,null);");
  assert.equal(ok("select count(*) from public.canary_reservations where order_link_id='task3-null';"),'0');
});

test('renewal permits active owner but does not resurrect an expired lease',()=> {
  assert.equal(acquire(),'worker-a:1');
  assert.ok(ok('select public.algobot_renew_executor_lease(1,30000);').length>0);
  ok('select public.algobot_assert_executor_fence(1);');
  reject("select * from public.algobot_acquire_executor('worker-a',30000);");
  ok("update public.bot_state_meta set lease_expires_at=now()-interval '1 second' where singleton_key='ALGOBOT';");
  reject('select public.algobot_renew_executor_lease(1,30000);');
});

test('a stale lease cannot commit or release a reservation',()=> {
  assert.equal(acquire(),'worker-a:1');
  ok("insert into public.execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,executor_fence_token) values ('task3-commit','BTCUSDT','BUY',0,5,'CREATED',1);");
  const id=ok("select reservation_id from public.algobot_reserve_canary('task3-commit',5,1);");
  ok("update public.bot_state_meta set lease_expires_at=now()-interval '1 second' where singleton_key='ALGOBOT';");
  reject("select public.algobot_commit_canary_reservation('"+id+"',5,1);");
  reject("select public.algobot_release_canary_reservation('"+id+"','non-dispatch',1);");
  assert.equal(ok("select status from public.canary_reservations where id='"+id+"';"),'RESERVED');
});
