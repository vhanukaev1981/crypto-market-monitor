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

export function normalizeBybitBotVisibility(snapshot: SnapshotLike, nowMs = Date.now()): BybitBotsOutput {
  const account = asRow(snapshot.account);
  const breakdown = Array.isArray(account.account_type_breakdown)
    ? account.account_type_breakdown.map(asRow)
    : [];
  const botRows = breakdown.filter((row) => isBotAccountType(row.type ?? row.account_type));
  const values = botRows.map((row) => finiteNumber(row.usd_value ?? row.equity_usd)).filter((value): value is number => value !== null);
  const totalBotEquity = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  const observedAt = typeof snapshot.checked_at === "string" ? snapshot.checked_at : null;
  const freshness = computeFreshness(observedAt, FRESHNESS_POLICIES.bybitAccount, nowMs);
  const hasError = Boolean(snapshot.last_error);

  return BybitBotsOutputSchema.parse({
    bots: [],
    total_bot_account_equity_usd: totalBotEquity,
    details_available: false,
    details_status: totalBotEquity === null ? "bot_account_not_reported" : "account_level_only",
    source: {
      observed_at: observedAt,
      age_seconds: freshness.ageSeconds,
      freshness_state: freshness.state,
      source_state: hasError ? "attention" : freshness.state === "unavailable" ? "unknown" : freshness.state === "stale" ? "attention" : "ok",
    },
  });
}
