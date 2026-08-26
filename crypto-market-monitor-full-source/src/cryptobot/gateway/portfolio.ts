import { PortfolioOutputSchema, type PortfolioOutput } from "../domain.ts";
import { FRESHNESS_POLICIES } from "../freshness.ts";
import type { Row } from "../repository.ts";
import { iso, num, row, rows, sourceMeta, text } from "./shared.ts";

export function mapPortfolio(
  snapshot: Row | null,
  assets: Row[],
  positions: Row[],
  executions: Row[],
  sourceError: boolean,
  nowMs = Date.now(),
): PortfolioOutput {
  const account = row(snapshot?.account);
  const breakdown = rows(account.account_type_breakdown).map((item) => ({
    account_type: String(item.type ?? item.account_type ?? "UNKNOWN"),
    usd_value: num(item.usd_value ?? item.equity_usd),
  }));

  const mappedAssets = assets.map((item) => ({
    coin: String(item.coin ?? ""),
    quantity: num(item.equity ?? item.wallet_balance),
    usd_value: num(item.usd_value),
    account_type: text(item.asset_class),
  }));

  const mappedPositions = positions.map((item) => ({
    id: String(item.position_id ?? `${item.symbol ?? "position"}:${item.opened_at ?? "unknown"}`),
    market: String(item.market ?? "unknown"),
    symbol: String(item.symbol ?? ""),
    side: String(item.direction ?? "unknown"),
    quantity: num(item.qty),
    entry_price: num(item.entry_price),
    current_price: num(item.current_price),
    notional_usd: num(item.notional_usdt),
    unrealized_pnl_usd: num(item.unrealized_pnl),
    realized_pnl_usd: null,
    stop_loss_price: num(item.stop_loss_price),
    take_profit_price: num(item.take_profit_price),
    leverage: null,
    protection_status: text(item.protection_status),
    strategy_key: text(item.strategy_key),
    opened_at: iso(item.opened_at),
  }));

  const recentTrades = executions.map((item) => ({
    id: String(item.id ?? ""),
    symbol: String(item.symbol ?? ""),
    side: String(item.side ?? "unknown"),
    quantity: num(item.qty),
    price: num(item.price),
    fee_usd: num(item.fee_usdt),
    realized_pnl_usd: num(item.realized_pnl),
    executed_at: iso(item.executed_at),
  }));

  const observedAt = iso(snapshot?.checked_at) ?? iso(assets[0]?.checked_at);
  return PortfolioOutputSchema.parse({
    total_equity_usd: num(account.total_assets_usd ?? account.total_equity),
    account_breakdown: breakdown,
    assets: mappedAssets,
    positions: mappedPositions,
    recent_trades: recentTrades,
    source: sourceMeta(observedAt, FRESHNESS_POLICIES.bybitAccount, sourceError ? "fault" : snapshot?.last_error ? "attention" : "ok", nowMs),
  });
}
