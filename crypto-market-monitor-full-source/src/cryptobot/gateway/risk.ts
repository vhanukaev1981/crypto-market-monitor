import { RiskStatusSchema, type RiskStatus } from "../domain.ts";
import { FRESHNESS_POLICIES } from "../freshness.ts";
import type { Row } from "../repository.ts";
import { bool, iso, latestTimestamp, num, row, severityToAlert, sourceMeta, text } from "./shared.ts";

export function mapRiskStatus(
  dashboard: Row | null,
  botStatuses: Row[],
  riskEvents: Row[],
  sourceError: boolean,
  nowMs = Date.now(),
): RiskStatus {
  const risk = row(botStatuses[0]?.risk);
  const referenceCapital = num(risk.reference_capital_usdt ?? dashboard?.reference_capital_usdt);
  const realizedToday = num(dashboard?.realized_today);
  const dailyLossPct = referenceCapital && realizedToday !== null
    ? Math.max(0, (-realizedToday / referenceCapital) * 100)
    : null;
  const dailyLossLimit = num(risk.max_daily_loss_usdt);
  const dailyLossLimitPct = referenceCapital && dailyLossLimit !== null
    ? (dailyLossLimit / referenceCapital) * 100
    : null;
  const openPositions = num(dashboard?.open_positions);
  const protectedPositions = num(dashboard?.protected_positions);
  const reconciliationState = openPositions === null || protectedPositions === null
    ? "unknown"
    : openPositions === protectedPositions
      ? "synced"
      : protectedPositions < openPositions
        ? "attention"
        : "mismatch";

  const alerts = riskEvents.map((event) => ({
    id: String(event.id ?? ""),
    severity: severityToAlert(event.severity),
    title: String(event.code ?? "אירוע סיכון"),
    message: String(event.message ?? "אין פירוט נוסף"),
    observed_at: iso(event.created_at),
    source: "risk_events",
  }));

  const observedAt = latestTimestamp([
    ...botStatuses.map((item) => item.last_run_at ?? item.updated_at),
    ...riskEvents.map((item) => item.created_at),
  ]);

  return RiskStatusSchema.parse({
    daily_loss_pct: dailyLossPct,
    daily_loss_limit_pct: dailyLossLimitPct,
    drawdown_pct: null,
    max_drawdown_pct: null,
    exposure_usd: num(dashboard?.open_exposure_usdt),
    max_exposure_usd: null,
    open_positions: openPositions === null ? null : Math.max(0, Math.trunc(openPositions)),
    max_open_positions: num(risk.max_open_positions) === null ? null : Math.max(0, Math.trunc(num(risk.max_open_positions)!)),
    kill_switch: botStatuses.length ? botStatuses.some((item) => item.kill_switch === true) : null,
    native_protection_required: bool(risk.require_native_protection),
    reconciliation_state: reconciliationState,
    recent_events: alerts,
    source: sourceMeta(observedAt, FRESHNESS_POLICIES.risk, sourceError ? "fault" : "ok", nowMs),
  });
}
