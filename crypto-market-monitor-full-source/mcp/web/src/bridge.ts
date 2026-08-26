import "./host.ts";

let nextRequestId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: number }>();
let installed = false;

function ensureResponseListener() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0" || typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    window.clearTimeout(request.timer);
    if (message.error) request.reject(new Error(String(message.error.message ?? "bridge_error")));
    else request.resolve(message.result);
  }, { passive: true });
}

async function bridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  ensureResponseListener();
  if (window.parent === window) throw new Error("mcp_bridge_unavailable");
  const id = nextRequestId++;
  const promise = new Promise<unknown>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("mcp_bridge_timeout"));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
  });
  window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  return promise;
}

function structuredContent(result: unknown): unknown {
  if (result && typeof result === "object" && "structuredContent" in result) {
    return (result as { structuredContent?: unknown }).structuredContent;
  }
  return result;
}

export async function callCryptoBotTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  try {
    return structuredContent(await bridgeRequest("tools/call", { name, arguments: args }));
  } catch (bridgeError) {
    if (!window.openai?.callTool) throw bridgeError;
    return structuredContent(await window.openai.callTool(name, args));
  }
}

export function subscribeToolResults(listener: (structuredContent: unknown) => void): () => void {
  const initial = window.openai?.toolOutput;
  if (initial !== undefined) listener(initial);
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0" || message.method !== "ui/notifications/tool-result") return;
    listener(message.params?.structuredContent);
  };
  window.addEventListener("message", onMessage, { passive: true });
  return () => window.removeEventListener("message", onMessage);
}

export function readWidgetState<T>(): T | null {
  const value = window.openai?.widgetState;
  return value && typeof value === "object" ? value as T : null;
}

export function writeWidgetState(value: unknown) {
  window.openai?.setWidgetState?.(value);
}

export async function requestFullscreen(): Promise<boolean> {
  if (!window.openai?.requestDisplayMode) return false;
  await window.openai.requestDisplayMode({ mode: "fullscreen" });
  return true;
}

export function canRequestFullscreen(): boolean {
  return Boolean(window.openai?.requestDisplayMode);
}
