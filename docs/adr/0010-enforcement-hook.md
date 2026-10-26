# 10. Optional enforcement hook

Status: accepted · 2026-10-17

## Decision
`nuncius install-hook` adds a Claude Code PreToolUse hook that denies direct `codex exec`, `cursor-agent -p` and `claude -p` calls from agents, and points them to Nuncius. Housekeeping commands such as `login`, `--version` and `status` stay allowed. The hook is opt-in.

## Since 2026-10-18
- The hook also denies `nuncius ... --force` (budget overrides are the user's call) and Cursor's `agent` alias. Nuncius itself refuses `--force` under an agent too, because a hook only sees the command text.
- `nuncius install-hook` keeps the user's other hooks and `nuncius uninstall-hook` removes only its own entry. `settings.json` is written in place (a symlink stays a symlink, the mode is kept), with a backup at `settings.json.nuncius-hook-backup`.

## Since 2026-10-20
- The hook judges what a command runs, not the text it contains. It splits a command line the way the shell would where it matters (quotes, command substitution, heredocs), checks Nuncius only in command position, through a runtime (`node bin/nuncius.js`) or inside a wrapper that runs commands (`bash -c`, `sudo`, `env`, `xargs`, ...), and treats a heredoc body as plain data only for `cat`/`tee` without a pipe on the line; a shell's heredoc is read as commands, and any other heredoc (an interpreter, a pipe, an unknown command) is checked word by word, like the code an interpreter gets through `-e`/`-c`. `<<` inside arithmetic is a shift, not a heredoc. (The first version treated more heredocs as data; the automatic security review showed `cat <<EOF | bash`, `$((x << y))` and interpreter code getting past it.) "Plain data" is now only the exact form `cat`/`tee` writing to a file or stdout as the first line of the whole command: two more reviews showed a cat heredoc inside `{ … } | bash`, behind a case pattern's `)`, or after a line continuation, which no character-level group counting can rule out. Comments are recognised so an apostrophe in one opens no quote, but their text is still checked word by word: a fourth review showed that telling exactly where the shell sees a comment (`echo \ #`, `$(…)#`) is itself a parser differential, so a wrong guess may only make the hook stricter. Every exception for "data" is attack surface, so it is kept to the one form agents actually use to write files. Before, any mention blocked: searching the README, a commit message, or an agent writing Nuncius's own code. Disguises the hook cannot see through are still refused by Nuncius itself, which checks its real arguments under an agent.
