import { createDurableCanaryDispatcher } from './durable-canary-dispatch.mjs';
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

  let reconciliationHealthy = true;

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

  const durable = mode==='CANARY' && config.executionStore && config.canaryBudgetStore &&
    config.executorFence && config.recoveryGate && Number.isSafeInteger(config.fenceToken)
    ? createDurableCanaryDispatcher({executionStore:config.executionStore,
        canaryBudgetStore:config.canaryBudgetStore,executorFence:config.executorFence,
        recoveryGate:config.recoveryGate,transport:getTransport(),fenceToken:config.fenceToken})
    : null;

  const adapter = {
    mode,

    getCumulativeExposure() {
      return null; // No RAM-backed exposure authority. Use PostgreSQL budget store.
    },

    isReconciliationHealthy() {
      return reconciliationHealthy && (durable ? durable.isHealthy() : true);
    },

    resetReconciliationStatus(status = true) {
      if(status===true)throw Error('RECOVERY_REQUIRED: health cannot be reset manually');
      reconciliationHealthy = false;
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
      if(mode!=='CANARY')throw Error('Order submission blocked in READ_ONLY mode');
      requireCredentials();
      if(request.humanApproved!==true)throw Error('Explicit human approval required');
      if(!reconciliationHealthy)throw Error('RECONCILIATION_UNHEALTHY: execution is locked');
      const marketType=String(request.marketType??request.category??'').toUpperCase();
      if(marketType!=='SPOT')throw Error('SPOT_ONLY_REQUIRED: Market type must be SPOT');
      if((request.leverage??1)!==1)throw Error('LEVERAGE_MUST_BE_1');
      const notionalUsdt=request.notionalUsdt??request.requestedNotionalUsd??request.approvedNotionalUsd;
      if(!Number.isFinite(notionalUsdt)||notionalUsdt<=0)throw Error('INVALID_NOTIONAL');
      if(notionalUsdt>MAX_ORDER_NOTIONAL_USDT)throw Error('MAX_ORDER_NOTIONAL_EXCEEDED: 10 USDT');
      const policy=evaluateLiveCanaryOrder({enabled:true,qualification:request.qualification,
        marketType:'SPOT',leverage:1,requestedNotionalUsd:notionalUsdt,
        committedNotionalUsd:0});
      if(!policy.allowed)throw Error('CANARY_POLICY_BLOCKED: '+policy.reasonCode);
      if(String(request.symbol??'').toUpperCase()!=='BTCUSDT' ||
        !['BUY','SELL'].includes(String(request.side??'').toUpperCase()) ||
        (request.orderType!==undefined&&request.orderType!=='Market')){
        throw Error('BTCUSDT_SPOT_MARKET_ONLY');
      }
      // No alternate legacy path: missing persistence always denies POST.
      if(!durable)throw Error('DURABLE_EXECUTION_REQUIRED: P0 recovery and stores missing');
      const permission=await adapter.validateApiPermissions();
      if(!permission.spotEnabled||permission.readOnly){
        throw Error('SPOT_PERMISSION_REQUIRED');
      }
      try{
        return await durable.submit({
          orderLinkId:request.orderLinkId,symbol:'BTCUSDT',
          side:String(request.side).toUpperCase(),notionalUsdt
        });
      }catch(error){
        // A local lock is strictly an additional defense; the dispatcher
        // persists any post-dispatch ambiguity through the execution store.
        if(String(error?.message).includes('CANARY_UNKNOWN_LOCKED'))reconciliationHealthy=false;
        throw error;
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


