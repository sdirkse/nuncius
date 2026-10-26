# 3. Hybrid synchronous and asynchronous tasks

Status: accepted · 2026-10-17

## Decision
`run_task` waits up to about 5 minutes (configurable). If the task is not done by then, it returns the task id and the state `running`, and the caller continues with `get_task` or `wait_task`. Short tasks feel synchronous, and long ones never hit an MCP timeout.

- Concurrency: at most 2 running tasks per target and 4 in total, both configurable. Extra tasks are `queued`.
- Timeout: 30 minutes per task by default, configurable. On timeout the process is killed, the task is marked `timeout`, and its worktree is kept for inspection.
