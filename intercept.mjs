#!/usr/bin/env node

// Watchtower — AI API traffic monitor for Claude Code, Codex CLI, and OpenAI-compatible clients
// Usage: node intercept.mjs [proxy_port] [dashboard_port]

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { WebSocketServer } from "ws";

import anthropicProvider from "./providers/anthropic.mjs";
import openaiProvider from "./providers/openai.mjs";

const PROXY_PORT = parseInt(process.argv[2] || "8024", 10);
const DASHBOARD_PORT = parseInt(process.argv[3] || "8025", 10);
const LOG_DIR = path.join(process.cwd(), "logs");

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

// ─── Proxy Server ───────────────────────────────────────────────────
const proxyServer = http.createServer(async (req, res) => {
  const reqId = ++requestCounter;
  const startTime = Date.now();

  // Detect provider before reading body (based on headers/URL)
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
  const rawRequestBody = rawBodyBuffer; // Original bytes for forwarding
  const requestBodyParsed = tryParseJson(decodedBody);

  // Resolve target — provider may pick a different upstream based on auth type
  const resolved = provider.resolveTarget
    ? provider.resolveTarget(req.headers)
    : { target: provider.target, pathPrefix: provider.pathPrefix };
  let targetPath = req.url;
  if (resolved.pathPrefix && !targetPath.startsWith(resolved.pathPrefix)) {
    targetPath = resolved.pathPrefix + targetPath;
  }
  const targetUrl = new URL(targetPath, resolved.target);
  const requestType = provider.classifyRequest(req.method, req.url, requestBodyParsed);

  // Detect agent role
  const { agentRole, parentId, newParent } = provider.detectAgentRole(requestBodyParsed, currentParent, reqId);
  currentParent = newParent;

  // Extract provider-specific request fields
  const fields = provider.extractRequestFields(requestBodyParsed);

  // Build the record
  const record = {
    id: reqId,
    startTime,
    provider: provider.name,
    method: req.method,
    url: req.url,
    type: requestType,
    agentRole,
    parentId,
    requestHeaders: provider.maskSecrets(req.headers),
    requestBody: requestBodyParsed || decodedBody,
    // Extracted fields
    model: fields.model,
    system: fields.system,
    messages: fields.messages,
    tools: fields.tools,
    thinking: fields.thinking,
    stream: fields.stream,
    maxTokens: fields.maxTokens,
    metadata: fields.metadata,
    contextManagement: fields.contextManagement,
    // Response fields - filled later
    status: null,
    responseHeaders: null,
    responseBody: null,
    rateLimits: null,
    sseEvents: [],
    duration: null,
    error: null,
  };

  store.requests.push(record);
  const parentTag = parentId ? ` parent=#${parentId}` : "";
  const provTag = provider.name === "openai" ? " [openai]" : "";
  log(">>>", `#${reqId} ${req.method} ${req.url} [${requestType}] [${agentRole}${parentTag}]${provTag} model=${record.model || "n/a"}`);
  broadcast("request_start", {
    id: reqId,
    provider: provider.name,
    method: req.method,
    url: req.url,
    type: requestType,
    agentRole,
    parentId,
    model: record.model,
    system: record.system,
    messages: record.messages,
    tools: record.tools ? record.tools.map((t) => ({ name: t.name, description: t.description?.slice(0, 120) })) : null,
    thinking: record.thinking,
    maxTokens: record.maxTokens,
    metadata: record.metadata,
    requestHeaders: record.requestHeaders,
  });

  // Forward to target — remove accept-encoding so we get plain text
  const proxyHeaders = { ...req.headers };
  delete proxyHeaders["host"];
  delete proxyHeaders["accept-encoding"];
  proxyHeaders["host"] = targetUrl.host;

  const proxyReq = https.request(targetUrl, { method: req.method, headers: proxyHeaders }, (proxyRes) => {
    // Detect SSE: check content-type first, then fall back to request's accept header
    // (ChatGPT backend omits content-type but streams SSE when accept: text/event-stream)
    const isSSE = (proxyRes.headers["content-type"] || "").includes("text/event-stream")
      || (!proxyRes.headers["content-type"] && proxyRes.statusCode === 200
          && (req.headers["accept"] || "").includes("text/event-stream"));
    const encoding = proxyRes.headers["content-encoding"];

    record.status = proxyRes.statusCode;
    record.responseHeaders = proxyRes.headers;
    record.rateLimits = provider.extractRateLimits(proxyRes.headers);

    log("<<<", `#${reqId} ${proxyRes.statusCode} [${isSSE ? "SSE" : "JSON"}]${provTag}`);

    // For the client, we forward without content-encoding since we stripped accept-encoding
    const clientHeaders = { ...proxyRes.headers };
    delete clientHeaders["content-encoding"];
    delete clientHeaders["transfer-encoding"];
    res.writeHead(proxyRes.statusCode, clientHeaders);

    if (isSSE) {
      // ── SSE stream handling ──
      let sseBuffer = "";
      let decompressor = null;

      if (encoding === "gzip") decompressor = zlib.createGunzip();
      else if (encoding === "br") decompressor = zlib.createBrotliDecompress();
      else if (encoding === "deflate") decompressor = zlib.createInflate();
      else if (encoding === "zstd" && zlib.createZstdDecompress) decompressor = zlib.createZstdDecompress();

      const source = decompressor ? proxyRes.pipe(decompressor) : proxyRes;

      source.on("data", (chunk) => {
        const text = chunk.toString("utf-8");
        res.write(text);

        const { events, remainingBuffer } = provider.parseSSEChunk(text, sseBuffer);
        sseBuffer = remainingBuffer;

        for (const event of events) {
          const parsed = tryParseJson(event.data);
          const sseRecord = { type: event.type, data: parsed || event.data, ts: Date.now() };
          record.sseEvents.push(sseRecord);

          broadcast("sse_event", { requestId: reqId, ...sseRecord });

          // Process for logging and agent hierarchy
          const { logLine, agentSpawn, newParent: updatedParent } = provider.processSSEEvent(
            { type: event.type, parsed },
            currentParent,
            reqId,
            log,
          );
          currentParent = updatedParent;

          if (agentSpawn) {
            broadcast("agent_spawn", agentSpawn);
            log("INFO", logLine);
          } else if (logLine) {
            log("SSE", logLine);
          }
        }
      });

      source.on("end", () => {
        record.duration = Date.now() - startTime;
        log("<<<", `#${reqId} Stream ended. ${record.sseEvents.length} events, ${record.duration}ms`);
        broadcast("request_end", { id: reqId, duration: record.duration, eventCount: record.sseEvents.length, rateLimits: record.rateLimits });
        saveLog(record);
        res.end();
      });

      source.on("error", (err) => {
        record.error = err.message;
        log("ERR", `#${reqId} Stream error: ${err.message}`);
        res.end();
      });
    } else {
      // ── Standard JSON response ──
      const chunks = [];
      proxyRes.on("data", (c) => chunks.push(c));
      proxyRes.on("end", async () => {
        const raw = Buffer.concat(chunks);
        try {
          const decompressed = await decompressBuffer(raw, encoding);
          const text = decompressed.toString("utf-8");
          record.responseBody = tryParseJson(text) || text;
          record.duration = Date.now() - startTime;
          log("<<<", `#${reqId} ${text.length} bytes, ${record.duration}ms`);
          broadcast("request_end", { id: reqId, duration: record.duration, responseBody: record.responseBody, rateLimits: record.rateLimits, status: record.status });
          saveLog(record);
          res.write(decompressed);
          res.end();
        } catch (err) {
          // If decompression fails, forward raw
          record.responseBody = "(binary/compressed - decompression failed)";
          record.duration = Date.now() - startTime;
          broadcast("request_end", { id: reqId, duration: record.duration, error: err.message });
          res.write(raw);
          res.end();
        }
      });
    }
  });

  proxyReq.on("error", (err) => {
    record.error = err.message;
    record.duration = Date.now() - startTime;
    log("ERR", `#${reqId} Proxy error: ${err.message}`);
    broadcast("request_end", { id: reqId, error: err.message });
    res.writeHead(502);
    res.end(JSON.stringify({ error: "Proxy error", message: err.message }));
  });

  if (rawRequestBody.length > 0) proxyReq.write(rawRequestBody);
  proxyReq.end();
});

function saveLog(record) {
  const filename = `${String(record.id).padStart(4, "0")}_${record.type}_${record.model || "unknown"}.json`;
  fs.writeFileSync(path.join(LOG_DIR, filename), JSON.stringify(record, null, 2));
}

// ─── Dashboard Server ───────────────────────────────────────────────
const dashboardHtml = fs.readFileSync(path.join(import.meta.dirname, "dashboard.html"), "utf-8");

const dashboardServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(dashboardHtml);
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
