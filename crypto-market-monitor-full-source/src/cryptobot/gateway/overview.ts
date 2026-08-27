import { DashboardOverviewSchema, type AlgoBotStatus, type BybitBotsOutput, type DashboardOverview, type RiskStatus, type SystemHealth } from "../domain.ts";
import type { Row } from "../repository.ts";
import { num } from "./shared.ts";

export function mapDashboardOverview(
  dashboard: Row | null,
  snapshot: Row | null,
  algobot: AlgoBotStatus,
  bybitBots: BybitBotsOutput,
  risk: RiskStatus,
  system: SystemHealth,
): DashboardOverview {
  const snapshotAccount = snapshot?.account && typeof snapshot.account === "object" && !Array.isArray(snapshot.account)
    ? snapshot.account as Row
    : {};
  const portfolioEquity = num(snapshotAccount.total_assets_usd ?? dashboard?.account_equity_usdt);
  const exposure = num(dashboard?.open_exposure_usdt);
  const deployedCapitalPct = portfolioEquity && portfolioEquity > 0 && exposure !== null
    ? Math.max(0, (exposure / portfolioEquity) * 100)
    : null;

  const activeStrategies = algobot.strategies.filter((strategy) => strategy.status === "active").length;
  const runtimeActive = activeStrategies > 0;
  const modeSummary = algobot.strategies.reduce<Record<string, number>>((acc, strategy) => {
    acc[strategy.mode] = (acc[strategy.mode] ?? 0) + 1;
    return acc;
  }, {});
  const algoPnlValues = runtimeActive
    ? algobot.strategies.map((strategy) => strategy.pnl_usd).filter((value): value is number => value !== null)
    : [];
  const algoPnl = algoPnlValues.length ? algoPnlValues.reduce((sum, value) => sum + value, 0) : null;

  return DashboardOverviewSchema.parse({
    portfolio_equity_usd: portfolioEquity,
    pnl: {
      day_usd: runtimeActive ? num(dashboard?.realized_today) : null,
      week_usd: null,
      month_usd: null,
    },
    drawdown_pct: risk.drawdown_pct,
    deployed_capital_pct: runtimeActive ? deployedCapitalPct : null,
    open_positions: num(dashboard?.open_positions) === null ? null : Math.max(0, Math.trunc(num(dashboard?.open_positions)!)),
    algobot: {
      active_strategies: algobot.strategies.length ? activeStrategies : null,
      pnl_usd: algoPnl,
      mode_summary: modeSummary,
    },
    bybit_bots: {
      count: bybitBots.bots.length || null,
      equity_usd: bybitBots.total_bot_account_equity_usd,
      pnl_usd: bybitBots.details_available
        ? (() => {
            const values = bybitBots.bots.map((bot) => bot.total_pnl_usd).filter((value): value is number => value !== null);
            return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
          })()
        : null,
    },
    latest_decision: runtimeActive ? algobot.latest_decisions[0] ?? null : null,
    alerts: risk.recent_events.slice(0, 10),
    system_state: system.overall_state,
    sources: {
      portfolio: bybitBots.source,
      algobot: algobot.source,
      risk: risk.source,
      system: system.source,
    },
  });
}
