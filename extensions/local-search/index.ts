import type { OpenClawPluginApi, ResolvedPluginContext } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "@sinclair/typebox";

type McpConfig = {
  baseUrl?: string;
  protocolVersion?: string;
  timeoutMs?: number;
};

type McpResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { message?: string };
};

type McpClientInfo = {
  name: string;
  version: string;
};

type McpClient = {
  request: (method: string, params: Record<string, unknown>) => Promise<McpResponse["result"]>;
  notify: (method: string, params: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 15000;

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

async function createMcpClient(baseUrl: string, clientInfo: McpClientInfo, protocolVersion: string, timeoutMs: number): Promise<McpClient> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const sseUrl = new URL("/mcp/sse", normalizedBaseUrl).toString();
  const fallbackMessagesUrl = new URL("/mcp/messages", normalizedBaseUrl).toString();
  const controller = new AbortController();

  const response = await fetch(sseUrl, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`MCP SSE connection failed: HTTP ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let endpointUrl: string | null = null;
  let endpointResolve: ((value: string) => void) | null = null;
  let endpointReject: ((reason?: unknown) => void) | null = null;

  const endpointPromise = new Promise<string>((resolve, reject) => {
    endpointResolve = resolve;
    endpointReject = reject;
  });

  const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();

  const setEndpoint = (value: string) => {
    if (endpointUrl) {
      return;
    }
    endpointUrl = new URL(value, normalizedBaseUrl).toString();
    endpointResolve?.(endpointUrl);
  };

  const readLoop = (async () => {
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let splitIndex = buffer.indexOf("\n\n");
        while (splitIndex >= 0) {
          const rawEvent = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          splitIndex = buffer.indexOf("\n\n");

          const lines = rawEvent.split("\n");
          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          const data = dataLines.join("\n");

          if (!data) {
            continue;
          }

          if (eventName === "endpoint") {
            setEndpoint(data);
            continue;
          }

          let message: McpResponse | null = null;
          try {
            message = JSON.parse(data) as McpResponse;
          } catch {
            continue;
          }

          if (message && message.id !== null && message.id !== undefined) {
            const waiter = pending.get(message.id);
            if (waiter) {
              pending.delete(message.id);
              if (message.error) {
                waiter.reject(new Error(message.error.message || "MCP error"));
              } else {
                waiter.resolve(message.result);
              }
            }
          }
        }
      }
    } catch (error) {
      endpointReject?.(error);
    }
  })();

  const messagesUrl = await withTimeout(
    endpointPromise.catch(() => fallbackMessagesUrl),
    1500,
    "MCP endpoint timeout"
  ).catch(() => fallbackMessagesUrl);

  if (!endpointUrl) {
    setEndpoint(messagesUrl);
  }

  const sendMessage = async (payload: Record<string, unknown>) => {
    const res = await fetch(endpointUrl ?? messagesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`MCP message POST failed: HTTP ${res.status} ${res.statusText}`);
    }
  };

  const request = async (method: string, params: Record<string, unknown>) => {
    const id = Date.now().toString() + Math.random().toString(16).slice(2);
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    await sendMessage({ jsonrpc: "2.0", id, method, params });
    return withTimeout(promise, timeoutMs, `MCP request timeout: ${method}`);
  };

  const notify = async (method: string, params: Record<string, unknown>) => {
    await sendMessage({ jsonrpc: "2.0", method, params });
  };

  const close = async () => {
    controller.abort();
    try {
      await readLoop;
    } catch {
      // Ignore errors on shutdown.
    }
  };

  await request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo,
  });
  await notify("initialized", {});

  return { request, notify, close };
}

function createSearchWebTool(context: ResolvedPluginContext): AnyAgentTool {
  const config = context.pluginConfig as McpConfig;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const protocolVersion = config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "search_web",
    description: "Search the web for current information using DuckDuckGo Search",
    schema: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(Type.Integer({ description: "Maximum number of results to return (default 5)" })),
    }),
    execute: async (params, _ctx) => {
      let client: McpClient | null = null;
      try {
        client = await createMcpClient(
          baseUrl,
          { name: "openclaw-local-search", version: "1.0.0" },
          protocolVersion,
          timeoutMs
        );

        const result = await client.request("tools/call", {
          name: "search_web",
          arguments: {
            query: params.query,
            max_results: params.max_results,
          },
        });

        await client.close();
        client = null;

        const content = (result as { content?: unknown })?.content;
        if (Array.isArray(content)) {
          return { content };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (client) {
          await client.close();
        }
        return {
          content: [
            {
              type: "text",
              text: `Search API failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  };
}

const plugin = {
  id: "local-search",
  name: "Local Search",
  description: "Wrapper for local DDGS search API",
  configSchema: Type.Object({
    baseUrl: Type.Optional(Type.String({
      description: "Base URL for the search API",
      default: DEFAULT_BASE_URL
    })),
    protocolVersion: Type.Optional(Type.String({
      description: "MCP protocol version to use for the SSE transport",
      default: DEFAULT_PROTOCOL_VERSION
    })),
    timeoutMs: Type.Optional(Type.Integer({
      description: "Timeout in milliseconds for MCP requests",
      default: DEFAULT_TIMEOUT_MS
    })),
  }),
  register(api: OpenClawPluginApi) {
    api.registerTool(createSearchWebTool(api.context) as unknown as AnyAgentTool, { optional: true });
  },
};

export default plugin;
