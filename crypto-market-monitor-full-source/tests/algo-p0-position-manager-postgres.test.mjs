import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const db=process.env.ALGOBOT_TEST_DATABASE_URL;
const migration=resolve(dirname(fileURLToPath(import.meta.url)),'../supabase/migrations/20260905_algobot_p0_execution.sql');
function run(sql){assert.ok(db,'real ALGOBOT_TEST_DATABASE_URL required');return spawnSync('psql',[db,'-X','-v','ON_ERROR_STOP=1','-q','-A','-t','-c',sql],{encoding:'utf8'});}
function ok(sql){const r=run(sql);assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout.trim();}
function rejects(sql){const r=run(sql);assert.notEqual(r.status,0,sql);assert.match(r.stderr,/ERROR/i);}
function asyncRun(sql){return new Promise((resolvePromise,rejectPromise)=>{
 const p=spawn('psql',[db,'-X','-v','ON_ERROR_STOP=1','-q','-A','-t','-c',sql]);
 let stdout='',stderr='';p.on('error',rejectPromise);p.stdout.on('data',x=>stdout+=x);
 p.stderr.on('data',x=>stderr+=x);p.on('close',code=>resolvePromise({code,stdout:stdout.trim(),stderr:stderr.trim()}));
});}
function buyLedger(qty='0.08',status='PARTIALLY_FILLED',notional='3.2',fees='0.02'){
 ok("insert into public.execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,reconciliation_status,exchange_order_id,filled_qty,filled_notional_usdt,avg_fill_price,fees_usdt,executor_fence_token) values ('buy-pos-1','BTCUSDT','BUY',0,8,'"+status+"','VERIFIED','bybit-buy-1',"+qty+","+notional+",40,"+fees+",1);");
}
function sellLedger(qty='0.07',status='PARTIALLY_FILLED',notional='3.15',fees='0.01'){
 ok("insert into public.execution_ledger(order_link_id,symbol,side,requested_qty,requested_notional_usdt,status,reconciliation_status,exchange_order_id,filled_qty,filled_notional_usdt,avg_fill_price,fees_usdt,executor_fence_token) values ('sell-pos-1','BTCUSDT','SELL',0,9,'"+status+"','VERIFIED','bybit-sell-1',"+qty+","+notional+",45,"+fees+",1);");
}
const buy=(execId,qty,price='40',fee='0.02',token=1)=>"select status||'|'||quantity::text||'|'||average_entry_price::text||'|'||fees_usdt::text from public.algobot_apply_position_buy_fill('buy-pos-1','"+execId+"',"+qty+","+price+","+fee+","+token+");";
const sell=(id,execId,qty,price='45',fee='0.01',token=1)=>"select status||'|'||quantity::text||'|'||realized_pnl_usdt::text from public.algobot_apply_position_sell_fill('"+id+"','sell-pos-1','"+execId+"',"+qty+","+price+","+fee+","+token+");";
function openBuy(){
 buyLedger();
 ok(buy('exec-buy-1','0.08'));
 ok("update public.execution_ledger set status='FILLED',filled_qty=0.2,filled_notional_usdt=8,fees_usdt=0.05 where order_link_id='buy-pos-1';");
 return ok(buy('exec-buy-2','0.12','40','0.03'));
}
function positionId(){return ok("select id from public.position_lifecycle where source_buy_order_link_id='buy-pos-1';");}
test.before(()=>{
 assert.ok(db,'real PostgreSQL required');
 const r=spawnSync('psql',[db,'-X','-v','ON_ERROR_STOP=1','-q'],{encoding:'utf8',input:readFileSync(migration,'utf8')});
 assert.equal(r.status,0,r.stderr||r.stdout);
});
test.beforeEach(()=>{
 ok("delete from public.position_fill_events; delete from public.position_lifecycle; delete from public.canary_reservations; delete from public.execution_ledger; update public.bot_state_meta set trading_state='RECOVERY_REQUIRED',executor_owner_id='position-tester',executor_fence_token=1,lease_expires_at=now()+interval '1 hour' where singleton_key='ALGOBOT';");
});
test('partial buy credits only verified quantity and fee-inclusive weighted cost',()=>{
 buyLedger();
 assert.match(ok(buy('exec-buy-1','0.08')),/^OPENING\|0\.080000000000\|40\.250000000000\|0\.020000000000$/);
 assert.equal(ok("select count(*) from public.position_fill_events where side='BUY';"),'1');
 assert.equal(ok("select count(*) from public.algobot_list_managed_positions() where status='OPENING';"),'1');
});
test('full buy becomes OPEN only when all verified fills were applied',()=>{
 buyLedger();
 ok(buy('exec-buy-1','0.08'));
 ok("update execution_ledger set status='FILLED',filled_qty=0.2,filled_notional_usdt=8,fees_usdt=0.05 where order_link_id='buy-pos-1';");
 assert.equal(ok("select status from position_lifecycle where source_buy_order_link_id='buy-pos-1';"),'OPENING');
 assert.match(ok(buy('exec-buy-2','0.12','40','0.03')),/^OPEN\|0\.200000000000\|40\.250000000000\|0\.050000000000$/);
});
test('replay after process restart is idempotent; mutated replay rejected',()=>{
 openBuy();const first=ok(buy('exec-buy-2','0.12','40','0.03'));
 assert.match(first,/^OPEN\|0\.200000000000/);
 assert.equal(ok("select count(*) from public.position_fill_events;"),'2');
 rejects(buy('exec-buy-2','0.12','41','0.03'));
 assert.equal(ok("select quantity from position_lifecycle where source_buy_order_link_id='buy-pos-1';"),'0.200000000000');
});
test('overstatement of buy beyond exchange cumulative ledger is denied',()=>{
 buyLedger();rejects(buy('fake-fill','0.20'));
 assert.equal(ok("select count(*) from position_lifecycle;"),'0');
});
test('unverified ledger, stale fence, and wrong-side ledger fail closed',()=>{
 buyLedger();ok("update execution_ledger set reconciliation_status='PENDING' where order_link_id='buy-pos-1';");
 rejects(buy('u','0.08'));ok("update execution_ledger set reconciliation_status='VERIFIED' where order_link_id='buy-pos-1';");
 rejects(buy('stale','0.08','40','0.02',0));
 assert.equal(ok("select count(*) from position_lifecycle;"),'0');
});
test('requestExit persists unique exit intent before SELL, forbids OPENING and duplicate exit',()=>{
 buyLedger();ok(buy('exec-buy-1','0.08'));
 const id=positionId();
 rejects("select status from public.algobot_request_position_exit('"+id+"','take-profit','sell-pos-1',1);");
 openBuy();assert.equal(ok("select status from public.algobot_request_position_exit('"+id+"','take-profit','sell-pos-1',1);"),'EXIT_PENDING');
 assert.equal(ok("select exit_order_link_id from position_lifecycle where id='"+id+"';"),'sell-pos-1');
 rejects("select status from public.algobot_request_position_exit('"+id+"','retry','different-link',1);");
});
test('partial SELL reduces inventory and realizes actual pnl, full SELL closes',()=>{
 openBuy();const id=positionId();
 ok("select status from public.algobot_request_position_exit('"+id+"','profit','sell-pos-1',1);");
 sellLedger();
 assert.match(ok(sell(id,'exec-sell-1','0.07')),/^CLOSING\|0\.130000000000\|0\.322500000000$/);
 assert.equal(ok("select fees_usdt from position_lifecycle where id='"+id+"';"),'0.060000000000');
 ok("update execution_ledger set status='FILLED',filled_qty=0.2,filled_notional_usdt=9,fees_usdt=0.03 where order_link_id='sell-pos-1';");
 assert.match(ok(sell(id,'exec-sell-2','0.13','45','0.02')),/^CLOSED\|0\.000000000000\|0\.920000000000$/);
 assert.equal(ok("select fees_usdt from position_lifecycle where id='"+id+"';"),'0.080000000000');
});
test('SELL cannot exceed position inventory or cumulative verified sell qty',()=>{
 openBuy();const id=positionId();
 ok("select status from public.algobot_request_position_exit('"+id+"','profit','sell-pos-1',1);");
 sellLedger();
 rejects(sell(id,'fake-sell','0.2'));
 rejects(sell(id,'fake-sell-2','0.3'));
 assert.equal(ok("select quantity from position_lifecycle where id='"+id+"';"),'0.200000000000');
});
test('duplicate and conflicting SELL fill across restart cannot double-book PnL',()=>{
 openBuy();const id=positionId();
 ok("select status from public.algobot_request_position_exit('"+id+"','profit','sell-pos-1',1);");
 sellLedger();const first=ok(sell(id,'exec-sell-1','0.07'));
 assert.equal(ok(sell(id,'exec-sell-1','0.07')),first);
 rejects(sell(id,'exec-sell-1','0.07','46'));
 assert.equal(ok("select count(*) from position_fill_events where side='SELL';"),'1');
});
test('concurrent duplicate BUY fills never double-increment quantity',async()=>{
 buyLedger();
 const sql=buy('concurrent-fill','0.08');
 const [a,b]=await Promise.all([asyncRun(sql),asyncRun(sql)]);
 assert.equal(a.code,0,a.stderr);assert.equal(b.code,0,b.stderr);
 assert.equal(ok("select count(*) from position_fill_events;"),'1');
 assert.equal(ok("select quantity from position_lifecycle where source_buy_order_link_id='buy-pos-1';"),'0.080000000000');
});
