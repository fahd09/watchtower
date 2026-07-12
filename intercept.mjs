#!/usr/bin/env node

// Watchtower — AI API traffic monitor for Claude Code, Codex CLI, and OpenAI-compatible clients
// Usage: node intercept.mjs [proxy_port] [dashboard_port]

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { WebSocketServer } from "./ws-server.mjs";

import anthropicProvider from "./providers/anthropic.mjs";
import openaiProvider from "./providers/openai.mjs";

const PROXY_PORT = parseInt(process.argv[2] || "8024", 10);
const DASHBOARD_PORT = parseInt(process.argv[3] || "8025", 10);
const LOG_DIR = path.join(process.cwd(), "logs");

// Opt-in request rewriting. When enabled, providers may transparently modify
// the outgoing request. Currently this reveals hidden extended-thinking by
// flipping thinking.display "omitted" → "summarized" on Anthropic requests.
// Off by default so the proxy is byte-for-byte transparent unless asked.
const REVEAL_THINKING = /^(1|true|yes|on)$/i.test(process.env.WATCHTOWER_REVEAL_THINKING || "");

const providers = { anthropic: anthropicProvider, openai: openaiProvider };

fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Auto-detect provider per request ──────────────────────────────
function detectProvider(req) {
  const auth = req.headers["authorization"] || "";
  // Anthropic: x-api-key header or Bearer sk-ant-* token
  if (req.headers["x-api-key"]) return providers.anthropic;
  if (auth.includes("sk-ant-")) return providers.anthropic;
  // Anthropic URL patterns
  if (req.url.startsWith("/v1/messages") || req.url.startsWith("/v1/count_tokens")) return providers.anthropic;
  // OpenAI / Codex: known headers, endpoints, or key patterns
  if (req.headers["originator"]?.includes("codex")) return providers.openai;
  if (req.headers["x-codex-turn-metadata"]) return providers.openai;
  if (req.url.startsWith("/v1/chat/") || req.url.startsWith("/v1/models")) return providers.openai;
  if (req.url.startsWith("/v1/responses") || req.url === "/responses") return providers.openai;
  if (auth.includes("Bearer sk-")) return providers.openai;
  return providers.anthropic; // backward compatible default
}

// ─── In-memory store ────────────────────────────────────────────────
const store = {
  requests: [], // All intercepted request/response pairs
};

// Unmasked request headers, kept in memory only (never written to disk or the
// API) so replays can reuse the original auth. Keyed by request id.
const realHeadersById = new Map();

let requestCounter = 0;

// ─── Agent hierarchy tracking ────────────────────────────────────────
let currentParent = null; // { reqId, toolUseIds: [] }

// ─── WebSocket clients ──────────────────────────────────────────────
const wsClients = new Set();

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString();
}

function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function decompressBuffer(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === "gzip") {
      zlib.gunzip(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (encoding === "br") {
      zlib.brotliDecompress(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (encoding === "deflate") {
      zlib.inflate(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (encoding === "zstd" && zlib.zstdDecompress) {
      zlib.zstdDecompress(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else {
      resolve(buffer);
    }
  });
}

// ─── Console logging ────────────────────────────────────────────────
const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

function log(prefix, msg) {
  const colors = { ">>>": C.cyan, "<<<": C.green, SSE: C.yellow, INFO: C.magenta, ERR: C.red };
  const c = colors[prefix] || C.reset;
  console.log(`${C.dim}${ts()}${C.reset} ${c}${C.bold}[${prefix}]${C.reset} ${msg}`);
}

// Build an intercepted-request record, register it, log it, and broadcast
// request_start. Used by both live proxying and replay. Real (unmasked)
// headers are stashed in realHeadersById so replays can reuse the auth.
function buildRecord({ reqId, provider, method, url, realHeaders, parsed, decodedBody, mutation, startTime, updateHierarchy, replayOf }) {
  const requestType = provider.classifyRequest(method, url, parsed);
  const { agentRole, parentId, newParent } = provider.detectAgentRole(parsed, currentParent, reqId);
  if (updateHierarchy) currentParent = newParent;
  const fields = provider.extractRequestFields(parsed);

  const record = {
    id: reqId,
    startTime,
    provider: provider.name,
    method,
    url,
    type: requestType,
    agentRole,
    parentId: updateHierarchy ? parentId : null,
    requestHeaders: provider.maskSecrets(realHeaders),
    requestBody: parsed || decodedBody,
    model: fields.model,
    system: fields.system,
    messages: fields.messages,
    tools: fields.tools,
    thinking: fields.thinking,
    stream: fields.stream,
    maxTokens: fields.maxTokens,
    metadata: fields.metadata,
    contextManagement: fields.contextManagement,
    mutation: mutation || null,
    replayOf: replayOf || null,
    status: null,
    responseHeaders: null,
    responseBody: null,
    rateLimits: null,
    sseEvents: [],
    duration: null,
    error: null,
  };

  store.requests.push(record);
  realHeadersById.set(reqId, realHeaders);

  const parentTag = record.parentId ? ` parent=#${record.parentId}` : "";
  const provTag = provider.name === "openai" ? " [openai]" : "";
  const replayTag = replayOf ? ` [replay of #${replayOf}]` : "";
  log(">>>", `#${reqId} ${method} ${url} [${requestType}] [${agentRole}${parentTag}]${provTag}${replayTag} model=${record.model || "n/a"}`);
  if (mutation) log("INFO", `#${reqId} request rewritten (${mutation})`);
  broadcast("request_start", {
    id: reqId,
    provider: provider.name,
    method,
    url,
    type: requestType,
    agentRole,
    parentId: record.parentId,
    model: record.model,
    system: record.system,
    messages: record.messages,
    tools: record.tools ? record.tools.map((t) => ({ name: t.name, description: t.description?.slice(0, 120) })) : null,
    thinking: record.thinking,
    maxTokens: record.maxTokens,
    metadata: record.metadata,
    requestHeaders: record.requestHeaders,
    replayOf: replayOf || null,
  });
  return record;
}

// Send the request upstream and capture the response into `record`. When
// clientRes is set (live proxying) the response is streamed back to the caller
// with transparent gzip pass-through; when null (replay) it's captured only.
function forwardAndCapture(record, opts) {
  const { provider, targetUrl, method, headers, bodyBuffer, clientRes, startTime, acceptHeader, updateHierarchy } = opts;
  const reqId = record.id;
  const provTag = provider.name === "openai" ? " [openai]" : "";

  const proxyReq = https.request(targetUrl, { method, headers }, (proxyRes) => {
    // Detect SSE: content-type first, else fall back to the request's accept
    // header (ChatGPT backend omits content-type but streams when asked).
    const isSSE = (proxyRes.headers["content-type"] || "").includes("text/event-stream")
      || (!proxyRes.headers["content-type"] && proxyRes.statusCode === 200
          && (acceptHeader || "").includes("text/event-stream"));
    const encoding = proxyRes.headers["content-encoding"];

    record.status = proxyRes.statusCode;
    record.responseHeaders = proxyRes.headers;
    record.rateLimits = provider.extractRateLimits(proxyRes.headers);

    log("<<<", `#${reqId} ${proxyRes.statusCode} [${isSSE ? "SSE" : "JSON"}]${provTag}`);

    if (clientRes) {
      // Forward upstream headers as-is, preserving content-encoding (the body
      // we pass through is byte-identical). Drop transfer-encoding; we re-frame.
      const clientHeaders = { ...proxyRes.headers };
      delete clientHeaders["transfer-encoding"];
      clientRes.writeHead(proxyRes.statusCode, clientHeaders);
    }

    if (isSSE) {
      let sseBuffer = "";
      let rawResponseChunks = [];
      let decompressor = null;

      if (encoding === "gzip") decompressor = zlib.createGunzip();
      else if (encoding === "br") decompressor = zlib.createBrotliDecompress();
      else if (encoding === "deflate") decompressor = zlib.createInflate();
      else if (encoding === "zstd" && zlib.createZstdDecompress) decompressor = zlib.createZstdDecompress();

      const parseSource = decompressor ? proxyRes.pipe(decompressor) : proxyRes;

      // (1) Forward original bytes to the client, verbatim (live only).
      if (clientRes) {
        proxyRes.on("data", (chunk) => clientRes.write(chunk));
        proxyRes.on("end", () => clientRes.end());
      }

      // (2) Parse a decompressed copy for our own SSE event capture.
      parseSource.on("data", (chunk) => {
        const text = chunk.toString("utf-8");
        rawResponseChunks.push(text);

        const { events, remainingBuffer } = provider.parseSSEChunk(text, sseBuffer);
        sseBuffer = remainingBuffer;

        for (const event of events) {
          const parsed = tryParseJson(event.data);
          const sseRecord = { type: event.type, data: parsed || event.data, ts: Date.now() };
          record.sseEvents.push(sseRecord);

          broadcast("sse_event", { requestId: reqId, ...sseRecord });

          const { logLine, agentSpawn, newParent: updatedParent } = provider.processSSEEvent(
            { type: event.type, parsed },
            currentParent,
            reqId,
            log,
          );
          if (updateHierarchy) currentParent = updatedParent;

          if (agentSpawn) {
            broadcast("agent_spawn", agentSpawn);
            log("INFO", logLine);
          } else if (logLine) {
            log("SSE", logLine);
          }
        }
      });

      parseSource.on("end", () => {
        record.responseBody = provider.assembleResponse
          ? provider.assembleResponse(record.sseEvents)
          : rawResponseChunks.join("");
        record.duration = Date.now() - startTime;
        log("<<<", `#${reqId} Stream ended. ${record.sseEvents.length} events, ${record.duration}ms`);
        broadcast("request_end", { id: reqId, duration: record.duration, eventCount: record.sseEvents.length, rateLimits: record.rateLimits });
        saveLog(record);
      });

      parseSource.on("error", (err) => {
        record.error = err.message;
        log("ERR", `#${reqId} Stream parse error: ${err.message}`);
      });
      proxyRes.on("error", (err) => {
        record.error = err.message;
        log("ERR", `#${reqId} Stream error: ${err.message}`);
        if (clientRes) clientRes.end();
      });
    } else {
      const chunks = [];
      proxyRes.on("data", (c) => chunks.push(c));
      proxyRes.on("end", async () => {
        const raw = Buffer.concat(chunks);
        if (clientRes) clientRes.end(raw); // forward original bytes, encoding intact
        try {
          const decompressed = await decompressBuffer(raw, encoding);
          const text = decompressed.toString("utf-8");
          record.responseBody = tryParseJson(text) || text;
          record.duration = Date.now() - startTime;
          log("<<<", `#${reqId} ${text.length} bytes, ${record.duration}ms`);
          broadcast("request_end", { id: reqId, duration: record.duration, responseBody: record.responseBody, rateLimits: record.rateLimits, status: record.status });
          saveLog(record);
        } catch (err) {
          record.responseBody = "(binary/compressed - decompression failed)";
          record.duration = Date.now() - startTime;
          log("ERR", `#${reqId} Decompression failed: ${err.message}`);
          broadcast("request_end", { id: reqId, duration: record.duration, error: err.message });
          saveLog(record);
        }
      });
    }
  });

  proxyReq.on("error", (err) => {
    record.error = err.message;
    record.duration = Date.now() - startTime;
    log("ERR", `#${reqId} Proxy error: ${err.message}`);
    broadcast("request_end", { id: reqId, error: err.message });
    if (clientRes) {
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: "Proxy error", message: err.message }));
    }
  });

  if (bodyBuffer && bodyBuffer.length > 0) proxyReq.write(bodyBuffer);
  proxyReq.end();
}

// Re-send a captured request (optionally with an edited body) and capture the
// result as a new request. Reuses the original request's real headers/auth.
function replayRequest({ originalId, editedBody }) {
  const orig = store.requests.find((r) => r.id === originalId);
  const realHeaders = realHeadersById.get(originalId);
  if (!orig || !realHeaders) return { error: "Original request not found or its headers are no longer in memory." };

  const provider = providers[orig.provider] || providers.anthropic;
  const bodyStr = editedBody != null
    ? (typeof editedBody === "string" ? editedBody : JSON.stringify(editedBody))
    : JSON.stringify(orig.requestBody);
  const parsed = tryParseJson(bodyStr);
  const bodyBuffer = Buffer.from(bodyStr, "utf-8");

  const headers = { ...realHeaders };
  const resolved = provider.resolveTarget ? provider.resolveTarget(headers) : { target: provider.target, pathPrefix: provider.pathPrefix };
  let targetPath = orig.url;
  if (resolved.pathPrefix && !targetPath.startsWith(resolved.pathPrefix)) targetPath = resolved.pathPrefix + targetPath;
  const targetUrl = new URL(targetPath, resolved.target);
  delete headers["host"];
  headers["host"] = targetUrl.host;
  delete headers["content-encoding"]; // we send plain re-serialized JSON
  headers["content-length"] = String(bodyBuffer.length);

  const reqId = ++requestCounter;
  const startTime = Date.now();
  const record = buildRecord({
    reqId, provider, method: orig.method, url: orig.url, realHeaders,
    parsed, decodedBody: bodyStr, startTime, updateHierarchy: false, replayOf: originalId,
  });

  forwardAndCapture(record, {
    provider, targetUrl, method: orig.method, headers, bodyBuffer,
    clientRes: null, startTime, acceptHeader: headers["accept"] || "", updateHierarchy: false,
  });
  return { id: reqId };
}

// ─── Proxy Server ───────────────────────────────────────────────────
const proxyServer = http.createServer(async (req, res) => {
  const reqId = ++requestCounter;
  const startTime = Date.now();
  const provider = detectProvider(req);

  // Collect request body (decompress if needed for parsing)
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const rawBodyBuffer = Buffer.concat(bodyChunks);
  const reqEncoding = req.headers["content-encoding"];
  let decodedBody;
  try {
    const decompressed = reqEncoding ? await decompressBuffer(rawBodyBuffer, reqEncoding) : rawBodyBuffer;
    decodedBody = decompressed.toString("utf-8");
  } catch {
    decodedBody = rawBodyBuffer.toString("utf-8");
  }
  const requestBodyParsed = tryParseJson(decodedBody);

  // Optional request rewriting (opt-in). If a provider mutates the body we
  // forward the re-serialized JSON instead of the original bytes.
  let rawRequestBody = rawBodyBuffer;
  let mutation = null;
  if (REVEAL_THINKING && provider.revealThinking && requestBodyParsed) {
    const rewritten = provider.revealThinking(requestBodyParsed);
    if (rewritten) {
      rawRequestBody = Buffer.from(JSON.stringify(rewritten), "utf-8");
      mutation = "thinking.display: omitted → summarized";
    }
  }

  // Resolve target — provider may pick a different upstream based on auth type
  const resolved = provider.resolveTarget
    ? provider.resolveTarget(req.headers)
    : { target: provider.target, pathPrefix: provider.pathPrefix };
  let targetPath = req.url;
  if (resolved.pathPrefix && !targetPath.startsWith(resolved.pathPrefix)) {
    targetPath = resolved.pathPrefix + targetPath;
  }
  const targetUrl = new URL(targetPath, resolved.target);

  const record = buildRecord({
    reqId, provider, method: req.method, url: req.url, realHeaders: req.headers,
    parsed: requestBodyParsed, decodedBody, mutation, startTime, updateHierarchy: true,
  });

  // Build forward headers (transparent pass-through: keep accept-encoding).
  const proxyHeaders = { ...req.headers };
  delete proxyHeaders["host"];
  proxyHeaders["host"] = targetUrl.host;
  if (mutation) {
    delete proxyHeaders["content-encoding"];
    proxyHeaders["content-length"] = String(rawRequestBody.length);
  }

  forwardAndCapture(record, {
    provider, targetUrl, method: req.method, headers: proxyHeaders, bodyBuffer: rawRequestBody,
    clientRes: res, startTime, acceptHeader: req.headers["accept"] || "", updateHierarchy: true,
  });
});

// Best-effort token usage for a record, merged across providers/streaming.
// Anthropic streaming: message_start carries input/cache, message_delta the
// final output_tokens — merge both. Non-streaming / assembled bodies and
// OpenAI usage come straight off the response.
function extractUsage(record) {
  const evs = record.sseEvents || [];
  const ms = evs.find((e) => e.type === "message_start")?.data?.message?.usage;
  const md = evs.find((e) => e.type === "message_delta")?.data?.usage;
  if (ms || md) return { ...(ms || {}), ...(md || {}) };
  const usageEv = evs.find((e) => e.data?.usage);
  if (usageEv?.data?.usage) return usageEv.data.usage;
  const done = evs.find((e) => e.type === "response.completed" || e.type === "response.done");
  if (done?.data?.response?.usage) return done.data.response.usage;
  if (done?.data?.usage) return done.data.usage;
  if (record.responseBody && typeof record.responseBody === "object" && record.responseBody.usage) {
    return record.responseBody.usage;
  }
  return null;
}

function saveLog(record) {
  const filename = `${String(record.id).padStart(4, "0")}_${record.type}_${record.model || "unknown"}.json`;
  fs.writeFileSync(path.join(LOG_DIR, filename), JSON.stringify(record, null, 2));
}

// ─── Dashboard Server ───────────────────────────────────────────────
const dashboardHtml = fs.readFileSync(path.join(import.meta.dirname, "dashboard.html"), "utf-8");

const dashboardServer = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(dashboardHtml);
  } else if (req.method === "POST" && req.url === "/api/replay") {
    // Re-send a captured request, optionally with an edited body.
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const payload = tryParseJson(Buffer.concat(chunks).toString("utf-8")) || {};
    const result = replayRequest({ originalId: payload.id, editedBody: payload.body });
    res.writeHead(result.error ? 400 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } else if (req.url === "/api/requests") {
    res.writeHead(200, { "content-type": "application/json" });
    // Send summary list
    const summary = store.requests.map((r) => ({
      id: r.id,
      provider: r.provider,
      type: r.type,
      agentRole: r.agentRole,
      parentId: r.parentId,
      method: r.method,
      url: r.url,
      model: r.model,
      status: r.status,
      duration: r.duration,
      startTime: r.startTime,
      sseEventCount: r.sseEvents?.length || 0,
      messageCount: r.messages?.length || 0,
      toolCount: r.tools?.length || 0,
      error: r.error,
      mutation: r.mutation || null,
      replayOf: r.replayOf || null,
      usage: extractUsage(r), // token usage for cost totals without loading full detail
    }));
    res.end(JSON.stringify(summary));
  } else if (req.url.startsWith("/api/request/")) {
    const id = parseInt(req.url.split("/").pop(), 10);
    const record = store.requests.find((r) => r.id === id);
    if (record) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(record));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ server: dashboardServer });
wss.on("connection", (ws) => {
  wsClients.add(ws);
  // Send current state
  ws.send(JSON.stringify({ event: "init", data: { requestCount: store.requests.length } }));
  ws.on("close", () => wsClients.delete(ws));
});

// ─── Start ──────────────────────────────────────────────────────────
proxyServer.listen(PROXY_PORT, () => {
  dashboardServer.listen(DASHBOARD_PORT, () => {
    console.log(`
${C.bold}${C.cyan}╔═══════════════════════════════════════════════════════════╗
║              Watchtower — AI API Monitor                  ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  Proxy:     ${C.reset}${C.bold}http://localhost:${PROXY_PORT}${C.cyan}                          ║
║  Dashboard: ${C.reset}${C.bold}http://localhost:${DASHBOARD_PORT}${C.cyan}                          ║
║  Logs:      ${C.reset}${C.dim}./logs/${C.cyan}                                        ║
║                                                           ║
║  ${C.reset}${C.yellow}ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT} claude${C.cyan}         ║
║  ${C.reset}${C.blue}OPENAI_BASE_URL=http://localhost:${PROXY_PORT} codex${C.cyan}            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝${C.reset}
`);
  });
});
