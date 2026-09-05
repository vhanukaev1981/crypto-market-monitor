import test from 'node:test';
import assert from 'node:assert/strict';
import { createBybitLiveAdapter } from '../algo/bybit-live-adapter.mjs';

test('defaults to READ_ONLY and rejects canary writes', async () => {
  let writes = 0;
  const adapter = createBybitLiveAdapter({ transport: { request: async () => ({ ok: true }), placeOrder: async () => { writes += 1; } } });
  assert.equal(adapter.mode, 'READ_ONLY');
  await assert.rejects(() => adapter.submitCanaryOrder({ symbol: 'BTCUSDT', notionalUsdt: 5 }), /READ_ONLY/);
  assert.equal(writes, 0);
});

test('rejects unsupported LIVE mode', () => {
  assert.throws(() => createBybitLiveAdapter({ mode: 'LIVE' }), /LIVE.*disabled/);
});

test('read-only authenticated snapshot fails closed when credentials are missing', async () => {
  const adapter = createBybitLiveAdapter({ mode: 'READ_ONLY', transport: { request: async () => ({}) } });
  await assert.rejects(() => adapter.getAccountSnapshot(), /credentials/i);
});

test('CANARY cannot reach order transport without explicit approval', async () => {
  let writes = 0;
  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'key', apiSecret: 'secret',
    transport: { placeOrder: async () => { writes += 1; return { ok: true }; } }
  });
  await assert.rejects(() => adapter.submitCanaryOrder({ symbol: 'BTCUSDT', category: 'spot', leverage: 1, notionalUsdt: 5 }), /approval/i);
  assert.equal(writes, 0);
});

test('validateApiPermissions approves read-only/spot keys with NO withdrawal permission and redacts secrets', async () => {
  const secret = 'super-secret-key-12345';
  const adapter = createBybitLiveAdapter({
    mode: 'READ_ONLY', apiKey: 'test-api-key', apiSecret: secret,
    transport: {
      request: async ({ operation }) => {
        if (operation === 'queryApiPermissions') {
          return {
            retCode: 0, retMsg: 'OK',
            result: {
              readOnly: 0,
              permissions: {
                Spot: ['SpotTrade'],
                Wallet: ['AccountTransfer'],
                ContractTrade: []
              },
              ips: ['192.168.1.1']
            }
          };
        }
        throw new Error('Unexpected operation');
      }
    }
  });

  const result = await adapter.validateApiPermissions();
  assert.equal(result.valid, true);
  assert.equal(result.withdrawalDisabled, true);
  assert.equal(result.permissionsEstablished, true);
  assert.equal(result.spotEnabled, true);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('validateApiPermissions rejects fail-closed when withdrawal permission is present', async () => {
  const adapter = createBybitLiveAdapter({
    mode: 'READ_ONLY', apiKey: 'test-api-key', apiSecret: 'secret',
    transport: {
      request: async ({ operation }) => {
        if (operation === 'queryApiPermissions') {
          return {
            retCode: 0, retMsg: 'OK',
            result: {
              permissions: {
                Spot: ['SpotTrade'],
                Wallet: ['AccountTransfer', 'Withdraw']
              }
            }
          };
        }
        throw new Error('Unexpected operation');
      }
    }
  });

  await assert.rejects(
    () => adapter.validateApiPermissions(),
    /WITHDRAWAL_PERMISSION_DETECTED/i
  );
});

test('validateApiPermissions rejects fail-closed when permissions cannot be established', async () => {
  for (const mockResponse of [
    { retCode: 10003, retMsg: 'API key is invalid' },
    { retCode: 0, result: null },
    { retCode: 0, result: { permissions: null } },
  ]) {
    const adapter = createBybitLiveAdapter({
      mode: 'READ_ONLY', apiKey: 'test-api-key', apiSecret: 'secret',
      transport: {
        request: async () => mockResponse
      }
    });

    await assert.rejects(
      () => adapter.validateApiPermissions(),
      /PERMISSIONS_UNESTABLISHED|Bybit API failure/i
    );
  }
});

test('getAccountSnapshot returns normalized, redacted account data', async () => {
  const secret = 'ultra-secret-value-999';
  const adapter = createBybitLiveAdapter({
    mode: 'READ_ONLY', apiKey: 'test-api-key', apiSecret: secret,
    transport: {
      request: async ({ operation }) => {
        if (operation === 'accountSnapshot') {
          return {
            retCode: 0, retMsg: 'OK',
            result: {
              list: [{
                accountType: 'UNIFIED',
                totalEquity: '123.45',
                totalWalletBalance: '120.00',
                totalAvailableBalance: '100.00',
                coin: [{ coin: 'USDT', walletBalance: '100.00', availableToWithdraw: '0.00' }]
              }]
            }
          };
        }
        throw new Error('Unexpected operation');
      }
    }
  });

  const snapshot = await adapter.getAccountSnapshot();
  assert.equal(snapshot.accountType, 'UNIFIED');
  assert.equal(snapshot.totalEquity, 123.45);
  assert.equal(snapshot.totalAvailableBalance, 100);
  assert.equal(snapshot.coins.length, 1);
  assert.equal(snapshot.coins[0].coin, 'USDT');
  assert.ok(!JSON.stringify(snapshot).includes(secret));
});

test('submitCanaryOrder enforces SPOT only and leverage 1', async () => {
  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'k', apiSecret: 's',
    transport: { placeOrder: async () => ({ orderId: '1' }), request: async () => ({ retCode: 0, result: { permissions: { Spot: ['SpotTrade'] } } }) }
  });

  await assert.rejects(
    () => adapter.submitCanaryOrder({ humanApproved: true, marketType: 'FUTURES', leverage: 1, notionalUsdt: 5, qualification: { status: 'PASS', fresh: true } }),
    /SPOT_ONLY_REQUIRED|SPOT.*only/i
  );

  await assert.rejects(
    () => adapter.submitCanaryOrder({ humanApproved: true, marketType: 'SPOT', leverage: 2, notionalUsdt: 5, qualification: { status: 'PASS', fresh: true } }),
    /LEVERAGE/i
  );
});

test('submitCanaryOrder enforces <= 10 USDT per order', async () => {
  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'k', apiSecret: 's',
    transport: { placeOrder: async () => ({ orderId: '1' }), request: async () => ({ retCode: 0, result: { permissions: { Spot: ['SpotTrade'] } } }) }
  });

  const baseOrder = { humanApproved: true, marketType: 'SPOT', leverage: 1, symbol: 'BTCUSDT', side: 'BUY', qualification: { status: 'PASS', fresh: true } };

  await assert.rejects(
    () => adapter.submitCanaryOrder({ ...baseOrder, notionalUsdt: 10.01 }),
    /MAX_ORDER_NOTIONAL_EXCEEDED|10 USDT/i
  );

  await assert.rejects(
    () => adapter.submitCanaryOrder({ ...baseOrder, notionalUsdt: 0 }),
    /INVALID_NOTIONAL/i
  );

  await assert.rejects(
    () => adapter.submitCanaryOrder({ ...baseOrder, notionalUsdt: -5 }),
    /INVALID_NOTIONAL/i
  );

  await assert.rejects(
    () => adapter.submitCanaryOrder({ ...baseOrder, notionalUsdt: NaN }),
    /INVALID_NOTIONAL/i
  );
});

test('submitCanaryOrder enforces <= 100 USDT cumulative exposure', async () => {
  let placedOrders = 0;
  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'k', apiSecret: 's',
    transport: {
      request: async ({ operation }) => {
        if (operation === 'queryApiPermissions') return { retCode: 0, result: { permissions: { Spot: ['SpotTrade'] } } };
        if (operation === 'reconcileOrder') return { retCode: 0, result: { orderStatus: 'Filled', orderLinkId: 'test' } };
        return { retCode: 0, result: {} };
      },
      placeOrder: async () => { placedOrders += 1; return { retCode: 0, result: { orderId: `ord_${placedOrders}` } }; }
    }
  });

  const baseOrder = { humanApproved: true, marketType: 'SPOT', leverage: 1, symbol: 'BTCUSDT', side: 'BUY', qualification: { status: 'PASS', fresh: true } };

  // Place 10 orders of 10 USDT = 100 USDT
  for (let i = 1; i <= 10; i++) {
    const res = await adapter.submitCanaryOrder({ ...baseOrder, orderLinkId: `link_${i}`, notionalUsdt: 10 });
    assert.equal(res.success, true);
    assert.equal(adapter.getCumulativeExposure(), i * 10);
  }

  // 11th order must fail closed
  await assert.rejects(
    () => adapter.submitCanaryOrder({ ...baseOrder, orderLinkId: 'link_11', notionalUsdt: 1 }),
    /LIVE_CANARY_BUDGET_EXCEEDED|100 USDT/i
  );
  assert.equal(placedOrders, 10);
});

test('submitCanaryOrder requires fresh PASS qualification', async () => {
  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'k', apiSecret: 's',
    transport: { placeOrder: async () => ({ orderId: '1' }), request: async () => ({ retCode: 0, result: { permissions: { Spot: ['SpotTrade'] } } }) }
  });

  const baseOrder = { humanApproved: true, marketType: 'SPOT', leverage: 1, symbol: 'BTCUSDT', side: 'BUY', notionalUsdt: 5 };

  for (const qualification of [undefined, null, { status: 'FAIL', fresh: true }, { status: 'PASS', fresh: false }]) {
    await assert.rejects(
      () => adapter.submitCanaryOrder({ ...baseOrder, qualification }),
      /QUALIFICATION_REQUIRED/i
    );
  }
});

test('submitCanaryOrder handles idempotency and prevents duplicate orders', async () => {
  let transportCalls = 0;
  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'k', apiSecret: 's',
    transport: {
      request: async ({ operation }) => {
        if (operation === 'queryApiPermissions') return { retCode: 0, result: { permissions: { Spot: ['SpotTrade'] } } };
        if (operation === 'reconcileOrder') return { retCode: 0, result: { orderStatus: 'Filled', orderLinkId: 'idem_1' } };
        return { retCode: 0, result: {} };
      },
      placeOrder: async () => { transportCalls += 1; return { retCode: 0, result: { orderId: 'ord_idem_1' } }; }
    }
  });

  const orderReq = {
    humanApproved: true, marketType: 'SPOT', leverage: 1,
    symbol: 'BTCUSDT', side: 'BUY', notionalUsdt: 8,
    orderLinkId: 'idem_1',
    qualification: { status: 'PASS', fresh: true }
  };

  // First call
  const first = await adapter.submitCanaryOrder(orderReq);
  assert.equal(first.success, true);
  assert.equal(first.duplicate, false);
  assert.equal(transportCalls, 1);

  // Second call with same orderLinkId and same details: idempotent duplicate return, no new transport call
  const second = await adapter.submitCanaryOrder(orderReq);
  assert.equal(second.success, true);
  assert.equal(second.duplicate, true);
  assert.equal(transportCalls, 1);

  // Third call with same orderLinkId but conflicting params: IDEMPOTENCY_CONFLICT
  await assert.rejects(
    () => adapter.submitCanaryOrder({ ...orderReq, notionalUsdt: 9 }),
    /IDEMPOTENCY_CONFLICT/i
  );
  assert.equal(transportCalls, 1);
});

test('submitCanaryOrder fails closed when Bybit order placement fails', async () => {
  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'k', apiSecret: 's',
    transport: {
      request: async ({ operation }) => {
        if (operation === 'queryApiPermissions') return { retCode: 0, result: { permissions: { Spot: ['SpotTrade'] } } };
        return { retCode: 0, result: {} };
      },
      placeOrder: async () => {
        return { retCode: 170140, retMsg: 'Order price is out of allowed range' };
      }
    }
  });

  await assert.rejects(
    () => adapter.submitCanaryOrder({
      humanApproved: true, marketType: 'SPOT', leverage: 1,
      symbol: 'BTCUSDT', side: 'BUY', notionalUsdt: 5,
      qualification: { status: 'PASS', fresh: true }
    }),
    /BYBIT_ORDER_FAILED|170140/i
  );
  assert.equal(adapter.getCumulativeExposure(), 0);
});

test('submitCanaryOrder fails closed when post-order reconciliation fails', async () => {
  let placed = false;
  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'k', apiSecret: 's',
    transport: {
      request: async ({ operation }) => {
        if (operation === 'queryApiPermissions') return { retCode: 0, result: { permissions: { Spot: ['SpotTrade'] } } };
        if (operation === 'reconcileOrder') {
          // Reconciliation fails (e.g. order not found on exchange or rejected)
          return { retCode: 0, result: { orderStatus: 'Rejected', rejectReason: 'Balance insufficient' } };
        }
        return { retCode: 0, result: {} };
      },
      placeOrder: async () => { placed = true; return { retCode: 0, result: { orderId: 'ord_recon_fail' } }; }
    }
  });

  await assert.rejects(
    () => adapter.submitCanaryOrder({
      humanApproved: true, marketType: 'SPOT', leverage: 1,
      symbol: 'BTCUSDT', side: 'BUY', notionalUsdt: 5,
      qualification: { status: 'PASS', fresh: true }
    }),
    /RECONCILIATION_FAILED/i
  );
  assert.equal(placed, true);
  // Adapter locks further orders on reconciliation failure
  assert.equal(adapter.isReconciliationHealthy(), false);
});

test('executeCanaryTradeCycle executes full pipeline: Strategy -> Risk -> Qual -> Readiness -> Canary -> Order -> Reconcile', async () => {
  const { executeCanaryTradeCycle } = await import('../algo/bybit-live-adapter.mjs');
  let orderPlaced = false;

  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'k', apiSecret: 's',
    transport: {
      request: async ({ operation }) => {
        if (operation === 'queryApiPermissions') return { retCode: 0, result: { permissions: { Spot: ['SpotTrade'] } } };
        if (operation === 'reconcileOrder') return { retCode: 0, result: { orderStatus: 'Filled', orderLinkId: 'cycle_1' } };
        return { retCode: 0, result: {} };
      },
      placeOrder: async () => { orderPlaced = true; return { retCode: 0, result: { orderId: 'ord_cycle_1' } }; }
    }
  });

  const signal = { symbol: 'BTCUSDT', side: 'BUY', requestedNotional: 10, orderLinkId: 'cycle_1' };
  const cycleResult = await executeCanaryTradeCycle({
    adapter,
    strategySignal: signal,
    riskContext: { portfolioEquity: 1000, drawdownPct: 1, dailyPnlPct: 0.5 },
    qualification: { status: 'PASS', fresh: true },
    readinessInput: { dataFresh: true, oosLockActive: true }
  });

  assert.equal(cycleResult.executed, true);
  assert.equal(cycleResult.stage, 'COMPLETE');
  assert.equal(cycleResult.orderResult.success, true);
  assert.equal(cycleResult.orderResult.orderLinkId, 'cycle_1');
  assert.equal(orderPlaced, true);
});

test('executeCanaryTradeCycle fails closed at each upstream gate', async () => {
  const { executeCanaryTradeCycle } = await import('../algo/bybit-live-adapter.mjs');
  let orderPlaced = false;

  const adapter = createBybitLiveAdapter({
    mode: 'CANARY', apiKey: 'k', apiSecret: 's',
    transport: {
      request: async () => ({ retCode: 0, result: { permissions: { Spot: ['SpotTrade'] } } }),
      placeOrder: async () => { orderPlaced = true; return { retCode: 0 }; }
    }
  });

  const signal = { symbol: 'BTCUSDT', side: 'BUY', requestedNotional: 10 };

  // 1. Risk gate blocks
  const riskBlocked = await executeCanaryTradeCycle({
    adapter,
    strategySignal: signal,
    riskContext: { portfolioEquity: 1000, drawdownPct: 6 } // > 5% drawdown
  });
  assert.equal(riskBlocked.executed, false);
  assert.equal(riskBlocked.stage, 'RISK_ENGINE');
  assert.equal(riskBlocked.reasonCode, 'RISK_003_MAX_DRAWDOWN');
  assert.equal(orderPlaced, false);

  // 2. Qualification gate blocks
  const qualBlocked = await executeCanaryTradeCycle({
    adapter,
    strategySignal: signal,
    riskContext: { portfolioEquity: 1000 },
    qualification: { status: 'PASS', fresh: false } // stale qualification
  });
  assert.equal(qualBlocked.executed, false);
  assert.equal(qualBlocked.stage, 'QUALIFICATION');
  assert.equal(qualBlocked.reasonCode, 'QUALIFICATION_REQUIRED');
  assert.equal(orderPlaced, false);

  // 3. Live Readiness gate blocks
  const readinessBlocked = await executeCanaryTradeCycle({
    adapter,
    strategySignal: signal,
    riskContext: { portfolioEquity: 1000 },
    qualification: { status: 'PASS', fresh: true },
    readinessInput: { dataFresh: false } // data not fresh
  });
  assert.equal(readinessBlocked.executed, false);
  assert.equal(readinessBlocked.stage, 'LIVE_READINESS');
  assert.equal(readinessBlocked.reasonCode, 'DATA_NOT_FRESH');
  assert.equal(orderPlaced, false);
});



