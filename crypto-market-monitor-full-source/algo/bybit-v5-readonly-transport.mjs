import { createHmac } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.bybit.com';
const RECV_WINDOW = '5000';

export function createBybitV5ReadOnlyTransport(config = {}) {
  const { apiKey, apiSecret } = config;
  if (typeof apiKey !== 'string' || !apiKey || typeof apiSecret !== 'string' || !apiSecret) {
    throw new Error('Bybit credentials are required');
  }
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Bybit fetch transport unavailable');
  const now = config.now ?? Date.now;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  function signedHeaders(timestamp, signingPayload, extra = {}) {
    return {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      'X-BAPI-SIGN': createHmac('sha256', apiSecret).update(signingPayload).digest('hex'),
      'X-BAPI-SIGN-TYPE': '2',
      ...extra,
    };
  }

  async function parseResponse(response) {
    if (!response?.ok) throw new Error(`Bybit HTTP failure: ${response?.status ?? 'unknown'}`);
    const body = await response.json();
    if (!body || body.retCode !== 0) throw new Error(`Bybit API failure ${body?.retCode ?? 'unknown'}: ${body?.retMsg ?? 'unknown'}`);
    return body;
  }

  async function signedGet(path, query = '') {
    const timestamp = String(now());
    const payload = `${timestamp}${apiKey}${RECV_WINDOW}${query}`;
    const suffix = query ? `?${query}` : '';
    return parseResponse(await fetchImpl(`${baseUrl}${path}${suffix}`, {
      method: 'GET',
      headers: signedHeaders(timestamp, payload),
    }));
  }

  async function accountSnapshot() {
    return signedGet('/v5/account/wallet-balance', 'accountType=UNIFIED');
  }

  async function queryApiPermissions() {
    return signedGet('/v5/user/query-api');
  }

  function validateSpotMarketOrder(request) {
    if (request.category !== 'spot') throw new Error('Bybit order transport is Spot only');
    if ('leverage' in request || 'isLeverage' in request || 'marginMode' in request) throw new Error('Leverage or margin semantics are forbidden');
    if (request.orderType !== 'Market') throw new Error('Only Spot Market canary orders are supported');
    if (!/^[A-Z0-9]{3,24}$/.test(request.symbol ?? '')) throw new Error('Invalid Bybit Spot symbol');
    if (request.side !== 'Buy' && request.side !== 'Sell') throw new Error('Invalid Bybit order side');
    if (!Number.isFinite(Number(request.qty)) || Number(request.qty) <= 0) throw new Error('Invalid Bybit order quantity');
    if (request.marketUnit !== 'quoteCoin') throw new Error('Canary order quantity must use quoteCoin market unit');
    if (typeof request.orderLinkId !== 'string' || request.orderLinkId.length < 1 || request.orderLinkId.length > 36) throw new Error('Invalid Bybit orderLinkId');
  }

  async function placeOrder(request) {
    validateSpotMarketOrder(request);
    const order = {
      category: 'spot',
      symbol: request.symbol,
      side: request.side,
      orderType: 'Market',
      qty: String(request.qty),
      marketUnit: 'quoteCoin',
      orderLinkId: request.orderLinkId,
    };
    const body = JSON.stringify(order);
    const timestamp = String(now());
    const payload = `${timestamp}${apiKey}${RECV_WINDOW}${body}`;
    return parseResponse(await fetchImpl(`${baseUrl}/v5/order/create`, {
      method: 'POST',
      headers: signedHeaders(timestamp, payload, { 'Content-Type': 'application/json' }),
      body,
    }));
  }

  return Object.freeze({
    async request(request = {}) {
      if (request.operation === 'accountSnapshot') return accountSnapshot();
      if (request.operation === 'queryApiPermissions') return queryApiPermissions();
      if (request.operation === 'placeOrder') return placeOrder(request);
      throw new Error('Unsupported Bybit operation');
    }
  });
}
