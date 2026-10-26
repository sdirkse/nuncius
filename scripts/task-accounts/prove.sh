#!/bin/bash
# nuncius: prove what the task accounts add (docs/adr/0012-separate-task-accounts.md, "Prototype").
# Run as yourself after setup.sh (no admin needed: it only switches *down* to a task account):
#
#   ./scripts/task-accounts/prove.sh
#
# Each check runs WITHOUT nuncius's sandbox, to show the account boundary on its own.
set -uo pipefail
U=_nuncius1
H=$HOME
pass=0; failn=0
ok() { printf '  ok    %s\n' "$*"; pass=$((pass + 1)); }
no() { printf '  FAIL  %s\n' "$*"; failn=$((failn + 1)); }
as() { sudo -n -u "$U" -- "$@"; }
expect_denied() { if as /bin/sh -c "$2" >/dev/null 2>&1; then no "$1"; else ok "$1"; fi; }
expect_allowed() { if as /bin/sh -c "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

sudo -n -u "$U" true 2>/dev/null || { echo "cannot switch to $U: run setup.sh first"; exit 1; }
WORK=$(mktemp -d "$H/.nuncius-prove.XXXXXX")
trap '/bin/rm -rf "$WORK"' EXIT

echo "Your files"
expect_denied "cannot list your home folder" "ls '$H'"
expect_denied "cannot read the Codex login (~/.codex/auth.json, 600)" "cat '$H/.codex/auth.json'"
expect_denied "cannot list ~/Documents (700)" "ls '$H/Documents'"
expect_denied "cannot read nuncius's data (~/.nuncius, 700)" "ls '$H/.nuncius'"
[ -f "$H/.ssh/id_ed25519" ] && expect_denied "cannot read an SSH private key" "cat '$H/.ssh/id_ed25519'"
[ -f "$H/.ssh/id_rsa" ] && expect_denied "cannot read an SSH private key" "cat '$H/.ssh/id_rsa'"
expect_allowed "can pass through to a world-readable path it knows (option A)" "test -r '$H/.local'"
expect_allowed "can start the Claude CLI in ~/.local" "'$H/.local/bin/claude' --version"
expect_allowed "can start the Cursor CLI in ~/.local" "'$H/.local/bin/cursor-agent' --version"

echo "Your terminals and processes"
mytty=$(ls -l /dev/ttys* 2>/dev/null | awk -v u="$(id -un)" '$3 == u {print $NF; exit}')
if [ -n "$mytty" ]; then expect_denied "cannot open your terminal $mytty for writing" "exec 3>>'$mytty'"; else echo "  skip  no terminal of yours open"; fi
sleep 60 & mine=$!
expect_denied "cannot signal your processes" "kill -0 $mine"
kill "$mine" 2>/dev/null

echo "Stopping everything at the end"
as /bin/sh -c "cd /tmp && /usr/bin/perl -MPOSIX -e 'if (!fork) { POSIX::setsid(); sleep 120; exit }'" >/dev/null 2>&1
sleep 1
if pgrep -u "$U" >/dev/null; then
  sudo -n -u "$U" /usr/bin/pkill -KILL -u "$U"; sleep 1
  if pgrep -u "$U" >/dev/null; then no "pkill -u removes a setsid survivor"; else ok "pkill -u removes a setsid survivor"; fi
else
  no "the setsid probe did not start"
fi

echo "Shared task folders"
mkdir "$WORK/task" && chgrp _nuncius "$WORK/task" && chmod 2770 "$WORK/task"
chmod g+x "$WORK" && chgrp _nuncius "$WORK"
expect_allowed "a task account can write a group folder" "umask 002; echo hi > '$WORK/task/out.txt' && mkdir '$WORK/task/sub' && echo x > '$WORK/task/sub/y'"
if cat "$WORK/task/out.txt" >/dev/null 2>&1 && /bin/rm -rf "$WORK/task/sub" "$WORK/task/out.txt"; then ok "you can read and remove what it wrote"; else no "you can read and remove what it wrote"; fi

echo "git on a repository in your home folder"
REPO="$WORK/repo"; git init -q -b main "$REPO" && git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
chmod -R go+rX "$REPO"; chmod o+x "$WORK"
git -C "$REPO" worktree add -q "$WORK/task/wt" -b t 2>/dev/null; chgrp -R _nuncius "$WORK/task/wt"; chmod -R g+rwX "$WORK/task/wt"
# git refuses a repository owned by another account ("dubious ownership"); nuncius names exactly the
# task's worktree as safe, through the environment, as below.
GITENV="GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='$WORK/task/wt'"
expect_denied "without that exception, git refuses (dubious ownership)" "cd '$WORK/task/wt' && GIT_CONFIG_GLOBAL=/dev/null git log --oneline -1"
expect_allowed "git log works for a task account in a worktree" "cd '$WORK/task/wt' && env $GITENV git log --oneline -1"
expect_allowed "git status works for a task account in a worktree" "cd '$WORK/task/wt' && env $GITENV git status --short"
expect_denied "a task account cannot write the repository's git data" "echo x > '$REPO/.git/HEAD'"
git -C "$REPO" worktree remove --force "$WORK/task/wt" 2>/dev/null

echo "Network (firewall)"
if sudo -n /sbin/pfctl -a com.apple/250.nuncius -s rules >/dev/null 2>&1 || true; then :; fi
expect_denied "a task account cannot connect out directly" "/usr/bin/nc -z -G 3 1.1.1.1 443"
nc -l 127.0.0.1 47123 >/dev/null 2>&1 & lis=$!; sleep 0.5
expect_allowed "a task account can reach loopback (nuncius's proxy)" "/usr/bin/nc -z -G 3 127.0.0.1 47123"
kill "$lis" 2>/dev/null

echo
echo "$pass passed, $failn failed"
[ "$failn" = 0 ]
