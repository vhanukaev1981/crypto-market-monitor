import test from 'node:test';
import assert from 'node:assert/strict';
import { createBybitLiveAdapter } from '../algo/bybit-live-adapter.mjs';

const order={humanApproved:true,marketType:'SPOT',leverage:1,symbol:'BTCUSDT',
  side:'BUY',orderType:'Market',notionalUsdt:5,orderLinkId:'task6_canary_1',
  qualification:{status:'PASS',fresh:true}};
const permission={retCode:0,result:{readOnly:0,permissions:{Spot:['SpotTrade'],Wallet:[]}}};
const fill={category:'spot',symbol:'BTCUSDT',orderId:'exchange-1',
  orderLinkId:order.orderLinkId,side:'Buy',orderType:'Market',
  execType:'Trade',execId:'fill-1',execPrice:'5000',execQty:'0.001',
  execValue:'5',execFee:'0.005',feeCurrency:'USDT',execTime:'1700000000000'};
const recon={retCode:0,result:{category:'spot',orderStatus:'Filled',
  orderId:'exchange-1',orderLinkId:order.orderLinkId,symbol:'BTCUSDT',
  side:'Buy',orderType:'Market',cumExecQty:'0.001',cumExecValue:'5'}};
function fixture(overrides={}){
 const rows=new Map(),reservations=new Map(),events=[];
 let placed=0,enabled=true;
 const executionStore={
  async getByOrderLinkId({orderLinkId}){events.push('get');return rows.get(orderLinkId)??null;},
  async createExecution({orderLinkId,symbol,side,requestedNotional}){
   events.push('create');const item={order_link_id:orderLinkId,symbol,side,
   requested_notional_usdt:String(requestedNotional),status:'CREATED'};
   if(!rows.has(orderLinkId))rows.set(orderLinkId,item);
   return rows.get(orderLinkId);
  },
  async markInFlight({orderLinkId}){events.push('inflight');
   rows.get(orderLinkId).status='IN_FLIGHT';return rows.get(orderLinkId);},
  async markUnknown({orderLinkId}){events.push('unknown');
   rows.get(orderLinkId).status='UNKNOWN';enabled=false;return rows.get(orderLinkId);},
  async applyExchangeEvidence({orderLinkId,status,exchangeOrderId,filledQty,filledNotional,avgFillPrice,fees}){
   events.push('evidence');const row=rows.get(orderLinkId);
   Object.assign(row,{status,exchange_order_id:exchangeOrderId,filled_qty:filledQty,
     filled_notional_usdt:filledNotional,avg_fill_price:avgFillPrice,fees_usdt:fees});
   return row;
  },
  async lockTrading(){events.push('lock');enabled=false;}
 };
 const canaryBudgetStore={
  async reserve({orderLinkId}){events.push('reserve');
   reservations.set(orderLinkId,{reservationId:'reservation-1'});
   return {reservationId:'reservation-1',totalAuthorizedUsdt:5};},
  async commit(){events.push('commit');},
 };
 const executorFence={async assertCurrent(){events.push('fence');}};
 const recoveryGate={isTradingEnabled(){events.push('gate');return enabled;}};
 const transport={async request({operation}){events.push('permissions');if(operation==='queryApiPermissions')return permission;
   throw Error('Unexpected '+operation);},
   async placeOrder(payload){placed+=1;events.push('POST');return {
    retCode:0,result:{orderId:'exchange-1',orderLinkId:payload.orderLinkId}};},
   async reconcileOrder(){events.push('reconcile');return recon;},
   async listExecutions(){events.push('fills');return {retCode:0,
    result:{category:'spot',list:[fill],hasMore:false,pageFinal:true}};}
 };
 return {executionStore,canaryBudgetStore,executorFence,recoveryGate,transport,events,rows,
   get placed(){return placed;},get enabled(){return enabled;},...overrides};
}
const create=(cfg)=>createBybitLiveAdapter({
 mode:'CANARY',apiKey:'unit-key',apiSecret:'unit-secret',...cfg
});

test('legacy CANARY with no persistent controls can never POST',async()=>{
 let count=0;
 const t={request:async()=>permission,
  placeOrder:async()=>{count++;return {retCode:0,result:{orderId:'fake'}};}};
 const adapter=create({transport:t});
 await assert.rejects(()=>adapter.submitCanaryOrder(order),/DURABLE|PERSISTENCE|RECOVERY|LOCKED/);
 assert.equal(count,0);
});
test('recovery lock rejects before any DB intent or POST',async()=>{
 const fx=fixture({recoveryGate:{isTradingEnabled:()=>false}});
 await assert.rejects(()=>create(fx).submitCanaryOrder(order),/RECOVERY|LOCKED/);
 assert.equal(fx.placed,0);
 assert.equal(fx.rows.size,0);
});
test('a stale executor fails closed before reservation or POST',async()=>{
 const fx=fixture({executorFence:{assertCurrent:async()=>{throw Error('stale fence');}}});
 await assert.rejects(()=>create(fx).submitCanaryOrder(order),/stale fence/);
 assert.equal(fx.placed,0);
 assert.equal(fx.rows.size,0);
});
test('successful test-only fill: create -> reserve -> in-flight -> POST -> verified evidence -> commit',async()=>{
 const fx=fixture();
 const result=await create(fx).submitCanaryOrder(order);
 assert.equal(fx.placed,1);
 assert.equal(result.success,true);
 assert.equal(result.orderId,'exchange-1');
 assert.deepEqual(fx.events.filter(x=>['create','reserve','inflight','POST','reconcile','fills','evidence','commit'].includes(x)),
   ['create','reserve','inflight','POST','reconcile','fills','evidence','commit']);
});
test('duplicate after cold adapter restart is never retransmitted',async()=>{
 const fx=fixture();
 const a=create(fx);
 await a.submitCanaryOrder(order);
 const b=create(fx);
 const duplicate=await b.submitCanaryOrder(order);
 assert.equal(duplicate.duplicate,true);
 assert.equal(duplicate.success,false);
 assert.equal(fx.placed,1);
 await assert.rejects(()=>b.submitCanaryOrder({...order,notionalUsdt:6}),/IDEMPOTENCY_CONFLICT/);
 assert.equal(fx.placed,1);
});
test('exchange timeout after POST records UNKNOWN and prevents subsequent orders',async()=>{
 const fx=fixture();
 fx.transport.reconcileOrder=async()=>{throw Error('Bybit timeout');};
 const a=create(fx);
 await assert.rejects(()=>a.submitCanaryOrder(order),/UNKNOWN|RECONCILIATION|timeout/i);
 assert.equal(fx.placed,1);
 assert.equal(fx.rows.get(order.orderLinkId).status,'UNKNOWN');
 assert.equal(fx.enabled,false);
 await assert.rejects(()=>a.submitCanaryOrder({...order,orderLinkId:'second-order'}),/RECOVERY|LOCKED|UNHEALTHY/);
 assert.equal(fx.placed,1);
});
test('absent fill evidence must never synthesize Filled',async()=>{
 const fx=fixture();
 fx.transport.listExecutions=async()=>({retCode:0,result:{category:'spot',list:[],hasMore:false}});
 await assert.rejects(()=>create(fx).submitCanaryOrder(order),/UNKNOWN|RECONCILIATION|evidence/i);
 assert.equal(fx.rows.get(order.orderLinkId).status,'UNKNOWN');
 assert.equal(fx.placed,1);
});
test('non-USDT fee cannot be silently misrecorded as fees_usdt',async()=>{
 const fx=fixture();
 fx.transport.listExecutions=async()=>({retCode:0,result:{category:'spot',
  list:[{...fill,feeCurrency:'BTC'}],hasMore:false,pageFinal:true}});
 await assert.rejects(()=>create(fx).submitCanaryOrder(order),/FEE|UNKNOWN|RECONCILIATION/i);
 assert.equal(fx.rows.get(order.orderLinkId).status,'UNKNOWN');
});
test('ledger persistence outage cannot trigger POST',async()=>{
 const fx=fixture({executionStore:{
  async getByOrderLinkId(){return null;},
  async createExecution(){throw Error('PostgreSQL offline');}}});
 await assert.rejects(()=>create(fx).submitCanaryOrder(order),/PostgreSQL offline/);
 assert.equal(fx.placed,0);
});
