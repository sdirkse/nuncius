#!/bin/bash
# nuncius: one-time setup of the task accounts (docs/adr/0012-separate-task-accounts.md).
#
#   sudo ./scripts/task-accounts/setup.sh                 # accounts, sudo rule, home pass-through, firewall
#   sudo ./scripts/task-accounts/setup.sh --no-firewall   # the same without the pf firewall rules
#
# Safe to run again: it checks what exists and only adds what is missing. Undo: undo.sh next to it.
set -euo pipefail

GROUP=_nuncius
GID=460
FIRST_UID=461
COUNT=4
SUDOERS=/etc/sudoers.d/nuncius
ANCHOR=com.apple/250.nuncius
ANCHOR_FILE=/etc/pf.anchors/nuncius
PLIST=/Library/LaunchDaemons/dev.nuncius.pf.plist
LABEL=dev.nuncius.pf
# Each task account's own home: the CLIs read macOS preferences from it (Codex fails without one).
# nuncius empties it after every task, so nothing carries over between tasks. Under /var/db, which
# only root can write: a world-writable parent such as /Users/Shared would let another account
# plant a link there that this script (as root) then follows.
HOMES=/var/db/nuncius-homes

FIREWALL=1
for arg in "$@"; do
  case "$arg" in
    --no-firewall) FIREWALL=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
fail() { printf 'setup stopped: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "run it with sudo"
OWNER=${SUDO_USER:-}
{ [ -n "$OWNER" ] && [ "$OWNER" != root ]; } || fail "run it with sudo from your own account, not as root"
OWNER_HOME=$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')
[ -d "$OWNER_HOME" ] || fail "cannot find the home folder of $OWNER"

USERS=()
for i in $(seq 1 "$COUNT"); do USERS+=("${GROUP}${i}"); done
UIDS=()
for i in $(seq 0 $((COUNT - 1))); do UIDS+=($((FIRST_UID + i))); done

echo "nuncius task accounts for $OWNER"

# --- Check before changing anything: the IDs must be free or already ours. ---
holder_of_gid=$(dscl . -list /Groups PrimaryGroupID | awk -v g="$GID" '$2 == g {print $1}')
[ -z "$holder_of_gid" ] || [ "$holder_of_gid" = "$GROUP" ] || fail "group ID $GID is used by $holder_of_gid"
for i in "${!USERS[@]}"; do
  holder=$(dscl . -list /Users UniqueID | awk -v u="${UIDS[$i]}" '$2 == u {print $1}')
  [ -z "$holder" ] || [ "$holder" = "${USERS[$i]}" ] || fail "user ID ${UIDS[$i]} is used by $holder"
done

# --- Group and accounts ---
# Refuse a path that is a link or not root's own, then create it in one step.
safe_dir() { # path owner group mode
  if [ -L "$1" ]; then fail "$1 is a symbolic link"; fi
  if [ -e "$1" ] && [ "$(stat -f %Su "$1")" != "$2" ] && [ "$(stat -f %Su "$1")" != root ]; then fail "$1 is owned by $(stat -f %Su "$1")"; fi
  install -d -o "$2" -g "$3" -m "$4" "$1"
}
safe_dir "$HOMES" root wheel 755
if dscl . -read "/Groups/$GROUP" >/dev/null 2>&1; then
  say "group $GROUP exists"
else
  dscl . -create "/Groups/$GROUP"
  dscl . -create "/Groups/$GROUP" PrimaryGroupID "$GID"
  dscl . -create "/Groups/$GROUP" RealName "nuncius task accounts"
  dscl . -create "/Groups/$GROUP" Password '*'
  say "created group $GROUP ($GID)"
fi

for i in "${!USERS[@]}"; do
  u=${USERS[$i]}
  if dscl . -read "/Users/$u" >/dev/null 2>&1; then
    say "account $u exists"
  else
    dscl . -create "/Users/$u"
    dscl . -create "/Users/$u" UniqueID "${UIDS[$i]}"
    dscl . -create "/Users/$u" PrimaryGroupID "$GID"
    dscl . -create "/Users/$u" UserShell /usr/bin/false
    dscl . -create "/Users/$u" NFSHomeDirectory "$HOMES/$u"
    dscl . -create "/Users/$u" RealName "nuncius task $((i + 1))"
    dscl . -create "/Users/$u" Password '*'
    dscl . -create "/Users/$u" IsHidden 1
    say "created account $u (${UIDS[$i]})"
  fi
  dseditgroup -o edit -a "$u" -t user "$GROUP"
  # A private home folder (also for accounts made by an earlier version, which had /var/empty).
  safe_dir "$HOMES/$u" "$u" "$GROUP" 700
  dscl . -create "/Users/$u" NFSHomeDirectory "$HOMES/$u"
  # Not in staff: the owner's home folder is readable by staff.
  if dseditgroup -o checkmember -m "$u" staff >/dev/null 2>&1; then fail "$u is a member of staff"; fi
done

dseditgroup -o edit -a "$OWNER" -t user "$GROUP"
say "$OWNER is in $GROUP (to read and clean up what tasks write)"

# --- Pass-through on the home folder: traverse only, no listing (ADR 12, option A). ---
if ls -led "$OWNER_HOME" | grep -q "group:$GROUP allow search"; then
  say "home pass-through exists"
else
  chmod +a "group:$GROUP allow search" "$OWNER_HOME"
  say "task accounts may pass through $OWNER_HOME (not list it)"
fi

# --- nuncius's own data folder: private to the owner. ---
for d in "$OWNER_HOME/.nuncius"; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then
    chmod 700 "$d"
    say "$d is private (700)"
  fi
done

# --- sudo: the owner may run commands as the task accounts (never as root), without a password. ---
tmp=$(mktemp)
cat > "$tmp" <<EOF
# nuncius (docs/adr/0012-separate-task-accounts.md): $OWNER may run commands as the
# task accounts, which have fewer rights than $OWNER. Nothing here runs as root.
Runas_Alias NUNCIUS_TASKS = $(IFS=,; echo "${USERS[*]}" | sed 's/,/, /g')
$OWNER ALL = (NUNCIUS_TASKS) NOPASSWD: ALL
EOF
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; fail "the sudo rule did not validate"; }
install -m 0440 -o root -g wheel "$tmp" "$SUDOERS"
rm -f "$tmp"
say "sudo rule installed ($SUDOERS)"

# --- Firewall: the task accounts reach only loopback (nuncius's proxy); nothing inbound. ---
if [ "$FIREWALL" = 1 ]; then
  ulist=$(IFS=,; echo "${UIDS[*]}" | sed 's/,/, /g')
  tmp=$(mktemp)
  cat > "$tmp" <<EOF
# nuncius task accounts (docs/adr/0012-separate-task-accounts.md): loopback only, no inbound.
block drop out quick inet proto { tcp, udp } from any to ! 127.0.0.1 user { $ulist }
block drop out quick inet6 proto { tcp, udp } user { $ulist }
block drop in quick inet proto { tcp, udp } from ! 127.0.0.1 to any user { $ulist }
block drop in quick inet6 proto { tcp, udp } user { $ulist }
EOF
  pfctl -nf "$tmp" -a "$ANCHOR" >/dev/null 2>&1 || { rm -f "$tmp"; fail "the firewall rules did not validate"; }
  install -m 0644 -o root -g wheel "$tmp" "$ANCHOR_FILE"
  rm -f "$tmp"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>/sbin/pfctl -E >/dev/null 2>&amp;1; /sbin/pfctl -a '$ANCHOR' -f '$ANCHOR_FILE'</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
  chown root:wheel "$PLIST"
  chmod 0644 "$PLIST"
  launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap system "$PLIST"
  sleep 1
  if pfctl -a "$ANCHOR" -s rules 2>/dev/null | grep -q "block drop out"; then
    say "firewall rules loaded (anchor $ANCHOR, reloaded at every start)"
  else
    fail "the firewall rules did not load"
  fi
else
  say "firewall skipped (--no-firewall)"
fi

echo "done. Check it with: nuncius doctor"
