import { pathToFileURL } from 'node:url';
import { createBybitLiveAdapter } from '../algo/bybit-live-adapter.mjs';
import { createBybitV5ReadOnlyTransport } from '../algo/bybit-v5-readonly-transport.mjs';

export async function checkBybitLiveReadiness(options = {}) {
  const env = options.env || process.env;
  const apiKey = env.BYBIT_API_KEY;
  const apiSecret = env.BYBIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return Object.freeze({
      status: 'FAIL',
      reason: 'MISSING_CREDENTIALS: BYBIT_API_KEY and BYBIT_API_SECRET are required',
      orderTransportEngaged: false
    });
  }

  const transport = options.transport || createBybitV5ReadOnlyTransport({
    apiKey,
    apiSecret,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    now: options.now
  });

  const adapter = createBybitLiveAdapter({ mode: 'READ_ONLY', apiKey, apiSecret, transport });

  try {
    // 1. Verify API Permissions (fail-closed if withdrawal present or permissions unestablished)
    const permissions = await adapter.validateApiPermissions();

    // 2. Verify account connectivity (fail-closed if account snapshot fails)
    const snapshot = await adapter.getAccountSnapshot();

    return Object.freeze({
      status: 'PASS',
      mode: 'READ_ONLY',
      accountType: snapshot.accountType,
      assetCount: snapshot.coins?.length ?? 0,
      permissions: Object.freeze({
        permissionsEstablished: permissions.permissionsEstablished,
        withdrawalDisabled: permissions.withdrawalDisabled,
        spotEnabled: permissions.spotEnabled,
        readOnly: permissions.readOnly
      }),
      canaryPolicy: Object.freeze({
        maxOrderNotionalUsdt: 10,
        maxCumulativeExposureUsdt: 100,
        spotOnly: true,
        leverage: 1
      }),
      orderTransportEngaged: false
    });
  } catch (err) {
    // Redact any potential secret leakage from error message
    let sanitizedReason = err instanceof Error ? err.message : String(err);
    if (apiKey) sanitizedReason = sanitizedReason.replaceAll(apiKey, '[REDACTED_API_KEY]');
    if (apiSecret) sanitizedReason = sanitizedReason.replaceAll(apiSecret, '[REDACTED_API_SECRET]');

    return Object.freeze({
      status: 'FAIL',
      reason: sanitizedReason,
      orderTransportEngaged: false
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await checkBybitLiveReadiness();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') {
    process.exitCode = 1;
  }
}
