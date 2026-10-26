# 9. Standard task preamble

Status: accepted · 2026-10-17

## Decision
Nuncius prepends a short fixed preamble to every prompt. It tells the target that it works in an isolated worktree, must not commit or push (Nuncius commits), has no network unless the task granted it, and must end with a short summary of what it changed and why.
