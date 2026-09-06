// Transactional adapter over the CANARY budget accounting SQL functions
// (algobot_reserve_canary / algobot_commit_canary_reservation /
// algobot_release_canary_reservation) defined in
// supabase/migrations/20260905_algobot_p0_execution.sql.
//
// This module is intentionally a thin pass-through: PostgreSQL is the sole
// authority for the 10 USDT per-order and 100 USDT cumulative CANARY caps.
// Nothing here computes, caches, or re-derives that accounting in process
// memory — every call round-trips through the locked, transactional SQL
// function so concurrent workers can never oversubscribe the budget and a
// process restart can never lose track of what has already been reserved.
//
// `pool` only needs to satisfy `query(text, params) => Promise<{ rows }>`,
// the same contract a real `pg.Pool` exposes, so a production caller can
// pass a real driver-backed pool without any change here.

function assertPresent(fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') {
      throw new Error(`canary-budget-store: "${key}" is required`);
    }
  }
}

export function createCanaryBudgetStore({ pool, maxOrderNotionalUsdt = 10, maxCumulativeNotionalUsdt = 100 } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createCanaryBudgetStore requires a pool with a query(text, params) method');
  }
  if (!(Number(maxOrderNotionalUsdt) > 0)) {
    throw new Error('createCanaryBudgetStore requires a positive maxOrderNotionalUsdt');
  }
  if (!(Number(maxCumulativeNotionalUsdt) > 0)) {
    throw new Error('createCanaryBudgetStore requires a positive maxCumulativeNotionalUsdt');
  }

  async function reserve({ orderLinkId, requestedNotionalUsdt, executorFenceToken }) {
    assertPresent({ orderLinkId, executorFenceToken });
    if (typeof requestedNotionalUsdt !== 'number' || !Number.isFinite(requestedNotionalUsdt)) {
      throw new Error('canary-budget-store: "requestedNotionalUsdt" must be a finite number');
    }

    const result = await pool.query(
      `select reservation_id, reserved_notional_usdt, total_authorized_usdt
         from public.algobot_reserve_canary($1, $2, $3)`,
      [orderLinkId, requestedNotionalUsdt, executorFenceToken],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`canary-budget-store: algobot_reserve_canary returned no row for order_link_id ${orderLinkId}`);
    }
    return {
      reservationId: row.reservation_id,
      reservedNotionalUsdt: Number(row.reserved_notional_usdt),
      totalAuthorizedUsdt: Number(row.total_authorized_usdt),
    };
  }

  async function release({ reservationId, reason, executorFenceToken }) {
    assertPresent({ reservationId, executorFenceToken });
    await pool.query(
      `select public.algobot_release_canary_reservation($1, $2, $3)`,
      [reservationId, reason ?? null, executorFenceToken],
    );
  }

  async function commit({ reservationId, filledNotionalUsdt, executorFenceToken }) {
    assertPresent({ reservationId, executorFenceToken });
    if (typeof filledNotionalUsdt !== 'number' || !Number.isFinite(filledNotionalUsdt)) {
      throw new Error('canary-budget-store: "filledNotionalUsdt" must be a finite number');
    }
    await pool.query(
      `select public.algobot_commit_canary_reservation($1, $2, $3)`,
      [reservationId, filledNotionalUsdt, executorFenceToken],
    );
  }

  return {
    maxOrderNotionalUsdt,
    maxCumulativeNotionalUsdt,
    reserve,
    release,
    commit,
  };
}
