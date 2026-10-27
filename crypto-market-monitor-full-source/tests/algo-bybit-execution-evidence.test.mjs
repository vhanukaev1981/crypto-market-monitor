import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBybitV5ReadOnlyTransport } from '../algo/bybit-v5-readonly-transport.mjs';

const NOW=1700000000123;
const KEY='unit-test-key',SECRET='unit-test-secret';
const reply=body=>({ok:true,status:200,async json(){return body;}});
const fill=(o={})=>({
  category:'spot',symbol:'BTCUSDT',orderId:'bybit-order-1',orderLinkId:'algobot-evidence-1',
  side:'Buy',orderType:'Market',execType:'Trade',
  execId:'exec-1',execPrice:'50000.00',execQty:'0.0001',
  execValue:'5.00',execFee:'0.0000001',feeCurrency:'BTC',execTime:'1700000000100',...o
});
const bybit=(fetchImpl)=>createBybitV5ReadOnlyTransport({
  apiKey:KEY,apiSecret:SECRET,now:()=>NOW,fetchImpl
});
test('execution query signs GET Spot only with complete identification',async()=>{
  const calls=[];
  const transport=bybit(async(url,init)=>{
    calls.push({url,init});
    return reply({retCode:0,retMsg:'OK',result:{category:'spot',list:[fill()],nextPageCursor:''}});
  });
  const result=await transport.listExecutions({symbol:'BTCUSDT',orderLinkId:'algobot-evidence-1'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].init.method,'GET');
  assert.equal(calls[0].url,'https://api.bybit.com/v5/execution/list?category=spot&symbol=BTCUSDT&orderLinkId=algobot-evidence-1');
  const query='category=spot&symbol=BTCUSDT&orderLinkId=algobot-evidence-1';
  const expected=createHmac('sha256',SECRET).update(''+NOW+KEY+'5000'+query).digest('hex');
  assert.equal(calls[0].init.headers['X-BAPI-SIGN'],expected);
  assert.equal(result.result.list[0].feeCurrency,'BTC');
  assert.equal(result.result.list[0].execFee,'0.0000001');
  assert.equal(result.result.hasMore,false);
  assert.ok(!JSON.stringify(calls).includes(SECRET));
});
test('no non-Spot/margin/leverage or missing order identifiers allowed',async()=>{
  let calls=0;const t=bybit(async()=>{calls++;return reply({retCode:0});});
  const invalid=[
    {category:'linear',symbol:'BTCUSDT',orderId:'1'},
    {symbol:'ETHUSDT',orderId:'1'},
    {symbol:'BTCUSDT'},
    {symbol:'BTCUSDT',orderId:'1',leverage:2},
    {symbol:'BTCUSDT',orderId:'1',isLeverage:1},
    {symbol:'BTCUSDT',orderId:'1',marginMode:'cross'},
    {symbol:'BTCUSDT',orderLinkId:''},
  ];
  for(const request of invalid)await assert.rejects(()=>t.listExecutions(request));
  assert.equal(calls,0);
});
test('malformed or cross-market response rejects rather than produces evidence',async()=>{
  const cases=[
    {retCode:0,result:{}},
    {retCode:0,result:{category:'linear',list:[fill()]}},
    {retCode:0,result:{category:'spot',list:[fill({symbol:'ETHUSDT'})]}},
    {retCode:0,result:{category:'spot',list:[fill({orderId:'wrong-order'})]}},
    {retCode:0,result:{category:'spot',list:[fill({orderLinkId:'wrong-link'})]}},
    {retCode:0,result:{category:'spot',list:[fill({execPrice:'NaN'})]}},
    {retCode:0,result:{category:'spot',list:[fill({execQty:'0'})]}},
    {retCode:0,result:{category:'spot',list:[fill({execFee:'0.1',feeCurrency:''})]}},
    {retCode:0,result:{category:'spot',list:[fill(),fill()]}},
  ];
  for(const body of cases){
    const t=bybit(async()=>reply(body));
    await assert.rejects(()=>t.listExecutions({symbol:'BTCUSDT',orderId:'bybit-order-1',orderLinkId:'algobot-evidence-1'}));
  }
});
test('cursor response remains explicitly incomplete; only matching executions accepted',async()=>{
  const urls=[];
  const t=bybit(async(url)=>{
    urls.push(url);
    return reply({retCode:0,result:{category:'spot',list:[fill()],nextPageCursor:'cursor+1'}});
  });
  const one=await t.listExecutions({symbol:'BTCUSDT',orderId:'bybit-order-1'});
  assert.equal(one.result.hasMore,true);
  assert.equal(one.result.nextPageCursor,'cursor+1');
  await t.listExecutions({symbol:'BTCUSDT',orderId:'bybit-order-1',cursor:'cursor+1'});
  assert.ok(urls[1].includes('cursor=cursor%2B1'));
});
test('empty execution history is not converted into a fill',async()=>{
  const t=bybit(async()=>reply({retCode:0,result:{category:'spot',list:[],nextPageCursor:''}}));
  const response=await t.listExecutions({symbol:'BTCUSDT',orderId:'bybit-order-1'});
  assert.deepEqual(response.result.list,[]);
  assert.equal(response.result.hasMore,false);
});
test('wallet evidence signs authenticated GET for UNIFIED BTC,USDT only',async()=>{
  const calls=[];
  const t=bybit(async(url,init)=>{
    calls.push({url,init});
    return reply({retCode:0,result:{list:[{accountType:'UNIFIED',coin:[
      {coin:'BTC',walletBalance:'0.001',spotBorrow:'0'},
      {coin:'USDT',walletBalance:'20',spotBorrow:'0'},
    ]}]}});
  });
  const data=await t.spotBalanceEvidence();
  assert.equal(calls[0].init.method,'GET');
  assert.equal(calls[0].url,'https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED&coin=BTC%2CUSDT');
  assert.equal(data.result.coins.length,2);
  assert.equal(data.result.coins[0].coin,'BTC');
});
test('wallet evidence rejects wrong account type or malformed numbers',async()=>{
  const replies=[
    {retCode:0,result:{list:[]}},
    {retCode:0,result:{list:[{accountType:'CONTRACT',coin:[]}]}},
    {retCode:0,result:{list:[{accountType:'UNIFIED',coin:[{coin:'BTC',walletBalance:'invalid',spotBorrow:'0'}]}]}},
  ];
  for(const value of replies){
    await assert.rejects(()=>bybit(async()=>reply(value)).spotBalanceEvidence());
  }
});
test('reconciliation rejects an order with mismatched requested identity',async()=>{
  const t=bybit(async()=>reply({retCode:0,result:{category:'spot',list:[{
    orderId:'incorrect',orderLinkId:'algobot-evidence-1',symbol:'ETHUSDT',side:'Buy',
    orderType:'Market',orderStatus:'Filled',cumExecQty:'1',cumExecValue:'5'
  }]}}));
  await assert.rejects(()=>t.reconcileOrder({symbol:'BTCUSDT',orderId:'bybit-order-1',orderLinkId:'algobot-evidence-1'}));
});
