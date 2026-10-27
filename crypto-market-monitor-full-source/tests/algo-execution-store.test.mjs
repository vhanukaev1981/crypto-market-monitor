import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionStore } from '../algo/execution-store.mjs';
test('store requires the real query contract',()=>{
  assert.throws(()=>createExecutionStore(),/pool.query/);
  assert.throws(()=>createExecutionStore({pool:{}}),/pool.query/);
});
test('create uses parameterized SQL without interpolating orderLinkId',async()=>{
  const calls=[];
  const store=createExecutionStore({pool:{query:async(sql,params)=>{
    calls.push({sql,params});return {rows:[{order_link_id:params[0],status:'CREATED'}]};
  }}});
  const marker="';drop table execution_ledger;--";
  assert.equal((await store.createExecution({orderLinkId:marker,symbol:'BTCUSDT',side:'BUY',requestedQty:0,requestedNotional:5,fenceToken:4})).status,'CREATED');
  assert.ok(!calls[0].sql.includes(marker));
  assert.deepEqual(calls[0].params,[marker,'BTCUSDT','BUY',0,5,4]);
});
test('invalid fence and numbers fail before database call',async()=>{
  let calls=0;const s=createExecutionStore({pool:{query:async()=>{calls++;return {rows:[]};}}});
  await assert.rejects(s.markInFlight({orderLinkId:'a',fenceToken:0}),/fenceToken/);
  await assert.rejects(s.createExecution({orderLinkId:'a',symbol:'BTCUSDT',side:'BUY',requestedNotional:-1,fenceToken:2}),/non-negative/);
  await assert.rejects(s.createExecution({orderLinkId:'a',symbol:'BTCUSDT',side:'BUY',requestedNotional:NaN,fenceToken:2}),/finite/);
  assert.equal(calls,0);
});
test('unexpected no row fails closed; reads return null or empty array',async()=>{
  const s=createExecutionStore({pool:{query:async()=>({rows:[]})}});
  await assert.rejects(s.createExecution({orderLinkId:'x',symbol:'BTCUSDT',side:'BUY',requestedNotional:5,fenceToken:1}),/no row/);
  await assert.rejects(s.markUnknown({orderLinkId:'x',reason:'unknown',fenceToken:1}),/no row/);
  assert.equal(await s.getByOrderLinkId({orderLinkId:'x'}),null);
  assert.deepEqual(await s.listUnresolved(),[]);
});
test('database outage propagates across every operation',async()=>{
  const s=createExecutionStore({pool:{query:async()=>{throw new Error('postgres unavailable');}}});
  await assert.rejects(s.markInFlight({orderLinkId:'x',fenceToken:1}),/postgres unavailable/);
  await assert.rejects(s.applyExchangeEvidence({orderLinkId:'x',status:'FILLED',exchangeOrderId:'bybit123',filledQty:1,filledNotional:5,avgFillPrice:5,fees:0,fenceToken:1}),/postgres unavailable/);
  await assert.rejects(s.listUnresolved(),/postgres unavailable/);
});
