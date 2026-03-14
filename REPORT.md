# OpenClaw Web Search Custom API Integration Report

## Scope
This report documents the end-to-end changes to route OpenClaw’s built-in `web_search` tool to a custom local API, starting from OpenClaw config changes and ending at the server-side behavior required to handle the calls.

## 1) OpenClaw Config Changes (`openclaw.json`)
Key configuration updates were made to:

- **Enable the `web_search` tool** in the allowlist.
- **Select Perplexity provider** for `web_search`.
- **Point Perplexity base URL** to the local API’s OpenAI-compatible endpoint.
- **Set the default LLM provider/model** to your custom API (`modelrouter/auto`).

Example (simplified):
```json
{
  "models": {
    "mode": "replace",
    "providers": {
      "modelrouter": {
        "baseUrl": "http://127.0.0.1:8000/v1",
        "apiKey": "local-proxy",
        "api": "openai-completions",
        "authHeader": true,
        "models": [
          {
            "id": "auto",
            "name": "ModelRouter Auto",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "modelrouter/auto" },
      "compaction": { "mode": "safeguard" }
    }
  },
  "tools": {
    "allow": [
      "group:fs",
      "group:runtime",
      "group:sessions",
      "group:memory",
      "web_search"
    ],
    "web": {
      "search": {
        "provider": "perplexity",
        "perplexity": {
          "baseUrl": "http://127.0.0.1:8000/v1",
          "apiKey": "local-dev"
        }
      }
    }
  }
}
```

### Effect
OpenClaw’s `web_search` now calls:

```
POST http://127.0.0.1:8000/v1/chat/completions
```

using the Perplexity provider path.

### Optional cleanup (if you previously used a local-search plugin)
If `plugins.local-search` was configured earlier, it should be removed to avoid startup errors and duplicate routing. After removal, OpenClaw relies entirely on the built-in `web_search` tool + provider config above.

## 2) OpenClaw Internal Behavior (No Core Code Changes)
OpenClaw’s built-in `web_search` tool uses the Perplexity provider path when configured:

- It constructs `{baseUrl}/chat/completions`.
- It sends `Authorization: Bearer <apiKey>`.
- It expects an OpenAI-compatible response.

No OpenClaw core code was modified; routing is driven entirely by configuration.

## 3) Custom API Requirements (Server-Side)
Your custom API must:

- Accept **OpenAI chat-completions** payloads at `/v1/chat/completions`.
- Support **streaming** (`stream=true`) responses.
- Emit **tool calls** (`tool_calls`) when a tool should be invoked.

This is required so OpenClaw can:

1. Ask the model to decide whether to use `web_search`.
2. Run the tool when the model requests it.
3. Send tool results back to the model for final synthesis.

## 4) Source Code Changes (Custom API)
On the API side (your `api.py`), changes were added to:

- Detect presence of `web_search` tool in incoming requests.
- Generate tool calls when a search is needed (tool-calling shim).
- Handle streaming tool call responses (SSE format with `tool_calls` and `finish_reason="tool_calls"`).
- Accept tool results (second round) and produce final answer.

## 5) End-to-End Flow (Result)
1. **User asks a question.**
2. OpenClaw sends `tools` to `/v1/chat/completions`.
3. Your API returns a `tool_calls` response for `web_search`.
4. OpenClaw executes `web_search` and calls your API again with a tool result.
5. Your API returns the final answer.

## 6) Summary
OpenClaw was not modified internally. The integration is achieved by:

- Updating user config to route `web_search` to a local API.
- Implementing tool-calling and tool-result handling in the custom API.

This keeps OpenClaw’s official web tool pipeline intact while letting you control the underlying search backend.
