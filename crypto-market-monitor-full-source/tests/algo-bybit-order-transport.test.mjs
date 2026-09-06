import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBybitV5ReadOnlyTransport } from '../algo/bybit-v5-readonly-transport.mjs';

const API_KEY = 'test-key';
const API_SECRET = 'test-secret';
const NOW = 1700000000123;
const RECV_WINDOW = '5000';

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

function validOrder(overrides = {}) {
  return {
    operation: 'placeOrder',
    category: 'spot',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Market',
    qty: '5',
    marketUnit: 'quoteCoin',
    orderLinkId: 'algobot-canary-001',
    ...overrides,
  };
}

test('placeOrder signs exact Bybit V5 JSON body and targets Spot order/create', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({ retCode: 0, retMsg: 'OK', result: { orderId: '123', orderLinkId: 'algobot-canary-001' } });
  };
  const transport = createBybitV5ReadOnlyTransport({ apiKey: API_KEY, apiSecret: API_SECRET, now: () => NOW, fetchImpl });

  const result = await transport.request(validOrder());
  assert.equal(result.retCode, 0);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://api.bybit.com/v5/order/create');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  const body = call.init.body;
  assert.deepEqual(JSON.parse(body), {
    category: 'spot', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '5', marketUnit: 'quoteCoin', orderLinkId: 'algobot-canary-001'
  });
  const expected = createHmac('sha256', API_SECRET).update(`${NOW}${API_KEY}${RECV_WINDOW}${body}`).digest('hex');
  assert.equal(call.init.headers['X-BAPI-SIGN'], expected);
  assert.ok(!JSON.stringify(call).includes(API_SECRET));
});

test('placeOrder fails closed for non-Spot, margin/leverage semantics, malformed order, or unsupported order type', async () => {
  let calls = 0;
  const transport = createBybitV5ReadOnlyTransport({ apiKey: API_KEY, apiSecret: API_SECRET, now: () => NOW, fetchImpl: async () => { calls++; return response({ retCode: 0 }); } });
  const invalid = [
    validOrder({ category: 'linear' }),
    validOrder({ leverage: 2 }),
    validOrder({ isLeverage: 1 }),
    validOrder({ symbol: 'btc/usdt' }),
    validOrder({ side: 'Short' }),
    validOrder({ qty: '0' }),
    validOrder({ orderType: 'Limit' }),
    validOrder({ orderLinkId: '' }),
  ];
  for (const request of invalid) await assert.rejects(() => transport.request(request));
  assert.equal(calls, 0);
});

test('placeOrder fails closed on HTTP or Bybit API rejection', async () => {
  const http = createBybitV5ReadOnlyTransport({ apiKey: API_KEY, apiSecret: API_SECRET, now: () => NOW, fetchImpl: async () => response({}, { ok: false, status: 403 }) });
  await assert.rejects(() => http.request(validOrder()), /HTTP failure: 403/);

  const api = createBybitV5ReadOnlyTransport({ apiKey: API_KEY, apiSecret: API_SECRET, now: () => NOW, fetchImpl: async () => response({ retCode: 10001, retMsg: 'bad request' }) });
  await assert.rejects(() => api.request(validOrder()), /API failure 10001/);
});

test('reconcileOrder signs GET /v5/order/realtime and normalizes order result', async () => {
  const calls = [];
  const mockOrder = {
    orderId: 'bybit-ord-999',
    orderLinkId: 'algobot-canary-001',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Market',
    orderStatus: 'Filled',
    qty: '10',
    cumExecQty: '0.00015',
    cumExecValue: '10.00',
    cumExecFee: '0.01',
    avgPrice: '66666.66',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({ retCode: 0, retMsg: 'OK', result: { list: [mockOrder], category: 'spot' } });
  };
  const transport = createBybitV5ReadOnlyTransport({ apiKey: API_KEY, apiSecret: API_SECRET, now: () => NOW, fetchImpl });

  const resDirect = await transport.reconcileOrder({ orderLinkId: 'algobot-canary-001', symbol: 'BTCUSDT' });
  assert.equal(resDirect.retCode, 0);
  assert.equal(resDirect.result.orderStatus, 'Filled');
  assert.equal(resDirect.result.orderId, 'bybit-ord-999');
  assert.equal(resDirect.result.category, 'spot');

  const call = calls[0];
  assert.match(call.url, /\/v5\/order\/realtime\?category=spot&symbol=BTCUSDT&orderLinkId=algobot-canary-001/);
  assert.equal(call.init.method, 'GET');
  const expectedQuery = 'category=spot&symbol=BTCUSDT&orderLinkId=algobot-canary-001';
  const expectedSign = createHmac('sha256', API_SECRET).update(`${NOW}${API_KEY}${RECV_WINDOW}${expectedQuery}`).digest('hex');
  assert.equal(call.init.headers['X-BAPI-SIGN'], expectedSign);
  assert.ok(!JSON.stringify(call).includes(API_SECRET));

  // Also via transport.request({ operation: 'reconcileOrder', ... })
  const resOp = await transport.request({ operation: 'reconcileOrder', orderLinkId: 'algobot-canary-001', symbol: 'BTCUSDT' });
  assert.equal(resOp.result.orderStatus, 'Filled');
});

test('reconcileOrder falls back to /v5/order/history when realtime returns empty list', async () => {
  const calls = [];
  const mockOrder = {
    orderId: 'bybit-ord-hist-1',
    orderLinkId: 'canary-hist-1',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Market',
    orderStatus: 'Filled',
    cumExecQty: '0.00015',
    cumExecValue: '10.00',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/v5/order/realtime')) {
      return response({ retCode: 0, retMsg: 'OK', result: { list: [], category: 'spot' } });
    }
    if (url.includes('/v5/order/history')) {
      return response({ retCode: 0, retMsg: 'OK', result: { list: [mockOrder], category: 'spot' } });
    }
    return response({}, { ok: false, status: 404 });
  };
  const transport = createBybitV5ReadOnlyTransport({ apiKey: API_KEY, apiSecret: API_SECRET, now: () => NOW, fetchImpl });
  const res = await transport.reconcileOrder({ orderLinkId: 'canary-hist-1', symbol: 'BTCUSDT' });
  assert.equal(res.result.orderId, 'bybit-ord-hist-1');
  assert.equal(res.result.orderStatus, 'Filled');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v5\/order\/realtime/);
  assert.match(calls[1].url, /\/v5\/order\/history/);
});

test('reconcileOrder fails closed when order is not found in realtime or history', async () => {
  const fetchImpl = async () => response({ retCode: 0, retMsg: 'OK', result: { list: [], category: 'spot' } });
  const transport = createBybitV5ReadOnlyTransport({ apiKey: API_KEY, apiSecret: API_SECRET, now: () => NOW, fetchImpl });
  await assert.rejects(
    () => transport.reconcileOrder({ orderLinkId: 'missing-order', symbol: 'BTCUSDT' }),
    /not found on exchange/i
  );
});

test('reconcileOrder fails closed on non-spot, leverage, or missing order identifiers', async () => {
  const transport = createBybitV5ReadOnlyTransport({ apiKey: API_KEY, apiSecret: API_SECRET, now: () => NOW, fetchImpl: async () => response({ retCode: 0 }) });
  const invalid = [
    { category: 'linear', orderLinkId: 'valid-1' },
    { leverage: 2, orderLinkId: 'valid-1' },
    { isLeverage: 1, orderLinkId: 'valid-1' },
    { orderLinkId: '' },
    { symbol: 'invalid/sym', orderLinkId: 'valid-1' },
    {},
  ];
  for (const req of invalid) {
    await assert.rejects(() => transport.reconcileOrder(req));
    await assert.rejects(() => transport.request({ operation: 'reconcileOrder', ...req }));
  }
});

