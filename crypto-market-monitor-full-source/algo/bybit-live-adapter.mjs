const MODES = new Set(['READ_ONLY', 'CANARY']);

export function createBybitLiveAdapter(config = {}) {
  const mode = config.mode ?? 'READ_ONLY';
  if (mode === 'LIVE') throw new Error('LIVE mode is disabled');
  if (!MODES.has(mode)) throw new Error(`Unsupported Bybit adapter mode: ${mode}`);

  const requireCredentials = () => {
    if (!config.apiKey || !config.apiSecret) throw new Error('Bybit credentials are required');
  };

  return Object.freeze({
    mode,
    async getAccountSnapshot() {
      requireCredentials();
      if (!config.transport?.request) throw new Error('Bybit transport unavailable');
      return config.transport.request({ operation: 'accountSnapshot' });
    },
    async submitCanaryOrder(request = {}) {
      if (mode !== 'CANARY') throw new Error('Order submission blocked in READ_ONLY mode');
      requireCredentials();
      if (request.humanApproved !== true) throw new Error('Explicit human approval required');
      throw new Error('CANARY transport intentionally not wired yet');
    }
  });
}
