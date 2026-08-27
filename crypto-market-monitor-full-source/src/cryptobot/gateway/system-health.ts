import { SystemHealthSchema, type SourceState, type SystemHealth, type SystemState } from "../domain.ts";
import { FRESHNESS_POLICIES } from "../freshness.ts";
import type { Row } from "../repository.ts";
import { bool, iso, latestTimestamp, sourceMeta, text } from "./shared.ts";

function sourceState(ok: boolean | null, hasError: boolean): SourceState {
  if (hasError) return "fault";
  if (ok === true) return "ok";
  if (ok === false) return "attention";
  return "unknown";
}

export function mapSystemHealth(
  snapshot: Row | null,
  connection: Row | null,
  botStatuses: Row[],
  streamState: Row | null,
  orderbookState: Row | null,
  sourceErrors: Record<string, boolean>,
  nowMs = Date.now(),
): SystemHealth {
  const exchangeObserved = connection?.last_checked_at ?? snapshot?.checked_at;
  const exchangeFlagsUnsafe = connection?.trading_enabled === true || connection?.withdrawals_enabled === true || connection?.is_read_only === false;
  const exchangeConnected = String(connection?.status ?? "").toLowerCase() === "connected" && !connection?.last_error;
  const exchangeMeta = sourceMeta(exchangeObserved, FRESHNESS_POLICIES.bybitAccount, sourceErrors.exchange ? "fault" : sourceState(exchangeConnected, Boolean(connection?.last_error)), nowMs);

  const engineObserved = latestTimestamp(botStatuses.map((item) => item.last_run_at ?? item.updated_at));
  const engineDisabled = botStatuses.length > 0 && botStatuses.every((item) => item.enabled !== true);
  const killSwitch = botStatuses.some((item) => item.kill_switch === true);
  const legacyRuntimeStopped = killSwitch || engineDisabled;
  const engineMeta = sourceMeta(
    engineObserved,
    FRESHNESS_POLICIES.algobot,
    sourceErrors.engine ? "fault" : legacyRuntimeStopped ? "attention" : botStatuses.length ? "ok" : "unknown",
    nowMs,
  );

  const streamObserved = streamState?.last_message_at ?? streamState?.updated_at;
  const orderbookObserved = orderbookState?.last_sample_at ?? orderbookState?.updated_at;
  const streamMeta = sourceMeta(
    streamObserved,
    FRESHNESS_POLICIES.reconciliation,
    sourceErrors.stream ? "fault" : legacyRuntimeStopped ? "unknown" : sourceState(bool(streamState?.connected), Boolean(streamState?.last_error)),
    nowMs,
  );
  const orderbookMeta = sourceMeta(
    orderbookObserved,
    FRESHNESS_POLICIES.reconciliation,
    sourceErrors.orderbook ? "fault" : legacyRuntimeStopped ? "unknown" : sourceState(bool(orderbookState?.connected), Boolean(orderbookState?.last_error)),
    nowMs,
  );

  let overallState: SystemState = "healthy";
  if (exchangeFlagsUnsafe) overallState = "emergency_stop";
  else if (legacyRuntimeStopped) overallState = "protection";
  else if ([exchangeMeta, engineMeta, streamMeta, orderbookMeta].some((meta) => meta.source_state === "fault" || meta.freshness_state === "stale")) overallState = "limited";
  else if ([exchangeMeta, engineMeta, streamMeta, orderbookMeta].some((meta) => meta.source_state === "attention" || meta.freshness_state === "aging" || meta.freshness_state === "unavailable")) overallState = "limited";

  const observedAt = latestTimestamp([exchangeObserved, engineObserved, streamState?.updated_at, orderbookState?.updated_at]);
  const inactiveMessage = "Inactive while legacy runtime is stopped safely";
  return SystemHealthSchema.parse({
    overall_state: overallState,
    components: [
      { key: "bybit", label: "Bybit", state: exchangeMeta.source_state, message: text(connection?.last_error), meta: exchangeMeta },
      {
        key: "algobot",
        label: "Legacy AlgoBot Runtime",
        state: engineMeta.source_state,
        message: legacyRuntimeStopped ? "Legacy runtime stopped safely; protection gate is active" : null,
        meta: engineMeta,
      },
      {
        key: "private_stream",
        label: "זרם נתונים פרטי",
        state: streamMeta.source_state,
        message: legacyRuntimeStopped ? inactiveMessage : text(streamState?.last_error),
        meta: streamMeta,
      },
      {
        key: "orderbook",
        label: "ספר פקודות",
        state: orderbookMeta.source_state,
        message: legacyRuntimeStopped ? inactiveMessage : text(orderbookState?.last_error),
        meta: orderbookMeta,
      },
    ],
    authorization_mode: "read_only",
    exchange_trading_enabled: connection?.trading_enabled === true,
    withdrawals_enabled: connection?.withdrawals_enabled === true,
    source: sourceMeta(observedAt, FRESHNESS_POLICIES.reconciliation, Object.values(sourceErrors).some(Boolean) ? "attention" : "ok", nowMs),
  });
}
