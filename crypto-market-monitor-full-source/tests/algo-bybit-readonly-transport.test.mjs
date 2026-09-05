import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBybitV5ReadOnlyTransport } from '../algo/bybit-v5-readonly-transport.mjs';

test('signs a V5 wallet balance GET and never sends the secret', async () => {
  let captured;
  const transport = createBybitV5ReadOnlyTransport({
    apiKey: 'test-key', apiSecret: 'test-secret', now: () => 1700000000000,
    fetchImpl: async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ retCode: 0, result: { list: [] } }) }; }
  });
  const result = await transport.request({ operation: 'accountSnapshot' });
  assert.equal(result.retCode, 0);
  assert.match(captured.url, /\/v5\/account\/wallet-balance\?accountType=UNIFIED/);
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.headers['X-BAPI-API-KEY'], 'test-key');
  assert.equal(captured.options.headers['X-BAPI-TIMESTAMP'], '1700000000000');
  assert.equal(captured.options.headers['X-BAPI-RECV-WINDOW'], '5000');
  assert.match(captured.options.headers['X-BAPI-SIGN'], /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(captured).includes('test-secret'));
});

test('fails closed on missing credentials and unknown operations', async () => {
  assert.throws(() => createBybitV5ReadOnlyTransport({ apiKey: '', apiSecret: '' }), /credentials/i);
  const transport = createBybitV5ReadOnlyTransport({ apiKey: 'k', apiSecret: 's', fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => transport.request({ operation: 'withdraw' }), /unsupported.*Bybit operation/i);
});

test('fails closed when Bybit rejects authentication', async () => {
  const transport = createBybitV5ReadOnlyTransport({ apiKey: 'k', apiSecret: 's', fetchImpl: async () => ({ ok: true, json: async () => ({ retCode: 10003, retMsg: 'API key is invalid' }) }) });
  await assert.rejects(() => transport.request({ operation: 'accountSnapshot' }), /Bybit.*10003/i);
});

test('signs a V5 query-api GET and never sends the secret', async () => {
  let captured;
  const transport = createBybitV5ReadOnlyTransport({
    apiKey: 'test-key', apiSecret: 'test-secret', now: () => 1700000000000,
    fetchImpl: async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ retCode: 0, result: { permissions: {} } }) }; }
  });
  const result = await transport.request({ operation: 'queryApiPermissions' });
  assert.equal(result.retCode, 0);
  assert.match(captured.url, /\/v5\/user\/query-api/);
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.headers['X-BAPI-API-KEY'], 'test-key');
  assert.equal(captured.options.headers['X-BAPI-TIMESTAMP'], '1700000000000');
  assert.equal(captured.options.headers['X-BAPI-RECV-WINDOW'], '5000');
  assert.match(captured.options.headers['X-BAPI-SIGN'], /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(captured).includes('test-secret'));
});

test('signs V5 order create POST with exact JSON body and no secret leakage', async () => {
  let captured;
  const transport = createBybitV5ReadOnlyTransport({
    apiKey: 'test-key', apiSecret: 'test-secret', now: () => 1700000000000,
    fetchImpl: async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ retCode: 0, result: { orderId: 'mock-order-1', orderLinkId: 'canary-1' } }) }; }
  });
  const order = { category: 'spot', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '5', marketUnit: 'quoteCoin', orderLinkId: 'canary-1' };
  const result = await transport.request({ operation: 'placeOrder', order });
  assert.equal(result.result.orderId, 'mock-order-1');
  assert.equal(captured.url, 'https://api.bybit.com/v5/order/create');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.equal(captured.options.body, JSON.stringify(order));
  const expected = createHmac('sha256', 'test-secret').update(`1700000000000test-key5000${JSON.stringify(order)}`).digest('hex');
  assert.equal(captured.options.headers['X-BAPI-SIGN'], expected);
  assert.ok(!JSON.stringify(captured).includes('test-secret'));
});
