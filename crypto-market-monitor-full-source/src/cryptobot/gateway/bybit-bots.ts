import type { BybitBotsOutput } from "../domain.ts";
import type { Row } from "../repository.ts";
import { normalizeBybitBotVisibility } from "../bybit-bot-normalizer.ts";

export function mapBybitBots(snapshot: Row | null, nowMs = Date.now()): BybitBotsOutput {
  return normalizeBybitBotVisibility({
    account: snapshot?.account,
    checked_at: typeof snapshot?.checked_at === "string" ? snapshot.checked_at : null,
    last_error: snapshot?.last_error,
  }, nowMs);
}
