import { BybitBotsOutputSchema, type BybitBotsOutput } from "./domain.ts";
import { computeFreshness, FRESHNESS_POLICIES } from "./freshness.ts";

type SnapshotLike = {
  account?: unknown;
  checked_at?: string | null;
  last_error?: unknown;
};

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isBotAccountType(value: unknown): boolean {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return normalized.includes("bot") || normalized === "tradingbot";
}

function detectedBotKind(category: string): "spot_grid" | "dca" | "other" {
  const normalized = category.toLowerCase();
  if (normalized.includes("grid")) return "spot_grid";
  if (normalized.includes("dca")) return "dca";
  return "other";
}

export function normalizeBybitBotVisibility(snapshot: SnapshotLike, nowMs = Date.now()): BybitBotsOutput {
  const account = asRow(snapshot.account);
  const breakdown = Array.isArray(account.account_type_breakdown)
    ? account.account_type_breakdown.map(asRow)
    : [];
  const botRows = breakdown.filter((row) => isBotAccountType(row.type ?? row.account_type));
  const values = botRows.map((row) => finiteNumber(row.usd_value ?? row.equity_usd)).filter((value): value is number => value !== null);
  const totalBotEquity = values.length ? values.reduce((sum, value) => sum + value, 0) : null;

  const ethBreakdown = Array.isArray(account.eth_breakdown)
    ? account.eth_breakdown.map(asRow)
    : [];
  const detectedRows = ethBreakdown.filter((row) =>
    isBotAccountType(row.account_type) && typeof row.category === "string" && row.category.trim().length > 0
  );
  const unique = new Map<string, Row>();
  for (const row of detectedRows) unique.set(String(row.category), row);

  const observedAt = typeof snapshot.checked_at === "string" ? snapshot.checked_at : null;
  const bots = [...unique.entries()].map(([category, row], index) => {
    const kind = detectedBotKind(category);
    return {
      id: `bybit-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index}`,
      kind,
      symbol: kind === "spot_grid" ? "ETHUSDT" : null,
      status: "detected" as const,
      invested_usd: null,
      equity_usd: null,
      total_pnl_usd: null,
      total_pnl_pct: null,
      grid_profit_usd: null,
      range_low: null,
      range_high: null,
      grid_count: null,
      observed_eth_quantity: finiteNumber(row.quantity),
      observed_at: observedAt,
    };
  });

  const freshness = computeFreshness(observedAt, FRESHNESS_POLICIES.bybitAccount, nowMs);
  const hasError = Boolean(snapshot.last_error);
  const detailsStatus = bots.length
    ? "allocation_detected_performance_unavailable"
    : totalBotEquity === null
      ? "bot_account_not_reported"
      : "account_level_only";

  return BybitBotsOutputSchema.parse({
    bots,
    total_bot_account_equity_usd: totalBotEquity,
    details_available: false,
    details_status: detailsStatus,
    source: {
      observed_at: observedAt,
      age_seconds: freshness.ageSeconds,
      freshness_state: freshness.state,
      source_state: hasError ? "attention" : freshness.state === "unavailable" ? "unknown" : freshness.state === "stale" ? "attention" : "ok",
    },
  });
}
