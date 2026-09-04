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

  async function accountSnapshot() {
    const timestamp = String(now());
    const query = 'accountType=UNIFIED';
    const payload = `${timestamp}${apiKey}${RECV_WINDOW}${query}`;
    const signature = createHmac('sha256', apiSecret).update(payload).digest('hex');
    const response = await fetchImpl(`${baseUrl}/v5/account/wallet-balance?${query}`, {
      method: 'GET',
      headers: {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': signature,
        'X-BAPI-SIGN-TYPE': '2'
      }
    });
    if (!response?.ok) throw new Error(`Bybit HTTP failure: ${response?.status ?? 'unknown'}`);
    const body = await response.json();
    if (!body || body.retCode !== 0) throw new Error(`Bybit API failure ${body?.retCode ?? 'unknown'}: ${body?.retMsg ?? 'unknown'}`);
    return body;
  }

  return Object.freeze({
    async request(request = {}) {
      if (request.operation !== 'accountSnapshot') throw new Error('Unsupported read-only Bybit operation');
      return accountSnapshot();
    }
  });
}
