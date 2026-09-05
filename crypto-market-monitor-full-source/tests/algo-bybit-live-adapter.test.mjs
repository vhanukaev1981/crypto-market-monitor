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

