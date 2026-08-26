import { AlgoBotStatusSchema, type AlgoBotStatus } from "../domain.ts";
import { FRESHNESS_POLICIES } from "../freshness.ts";
import type { Row } from "../repository.ts";
import { decisionSummary } from "./decision.ts";
import { iso, latestTimestamp, num, row, sourceMeta, strategyMode, text } from "./shared.ts";

export function mapAlgoBotStatus(
  performance: Row[],
  decisions: Row[],
  botStatuses: Row[],
  sourceError: boolean,
  nowMs = Date.now(),
): AlgoBotStatus {
  const botStrategy = row(botStatuses[0]?.strategy);
  const configuredMode = strategyMode(botStrategy.mode ?? botStatuses[0]?.environment);
  const latestByStrategy = new Map<string, Row>();
  for (const decision of decisions) {
    const key = String(decision.strategy_key ?? "");
    if (key && !latestByStrategy.has(key)) latestByStrategy.set(key, decision);
  }

  const strategyKeys = new Set<string>([
    ...performance.map((item) => String(item.strategy_key ?? "")).filter(Boolean),
    ...latestByStrategy.keys(),
  ]);

  const strategies = [...strategyKeys].sort().map((key) => {
    const perf = performance.find((item) => String(item.strategy_key ?? "") === key);
    const latest = latestByStrategy.get(key);
    const trades = num(perf?.trades);
    const wins = num(perf?.wins);
    return {
      id: key,
      key,
      name: key.replaceAll("_", " "),
      mode: configuredMode,
      status: botStatuses[0]?.enabled === true && botStatuses[0]?.kill_switch !== true ? "active" : "inactive",
      win_rate_pct: trades && wins !== null ? (wins / trades) * 100 : null,
      expectancy_usd: num(perf?.expectancy_usdt),
      pnl_usd: num(perf?.net_pnl),
      drawdown_pct: null,
      trade_count: trades === null ? null : Math.max(0, Math.trunc(trades)),
      latest_signal: text(latest?.signal),
      latest_decision_id: latest?.id === null || latest?.id === undefined ? null : String(latest.id),
      observed_at: latestTimestamp([perf?.updated_at, latest?.created_at]),
    };
  });

  const latestSignals = decisions.slice(0, 20).map((item) => ({
    id: String(item.id ?? ""),
    strategy: text(item.strategy_key),
    symbol: String(item.symbol ?? "לא זמין"),
    signal: String(item.signal ?? "unknown"),
    confidence: num(row(item.metadata).decision ? row(row(item.metadata).decision).confidence : null),
    reason: Array.isArray(item.rejection_codes) ? item.rejection_codes.map(String).join(", ") : null,
    observed_at: iso(item.created_at),
  }));

  const observedAt = latestTimestamp([
    ...performance.map((item) => item.updated_at),
    ...decisions.map((item) => item.created_at),
    ...botStatuses.map((item) => item.last_run_at ?? item.updated_at),
  ]);

  return AlgoBotStatusSchema.parse({
    strategies,
    latest_signals: latestSignals,
    latest_decisions: decisions.slice(0, 20).map(decisionSummary),
    source: sourceMeta(observedAt, FRESHNESS_POLICIES.algobot, sourceError ? "fault" : "ok", nowMs),
  });
}
