import test from 'node:test';
import assert from 'node:assert/strict';
import { createBybitLiveAdapter } from '../algo/bybit-live-adapter.mjs';

test('defaults to READ_ONLY and rejects canary writes', async () => {
  let writes = 0;
  const adapter = createBybitLiveAdapter({ transport: { request: async () => ({ ok: true }), placeOrder: async () => { writes += 1; } } });
  assert.equal(adapter.mode, 'READ_ONLY');
  await assert.rejects(() => adapter.submitCanaryOrder({ symbol: 'BTCUSDT', notionalUsdt: 5 }), /READ_ONLY/);
  assert.equal(writes, 0);
});

test('rejects unsupported LIVE mode', () => {
  assert.throws(() => createBybitLiveAdapter({ mode: 'LIVE' }), /LIVE.*disabled/);
});

test('read-only authenticated snapshot fails closed when credentials are missing', async () => {
  const adapter = createBybitLiveAdapter({ mode: 'READ_ONLY', transport: { request: async () => ({}) } });
  await assert.rejects(() => adapter.getAccountSnapshot(), /credentials/i);
});

test('CANARY cannot reach order transport without explicit approval', async () => {
  let writes = 0;
  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'key', apiSecret: 'secret',
    transport: { placeOrder: async () => { writes += 1; return { ok: true }; } }
  });
  await assert.rejects(() => adapter.submitCanaryOrder({ symbol: 'BTCUSDT', category: 'spot', leverage: 1, notionalUsdt: 5 }), /approval/i);
  assert.equal(writes, 0);
});
