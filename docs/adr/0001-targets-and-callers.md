# 1. Targets and callers

Status: accepted · 2026-10-17

## Context
The user has subscriptions for Codex (ChatGPT), Cursor and Claude, and wants agents in one tool to be able to use the others.

## Decision
- The targets in v1 are `codex`, `cursor` and `claude`. Each one is a runner around its official CLI (`codex exec`, `cursor-agent -p`, `claude -p`), so work always runs on the user's own subscription.
- The callers are Claude Code and Cursor through MCP, and anyone through the `nuncius` CLI.
- Local models (Ollama) and image generation are out of scope for v1. Image generation (`generate_image`) is phase 2, after we verify that Cursor's built-in image generation works in headless mode.

## Consequences
Adding a target means adding a runner. Each provider's terms for automated or third-party use of a consumer subscription are the user's responsibility to check.
