import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperExecutionEngine } from '../algo/paper-executor.mjs';

const approx = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);

function engine() {
  return new PaperExecutionEngine({ startingCash: 1000, takerFeeBps: 10, slippageBps: 5 });
}

test('rejects invalid fee and slippage configuration fail-closed', () => {
  assert.throws(() => new PaperExecutionEngine({ startingCash: 1000, takerFeeBps: -1, slippageBps: 0 }), /INVALID_EXECUTION_COSTS/);
  assert.throws(() => new PaperExecutionEngine({ startingCash: 1000, takerFeeBps: 0, slippageBps: -1 }), /INVALID_EXECUTION_COSTS/);
  assert.throws(() => new PaperExecutionEngine({ startingCash: 1000, takerFeeBps: Number.NaN, slippageBps: 0 }), /INVALID_EXECUTION_COSTS/);
  assert.throws(() => new PaperExecutionEngine({ startingCash: 1000, takerFeeBps: 0, slippageBps: Number.POSITIVE_INFINITY }), /INVALID_EXECUTION_COSTS/);
});

test('market buy uses ask plus slippage and charges fee', () => {
  const e = engine();
  e.createOrder({ clientOrderId: 'o1', symbol: 'ETHUSDT', side: 'BUY', qty: 1 });
  const fill = e.applyMarketFill({ fillId: 'f1', clientOrderId: 'o1', qty: 1, bid: 99, ask: 100 });
  approx(fill.price, 100.05);
  approx(fill.fee, 0.10005);
  approx(e.snapshot().cash, 899.84995);
});

test('partial fills advance order state without losing quantity', () => {
  const e = engine();
  e.createOrder({ clientOrderId: 'o2', symbol: 'ETHUSDT', side: 'BUY', qty: 2 });
  const first = e.applyMarketFill({ fillId: 'f2a', clientOrderId: 'o2', qty: 0.5, bid: 99, ask: 100 });
  assert.equal(first.order.status, 'PARTIALLY_FILLED');
  assert.equal(first.order.filledQty, 0.5);
  const second = e.applyMarketFill({ fillId: 'f2b', clientOrderId: 'o2', qty: 1.5, bid: 99, ask: 100 });
  assert.equal(second.order.status, 'FILLED');
  assert.equal(second.order.filledQty, 2);
  assert.equal(e.snapshot().positions.ETHUSDT.qty, 2);
});

test('duplicate client order id is idempotent', () => {
  const e = engine();
  const first = e.createOrder({ clientOrderId: 'same', symbol: 'BTCUSDT', side: 'BUY', qty: 0.01 });
  const second = e.createOrder({ clientOrderId: 'same', symbol: 'BTCUSDT', side: 'BUY', qty: 0.01 });
  assert.equal(second.duplicate, true);
  assert.equal(first.order.clientOrderId, second.order.clientOrderId);
  assert.equal(e.snapshot().orderCount, 1);
});

test('duplicate fill id cannot mutate portfolio twice', () => {
  const e = engine();
  e.createOrder({ clientOrderId: 'o3', symbol: 'ETHUSDT', side: 'BUY', qty: 1 });
  e.applyMarketFill({ fillId: 'same-fill', clientOrderId: 'o3', qty: 1, bid: 99, ask: 100 });
  const cashAfterFirst = e.snapshot().cash;
  const second = e.applyMarketFill({ fillId: 'same-fill', clientOrderId: 'o3', qty: 1, bid: 99, ask: 100 });
  assert.equal(second.duplicate, true);
  approx(e.snapshot().cash, cashAfterFirst);
  assert.equal(e.snapshot().positions.ETHUSDT.qty, 1);
});

test('round trip realized pnl and cash reconcile net of both fees', () => {
  const e = engine();
  e.createOrder({ clientOrderId: 'buy', symbol: 'ETHUSDT', side: 'BUY', qty: 1 });
  e.applyMarketFill({ fillId: 'buy-fill', clientOrderId: 'buy', qty: 1, bid: 99, ask: 100 });
  e.createOrder({ clientOrderId: 'sell', symbol: 'ETHUSDT', side: 'SELL', qty: 1 });
  const sell = e.applyMarketFill({ fillId: 'sell-fill', clientOrderId: 'sell', qty: 1, bid: 110, ask: 111 });
  const snap = e.snapshot();
  const sellPrice = 110 * (1 - 5 / 10000);
  const buyCost = 100.05 + 100.05 * 10 / 10000;
  const sellNet = sellPrice - sellPrice * 10 / 10000;
  approx(sell.realizedPnlDelta, sellNet - buyCost);
  approx(snap.cash, 1000 + snap.realizedPnl);
  assert.equal(snap.positions.ETHUSDT.qty, 0);
});

test('state can be restored after restart without losing idempotency', () => {
  const e = engine();
  e.createOrder({ clientOrderId: 'restore', symbol: 'ETHUSDT', side: 'BUY', qty: 2 });
  e.applyMarketFill({ fillId: 'restore-fill-1', clientOrderId: 'restore', qty: 1, bid: 99, ask: 100 });
  const restored = PaperExecutionEngine.fromState(e.exportState());
  const duplicate = restored.applyMarketFill({ fillId: 'restore-fill-1', clientOrderId: 'restore', qty: 1, bid: 99, ask: 100 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(restored.snapshot().positions.ETHUSDT.qty, 1);
  const finalFill = restored.applyMarketFill({ fillId: 'restore-fill-2', clientOrderId: 'restore', qty: 1, bid: 99, ask: 100 });
  assert.equal(finalFill.order.status, 'FILLED');
  assert.equal(restored.snapshot().positions.ETHUSDT.qty, 2);
});

test('restart state validation rejects corrupt or ambiguous persisted state fail-closed', () => {
  const valid = engine().exportState();
  const invalidStates = [
    null,
    { ...valid, version: 2 },
    { ...valid, cash: Number.NaN },
    { ...valid, cash: -1 },
    { ...valid, realizedPnl: Number.POSITIVE_INFINITY },
    { ...valid, orders: {} },
    { ...valid, fills: null },
    { ...valid, positions: 'bad' },
    { ...valid, orders: [{ clientOrderId: 'dup', symbol: 'BTCUSDT', side: 'BUY', qty: 1, type: 'MARKET', filledQty: 0, averageFillPrice: 0, status: 'CREATED' }, { clientOrderId: 'dup', symbol: 'BTCUSDT', side: 'BUY', qty: 1, type: 'MARKET', filledQty: 0, averageFillPrice: 0, status: 'CREATED' }] },
    { ...valid, positions: [['BTCUSDT', { qty: -1, totalCost: 0 }]] },
  ];
  for (const state of invalidStates) {
    assert.throws(() => PaperExecutionEngine.fromState(state), /INVALID_STATE/);
  }
});

test('restart reconciliation rejects persisted accounting that disagrees with fills', () => {
  const e = engine();
  e.createOrder({ clientOrderId: 'reconcile-buy', symbol: 'ETHUSDT', side: 'BUY', qty: 1 });
  e.applyMarketFill({ fillId: 'reconcile-buy-fill', clientOrderId: 'reconcile-buy', qty: 1, bid: 99, ask: 100 });
  e.createOrder({ clientOrderId: 'reconcile-sell', symbol: 'ETHUSDT', side: 'SELL', qty: 0.25 });
  e.applyMarketFill({ fillId: 'reconcile-sell-fill', clientOrderId: 'reconcile-sell', qty: 0.25, bid: 110, ask: 111 });
  const valid = e.exportState();

  const corruptStates = [
    { ...structuredClone(valid), startingCash: 999 },
    { ...structuredClone(valid), cash: valid.cash + 1 },
    { ...structuredClone(valid), realizedPnl: valid.realizedPnl + 1 },
    {
      ...structuredClone(valid),
      positions: valid.positions.map(([symbol, position]) => [symbol, { ...position, totalCost: position.totalCost + 1 }]),
    },
    {
      ...structuredClone(valid),
      fills: valid.fills.map((fill, index) => index === 0 ? { ...fill, fee: fill.fee + 1 } : fill),
    },
    {
      ...structuredClone(valid),
      orders: valid.orders.map((order, index) => index === 0 ? { ...order, filledQty: 0.5, status: 'PARTIALLY_FILLED' } : order),
    },
  ];

  for (const state of corruptStates) {
    assert.throws(() => PaperExecutionEngine.fromState(state), /INVALID_STATE/);
  }
});

test('insufficient cash failure leaves portfolio unchanged', () => {
  const e = engine();
  e.createOrder({ clientOrderId: 'too-big', symbol: 'BTCUSDT', side: 'BUY', qty: 100 });
  const before = e.snapshot();
  assert.throws(() => e.applyMarketFill({ fillId: 'too-big-fill', clientOrderId: 'too-big', qty: 100, bid: 99, ask: 100 }), /INSUFFICIENT_CASH/);
  assert.deepEqual(e.snapshot(), before);
});

test('oversell failure leaves portfolio unchanged', () => {
  const e = engine();
  e.createOrder({ clientOrderId: 'oversell', symbol: 'ETHUSDT', side: 'SELL', qty: 1 });
  const before = e.snapshot();
  assert.throws(() => e.applyMarketFill({ fillId: 'oversell-fill', clientOrderId: 'oversell', qty: 1, bid: 100, ask: 101 }), /INSUFFICIENT_POSITION/);
  assert.deepEqual(e.snapshot(), before);
});
