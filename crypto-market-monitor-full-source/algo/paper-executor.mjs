export class PaperExecutionEngine {
  constructor({ startingCash, takerFeeBps = 0, slippageBps = 0 }) {
    if (!Number.isFinite(startingCash) || startingCash < 0) throw new Error('INVALID_STARTING_CASH');
    if (!Number.isFinite(takerFeeBps) || takerFeeBps < 0 || !Number.isFinite(slippageBps) || slippageBps < 0) throw new Error('INVALID_EXECUTION_COSTS');
    this.cash = startingCash;
    this.takerFeeBps = takerFeeBps;
    this.slippageBps = slippageBps;
    this.orders = new Map();
    this.fills = new Map();
    this.positions = new Map();
    this.realizedPnl = 0;
  }

  static fromState(state) {
    if (!state || state.version !== 1) throw new Error('INVALID_STATE');
    const engine = new PaperExecutionEngine({ startingCash: state.cash, takerFeeBps: state.takerFeeBps, slippageBps: state.slippageBps });
    engine.realizedPnl = state.realizedPnl;
    engine.orders = new Map(state.orders.map((o) => [o.clientOrderId, structuredClone(o)]));
    engine.fills = new Map(state.fills.map((f) => [f.fillId, structuredClone(f)]));
    engine.positions = new Map(state.positions.map(([symbol, p]) => [symbol, structuredClone(p)]));
    return engine;
  }

  exportState() {
    return {
      version: 1,
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
