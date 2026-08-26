export const STANDALONE_PREVIEW_TOOLS = [
  "open_control_center",
  "get_dashboard_overview",
  "get_algobot_status",
  "get_bybit_bots",
  "get_portfolio",
  "get_risk_status",
  "get_system_health",
  "explain_decision",
] as const;

export type StandalonePreviewTool = typeof STANDALONE_PREVIEW_TOOLS[number];

const STANDALONE_PREVIEW_TOOL_SET = new Set<string>(STANDALONE_PREVIEW_TOOLS);

export function isStandalonePreviewTool(value: string): value is StandalonePreviewTool {
  return STANDALONE_PREVIEW_TOOL_SET.has(value);
}
