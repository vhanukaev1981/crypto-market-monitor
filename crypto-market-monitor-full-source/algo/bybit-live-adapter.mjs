import { createBybitV5ReadOnlyTransport } from './bybit-v5-readonly-transport.mjs';
import { evaluateLiveCanaryOrder } from './live-canary-policy.mjs';
import { evaluateLiveReadiness } from './live-readiness.mjs';
import { evaluateRisk } from './risk-engine.mjs';

const MODES = new Set(['READ_ONLY', 'CANARY']);
const MAX_ORDER_NOTIONAL_USDT = 10;
const MAX_CUMULATIVE_EXPOSURE_USDT = 100;

function generateUniqueOrderLinkId() {
  return `canary_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createBybitLiveAdapter(config = {}) {
  const mode = config.mode ?? 'READ_ONLY';
  if (mode === 'LIVE') throw new Error('LIVE mode is disabled');
  if (!MODES.has(mode)) throw new Error(`Unsupported Bybit adapter mode: ${mode}`);

  let cumulativeCommittedNotionalUsdt = 0;
  let reconciliationHealthy = true;
  const executedOrders = new Map();
  const inFlightOrders = new Set();

  const requireCredentials = () => {
    if (!config.apiKey || !config.apiSecret) throw new Error('Bybit credentials are required');
  };

  const getTransport = () => {
    if (config.transport?.request || config.transport?.placeOrder) return config.transport;
    if (config.apiKey && config.apiSecret) {
      return createBybitV5ReadOnlyTransport({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        baseUrl: config.baseUrl,
        fetchImpl: config.fetchImpl,
        now: config.now
      });
    }
    throw new Error('Bybit transport unavailable');
  };

  const adapter = {
    mode,

    getCumulativeExposure() {
      return cumulativeCommittedNotionalUsdt;
    },

    isReconciliationHealthy() {
      return reconciliationHealthy;
    },

    resetReconciliationStatus(status = true) {
      reconciliationHealthy = Boolean(status);
    },

    async validateApiPermissions() {
      requireCredentials();
      const transport = getTransport();
      const response = await transport.request({ operation: 'queryApiPermissions' });
      if (!response || response.retCode !== 0 || !response.result?.permissions) {
        throw new Error(`PERMISSIONS_UNESTABLISHED: ${response?.retMsg || 'Invalid permissions payload'}`);
      }

      const result = response.result;
      const permissions = result.permissions;
      const walletPermissions = Array.isArray(permissions.Wallet) ? permissions.Wallet : [];
      const hasWithdrawal = walletPermissions.some(p => String(p).toLowerCase().includes('withdraw')) ||
                            Boolean(permissions.Withdraw) ||
                            Object.keys(permissions).some(k => k.toLowerCase().includes('withdraw'));
      if (hasWithdrawal) {
        throw new Error('WITHDRAWAL_PERMISSION_DETECTED: Bybit API key must NOT have withdrawal permissions');
      }

      const spotPermissions = Array.isArray(permissions.Spot) ? permissions.Spot : [];
      const spotEnabled = spotPermissions.includes('SpotTrade') || spotPermissions.length > 0;
      const readOnly = result.readOnly === 1;

      return Object.freeze({
        valid: true,
        permissionsEstablished: true,
        withdrawalDisabled: true,
        spotEnabled,
        readOnly,
        permissions: Object.freeze({
          Spot: Object.freeze([...spotPermissions]),
          Wallet: Object.freeze([...walletPermissions])
        })
      });
    },

    async getAccountSnapshot() {
      requireCredentials();
      const transport = getTransport();
      const raw = await transport.request({ operation: 'accountSnapshot' });
      if (!raw || raw.retCode !== 0) {
        throw new Error(`Bybit API failure: ${raw?.retCode ?? 'unknown'} - ${raw?.retMsg ?? 'unknown'}`);
      }

      const list = raw?.result?.list;
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error('Malformed Bybit account snapshot: empty account list');
      }

      const account = list[0];
      const coinList = Array.isArray(account.coin)
        ? account.coin.map(c => Object.freeze({
            coin: String(c.coin || ''),
            walletBalance: Number(c.walletBalance || 0),
            availableBalance: Number(c.availableToWithdraw ?? c.walletBalance ?? 0),
          }))
        : [];

      return Object.freeze({
        retCode: 0,
        accountType: account.accountType,
        totalEquity: Number(account.totalEquity || 0),
        totalWalletBalance: Number(account.totalWalletBalance || 0),
        totalAvailableBalance: Number(account.totalAvailableBalance || 0),
        coins: Object.freeze(coinList),
        coin: Object.freeze(coinList),
        result: Object.freeze({ list: Object.freeze([account]) })
      });
    },

    async submitCanaryOrder(request = {}) {
      if (mode !== 'CANARY') throw new Error('Order submission blocked in READ_ONLY mode');
      requireCredentials();

      if (request.humanApproved !== true) {
        throw new Error('Explicit human approval required');
      }

      if (!reconciliationHealthy) {
        throw new Error('RECONCILIATION_UNHEALTHY: System locked due to previous reconciliation failure');
      }

      const marketType = String(request.marketType || request.category || '').toUpperCase();
      if (marketType !== 'SPOT') {
        throw new Error('SPOT_ONLY_REQUIRED: Market type must be SPOT');
      }

      const leverage = request.leverage ?? 1;
      if (leverage !== 1) {
        throw new Error('LEVERAGE_MUST_BE_1: Leverage must equal 1');
      }

      const notionalUsdt = request.notionalUsdt ?? request.requestedNotionalUsd ?? request.approvedNotionalUsd;
      if (!Number.isFinite(notionalUsdt) || notionalUsdt <= 0) {
        throw new Error('INVALID_NOTIONAL: Order notional must be a positive finite number');
      }

      if (notionalUsdt > MAX_ORDER_NOTIONAL_USDT) {
        throw new Error(`MAX_ORDER_NOTIONAL_EXCEEDED: Requested notional ${notionalUsdt} USDT exceeds ${MAX_ORDER_NOTIONAL_USDT} USDT limit`);
      }

      if (cumulativeCommittedNotionalUsdt + notionalUsdt > MAX_CUMULATIVE_EXPOSURE_USDT) {
        throw new Error(`LIVE_CANARY_BUDGET_EXCEEDED: Cumulative exposure would reach ${cumulativeCommittedNotionalUsdt + notionalUsdt} USDT, exceeding ${MAX_CUMULATIVE_EXPOSURE_USDT} USDT cap`);
      }

      // Live canary policy verification
      const canaryPolicy = evaluateLiveCanaryOrder({
        enabled: true,
        qualification: request.qualification,
        marketType: 'SPOT',
        leverage: 1,
        requestedNotionalUsd: notionalUsdt,
        committedNotionalUsd: cumulativeCommittedNotionalUsdt
      });
      if (!canaryPolicy.allowed) {
        throw new Error(`CANARY_POLICY_BLOCKED: ${canaryPolicy.reasonCode}`);
      }

      // API permission verification
      const permReport = await adapter.validateApiPermissions();
      if (!permReport.spotEnabled) {
        throw new Error('SPOT_PERMISSION_REQUIRED: Bybit API key must have Spot trading permission');
      }

      const orderLinkId = String(request.orderLinkId || generateUniqueOrderLinkId());
      const symbol = String(request.symbol || 'BTCUSDT').toUpperCase();
      const rawSide = String(request.side || 'BUY').toUpperCase();
      const side = rawSide === 'BUY' ? 'Buy' : 'Sell';

      // Idempotency & duplicate check
      if (executedOrders.has(orderLinkId)) {
        const existing = executedOrders.get(orderLinkId);
        if (existing.symbol !== symbol || existing.side !== side || Math.abs(existing.notionalUsdt - notionalUsdt) > 1e-6) {
          throw new Error(`IDEMPOTENCY_CONFLICT: orderLinkId ${orderLinkId} already executed with different parameters`);
        }
        return Object.freeze({
          success: true,
          duplicate: true,
          reasonCode: 'EXECUTION_DUPLICATE_ORDER',
          orderLinkId,
          symbol,
          side,
          notionalUsdt,
          cumulativeExposureUsdt: cumulativeCommittedNotionalUsdt,
          order: existing.order
        });
      }

      if (inFlightOrders.has(orderLinkId)) {
        throw new Error(`IDEMPOTENCY_CONFLICT: orderLinkId ${orderLinkId} is currently in flight`);
      }

      inFlightOrders.add(orderLinkId);

      let orderResponse;
      const transport = getTransport();
      const orderPayload = {
        category: 'spot',
        symbol,
        side,
        orderType: request.orderType || 'Market',
        qty: String(notionalUsdt),
        marketUnit: 'quoteCoin',
        orderLinkId
      };

      try {
        if (typeof transport.placeOrder === 'function') {
          orderResponse = await transport.placeOrder(orderPayload);
        } else if (typeof transport.request === 'function') {
          orderResponse = await transport.request({ operation: 'placeOrder', ...orderPayload });
        } else {
          throw new Error('Bybit transport unavailable for order placement');
        }

        if (!orderResponse || (orderResponse.retCode !== undefined && orderResponse.retCode !== 0)) {
          throw new Error(`BYBIT_ORDER_FAILED: ${orderResponse?.retCode ?? 'unknown'} - ${orderResponse?.retMsg || 'Order placement rejected'}`);
        }
      } catch (error) {
        inFlightOrders.delete(orderLinkId);
        throw error;
      }

      // Post-order reconciliation
      let reconciled;
      try {
        if (typeof transport.reconcileOrder === 'function') {
          reconciled = await transport.reconcileOrder({ orderLinkId, symbol });
        } else if (typeof transport.request === 'function') {
          reconciled = await transport.request({ operation: 'reconcileOrder', orderLinkId, symbol });
        } else {
          reconciled = { retCode: 0, result: { orderStatus: 'Filled', orderLinkId } };
        }

        const recResult = reconciled?.result || reconciled;
        const status = recResult?.orderStatus || recResult?.status;
        const failedStatuses = new Set(['Rejected', 'Cancelled', 'Deactivated', 'Failed']);

        if (!reconciled || (reconciled.retCode !== undefined && reconciled.retCode !== 0) || !status || failedStatuses.has(status)) {
          reconciliationHealthy = false;
          throw new Error(`RECONCILIATION_FAILED: Order status '${status || 'UNKNOWN'}' rejected or unconfirmed: ${recResult?.rejectReason || reconciled?.retMsg || 'No detail'}`);
        }

        cumulativeCommittedNotionalUsdt += notionalUsdt;
        executedOrders.set(orderLinkId, Object.freeze({
          symbol,
          side,
          notionalUsdt,
          order: recResult
        }));

        inFlightOrders.delete(orderLinkId);

        return Object.freeze({
          success: true,
          duplicate: false,
          reasonCode: 'EXECUTION_FILLED',
          orderLinkId,
          symbol,
          side,
          notionalUsdt,
          cumulativeExposureUsdt: cumulativeCommittedNotionalUsdt,
          order: recResult
        });
      } catch (reconError) {
        reconciliationHealthy = false;
        inFlightOrders.delete(orderLinkId);
        throw reconError;
      }
    }
  };

  return Object.freeze(adapter);
}

/**
 * End-to-end Canary Trade Execution Pipeline
 * Strategy -> Risk Engine -> Qualification -> Live Readiness -> Canary Policy -> Bybit Adapter -> Order -> Reconciliation
 */
export async function executeCanaryTradeCycle({
  adapter,
  strategySignal,
  riskContext = {},
  qualification = { status: 'PASS', fresh: true },
  readinessInput = {},
  humanApproved = true,
} = {}) {
  if (!adapter) throw new Error('Adapter required for trade cycle');
  if (!strategySignal?.symbol || !strategySignal?.side) throw new Error('Valid strategy signal required');

  const symbol = String(strategySignal.symbol).toUpperCase();
  const side = String(strategySignal.side).toUpperCase();
  const requestedNotional = Number(strategySignal.requestedNotional || strategySignal.notionalUsdt || 10);

  // 1. Risk Engine Evaluation
  const riskResult = evaluateRisk({
    portfolioEquity: riskContext.portfolioEquity ?? 1000,
    dailyPnlPct: riskContext.dailyPnlPct ?? 0,
    drawdownPct: riskContext.drawdownPct ?? 0,
    volatilityLevel: riskContext.volatilityLevel ?? 'normal',
    currentSymbolExposurePct: riskContext.currentSymbolExposurePct ?? 0,
    maxSymbolExposurePct: riskContext.maxSymbolExposurePct ?? 40,
    requestedNotional,
    spreadBps: riskContext.spreadBps ?? 5,
    maxSpreadBps: riskContext.maxSpreadBps ?? 50,
    estimatedSlippageBps: riskContext.estimatedSlippageBps ?? 5,
    maxSlippageBps: riskContext.maxSlippageBps ?? 30,
  });

  if (riskResult.decision !== 'APPROVED' && riskResult.decision !== 'REDUCED_SIZE') {
    return Object.freeze({
      executed: false,
      stage: 'RISK_ENGINE',
      reasonCode: riskResult.reasonCode,
      riskResult
    });
  }

  const approvedNotional = Math.min(riskResult.approvedNotional, MAX_ORDER_NOTIONAL_USDT);

  // 2. Qualification Gate
  if (qualification?.status !== 'PASS' || qualification.fresh !== true) {
    return Object.freeze({
      executed: false,
      stage: 'QUALIFICATION',
      reasonCode: 'QUALIFICATION_REQUIRED',
      qualification
    });
  }

  // 3. Live Readiness Evaluation
  const readinessResult = evaluateLiveReadiness({
    dataFresh: readinessInput.dataFresh ?? true,
    riskEngineHealthy: readinessInput.riskEngineHealthy ?? true,
    executionEngineHealthy: readinessInput.executionEngineHealthy ?? true,
    reconciliationHealthy: adapter.isReconciliationHealthy() && (readinessInput.reconciliationHealthy ?? true),
    oosLockActive: readinessInput.oosLockActive ?? true,
    leverageEnabled: false,
    marketType: 'SPOT',
    canaryBudgetUsd: 100,
    maxOrderNotionalUsd: approvedNotional,
    humanApproval: humanApproved,
    withdrawalPermission: false,
    ...readinessInput
  });

  if (readinessResult.status !== 'PASS') {
    return Object.freeze({
      executed: false,
      stage: 'LIVE_READINESS',
      reasonCode: readinessResult.blockers[0] || 'LIVE_READINESS_BLOCKED',
      blockers: readinessResult.blockers
    });
  }

  // 4. Canary Order Execution via Adapter (includes Canary Policy, Idempotency, Order, Reconciliation)
  const orderResult = await adapter.submitCanaryOrder({
    humanApproved,
    marketType: 'SPOT',
    leverage: 1,
    symbol,
    side,
    notionalUsdt: approvedNotional,
    orderLinkId: strategySignal.orderLinkId,
    qualification
  });

  return Object.freeze({
    executed: true,
    stage: 'COMPLETE',
    orderResult,
    riskResult,
    readinessResult
  });
}


