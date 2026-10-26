# 2. MCP server and CLI over one core

Status: accepted · 2026-10-17

## Decision
- One core library, with two front ends: a stdio MCP server (`nuncius mcp`) and the `nuncius` CLI.
- Each MCP client spawns its own server. All shared state lives on disk in `~/.nuncius` (configurable through `NUNCIUS_HOME`).
- Background tasks run as detached processes. Their state is kept in `tasks/<id>.json`, so they survive restarts of the MCP server.
- The MCP tools are `list_targets`, `run_task`, `get_task`, `wait_task` and `usage`. `generate_image` comes later.
- The dashboard is a separate `nuncius dashboard` server, bound to 127.0.0.1 only.

## Alternatives considered
One shared HTTP server for all clients. Rejected for v1: it adds a long-running daemon and auth for little gain.
