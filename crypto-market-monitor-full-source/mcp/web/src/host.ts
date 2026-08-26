export type DisplayMode = "inline" | "fullscreen" | "pip";

export type OpenAiHost = {
  toolOutput?: unknown;
  widgetState?: unknown;
  displayMode?: DisplayMode;
  setWidgetState?: (state: unknown) => void;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  requestDisplayMode?: (request: { mode: DisplayMode }) => Promise<unknown>;
  sendFollowUpMessage?: (request: { prompt: string; scrollToBottom?: boolean }) => Promise<unknown>;
};

declare global {
  interface Window {
    openai?: OpenAiHost;
  }
}

export {};
