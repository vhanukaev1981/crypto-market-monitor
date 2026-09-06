import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBybitAccountSnapshot } from '../scripts/run-bybit-readonly-diagnostic.mjs';

test('diagnostic exposes only non-secret connectivity metadata', () => {
  const summary = summarizeBybitAccountSnapshot({ retCode: 0, result: { list: [{ accountType: 'UNIFIED', totalEquity: '123.45', coin: [{ coin: 'USDT' }, { coin: 'BTC' }] }] } });
  assert.deepEqual(summary, { status: 'PASS', accountType: 'UNIFIED', assetCount: 2 });
  assert.ok(!JSON.stringify(summary).includes('123.45'));
});

test('diagnostic fails closed on malformed snapshot', () => {
  assert.throws(() => summarizeBybitAccountSnapshot({ retCode: 0, result: { list: [] } }), /snapshot/i);
});
