export function detectRegime(input) {
  const {
    price,
    ema20,
    ema50,
    ema200,
    ema20Slope = 0,
    ema50Slope = 0,
    adx14 = 0,
    atrPct = 0,
    volatilityPercentile = 0,
  } = input;

  if (atrPct >= 5 || volatilityPercentile >= 95) {
    return { regime: 'HIGH_VOLATILITY', confidence: 100 };
  }

  let upScore = 0;
  if (price > ema200) upScore += 20;
  if (ema20 > ema50) upScore += 20;
  if (ema50 > ema200) upScore += 20;
  if (ema20Slope > 0) upScore += 15;
  if (ema50Slope >= 0) upScore += 10;
  if (adx14 >= 22) upScore += 15;

  if (upScore >= 70) {
    return { regime: 'TREND_UP', confidence: upScore };
  }

  let downScore = 0;
  if (price < ema200) downScore += 20;
  if (ema20 < ema50) downScore += 20;
  if (ema50 < ema200) downScore += 20;
  if (ema20Slope < 0) downScore += 15;
  if (ema50Slope <= 0) downScore += 10;
  if (adx14 >= 22) downScore += 15;

  if (downScore >= 70) {
    return { regime: 'TREND_DOWN', confidence: downScore };
  }

  if (adx14 < 18 && Math.abs(ema20Slope) < 0.2 && Math.abs(ema50Slope) < 0.2) {
    return { regime: 'RANGE', confidence: 70 };
  }

  return { regime: 'UNCERTAIN', confidence: Math.max(upScore, downScore) };
}
