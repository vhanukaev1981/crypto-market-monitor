export function evaluateTrendPullback(input) {
  if (input.regime !== 'TREND_UP') return { action: 'NO_TRADE', score: 0, reason: 'REGIME_NOT_ALLOWED' };
  const { regimeConfidence=0, structural1d='NEUTRAL', confirmation4h='NEUTRAL', dataHealth='RED', riskHealth='RED', price, ema20, ema50, ema200, ema20Slope=0, ema50Slope=0, adx14=0, atr, rsi14, pullbackDepthPct, previousClose, candleHigh, candleLow, candleClose, volume, volume20Avg, spreadBps, maxSpreadBps, estimatedSlippageBps, maxSlippageBps } = input;
  if (regimeConfidence < 70 || structural1d === 'TREND_DOWN' || confirmation4h === 'TREND_DOWN') return { action: 'NO_TRADE', score: 0, reason: 'TREND_CONFIRMATION_FAILED' };
  if (dataHealth !== 'GREEN' || riskHealth !== 'GREEN') return { action: 'NO_TRADE', score: 0, reason: 'SYSTEM_HEALTH_FAILED' };
  if (!(price > ema200 && ema20 > ema50 && ema50 > ema200 && ema20Slope > 0 && ema50Slope >= 0 && adx14 >= 22)) return { action: 'NO_TRADE', score: 0, reason: 'TREND_QUALITY_FAILED' };
  if (!Number.isFinite(atr) || atr <= 0) return { action: 'NO_TRADE', score: 0, reason: 'INVALID_ATR' };
  if (price > ema20 + 1.5 * atr) return { action: 'NO_TRADE', score: 0, reason: 'NO_CHASE' };
  const nearEma20 = Math.abs(price - ema20) <= 0.75 * atr;
  const nearEma50 = Math.abs(price - ema50) <= 0.5 * atr;
  if ((!nearEma20 && !nearEma50) || pullbackDepthPct < 0.5 || pullbackDepthPct > 4) return { action: 'NO_TRADE', score: 0, reason: 'PULLBACK_QUALITY_FAILED' };
  if (rsi14 < 45 || rsi14 > 70) return { action: 'NO_TRADE', score: 0, reason: 'RSI_FILTER_FAILED' };
  if (!Number.isFinite(volume20Avg) || volume20Avg <= 0 || volume < 0.8 * volume20Avg) return { action: 'NO_TRADE', score: 0, reason: 'VOLUME_FILTER_FAILED' };
  if (spreadBps > maxSpreadBps || estimatedSlippageBps > maxSlippageBps) return { action: 'NO_TRADE', score: 0, reason: 'EXECUTION_QUALITY_FAILED' };

  const candleRange = Math.max(0, candleHigh - candleLow);
  const upper40Threshold = candleLow + 0.6 * candleRange;
  const stabilized = candleClose > previousClose || candleClose >= upper40Threshold || price > ema20;
  const volumeOk = true;

  let score = 0;
  score += Math.min(25, 15 + Math.max(0, adx14 - 22));
  score += nearEma20 || nearEma50 ? 25 : 0;
  score += stabilized ? 20 : 0;
  score += volumeOk ? 10 : 0;
  score += confirmation4h === 'TREND_UP' ? 10 : 5;
  score += spreadBps <= maxSpreadBps && estimatedSlippageBps <= maxSlippageBps ? 10 : 0;

  const riskMultiplier = score >= 80 ? 1 : score >= 70 ? 0.75 : score >= 65 ? 0.5 : 0;
  if (riskMultiplier === 0) return { action: 'NO_TRADE', score, reason: 'SCORE_TOO_LOW', riskMultiplier };
  return { action: 'BUY_CANDIDATE', score, reason: 'SETUP_VALID', riskMultiplier };
}
