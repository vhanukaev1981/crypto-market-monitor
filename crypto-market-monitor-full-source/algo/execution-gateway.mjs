const EXECUTABLE_DECISIONS = new Set(['APPROVED', 'REDUCED_SIZE']);

function validateMarket(market) {
  const { bid, ask } = market ?? {};
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) {
    throw new Error('INVALID_MARKET');
  }
  return { bid, ask };
}

export function executeRiskApprovedPaperOrder({
  engine,
  riskDecision,
  clientOrderId,
  fillId,
  symbol,
  side,
  market,
} = {}) {
  if (!engine || typeof engine.createOrder !== 'function' || typeof engine.applyMarketFill !== 'function') {
    throw new Error('INVALID_EXECUTION_ENGINE');
  }
  if (!riskDecision || typeof riskDecision.decision !== 'string') {
    throw new Error('INVALID_RISK_DECISION');
  }

  if (!EXECUTABLE_DECISIONS.has(riskDecision.decision)) {
    return {
      executed: false,
      duplicate: false,
      reasonCode: 'EXECUTION_RISK_NOT_APPROVED',
      riskDecision: structuredClone(riskDecision),
    };
  }

  if (!Number.isFinite(riskDecision.approvedNotional) || riskDecision.approvedNotional <= 0) {
    throw new Error('INVALID_RISK_DECISION');
  }
  if (!clientOrderId || !fillId || !symbol || !['BUY', 'SELL'].includes(side)) {
    throw new Error('INVALID_EXECUTION_REQUEST');
  }

  const { bid, ask } = validateMarket(market);
  const existingFill = engine.fills?.get?.(fillId);
  if (existingFill) {
    return { executed: true, duplicate: true, fill: structuredClone(existingFill), reasonCode: 'EXECUTION_DUPLICATE_FILL' };
  }

  const slip = engine.slippageBps / 10000;
  const executablePrice = side === 'BUY' ? ask * (1 + slip) : bid * (1 - slip);
  if (!Number.isFinite(executablePrice) || executablePrice <= 0) throw new Error('INVALID_MARKET');
  const qty = riskDecision.approvedNotional / executablePrice;
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('INVALID_EXECUTION_QTY');

  const created = engine.createOrder({ clientOrderId, symbol, side, qty, type: 'MARKET' });
  if (created.duplicate) {
    const existing = created.order;
    if (existing.symbol !== symbol || existing.side !== side || Math.abs(existing.qty - qty) > 1e-12) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
  }

  const fill = engine.applyMarketFill({ fillId, clientOrderId, qty, bid, ask });
  return {
    executed: true,
    duplicate: Boolean(created.duplicate || fill.duplicate),
    fill,
    reasonCode: fill.duplicate ? 'EXECUTION_DUPLICATE_FILL' : 'EXECUTION_FILLED',
  };
}
