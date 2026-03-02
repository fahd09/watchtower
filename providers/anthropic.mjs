// Anthropic provider — Claude Code, Claude API

export default {
  name: "anthropic",
  target: "https://api.anthropic.com",
  envVar: "ANTHROPIC_BASE_URL",

  maskSecrets(headers) {
    const masked = { ...headers };
    if (masked["x-api-key"]) {
      const k = masked["x-api-key"];
      masked["x-api-key"] = k.slice(0, 12) + "..." + k.slice(-4);
    }
    if (masked["authorization"]) {
      const a = masked["authorization"];
      masked["authorization"] = a.slice(0, 20) + "..." + a.slice(-4);
    }
    return masked;
  },

  classifyRequest(method, url, body) {
    if (url.includes("/count_tokens")) return "token_count";
    if (url.includes("/messages") && body?.max_tokens === 1) return "quota_check";
    if (url.includes("/messages") && body?.stream) return "messages_stream";
    if (url.includes("/messages")) return "messages";
    return "unknown";
  },

  extractRequestFields(body) {
    if (!body || typeof body !== "object") return {};
    return {
      model: body.model || null,
      system: body.system || null,
      messages: body.messages || null,
      tools: body.tools || null,
      thinking: body.thinking || null,
      stream: body.stream || false,
      maxTokens: body.max_tokens || null,
      metadata: body.metadata || null,
      contextManagement: body.context_management || null,
    };
  },

  detectAgentRole(body, currentParent, reqId) {
    const tools = body?.tools || [];
    const hasAgentTool = tools.some((t) => t.name === "Agent");
    let agentRole = "utility";
    let parentId = null;
    let newParent = currentParent;

    if (hasAgentTool) {
      agentRole = "main";
      newParent = { reqId, toolUseIds: [] };
    } else if (tools.length > 0) {
      agentRole = "subagent";
      if (currentParent && currentParent.toolUseIds.length > 0) {
        parentId = currentParent.reqId;
      }
    } else {
      if (currentParent && currentParent.toolUseIds.length > 0) {
        parentId = currentParent.reqId;
      }
    }

    return { agentRole, parentId, newParent };
  },

  extractRateLimits(headers) {
    const limits = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith("anthropic-ratelimit")) {
        const shortKey = k.replace("anthropic-ratelimit-", "");
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

      events.push({ type: eventType, data: eventData });
    }

    return { events, remainingBuffer };
  },

  processSSEEvent(event, currentParent, reqId, log) {
    let logLine = null;
    let agentSpawn = null;
    let newParent = currentParent;

    const { type: eventType, parsed } = event;

    // Track Agent tool_use blocks for hierarchy linking
    if (eventType === "content_block_start") {
      const cb = parsed?.content_block;
      if (cb?.type === "tool_use" && cb?.name === "Agent" && currentParent?.reqId === reqId) {
        currentParent.toolUseIds.push(cb.id);
        newParent = currentParent;
        logLine = `#${reqId} Agent tool_use spawned: ${cb.id}`;
        agentSpawn = { parentId: reqId, toolUseId: cb.id };
      }
    }

    // Compact console logging
    if (eventType === "content_block_delta") {
      const delta = parsed?.delta;
      if (delta?.type === "text_delta") {
        logLine = logLine || `#${reqId} text: "${delta.text.slice(0, 80)}${delta.text.length > 80 ? "..." : ""}"`;
      } else if (delta?.type === "thinking_delta") {
        logLine = logLine || `#${reqId} think: "${delta.thinking.slice(0, 80)}..."`;
      } else {
        logLine = logLine || `#${reqId} ${eventType}: ${JSON.stringify(delta).slice(0, 120)}`;
      }
    } else if (eventType === "message_start" || eventType === "message_stop" || eventType === "message_delta") {
      logLine = logLine || `#${reqId} ${eventType}: ${JSON.stringify(parsed).slice(0, 200)}`;
    } else {
      logLine = logLine || `#${reqId} ${eventType}`;
    }

    return { logLine, agentSpawn, newParent };
  },
};
