#!/bin/bash
# nuncius: remove everything setup.sh added (docs/adr/0012-separate-task-accounts.md).
#
#   sudo ./scripts/task-accounts/undo.sh
#
# It stops the task accounts' processes, then removes the firewall rules, the sudo rule, the
# pass-through on the home folder, the accounts and the group. nuncius then runs tasks as before.
# Your files are not touched. pf stays enabled if setup enabled it (it then has only Apple's rules).
set -uo pipefail

GROUP=_nuncius
COUNT=4
SUDOERS=/etc/sudoers.d/nuncius
ANCHOR=com.apple/250.nuncius
ANCHOR_FILE=/etc/pf.anchors/nuncius
PLIST=/Library/LaunchDaemons/dev.nuncius.pf.plist

say() { printf '  %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "run it with sudo" >&2; exit 1; }
OWNER=${SUDO_USER:-}
{ [ -n "$OWNER" ] && [ "$OWNER" != root ]; } || { echo "run it with sudo from your own account, not as root" >&2; exit 1; }
OWNER_HOME=$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')

echo "removing nuncius task accounts for $OWNER"

for i in $(seq 1 "$COUNT"); do
  u="${GROUP}${i}"
  dscl . -read "/Users/$u" >/dev/null 2>&1 && pkill -KILL -u "$u" 2>/dev/null && say "stopped processes of $u"
done

if [ -f "$PLIST" ]; then
  launchctl bootout system "$PLIST" >/dev/null 2>&1
  rm -f "$PLIST"
  say "removed the firewall start job"
fi
pfctl -a "$ANCHOR" -F all >/dev/null 2>&1 && say "flushed the firewall rules ($ANCHOR)"
rm -f "$ANCHOR_FILE"

if [ -f "$SUDOERS" ]; then
  rm -f "$SUDOERS"
  say "removed the sudo rule"
fi

if ls -led "$OWNER_HOME" | grep -q "group:$GROUP allow search"; then
  chmod -a "group:$GROUP allow search" "$OWNER_HOME"
  say "removed the pass-through on $OWNER_HOME"
fi

dseditgroup -o edit -d "$OWNER" -t user "$GROUP" >/dev/null 2>&1
for i in $(seq 1 "$COUNT"); do
  u="${GROUP}${i}"
  if dscl . -read "/Users/$u" >/dev/null 2>&1; then
    dscl . -delete "/Users/$u"
    say "deleted account $u"
  fi
done
[ -d /var/db/nuncius-homes ] && [ ! -L /var/db/nuncius-homes ] && rm -rf /var/db/nuncius-homes && say "removed the task accounts' home folders"
if dscl . -read "/Groups/$GROUP" >/dev/null 2>&1; then
  dscl . -delete "/Groups/$GROUP"
  say "deleted group $GROUP"
fi

echo "done. Files a task account left in worktrees keep their numeric owner; nuncius cleanup removes them."
