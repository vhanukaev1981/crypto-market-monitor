// Transactional adapter over the single-writer executor fencing SQL
// functions (algobot_acquire_executor / algobot_renew_executor_lease /
// algobot_assert_executor_fence / algobot_release_executor) defined in
// supabase/migrations/20260905_algobot_p0_execution.sql.
//
// PostgreSQL is the sole authority for who currently owns execution and
// which fence token is current. This module computes nothing and caches
// nothing in process memory: every call round-trips through the locked SQL
// function, so a stale process can never keep acting after a newer
// executor generation has taken over.
//
// `pool` only needs to satisfy `query(text, params) => Promise<{ rows }>`,
// the same contract a real `pg.Pool` exposes.

function assertPresent(fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') {
      throw new Error(`executor-fence: "${key}" is required`);
    }
  }
}

export function createExecutorFence({ pool, ownerId, leaseMs = 30_000 } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createExecutorFence requires a pool with a query(text, params) method');
  }
  if (!ownerId) {
    throw new Error('createExecutorFence requires a non-empty ownerId');
  }
  if (!(Number(leaseMs) > 0)) {
    throw new Error('createExecutorFence requires a positive leaseMs');
  }

  async function acquire() {
    const result = await pool.query(
      `select owner_id, fence_token, lease_expires_at
         from public.algobot_acquire_executor($1, $2)`,
      [ownerId, leaseMs],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('executor-fence: algobot_acquire_executor returned no row');
    }
    return {
      ownerId: row.owner_id,
      fenceToken: Number(row.fence_token),
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  async function renew({ fenceToken }) {
    assertPresent({ fenceToken });
    const result = await pool.query(
      `select lease_expires_at from public.algobot_renew_executor_lease($1, $2)`,
      [fenceToken, leaseMs],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('executor-fence: algobot_renew_executor_lease returned no row');
    }
    return { leaseExpiresAt: row.lease_expires_at };
  }

  async function assertCurrent({ fenceToken }) {
    assertPresent({ fenceToken });
    await pool.query(`select public.algobot_assert_executor_fence($1)`, [fenceToken]);
  }

  async function release({ fenceToken }) {
    assertPresent({ fenceToken });
    await pool.query(`select public.algobot_release_executor($1)`, [fenceToken]);
  }

  return {
    ownerId,
    leaseMs,
    acquire,
    renew,
    assertCurrent,
    release,
  };
}
