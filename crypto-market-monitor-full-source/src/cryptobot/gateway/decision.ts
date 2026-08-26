import { DecisionExplanationSchema, type DecisionExplanation, type DecisionSummarySchema } from "../domain.ts";
import { FRESHNESS_POLICIES } from "../freshness.ts";
import type { Row } from "../repository.ts";
import { iso, num, row, rows, sourceMeta, text } from "./shared.ts";

export function decisionSummary(value: Row) {
  const rejectionCodes = Array.isArray(value.rejection_codes) ? value.rejection_codes.map(String) : [];
  return {
    id: String(value.id ?? ""),
    strategy: text(value.strategy_key),
    symbol: text(value.symbol),
    direction: text(value.signal),
    decision: value.eligible === true ? "eligible" : "rejected",
    reason: rejectionCodes.length ? rejectionCodes.join(", ") : text(row(value.metadata).decision && row(row(value.metadata).decision).reason),
    observed_at: iso(value.created_at),
  };
}

function evidenceFromMetadata(metadata: Row): string[] {
  const evidence: string[] = [];
  const analysis = row(metadata.analysis);
  const decision = row(metadata.decision);
  if (text(analysis.regime)) evidence.push(`regime=${text(analysis.regime)}`);
  if (num(analysis.regimeConfidence) !== null) evidence.push(`regime_confidence=${num(analysis.regimeConfidence)}`);
  if (num(decision.score) !== null) evidence.push(`score=${num(decision.score)}`);
  if (text(decision.reason)) evidence.push(`reason=${text(decision.reason)}`);
  return evidence;
}

export function explainPersistedDecision(value: Row, nowMs = Date.now()): DecisionExplanation {
  const metadata = row(value.metadata);
  const rejectionReasons = Array.isArray(value.rejection_codes) ? value.rejection_codes.map(String) : [];
  const eligible = value.eligible === true;
  const observedAt = iso(value.created_at);
  const explanationHe = eligible
    ? "ההחלטה סומנה ככשירה לפי הנתונים שנשמרו במנוע האסטרטגיה."
    : rejectionReasons.length
      ? `העסקה נדחתה. סיבות שנשמרו במערכת: ${rejectionReasons.join(", ")}.`
      : "העסקה נדחתה, אך לא נשמר נימוק מפורט.";

  return DecisionExplanationSchema.parse({
    decision_id: String(value.id ?? ""),
    strategy: text(value.strategy_key),
    symbol: text(value.symbol),
    direction: text(value.signal),
    signal: text(value.signal),
    signal_evidence: evidenceFromMetadata(metadata),
    risk_checks: rejectionReasons.map((reason) => ({ name: reason, state: "failed" as const, detail: null })),
    market_checks: {
      spread_bps: num(value.spread_bps),
      estimated_slippage_bps: num(value.estimated_slippage_bps),
      expected_net_edge_bps: num(value.expected_net_edge_bps),
    },
    final_decision: eligible ? "eligible" : "rejected",
    rejection_reasons: rejectionReasons,
    explanation_he: explanationHe,
    observed_at: observedAt,
    source: sourceMeta(observedAt, FRESHNESS_POLICIES.algobot, "ok", nowMs),
  });
}
