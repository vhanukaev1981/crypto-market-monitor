import test from 'node:test';
import assert from 'node:assert/strict';
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

test('fails closed on missing credentials and unsupported operations', async () => {
  assert.throws(() => createBybitV5ReadOnlyTransport({ apiKey: '', apiSecret: '' }), /credentials/i);
  const transport = createBybitV5ReadOnlyTransport({ apiKey: 'k', apiSecret: 's', fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => transport.request({ operation: 'placeOrder' }), /unsupported.*read.only/i);
});

test('fails closed when Bybit rejects authentication', async () => {
  const transport = createBybitV5ReadOnlyTransport({ apiKey: 'k', apiSecret: 's', fetchImpl: async () => ({ ok: true, json: async () => ({ retCode: 10003, retMsg: 'API key is invalid' }) }) });
  await assert.rejects(() => transport.request({ operation: 'accountSnapshot' }), /Bybit.*10003/i);
});
