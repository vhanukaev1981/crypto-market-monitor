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
