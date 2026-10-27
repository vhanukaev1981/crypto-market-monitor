import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const db=process.env.ALGOBOT_TEST_DATABASE_URL;
const migration=resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations/20260905_algobot_p0_execution.sql');
function run(sql) { assert.ok(db,'ALGOBOT_TEST_DATABASE_URL required'); return spawnSync('psql',[db,'-X','-v','ON_ERROR_STOP=1','-q','-A','-t','-c',sql],{encoding:'utf8'}); }
function ok(sql) { const r=run(sql);assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout.trim(); }
function reject(sql) { const r=run(sql);assert.notEqual(r.status,0,sql);assert.match(r.stderr,/ERROR|error/i); }
function asyncRun(sql) { return new Promise((resolvePromise,rejectPromise)=> {
  const p=spawn('psql',[db,'-X','-v','ON_ERROR_STOP=1','-q','-A','-t','-c',sql]);
  let stdout='',stderr='';
  p.on('error',rejectPromise);p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);
  p.on('close',code=>resolvePromise({code,stdout:stdout.trim(),stderr:stderr.trim()}));
});}
const create=(id,amount=5,token=1) => "select id::text || '|' || status from public.algobot_create_execution('"+id+"','BTCUSDT','BUY',0,"+amount+","+token+");";
const reserve=id => "select reservation_id from public.algobot_reserve_canary('"+id+"',5,1);";
const inflight=(id,token=1) => "select status from public.algobot_mark_execution_in_flight('"+id+"',"+token+");";
const unknown=(id,token=1) => "select status from public.algobot_mark_execution_unknown('"+id+"','network ambiguous',"+token+");";
const evidence=(id,status,qty,notional,avg,fees,token=1,orderId='bybit-order-1') =>
  "select status || '|' || filled_qty::text || '|' || filled_notional_usdt::text || '|' || reconciliation_status from public.algobot_apply_execution_evidence('"+id+"','"+status+"',"+(orderId===null?'null':"'"+orderId+"'")+","+qty+","+notional+","+(avg===null?'null':avg)+","+fees+","+token+");";
function seed(id) {ok(create(id));ok(reserve(id));ok("update bot_state_meta set trading_state='TRADING_ENABLED' where singleton_key='ALGOBOT';");assert.equal(ok(inflight(id)),'IN_FLIGHT');}
test.before(()=>{assert.ok(db,'ALGOBOT_TEST_DATABASE_URL required');const r=spawnSync('psql',[db,'-X','-v','ON_ERROR_STOP=1','-q'],{input:readFileSync(migration,'utf8'),encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);});
test.beforeEach(()=>{ok("delete from canary_reservations; delete from execution_ledger; update bot_state_meta set trading_state='RECOVERY_REQUIRED',max_order_notional_usdt=10,max_cumulative_notional_usdt=100,executor_owner_id='ledger-tester',executor_fence_token=1,lease_expires_at=now()+interval '1 hour' where singleton_key='ALGOBOT';");});
test('create idempotency survives reconnect; conflicting request rejects',()=>{
 const first=ok(create('task4-idem'));assert.equal(ok(create('task4-idem')),first);
 assert.equal(ok("select count(*) from execution_ledger where order_link_id='task4-idem';"),'1');
 reject(create('task4-idem',6));
});
test('concurrent duplicate logical orders insert exactly once',async()=>{
 const [a,b]=await Promise.all([asyncRun(create('task4-race')),asyncRun(create('task4-race'))]);
 assert.equal(a.code,0,a.stderr);assert.equal(b.code,0,b.stderr);assert.equal(a.stdout,b.stdout);
 assert.equal(ok("select count(*) from execution_ledger where order_link_id='task4-race';"),'1');
});
test('enforce BTCUSDT, valid BUY/SELL, positive notional and active fence',()=>{
 reject("select id from algobot_create_execution('task4-eth','ETHUSDT','BUY',0,5,1);");
 reject("select id from algobot_create_execution('task4-short','BTCUSDT','SHORT',0,5,1);");
 reject("select id from algobot_create_execution('task4-zero','BTCUSDT','BUY',0,0,1);");
 reject(create('task4-stale',5,0));
 reject("select id from algobot_create_execution('task4-null','BTCUSDT','BUY',0,5,null);");
});
test('mark IN_FLIGHT requires reservation and TRADING_ENABLED gate',()=>{
 ok(create('task4-gate'));reject(inflight('task4-gate'));ok(reserve('task4-gate'));
 reject(inflight('task4-gate'));ok("update bot_state_meta set trading_state='TRADING_ENABLED' where singleton_key='ALGOBOT';");
 assert.equal(ok(inflight('task4-gate')),'IN_FLIGHT');reject(inflight('task4-gate'));
});
test('UNKNOWN persists, never synthesize fill',()=>{
 seed('task4-unknown');assert.equal(ok(unknown('task4-unknown')),'UNKNOWN');
 assert.equal(ok("select reconciliation_status || '|' || filled_qty::text from execution_ledger where order_link_id='task4-unknown';"),'PENDING|0.000000000000');
 assert.equal(ok(unknown('task4-unknown')),'UNKNOWN');
});
test('verified partial/full evidence persists orderId, quantities, average, fees',()=>{
 seed('task4-fills');
 assert.match(ok(evidence('task4-fills','PARTIALLY_FILLED',0.001,4,4000,0.004)),/^PARTIALLY_FILLED\|0\.001000000000\|4\.000000000000\|VERIFIED$/);
 assert.match(ok(evidence('task4-fills','FILLED',0.00125,5,4000,0.005)),/^FILLED\|0\.001250000000\|5\.000000000000\|VERIFIED$/);
 assert.equal(ok("select exchange_order_id || '|' || avg_fill_price::text || '|' || fees_usdt::text from execution_ledger where order_link_id='task4-fills';"),'bybit-order-1|4000.000000000000|0.005000000000');
});
test('reject fake FILLED without orderId, positive fill or avg price',()=>{
 seed('task4-no-fake');reject(evidence('task4-no-fake','FILLED',1,5,5,0,1,null));
 reject(evidence('task4-no-fake','PARTIALLY_FILLED',0,0,null,0));
 reject(evidence('task4-no-fake','FILLED',1,5,null,0));
 assert.equal(ok("select status from execution_ledger where order_link_id='task4-no-fake';"),'IN_FLIGHT');
});
test('reject out of order/decreased fills and conflicting terminal replay',()=>{
 seed('task4-no-regress');ok(evidence('task4-no-regress','PARTIALLY_FILLED',0.001,4,4000,0.004));
 reject(evidence('task4-no-regress','ACKNOWLEDGED',0.001,4,4000,0.004));
 reject(evidence('task4-no-regress','FILLED',0.0005,2,4000,0.002));
 ok(evidence('task4-no-regress','FILLED',0.00125,5,4000,0.005));
 assert.match(ok(evidence('task4-no-regress','FILLED',0.00125,5,4000,0.005)),/^FILLED/);
 reject(evidence('task4-no-regress','FILLED',0.0013,5.2,4000,0.006));
});
test('new executor reconciles UNKNOWN, stale token cannot mutate',()=>{
 seed('task4-fence');ok(unknown('task4-fence'));
 ok("update bot_state_meta set executor_owner_id='new-executor',executor_fence_token=2,lease_expires_at=now()+interval '1 hour' where singleton_key='ALGOBOT';");
 reject(evidence('task4-fence','FILLED',0.001,5,5000,0.005,1));
 assert.match(ok(evidence('task4-fence','FILLED',0.001,5,5000,0.005,2)),/^FILLED/);
 assert.equal(ok("select executor_fence_token from execution_ledger where order_link_id='task4-fence';"),'2');
});
test('list unresolved includes UNKNOWN, excludes VERIFIED terminal',()=>{
 seed('task4-active');ok(unknown('task4-active'));
 seed('task4-complete');ok(evidence('task4-complete','FILLED',0.001,5,5000,0.005));
 assert.equal(ok("select count(*) from public.algobot_list_unresolved_executions() where order_link_id='task4-active';"),'1');
 assert.equal(ok("select count(*) from public.algobot_list_unresolved_executions() where order_link_id='task4-complete';"),'0');
});
