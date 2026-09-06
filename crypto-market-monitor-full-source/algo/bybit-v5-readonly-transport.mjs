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
    if (request.category !== undefined && request.category !== 'spot') throw new Error('Bybit order transport is Spot only');
    if ('leverage' in request || 'isLeverage' in request || 'marginMode' in request) throw new Error('Leverage or margin semantics are forbidden');
    if (request.orderType !== undefined && request.orderType !== 'Market') throw new Error('Only Spot Market canary orders are supported');
    if (!/^[A-Z0-9]{3,24}$/.test(request.symbol ?? '')) throw new Error('Invalid Bybit Spot symbol');
    if (request.side !== 'Buy' && request.side !== 'Sell') throw new Error('Invalid Bybit order side');
    if (!Number.isFinite(Number(request.qty)) || Number(request.qty) <= 0) throw new Error('Invalid Bybit order quantity');
    if (request.marketUnit !== undefined && request.marketUnit !== 'quoteCoin') throw new Error('Canary order quantity must use quoteCoin market unit');
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

  function validateReconcileRequest(request) {
    if (request.category !== undefined && request.category !== 'spot') {
      throw new Error('Bybit reconciliation is Spot only');
    }
    if ('leverage' in request || 'isLeverage' in request || 'marginMode' in request) {
      throw new Error('Leverage or margin semantics are forbidden');
    }
    const hasOrderLinkId = typeof request.orderLinkId === 'string' && request.orderLinkId.trim().length > 0;
    const hasOrderId = typeof request.orderId === 'string' && request.orderId.trim().length > 0;
    if (!hasOrderLinkId && !hasOrderId) {
      throw new Error('Either orderLinkId or orderId is required for reconciliation');
    }
    if (request.symbol !== undefined && !/^[A-Z0-9]{3,24}$/.test(request.symbol)) {
      throw new Error('Invalid Bybit Spot symbol');
    }
  }

  async function reconcileOrder(request = {}) {
    validateReconcileRequest(request);
    const queryParts = ['category=spot'];
    if (request.symbol) queryParts.push(`symbol=${encodeURIComponent(request.symbol)}`);
    if (request.orderLinkId) queryParts.push(`orderLinkId=${encodeURIComponent(request.orderLinkId)}`);
    if (request.orderId) queryParts.push(`orderId=${encodeURIComponent(request.orderId)}`);
    const query = queryParts.join('&');

    let response = await signedGet('/v5/order/realtime', query);
    let order = response?.result?.list?.[0];

    if (!order) {
      const historyResponse = await signedGet('/v5/order/history', query);
      order = historyResponse?.result?.list?.[0];
    }

    if (!order) {
      throw new Error(`Bybit order reconciliation failed: order '${request.orderLinkId || request.orderId}' not found on exchange`);
    }

    return {
      retCode: 0,
      retMsg: 'OK',
      result: {
        orderId: order.orderId,
        orderLinkId: order.orderLinkId,
        symbol: order.symbol,
        side: order.side,
        orderType: order.orderType,
        orderStatus: order.orderStatus,
        qty: order.qty,
        cumExecQty: order.cumExecQty,
        cumExecValue: order.cumExecValue,
        cumExecFee: order.cumExecFee,
        avgPrice: order.avgPrice,
        category: 'spot',
        raw: order,
      }
    };
  }

  return Object.freeze({
    placeOrder,
    reconcileOrder,
    async request(request = {}) {
      if (request.operation === 'accountSnapshot') return accountSnapshot();
      if (request.operation === 'queryApiPermissions') return queryApiPermissions();
      if (request.operation === 'placeOrder') return placeOrder(request);
      if (request.operation === 'reconcileOrder') return reconcileOrder(request);
      throw new Error('Unsupported Bybit operation');
    }
  });
}
