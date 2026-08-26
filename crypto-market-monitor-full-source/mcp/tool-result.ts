export type StructuredToolResult<T extends Record<string, unknown>> = {
  structuredContent: T;
  content: Array<{ type: "text"; text: string }>;
};

export function toolResult<T extends Record<string, unknown>>(
  structuredContent: T,
  summary: string,
): StructuredToolResult<T> {
  return {
    structuredContent,
    content: [{ type: "text", text: summary }],
  };
}

export function safeToolError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "internal_error";
  const allowed = new Set([
    "invalid_decision_id",
    "decision_not_found",
    "decision_source_unavailable",
    "authentication_required",
    "principal_not_allowed",
    "insufficient_scope",
  ]);
  return new Error(allowed.has(message) ? message : "cryptobot_data_unavailable");
}
