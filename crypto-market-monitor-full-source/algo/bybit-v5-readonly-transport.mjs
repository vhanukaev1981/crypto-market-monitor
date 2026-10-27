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

    if ((request.symbol && order.symbol !== request.symbol) ||
        (request.orderId && order.orderId !== request.orderId) ||
        (request.orderLinkId && order.orderLinkId !== request.orderLinkId)) {
      throw new Error('Bybit reconciliation returned wrong order identity');
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


  // Only exchange-returned fill rows are evidence; results are not themselves
  // account-verified until queried with authenticated Bybit credentials.
  function positiveDecimal(value, label, allowZero=false) {
    if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(value) ||
        !Number.isFinite(Number(value)) ||
        (allowZero ? Number(value)<0 : Number(value)<=0)) {
      throw new Error('Invalid Bybit execution '+label);
    }
    return value;
  }

  async function listExecutions(request={}) {
    validateReconcileRequest(request);
    if (request.symbol !== 'BTCUSDT') throw new Error('P0 execution evidence is BTCUSDT Spot only');
    if (typeof request.orderId === 'string' && request.orderId.length > 128) throw new Error('Invalid Bybit orderId');
    if (typeof request.orderLinkId === 'string' && request.orderLinkId.length > 36) throw new Error('Invalid Bybit orderLinkId');
    if (request.cursor !== undefined &&
      (typeof request.cursor !== 'string' || request.cursor.length < 1 || request.cursor.length > 512)) {
      throw new Error('Invalid Bybit execution cursor');
    }
    const queryParts=['category=spot','symbol=BTCUSDT'];
    if (request.orderId) queryParts.push('orderId='+encodeURIComponent(request.orderId));
    if (request.orderLinkId) queryParts.push('orderLinkId='+encodeURIComponent(request.orderLinkId));
    if (request.cursor) queryParts.push('cursor='+encodeURIComponent(request.cursor));
    const response=await signedGet('/v5/execution/list',queryParts.join('&'));
    if (response?.result?.category !== 'spot' || !Array.isArray(response?.result?.list)) {
      throw new Error('Invalid Bybit Spot execution response shape');
    }
    const cursor=response.result.nextPageCursor ?? '';
    if (typeof cursor !== 'string' || cursor.length > 512) {
      throw new Error('Invalid Bybit execution pagination evidence');
    }
    const seen=new Set();
    const list=response.result.list.map(row=>{
      if (!row || row.symbol !== 'BTCUSDT' ||
          (request.orderId && row.orderId !== request.orderId) ||
          (request.orderLinkId && row.orderLinkId !== request.orderLinkId) ||
          row.side !== 'Buy' && row.side !== 'Sell' ||
          row.orderType !== 'Market' || row.execType !== 'Trade' ||
          typeof row.orderId !== 'string' || !row.orderId ||
          typeof row.orderLinkId !== 'string' || !row.orderLinkId ||
          typeof row.execId !== 'string' || !row.execId ||
          !/^[0-9]{10,17}$/.test(String(row.execTime ?? ''))) {
        throw new Error('Bybit execution identity or type mismatch');
      }
      if (seen.has(row.execId)) throw new Error('Duplicate Bybit execution id');
      seen.add(row.execId);
      positiveDecimal(row.execPrice,'price');
      positiveDecimal(row.execQty,'quantity');
      positiveDecimal(row.execValue,'value');
      positiveDecimal(row.execFee,'fee',true);
      if (Number(row.execFee)>0 && (typeof row.feeCurrency!=='string' || !row.feeCurrency)) {
        throw new Error('Bybit execution fee currency missing');
      }
      return {
        orderId:row.orderId,orderLinkId:row.orderLinkId,symbol:row.symbol,
        side:row.side,orderType:row.orderType,execId:row.execId,
        execPrice:row.execPrice,execQty:row.execQty,execValue:row.execValue,
        execFee:row.execFee,feeCurrency:row.feeCurrency || null,
        execTime:String(row.execTime),execType:row.execType,raw:row
      };
    });
    return {retCode:0,retMsg:'OK',result:{
      category:'spot',list,nextPageCursor:cursor,hasMore:cursor.length>0,
      source:'BYBIT_V5_EXECUTION_RESPONSE_UNVERIFIED',pageFinal:cursor.length===0,
    }};
  }

  async function spotBalanceEvidence() {
    const response=await signedGet('/v5/account/wallet-balance','accountType=UNIFIED&coin=BTC%2CUSDT');
    const accounts=response?.result?.list;
    if (!Array.isArray(accounts) || accounts.length!==1 ||
        accounts[0]?.accountType!=='UNIFIED' || !Array.isArray(accounts[0].coin)) {
      throw new Error('Invalid Bybit UNIFIED account balance response');
    }
    const seen=new Set();
    const coins=accounts[0].coin.map(row=>{
      if (!row || !['BTC','USDT'].includes(row.coin) || seen.has(row.coin)) {
        throw new Error('Bybit wallet coin identity mismatch');
      }
      seen.add(row.coin);
      positiveDecimal(row.walletBalance,'walletBalance',true);
      if (row.spotBorrow!==undefined && row.spotBorrow!==null && row.spotBorrow!=='') {
        positiveDecimal(row.spotBorrow,'spotBorrow',true);
      }
      return {coin:row.coin,walletBalance:row.walletBalance,
        spotBorrow:row.spotBorrow ?? null,raw:row};
    });
    return {retCode:0,retMsg:'OK',result:{
      accountType:'UNIFIED',coins,source:'BYBIT_V5_WALLET_RESPONSE_UNVERIFIED',
      rawAccount:accounts[0]
    }};
  }

  return Object.freeze({
    listExecutions,
    spotBalanceEvidence,
    placeOrder,
    reconcileOrder,
    async request(request = {}) {
      if (request.operation === 'accountSnapshot') return accountSnapshot();
      if (request.operation === 'queryApiPermissions') return queryApiPermissions();
      if (request.operation === 'placeOrder') return placeOrder(request);
      if (request.operation === 'reconcileOrder') return reconcileOrder(request);
      if (request.operation === 'listExecutions') return listExecutions(request);
      if (request.operation === 'spotBalanceEvidence') return spotBalanceEvidence();
      throw new Error('Unsupported Bybit operation');
    }
  });
}
