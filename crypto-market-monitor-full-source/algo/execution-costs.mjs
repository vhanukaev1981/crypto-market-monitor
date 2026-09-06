export function estimateMarketFill({ side, referencePrice, qty, spreadBps = 0, slippageBps = 0, feeBps = 0 }) {
  if (!['BUY','SELL'].includes(side)) throw new Error('INVALID_SIDE');
  if (![referencePrice, qty, spreadBps, slippageBps, feeBps].every(Number.isFinite) || referencePrice <= 0 || qty <= 0 || spreadBps < 0 || slippageBps < 0 || feeBps < 0) {
    throw new Error('INVALID_EXECUTION_INPUT');
  }
  const adverseBps = spreadBps / 2 + slippageBps;
  const direction = side === 'BUY' ? 1 : -1;
  const price = referencePrice * (1 + direction * adverseBps / 10000);
  const notional = price * qty;
  const fee = notional * feeBps / 10000;
  const cashDelta = side === 'BUY' ? -(notional + fee) : (notional - fee);
  return { side, price, qty, notional, fee, spreadBps, slippageBps, feeBps, cashDelta };
}
