// OpenAI provider — for Codex CLI and OpenAI-compatible clients
// Supports both Chat Completions API (/v1/chat/completions) and Responses API (/responses)

export default {
  name: "openai",
  target: "https://api.openai.com",
  // Codex CLI default base is https://api.openai.com/v1, so requests arrive
  // without the /v1 prefix. We prepend it when the path doesn't already have it.
  pathPrefix: "/v1",
  envVar: "OPENAI_BASE_URL",

  // Resolve the correct upstream target based on auth type.
  // Codex CLI with ChatGPT account auth (JWT + chatgpt-account-id header)
  // uses https://chatgpt.com/backend-api/codex, not api.openai.com.
  resolveTarget(headers) {
    if (headers["chatgpt-account-id"]) {
      return {
        target: "https://chatgpt.com",
        pathPrefix: "/backend-api/codex",
      };
    }
    return { target: this.target, pathPrefix: this.pathPrefix };
  },

  maskSecrets(headers) {
    const masked = { ...headers };
    if (masked["authorization"]) {
      const a = masked["authorization"];
      masked["authorization"] = a.slice(0, 20) + "..." + a.slice(-4);
    }
    return masked;
  },

  classifyRequest(method, url, body) {
    if (url.includes("/v1/models") || url.startsWith("/models")) return "models";
    // Responses API (Codex CLI)
    if (url.includes("/responses")) {
      if (body?.stream) return "responses_stream";
      return "responses";
    }
    // Chat Completions API
    if (url.includes("/v1/chat/completions") || url.includes("/chat/completions")) {
      if (body?.stream) return "chat_stream";
      return "chat_completion";
    }
    if (url.includes("/v1/completions")) {
      if (body?.stream) return "completion_stream";
      return "completion";
    }
    if (url.includes("/v1/embeddings")) return "embeddings";
    return "unknown";
  },

  extractRequestFields(body) {
    if (!body || typeof body !== "object") return {};

    // Responses API uses "input" (array of items) and "instructions"
    if (body.input !== undefined) {
      return extractResponsesApiFields(body);
    }

    // Chat Completions API uses "messages"
    return extractChatCompletionsFields(body);
  },

  detectAgentRole(body, currentParent, reqId) {
    // Codex CLI doesn't have Agent tool pattern — all requests with tools are "main"
    const tools = body?.tools || [];
    let agentRole = tools.length > 0 ? "main" : "utility";
    return { agentRole, parentId: null, newParent: currentParent };
  },

  extractRateLimits(headers) {
    const limits = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith("x-ratelimit-")) {
        const shortKey = k.replace("x-ratelimit-", "");
        limits[shortKey] = v;
      }
      // ChatGPT backend sends x-codex-* rate limit headers
      if (k.startsWith("x-codex-") && v) {
        const shortKey = k.replace("x-codex-", "");
        limits[shortKey] = v;
      }
    }
    return limits;
  },

  parseSSEChunk(text, buffer) {
    const combined = buffer + text;
    const parts = combined.split("\n\n");
    const remainingBuffer = parts.pop();
    const events = [];

    for (const part of parts) {
      if (!part.trim()) continue;
      const lines = part.split("\n");
      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7);
        else if (line.startsWith("data: ")) eventData += line.slice(6);
      }

      if (eventData === "[DONE]") {
        events.push({ type: "done", data: "[DONE]" });
        continue;
      }

      // Use explicit event type if present (Responses API sends event: lines),
      // otherwise classify from data shape (Chat Completions API)
      const type = eventType || classifyOpenAIChunk(eventData);
      events.push({ type, data: eventData });
    }

    return { events, remainingBuffer };
  },

  processSSEEvent(event, currentParent, reqId, log) {
    const { type: eventType, parsed } = event;

    let logLine = null;

    if (eventType === "done") {
      logLine = `#${reqId} [DONE]`;

    // ── Responses API events ──
    } else if (eventType === "response.output_text.delta") {
      const delta = parsed?.delta || "";
      logLine = `#${reqId} text: "${delta.slice(0, 80)}${delta.length > 80 ? "..." : ""}"`;
    } else if (eventType === "response.output_text.done") {
      logLine = `#${reqId} text_done (${(parsed?.text || "").length} chars)`;
    } else if (eventType === "response.function_call_arguments.delta") {
      logLine = `#${reqId} fn_args: ${(parsed?.delta || "").slice(0, 80)}`;
    } else if (eventType === "response.function_call_arguments.done") {
      logLine = `#${reqId} fn_done: ${parsed?.name || "?"} (${(parsed?.arguments || "").length} chars)`;
    } else if (eventType === "response.created" || eventType === "response.in_progress") {
      logLine = `#${reqId} ${eventType}`;
    } else if (eventType === "response.completed" || eventType === "response.done") {
      logLine = `#${reqId} ${eventType}: ${JSON.stringify(parsed?.usage || parsed?.status || "").slice(0, 120)}`;
    } else if (eventType.startsWith("response.")) {
      logLine = `#${reqId} ${eventType}`;

    // ── Chat Completions API events ──
    } else if (eventType === "chat_chunk") {
      const delta = parsed?.choices?.[0]?.delta;
      if (delta?.content) {
        logLine = `#${reqId} text: "${delta.content.slice(0, 80)}${delta.content.length > 80 ? "..." : ""}"`;
      } else if (delta?.tool_calls) {
        const tc = delta.tool_calls[0];
        if (tc?.function?.name) {
          logLine = `#${reqId} tool_call: ${tc.function.name}`;
        } else if (tc?.function?.arguments) {
          logLine = `#${reqId} tool_args: ${tc.function.arguments.slice(0, 80)}`;
        }
      } else if (delta?.role) {
        logLine = `#${reqId} role: ${delta.role}`;
      } else if (parsed?.choices?.[0]?.finish_reason) {
        logLine = `#${reqId} finish: ${parsed.choices[0].finish_reason}`;
      } else {
        logLine = `#${reqId} chunk: ${JSON.stringify(parsed).slice(0, 120)}`;
      }
    } else {
      logLine = `#${reqId} ${eventType}: ${JSON.stringify(parsed).slice(0, 120)}`;
    }

    return { logLine, agentSpawn: null, newParent: currentParent };
  },
};

// ── Helpers ──

function extractResponsesApiFields(body) {
  // Responses API: input is an array of conversation items
  const input = body.input || [];

  // Convert input items to messages-like format for the dashboard
  const messages = [];
  let system = body.instructions || null;

  for (const item of Array.isArray(input) ? input : []) {
    if (item.role === "system") {
      system = system || (typeof item.content === "string" ? item.content : JSON.stringify(item.content));
    } else if (item.type === "reasoning") {
      // Reasoning/thinking block — show summary if available, skip if empty
      const summary = item.summary?.map((s) => s.text || "").join("\n").trim();
      if (summary) {
        messages.push({
          role: "assistant",
          content: [{ type: "thinking", thinking: summary }],
        });
      }
    } else if (item.type === "message" || item.role) {
      messages.push({
        role: item.role || "user",
        content: normalizeResponsesContent(item.content),
      });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", name: item.name, input: item.arguments }],
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }],
      });
    } else {
      messages.push({ role: item.role || "unknown", content: normalizeResponsesContent(item.content) || JSON.stringify(item) });
    }
  }

  // Normalize tools — ensure every entry has at least { name, description, input_schema }
  let tools = null;
  if (body.tools) {
    tools = body.tools
      .map((t) => {
        if (t.type === "function") {
          return {
            name: t.name,
            description: t.description || null,
            input_schema: t.parameters || null,
            _openai_raw: t,
          };
        }
        // Custom tools (e.g. apply_patch with grammar format)
        if (t.name) {
          return {
            name: t.name,
            description: t.description || null,
            input_schema: null,
            _openai_raw: t,
          };
        }
        // Capability entries without a name (e.g. web_search) — synthesize name
        if (t.type) {
          return {
            name: t.type,
            description: `${t.type} capability`,
            input_schema: null,
            _openai_raw: t,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  return {
    model: body.model || null,
    system,
    messages: messages.length > 0 ? messages : null,
    tools,
    thinking: null,
    stream: body.stream || false,
    maxTokens: body.max_output_tokens || null,
    metadata: null,
    contextManagement: null,
  };
}

function extractChatCompletionsFields(body) {
  const messages = body.messages || null;
  let system = null;
  if (messages) {
    const systemMsgs = messages.filter((m) => m.role === "system");
    if (systemMsgs.length > 0) {
      system = systemMsgs.map((m) => m.content).join("\n\n");
    }
  }

  let tools = null;
  if (body.tools) {
    tools = body.tools.map((t) => {
      if (t.type === "function" && t.function) {
        return {
          name: t.function.name,
          description: t.function.description || null,
          input_schema: t.function.parameters || null,
          _openai_raw: t,
        };
      }
      return t;
    });
  }

  return {
    model: body.model || null,
    system,
    messages,
    tools,
    thinking: null,
    stream: body.stream || false,
    maxTokens: body.max_tokens || body.max_completion_tokens || null,
    metadata: null,
    contextManagement: null,
  };
}

// Normalize Responses API content blocks: input_text/output_text → text
function normalizeResponsesContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block.type === "input_text") {
      return { type: "text", text: block.text || "" };
    }
    if (block.type === "output_text") {
      return { type: "text", text: block.text || "" };
    }
    return block;
  });
}

function classifyOpenAIChunk(dataStr) {
  try {
    const obj = JSON.parse(dataStr);
    if (obj.object === "chat.completion.chunk") return "chat_chunk";
    return "data";
  } catch {
    return "data";
  }
}
