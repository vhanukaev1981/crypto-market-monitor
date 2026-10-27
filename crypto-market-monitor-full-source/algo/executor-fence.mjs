// Single-writer executor lease. PostgreSQL is the only authority; no cached token.
// A successful assertCurrent is diagnostic only: any subsequent write must
// re-check the token/lease inside the same database transaction.
function requiredToken(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('executor-fence: a positive safe integer fenceToken is required');
  }
  return value;
}
function requireRow(result, label) {
  if (!result || !Array.isArray(result.rows) || !result.rows[0]) {
    throw new Error('executor-fence: '+label+' returned no row');
  }
  return result.rows[0];
}
export function createExecutorFence({ pool, ownerId, leaseMs = 30000 } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createExecutorFence requires a PostgreSQL pool with query(text, params)');
  }
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw new Error('createExecutorFence requires a non-empty ownerId');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300000) {
    throw new Error('createExecutorFence requires leaseMs between 1 and 300000');
  }
  async function acquire() {
    const row = requireRow(await pool.query(
      'select owner_id, fence_token, lease_expires_at from public.algobot_acquire_executor($1, $2)',
      [ownerId, leaseMs],
    ), 'algobot_acquire_executor');
    const token=Number(row.fence_token);
    requiredToken(token);
    if (row.owner_id !== ownerId || !row.lease_expires_at) {
      throw new Error('executor-fence: inconsistent acquisition evidence');
    }
    return { ownerId: row.owner_id, fenceToken: token, leaseExpiresAt: row.lease_expires_at };
  }
  async function renew({ fenceToken } = {}) {
    const row=requireRow(await pool.query(
      'select lease_expires_at from public.algobot_renew_executor_lease($1, $2)',
      [requiredToken(fenceToken), leaseMs],
    ), 'algobot_renew_executor_lease');
    if (!row.lease_expires_at) throw new Error('executor-fence: missing renewal evidence');
    return { leaseExpiresAt: row.lease_expires_at };
  }
  async function assertCurrent({ fenceToken } = {}) {
    requireRow(await pool.query(
      'select public.algobot_assert_executor_fence($1) as authorized',
      [requiredToken(fenceToken)],
    ), 'algobot_assert_executor_fence');
  }
  async function release({ fenceToken } = {}) {
    requireRow(await pool.query(
      'select public.algobot_release_executor($1) as released',
      [requiredToken(fenceToken)],
    ), 'algobot_release_executor');
  }
  return Object.freeze({ ownerId, leaseMs, acquire, renew, assertCurrent, release });
}
