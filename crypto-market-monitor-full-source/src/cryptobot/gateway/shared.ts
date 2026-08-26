import type { SourceMeta, SourceState } from "../domain.ts";
import { computeFreshness, type FreshnessPolicy } from "../freshness.ts";
import type { Row } from "../repository.ts";

export function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

export function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(row) : [];
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function text(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return null;
}

export function iso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function sourceMeta(
  observedAt: unknown,
  policy: FreshnessPolicy,
  sourceState: SourceState = "ok",
  nowMs = Date.now(),
): SourceMeta {
  const observed = iso(observedAt);
  const freshness = computeFreshness(observed, policy, nowMs);
  const state = sourceState === "ok" && freshness.state === "stale" ? "attention" : sourceState;
  return {
    observed_at: observed,
    age_seconds: freshness.ageSeconds,
    freshness_state: freshness.state,
    source_state: freshness.state === "unavailable" && state === "ok" ? "unknown" : state,
  };
}

export function latestTimestamp(values: unknown[]): string | null {
  const timestamps = values.map(iso).filter((value): value is string => Boolean(value));
  if (!timestamps.length) return null;
  return timestamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

export function severityToAlert(value: unknown): "info" | "warning" | "critical" {
  const normalized = String(value ?? "").toLowerCase();
  if (["critical", "fatal", "emergency", "high"].some((token) => normalized.includes(token))) return "critical";
  if (["warn", "medium", "attention"].some((token) => normalized.includes(token))) return "warning";
  return "info";
}

export function strategyMode(value: unknown): "paper" | "shadow" | "demo" | "live" | "research" | "unknown" {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("shadow")) return "shadow";
  if (normalized.includes("paper")) return "paper";
  if (normalized.includes("demo")) return "demo";
  if (normalized.includes("live")) return "live";
  if (normalized.includes("research")) return "research";
  return "unknown";
}
