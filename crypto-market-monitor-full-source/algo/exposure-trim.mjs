import { estimateMarketFill } from './execution-costs.mjs';
import { evaluateExposureControl } from './risk-engine.mjs';

function clonePosition(position) {
  if (!position || !Number.isFinite(position.qty) || position.qty <= 0 || !Number.isFinite(position.totalCost) || position.totalCost < 0) {
    throw new Error('INVALID_POSITION');
  }
  return { ...position };
}

function entryMetadata(position) {
  return {
    entryRegime: position.entryRegime,
    entryRegimeConfidence: position.entryRegimeConfidence,
    structural1d: position.structural1d,
    confirmation4h: position.confirmation4h,
    entryAtrPct: position.entryAtrPct,
    entryAdx14: position.entryAdx14,
    entryRsi14: position.entryRsi14,
  };
}

export function applyHardExposureTrim({
  time,
  cash,
  position,
  referencePrice,
  entryAllocationCapPct = 25,
  hardExposureCapPct = 30,
  spreadBps = 0,
  slippageBps = 0,
  feeBps = 0,
} = {}) {
  if (!Number.isFinite(cash) || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new Error('INVALID_EXPOSURE_TRIM_STATE');
  }

  const nextPosition = clonePosition(position);
  const portfolioEquity = cash + nextPosition.qty * referencePrice;
  const positionValue = nextPosition.qty * referencePrice;
  const control = evaluateExposureControl({
    portfolioEquity,
    positionValue,
    entryAllocationCapPct,
    hardExposureCapPct,
  });

  if (control.decision === 'HALT') {
    throw new Error(control.reasonCode);
  }

  if (control.decision !== 'REDUCE') {
    const postExposurePct = portfolioEquity > 0 ? positionValue / portfolioEquity * 100 : Infinity;
    return {
      action: 'HOLD',
      cash,
      position: nextPosition,
      fill: null,
      trade: null,
      event: {
        time,
        decision: 'HOLD',
        reasonCode: control.reasonCode,
        exposurePctBefore: control.exposurePct,
        postExposurePct,
      },
      executionCost: 0,
      postEquity: portfolioEquity,
      postExposurePct,
    };
  }

  const hardCapFraction = hardExposureCapPct / 100;
  const unitSell = estimateMarketFill({
    side: 'SELL',
    referencePrice,
    qty: 1,
    spreadBps,
    slippageBps,
    feeBps,
  });
  const sellFrictionPerUnit = referencePrice - unitSell.cashDelta;
  const denominator = referencePrice - hardCapFraction * sellFrictionPerUnit;
  if (!Number.isFinite(denominator) || denominator <= 0) throw new Error('INVALID_TRIM_DENOMINATOR');

  const trimQty = Math.min(nextPosition.qty, Math.max(0, control.reduceNotional / denominator));
  if (!Number.isFinite(trimQty) || trimQty <= 0) throw new Error('INVALID_TRIM_QUANTITY');

  const qtyBefore = nextPosition.qty;
  const soldFraction = trimQty / qtyBefore;
  const proportionalCost = nextPosition.totalCost * soldFraction;
  const fill = estimateMarketFill({
    side: 'SELL',
    referencePrice,
    qty: trimQty,
    spreadBps,
    slippageBps,
    feeBps,
  });
  const executionCost = trimQty * (referencePrice - fill.price) + fill.fee;
  const nextCash = cash + fill.cashDelta;
  nextPosition.qty = qtyBefore - trimQty;
  nextPosition.totalCost -= proportionalCost;

  const postEquity = nextCash + nextPosition.qty * referencePrice;
  const postPositionValue = nextPosition.qty * referencePrice;
  const postExposurePct = postEquity > 0 ? postPositionValue / postEquity * 100 : Infinity;
  const pnl = fill.cashDelta - proportionalCost;

  const trade = {
    entryTime: nextPosition.entryTime,
    exitTime: time,
    entryPrice: nextPosition.entryPrice,
    exitPrice: fill.price,
    qty: trimQty,
    pnl,
    exitReason: 'HARD_EXPOSURE_TRIM',
    entryScore: nextPosition.entryScore,
    ...entryMetadata(nextPosition),
  };
  const event = {
    time,
    decision: 'REDUCE',
    reasonCode: control.reasonCode,
    exposurePctBefore: control.exposurePct,
    postExposurePct,
    trimQty,
    reduceNotional: trimQty * referencePrice,
  };

  return {
    action: 'REDUCE',
    cash: nextCash,
    position: nextPosition,
    fill,
    trade,
    event,
    executionCost,
    postEquity,
    postExposurePct,
  };
}
