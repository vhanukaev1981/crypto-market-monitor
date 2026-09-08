function invalidState() { throw new Error('INVALID_STATE'); }

function validatePersistedOrder(order) {
  if (!order || typeof order !== 'object' || !order.clientOrderId || !order.symbol || !['BUY', 'SELL'].includes(order.side) || order.type !== 'MARKET') invalidState();
  if (!Number.isFinite(order.qty) || order.qty <= 0 || !Number.isFinite(order.filledQty) || order.filledQty < 0 || order.filledQty > order.qty + 1e-12) invalidState();
  if (!Number.isFinite(order.averageFillPrice) || order.averageFillPrice < 0 || !['CREATED', 'PARTIALLY_FILLED', 'FILLED'].includes(order.status)) invalidState();
}

function validatePersistedFill(fill) {
  if (!fill || typeof fill !== 'object' || !fill.fillId || !fill.clientOrderId) invalidState();
  if (!Number.isFinite(fill.qty) || fill.qty <= 0 || !Number.isFinite(fill.price) || fill.price <= 0 || !Number.isFinite(fill.fee) || fill.fee < 0 || !Number.isFinite(fill.realizedPnlDelta)) invalidState();
  validatePersistedOrder(fill.order);
}

function validatePersistedPosition(entry) {
  if (!Array.isArray(entry) || entry.length !== 2 || !entry[0] || !entry[1] || typeof entry[1] !== 'object') invalidState();
  const [, position] = entry;
  if (!Number.isFinite(position.qty) || position.qty < 0 || !Number.isFinite(position.totalCost) || position.totalCost < 0) invalidState();
  if ((position.qty === 0) !== (position.totalCost === 0)) invalidState();
}

const closeEnough = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function reconcilePersistedAccounting(state) {
  const orders = new Map(state.orders.map((order) => [order.clientOrderId, order]));
  const orderProgress = new Map();
  const positions = new Map();
  let cash = state.startingCash;
  let realizedPnl = 0;

  for (const fill of state.fills) {
    const order = orders.get(fill.clientOrderId);
    if (!order) invalidState();
    if (
      fill.order.clientOrderId !== order.clientOrderId ||
      fill.order.symbol !== order.symbol ||
      fill.order.side !== order.side ||
      fill.order.type !== order.type ||
      !closeEnough(fill.order.qty, order.qty)
    ) invalidState();

    const progress = orderProgress.get(order.clientOrderId) ?? { filledQty: 0, weightedPrice: 0 };
    progress.filledQty += fill.qty;
    progress.weightedPrice += fill.price * fill.qty;
    if (progress.filledQty > order.qty + 1e-12) invalidState();
    const expectedAverage = progress.weightedPrice / progress.filledQty;
    const expectedStatus = closeEnough(progress.filledQty, order.qty) ? 'FILLED' : 'PARTIALLY_FILLED';
    if (
      !closeEnough(fill.order.filledQty, progress.filledQty) ||
      !closeEnough(fill.order.averageFillPrice, expectedAverage) ||
      fill.order.status !== expectedStatus
    ) invalidState();
    orderProgress.set(order.clientOrderId, progress);

    const notional = fill.price * fill.qty;
    const expectedFee = notional * state.takerFeeBps / 10000;
    if (!closeEnough(fill.fee, expectedFee)) invalidState();
    const position = positions.get(order.symbol) ?? { qty: 0, totalCost: 0 };
    let expectedRealizedDelta = 0;
    if (order.side === 'BUY') {
      cash -= notional + fill.fee;
      position.qty += fill.qty;
      position.totalCost += notional + fill.fee;
    } else {
      if (fill.qty > position.qty + 1e-12) invalidState();
      const averageCost = position.qty > 0 ? position.totalCost / position.qty : 0;
      const costRemoved = averageCost * fill.qty;
      const netProceeds = notional - fill.fee;
      cash += netProceeds;
      expectedRealizedDelta = netProceeds - costRemoved;
      realizedPnl += expectedRealizedDelta;
      position.qty -= fill.qty;
      position.totalCost -= costRemoved;
      if (Math.abs(position.qty) < 1e-12) {
        position.qty = 0;
        position.totalCost = 0;
      }
    }
    if (!closeEnough(fill.realizedPnlDelta, expectedRealizedDelta)) invalidState();
    positions.set(order.symbol, position);
  }

  for (const order of state.orders) {
    const progress = orderProgress.get(order.clientOrderId);
    const expectedFilled = progress?.filledQty ?? 0;
    const expectedAverage = progress ? progress.weightedPrice / progress.filledQty : 0;
    const expectedStatus = expectedFilled === 0 ? 'CREATED' : closeEnough(expectedFilled, order.qty) ? 'FILLED' : 'PARTIALLY_FILLED';
    if (
      !closeEnough(order.filledQty, expectedFilled) ||
      !closeEnough(order.averageFillPrice, expectedAverage) ||
      order.status !== expectedStatus
    ) invalidState();
  }

  if (!closeEnough(state.cash, cash) || !closeEnough(state.realizedPnl, realizedPnl)) invalidState();
  const persistedPositions = new Map(state.positions);
  if (persistedPositions.size !== positions.size) invalidState();
  for (const [symbol, expected] of positions) {
    const actual = persistedPositions.get(symbol);
    if (!actual || !closeEnough(actual.qty, expected.qty) || !closeEnough(actual.totalCost, expected.totalCost)) invalidState();
  }
}

export class PaperExecutionEngine {
  constructor({ startingCash, takerFeeBps = 0, slippageBps = 0 }) {
    if (!Number.isFinite(startingCash) || startingCash < 0) throw new Error('INVALID_STARTING_CASH');
    if (!Number.isFinite(takerFeeBps) || takerFeeBps < 0 || !Number.isFinite(slippageBps) || slippageBps < 0) throw new Error('INVALID_EXECUTION_COSTS');
    this.startingCash = startingCash;
    this.cash = startingCash;
    this.takerFeeBps = takerFeeBps;
    this.slippageBps = slippageBps;
    this.orders = new Map();
    this.fills = new Map();
    this.positions = new Map();
    this.realizedPnl = 0;
  }

  static fromState(state) {
    if (!state || state.version !== 1 || !Number.isFinite(state.startingCash) || state.startingCash < 0 || !Number.isFinite(state.cash) || state.cash < 0 || !Number.isFinite(state.takerFeeBps) || state.takerFeeBps < 0 || !Number.isFinite(state.slippageBps) || state.slippageBps < 0 || !Number.isFinite(state.realizedPnl)) invalidState();
    if (!Array.isArray(state.orders) || !Array.isArray(state.fills) || !Array.isArray(state.positions)) invalidState();

    const orderIds = new Set();
    for (const order of state.orders) {
      validatePersistedOrder(order);
      if (orderIds.has(order.clientOrderId)) invalidState();
      orderIds.add(order.clientOrderId);
    }
    const fillIds = new Set();
    for (const fill of state.fills) {
      validatePersistedFill(fill);
      if (fillIds.has(fill.fillId) || !orderIds.has(fill.clientOrderId) || fill.order.clientOrderId !== fill.clientOrderId) invalidState();
      fillIds.add(fill.fillId);
    }
    const positionSymbols = new Set();
    for (const entry of state.positions) {
      validatePersistedPosition(entry);
      if (positionSymbols.has(entry[0])) invalidState();
      positionSymbols.add(entry[0]);
    }
    reconcilePersistedAccounting(state);

    let engine;
    try {
      engine = new PaperExecutionEngine({ startingCash: state.startingCash, takerFeeBps: state.takerFeeBps, slippageBps: state.slippageBps });
    } catch {
      invalidState();
    }
    engine.realizedPnl = state.realizedPnl;
    engine.orders = new Map(state.orders.map((o) => [o.clientOrderId, structuredClone(o)]));
    engine.fills = new Map(state.fills.map((f) => [f.fillId, structuredClone(f)]));
    engine.positions = new Map(state.positions.map(([symbol, p]) => [symbol, structuredClone(p)]));
    return engine;
  }

  exportState() {
    return {
      version: 1,
      startingCash: this.startingCash,
      cash: this.cash,
      takerFeeBps: this.takerFeeBps,
      slippageBps: this.slippageBps,
      realizedPnl: this.realizedPnl,
      orders: [...this.orders.values()].map((o) => structuredClone(o)),
      fills: [...this.fills.values()].map((f) => structuredClone(f)),
      positions: [...this.positions.entries()].map(([symbol, p]) => [symbol, structuredClone(p)]),
    };
  }

  createOrder({ clientOrderId, symbol, side, qty, type = 'MARKET' }) {
    if (!clientOrderId || !symbol || !['BUY', 'SELL'].includes(side) || !Number.isFinite(qty) || qty <= 0) throw new Error('INVALID_ORDER');
    if (this.orders.has(clientOrderId)) return { order: structuredClone(this.orders.get(clientOrderId)), duplicate: true };
    const order = { clientOrderId, symbol, side, qty, type, filledQty: 0, averageFillPrice: 0, status: 'CREATED' };
    this.orders.set(clientOrderId, order);
    return { order: structuredClone(order), duplicate: false };
  }

  applyMarketFill({ fillId, clientOrderId, qty, bid, ask }) {
    if (!fillId) throw new Error('INVALID_FILL_ID');
    if (this.fills.has(fillId)) return { ...structuredClone(this.fills.get(fillId)), duplicate: true };
    const order = this.orders.get(clientOrderId);
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.type !== 'MARKET') throw new Error('ORDER_TYPE_NOT_MARKET');
    if (!Number.isFinite(qty) || qty <= 0 || order.filledQty + qty > order.qty + 1e-12) throw new Error('INVALID_FILL_QTY');
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) throw new Error('INVALID_MARKET');

    const slip = this.slippageBps / 10000;
    const price = order.side === 'BUY' ? ask * (1 + slip) : bid * (1 - slip);
    const notional = price * qty;
    const fee = notional * this.takerFeeBps / 10000;
    let realizedPnlDelta = 0;
    const current = this.positions.get(order.symbol) ?? { qty: 0, totalCost: 0 };

    if (order.side === 'BUY') {
      const totalDebit = notional + fee;
      if (totalDebit > this.cash + 1e-12) throw new Error('INSUFFICIENT_CASH');
      this.cash -= totalDebit;
      current.qty += qty;
      current.totalCost += totalDebit;
    } else {
      if (qty > current.qty + 1e-12) throw new Error('INSUFFICIENT_POSITION');
      const avgCost = current.qty > 0 ? current.totalCost / current.qty : 0;
      const costRemoved = avgCost * qty;
      const netProceeds = notional - fee;
      this.cash += netProceeds;
      realizedPnlDelta = netProceeds - costRemoved;
      this.realizedPnl += realizedPnlDelta;
      current.qty -= qty;
      current.totalCost -= costRemoved;
      if (Math.abs(current.qty) < 1e-12) { current.qty = 0; current.totalCost = 0; }
    }

    this.positions.set(order.symbol, current);
    const previousFilled = order.filledQty;
    order.filledQty += qty;
    order.averageFillPrice = ((order.averageFillPrice * previousFilled) + (price * qty)) / order.filledQty;
    order.status = Math.abs(order.filledQty - order.qty) < 1e-12 ? 'FILLED' : 'PARTIALLY_FILLED';
    const fill = { fillId, clientOrderId, qty, price, fee, realizedPnlDelta, order: structuredClone(order), duplicate: false };
    this.fills.set(fillId, fill);
    return structuredClone(fill);
  }

  snapshot() {
    const positions = {};
    for (const [symbol, p] of this.positions) positions[symbol] = { qty: p.qty, totalCost: p.totalCost, averageCost: p.qty > 0 ? p.totalCost / p.qty : 0 };
    return { cash: this.cash, realizedPnl: this.realizedPnl, positions, orderCount: this.orders.size, fillCount: this.fills.size };
  }
}
