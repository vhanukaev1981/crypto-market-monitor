import { pathToFileURL } from 'node:url';
import { createBybitLiveAdapter } from '../algo/bybit-live-adapter.mjs';
import { createBybitV5ReadOnlyTransport } from '../algo/bybit-v5-readonly-transport.mjs';

export function summarizeBybitAccountSnapshot(snapshot) {
  const account = snapshot?.retCode === 0 ? snapshot?.result?.list?.[0] : null;
  if (!account || typeof account.accountType !== 'string' || !Array.isArray(account.coin)) {
    throw new Error('Malformed Bybit account snapshot');
  }
  return Object.freeze({ status: 'PASS', accountType: account.accountType, assetCount: account.coin.length });
}

export async function runBybitReadOnlyDiagnostic(env = process.env) {
  const apiKey = env.BYBIT_API_KEY;
  const apiSecret = env.BYBIT_API_SECRET;
  const transport = createBybitV5ReadOnlyTransport({ apiKey, apiSecret });
  const adapter = createBybitLiveAdapter({ mode: 'READ_ONLY', apiKey, apiSecret, transport });
  return summarizeBybitAccountSnapshot(await adapter.getAccountSnapshot());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const summary = await runBybitReadOnlyDiagnostic();
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: error instanceof Error ? error.message : 'Unknown diagnostic failure' }));
    process.exitCode = 1;
  }
}
