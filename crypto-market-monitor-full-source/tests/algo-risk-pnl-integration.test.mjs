import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperExecutionEngine } from '../algo/paper-executor.mjs';
import { markPortfolio } from '../algo/portfolio-pnl.mjs';
import { evaluateRisk } from '../algo/risk-engine.mjs';

test('paper execution loss flows into risk engine daily-loss gate', () => {
  const execution = new PaperExecutionEngine({ startingCash: 1000, takerFeeBps: 10, slippageBps: 5 });
  execution.createOrder({ clientOrderId: 'buy-eth', symbol: 'ETHUSDT', side: 'BUY', qty: 1 });
  execution.applyMarketFill({ fillId: 'buy-eth-fill', clientOrderId: 'buy-eth', qty: 1, bid: 99, ask: 100 });

  const snap = execution.snapshot();
  const marked = markPortfolio({
    cash: snap.cash,
    positions: snap.positions,
    marks: { ETHUSDT: { bid: 80, ask: 81 } },
    peakEquity: 1000,
    startingEquity: 1000,
    dayStartEquity: 1000,
  });

  assert.ok(marked.dailyPnlPct < -1.5);
  const risk = evaluateRisk({
    portfolioEquity: marked.equity,
    dailyPnlPct: marked.dailyPnlPct,
    drawdownPct: marked.drawdownPct,
    volatilityLevel: 'normal',
    currentSymbolExposurePct: (marked.marketValue / marked.equity) * 100,
    maxSymbolExposurePct: 40,
    requestedNotional: 50,
    spreadBps: 2,
    maxSpreadBps: 10,
    estimatedSlippageBps: 2,
    maxSlippageBps: 10,
  });

  assert.equal(risk.decision, 'REJECTED');
  assert.equal(risk.reasonCode, 'RISK_002_DAILY_LOSS');
});
