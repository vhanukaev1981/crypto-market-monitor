import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperExecutionEngine } from '../algo/paper-executor.mjs';
import { executeRiskApprovedPaperOrder } from '../algo/execution-gateway.mjs';

function engine() {
  return new PaperExecutionEngine({ startingCash: 1000, takerFeeBps: 10, slippageBps: 5 });
}

const market = { bid: 99, ask: 100 };

test('gateway refuses rejected and halted risk decisions without creating an order', () => {
  for (const decision of ['REJECTED', 'HALT_SYSTEM']) {
    const e = engine();
    const result = executeRiskApprovedPaperOrder({
      engine: e,
      riskDecision: { decision, approvedNotional: 0, reasonCode: 'BLOCKED' },
      clientOrderId: `blocked-${decision}`,
      fillId: `fill-${decision}`,
      symbol: 'ETHUSDT',
      side: 'BUY',
      market,
    });
    assert.equal(result.executed, false);
    assert.equal(result.reasonCode, 'EXECUTION_RISK_NOT_APPROVED');
    assert.equal(e.snapshot().orderCount, 0);
    assert.equal(e.snapshot().fillCount, 0);
  }
});

test('gateway sizes buy from approved notional using executable ask plus configured slippage', () => {
  const e = engine();
  const result = executeRiskApprovedPaperOrder({
    engine: e,
    riskDecision: { decision: 'APPROVED', approvedNotional: 100, reasonCode: 'RISK_OK' },
    clientOrderId: 'approved-buy',
    fillId: 'approved-buy-fill',
    symbol: 'ETHUSDT',
    side: 'BUY',
    market,
  });
  assert.equal(result.executed, true);
  assert.equal(result.fill.order.status, 'FILLED');
  assert.ok(result.fill.qty > 0);
  assert.ok(result.fill.price >= market.ask);
  assert.ok(result.fill.price * result.fill.qty <= 100 + 1e-9);
});

test('gateway honors REDUCED_SIZE approvedNotional instead of requested size', () => {
  const e = engine();
  const result = executeRiskApprovedPaperOrder({
    engine: e,
    riskDecision: { decision: 'REDUCED_SIZE', approvedNotional: 50, reasonCode: 'RISK_010_VOLATILITY_REDUCTION' },
    clientOrderId: 'reduced-buy',
    fillId: 'reduced-buy-fill',
    symbol: 'ETHUSDT',
    side: 'BUY',
    market,
  });
  assert.equal(result.executed, true);
  assert.ok(result.fill.price * result.fill.qty <= 50 + 1e-9);
});

test('gateway fails closed on invalid risk payload or market before mutating execution state', () => {
  const e = engine();
  const before = e.snapshot();
  assert.throws(() => executeRiskApprovedPaperOrder({
    engine: e,
    riskDecision: { decision: 'APPROVED', approvedNotional: Number.NaN, reasonCode: 'RISK_OK' },
    clientOrderId: 'bad-risk', fillId: 'bad-risk-fill', symbol: 'ETHUSDT', side: 'BUY', market,
  }), /INVALID_RISK_DECISION/);
  assert.deepEqual(e.snapshot(), before);

  assert.throws(() => executeRiskApprovedPaperOrder({
    engine: e,
    riskDecision: { decision: 'APPROVED', approvedNotional: 100, reasonCode: 'RISK_OK' },
    clientOrderId: 'bad-market', fillId: 'bad-market-fill', symbol: 'ETHUSDT', side: 'BUY', market: { bid: 101, ask: 100 },
  }), /INVALID_MARKET/);
  assert.deepEqual(e.snapshot(), before);
});

test('gateway remains idempotent across restart for the same order and fill ids', () => {
  const e = engine();
  const args = {
    engine: e,
    riskDecision: { decision: 'APPROVED', approvedNotional: 100, reasonCode: 'RISK_OK' },
    clientOrderId: 'restart-buy', fillId: 'restart-fill', symbol: 'ETHUSDT', side: 'BUY', market,
  };
  const first = executeRiskApprovedPaperOrder(args);
  assert.equal(first.executed, true);
  const restored = PaperExecutionEngine.fromState(e.exportState());
  const second = executeRiskApprovedPaperOrder({ ...args, engine: restored });
  assert.equal(second.executed, true);
  assert.equal(second.duplicate, true);
  assert.equal(restored.snapshot().orderCount, 1);
  assert.equal(restored.snapshot().fillCount, 1);
});
