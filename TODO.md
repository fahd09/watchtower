# Roadmap

Planned features, roughly ordered by priority. PRs welcome — open an issue first for anything non-trivial.

## P0 — Ship Blockers

1. **Zero-dependency proxy** — Drop the `ws` npm dependency. Use Node's built-in `WebSocketServer` (node 22+) so the tool works with a single file. No `npm install` step.

2. **Transparent gzip pass-through** — Currently we strip `accept-encoding` so we can log plaintext. This works but sends uncompressed data to Claude Code (wastes bandwidth, possible behavioral difference). Decompress for logging, pipe raw bytes to the client.

3. **Cost & Token Tracker** — Aggregate `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` across all requests. Show per-request and cumulative session cost using model pricing. Display in a persistent header bar. This is the #1 thing people will ask: "how much did this session cost me?"

4. **Search & Filter** — Filter sidebar by request type (hide `quota_check`/`token_count`), model, status code. Full-text search across message content and tool names. Essential once a session has 20+ requests.

5. **Copy Buttons** — One-click copy on every JSON block, system prompt, message, header value. Small effort, huge QoL.

## P1 — High Impact

6. **TTFT & Throughput** — Calculate time-to-first-token (request start to first `content_block_delta`) and output tokens/sec from SSE timestamps. Show in overview and response tabs.

7. **Context Window Gauge** — Visualize token usage vs model max (200k Opus, 200k Sonnet, etc). The data is already in `message_start.usage`. Show as a progress bar per request and a trend line across the session.

8. **Cache Effectiveness** — Prominent cache hit/miss display. Show `cache_read` vs `cache_creation` ratio per request. Flag requests where caching could help but isn't being used.

9. **System Prompt Diff** — System prompt is sent on every request (~20k+ tokens). Diff consecutive requests to show what actually changed: new tool definitions, context edits, memory additions. Unique insight you can't get anywhere else.

10. **Turn Diff** — The `messages` array grows each turn. Diff request #N vs #N+1 to highlight exactly what was added: new user message, new assistant response, new tool results. Collapse unchanged context.

11. **Agent Hierarchy Tree** — Claude Code spawns subagents (Explore, Plan, claude-code-guide, etc.) that make their own API calls. Show the parent/child relationship as a tree in the sidebar instead of a flat list. Detection signals found in intercepted data:
    - **`cc_version` suffix** in `x-anthropic-billing-header` (system[0]): main agent has a different build hash (e.g. `.a43`) vs subagents (`.464`)
    - **System prompt role**: main = "interactive agent...software engineering", Explore = "file search specialist", Plan = "software architect"
    - **Tool set**: main agent has `Agent` tool (21 tools); subagents never have `Agent` (12 tools, no `Edit`/`Write`)
    - **Timing**: subagent requests always nest temporally inside a main agent request (main is blocked waiting)
    - **Model**: Explore subagents use haiku; Plan subagents use the parent model
    - Parent-child linking: the main agent's response contains an `Agent` tool_use block, then subagent requests appear, then the main agent's next request contains the tool_result

12. **Conversation Grouping** — Group related requests (quota check + token count + messages stream) into logical "turns". A single user message generates 2-3 API calls — show them as one unit with expand/collapse.

13. **Export** — Export full session or single request as JSON, HAR, or self-contained HTML snapshot. Essential for bug reports and sharing.

## P2 — Power User Features

14. **Request Replay** — Re-send a captured request to the API. Useful for reproducing issues or A/B testing prompt changes.

15. **Breakpoints (Request Modification)** — Pause a request before forwarding, let the user edit the body (messages, system prompt, tools, parameters), then send. Like Burp Suite for Claude. The killer feature for prompt engineering.

16. **Tool Usage Analytics** — Across all requests: which tools are called most, success vs error rate, average duration. Summary dashboard view.

17. **Persistent Sessions** — Save sessions to disk (SQLite or flat JSON) so you can browse past sessions, compare across time, query history.

18. **Keyboard Navigation** — Up/down arrows for requests, number keys for tabs, `/` to focus search, `c` to copy current view.

## P3 — Polish

19. **Auto-scroll toggle** for SSE stream tab.
20. **Error notifications** — Visual alert on 4xx/5xx or rate limit utilization > 80%.
21. ~~**Light theme** toggle.~~ ✅ Done
22. **Timeline waterfall** — Chrome DevTools-style timing chart across all requests.
23. **`npx` / `brew` distribution** — Zero-install CLI.

## Build Order

1. Zero-dependency + gzip fix (release-ready foundation)
2. Cost tracker (immediate tangible value)
3. Search/filter (essential at scale)
4. Copy buttons (5 min effort, daily use)
5. Agent hierarchy tree (unique differentiator — no other tool shows this)
6. System prompt diff (unique insight)
7. TTFT + context gauge (observability story)
8. Conversation grouping + turn diff (makes the tool click)
9. Export (sharing story)
10. Breakpoints (killer differentiator)
