// Durable execution ledger adapter. PostgreSQL transaction functions are authoritative.
// The caller must validate all incoming facts against authenticated Bybit evidence;
// this adapter is deliberately NOT an exchange proof oracle.
export function createExecutionStore({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createExecutionStore requires PostgreSQL pool.query');
  }
  function requiredText(label,value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(label+' required');
    return value;
  }
  function requiredToken(token) {
    if (!Number.isSafeInteger(token) || token <= 0) throw new Error('positive safe integer fenceToken required');
    return token;
  }
  function requiredNumber(label,value) {
    if ((typeof value !== 'number' && typeof value !== 'string') ||
        !Number.isFinite(Number(value)) || Number(value) < 0) {
      throw new Error(label+' must be non-negative finite');
    }
    return value;
  }
  async function one(sql,values,label) {
    const result=await pool.query(sql,values);
    if (!result || !Array.isArray(result.rows) || !result.rows[0]) {
      throw new Error('execution-store: '+label+' returned no row');
    }
    return result.rows[0];
  }
  return Object.freeze({
    async createExecution({ orderLinkId,symbol,side,requestedQty=0,requestedNotional,fenceToken }={}) {
      return one(
        'select * from public.algobot_create_execution($1,$2,$3,$4,$5,$6)',
        [requiredText('orderLinkId',orderLinkId),requiredText('symbol',symbol),
          requiredText('side',side),requiredNumber('requestedQty',requestedQty),
          requiredNumber('requestedNotional',requestedNotional),requiredToken(fenceToken)],
        'createExecution',
      );
    },
    async markInFlight({ orderLinkId,fenceToken }={}) {
      return one('select * from public.algobot_mark_execution_in_flight($1,$2)',
        [requiredText('orderLinkId',orderLinkId),requiredToken(fenceToken)],'markInFlight');
    },
    async applyExchangeEvidence({ orderLinkId,status,exchangeOrderId,
      filledQty=0,filledNotional=0,avgFillPrice=null,fees=0,fenceToken }={}) {
      return one(
        'select * from public.algobot_apply_execution_evidence($1,$2,$3,$4,$5,$6,$7,$8)',
        [requiredText('orderLinkId',orderLinkId),requiredText('status',status),
          requiredText('exchangeOrderId',exchangeOrderId),
          requiredNumber('filledQty',filledQty),
          requiredNumber('filledNotional',filledNotional),
          avgFillPrice===null ? null : requiredNumber('avgFillPrice',avgFillPrice),
          requiredNumber('fees',fees),requiredToken(fenceToken)],
        'applyExchangeEvidence',
      );
    },
    async markUnknown({orderLinkId,reason,fenceToken}={}) {
      return one('select * from public.algobot_mark_execution_unknown($1,$2,$3)',
        [requiredText('orderLinkId',orderLinkId),requiredText('reason',reason),
          requiredToken(fenceToken)],'markUnknown');
    },
    async getByOrderLinkId({orderLinkId}={}) {
      const result=await pool.query('select * from public.execution_ledger where order_link_id=$1',
        [requiredText('orderLinkId',orderLinkId)]);
      if (!result || !Array.isArray(result.rows)) throw new Error('execution-store: invalid query result');
      return result.rows[0] ?? null;
    },
    async listUnresolved() {
      const result=await pool.query('select * from public.algobot_list_unresolved_executions()',[]);
      if (!result || !Array.isArray(result.rows)) throw new Error('execution-store: invalid query result');
      return result.rows;
    },
  });
}
