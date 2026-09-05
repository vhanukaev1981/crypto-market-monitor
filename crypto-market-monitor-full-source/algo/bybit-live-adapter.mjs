import { createBybitV5ReadOnlyTransport } from './bybit-v5-readonly-transport.mjs';

const MODES = new Set(['READ_ONLY', 'CANARY']);

export function createBybitLiveAdapter(config = {}) {
  const mode = config.mode ?? 'READ_ONLY';
  if (mode === 'LIVE') throw new Error('LIVE mode is disabled');
  if (!MODES.has(mode)) throw new Error(`Unsupported Bybit adapter mode: ${mode}`);

  const requireCredentials = () => {
    if (!config.apiKey || !config.apiSecret) throw new Error('Bybit credentials are required');
  };

  const getTransport = () => {
    if (config.transport?.request) return config.transport;
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

  return Object.freeze({
    mode,
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
      if (request.humanApproved !== true) throw new Error('Explicit human approval required');
      throw new Error('CANARY transport intentionally not wired yet');
    }
  });
}

