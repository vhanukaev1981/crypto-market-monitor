import type { FreshnessState } from "./domain.ts";

export type FreshnessPolicy = {
  freshSeconds: number;
  staleSeconds: number;
};

export const FRESHNESS_POLICIES = {
  algobot: { freshSeconds: 15, staleSeconds: 60 },
  algobotResearch: { freshSeconds: 21_600, staleSeconds: 86_400 },
  risk: { freshSeconds: 15, staleSeconds: 60 },
  reconciliation: { freshSeconds: 60, staleSeconds: 180 },
  bybitAccount: { freshSeconds: 75, staleSeconds: 180 },
} as const satisfies Record<string, FreshnessPolicy>;

export function computeFreshness(
  observedAt: string | null | undefined,
  policy: FreshnessPolicy,
  nowMs = Date.now(),
): { ageSeconds: number | null; state: FreshnessState } {
  if (!observedAt) return { ageSeconds: null, state: "unavailable" };
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return { ageSeconds: null, state: "unavailable" };

  const ageSeconds = Math.max(0, Math.floor((nowMs - observedMs) / 1000));
  if (ageSeconds <= policy.freshSeconds) return { ageSeconds, state: "fresh" };
  if (ageSeconds <= policy.staleSeconds) return { ageSeconds, state: "aging" };
  return { ageSeconds, state: "stale" };
}
