// What a running task is doing, read from the target's own event stream as it arrives: Claude's
// stream-json, `codex exec --json` and Cursor's stream-json. Every tool's events become one shape:
// elapsed time, the last activity (when, and a short label such as "Edit src/game.js"), and counts of
// steps, edited files and commands. The labels come from the target, so they are data: control
// characters removed, shortened, and never put in a field the calling agent reads as instructions.

// After this long without any event a task is shown as quiet: maybe stuck, maybe thinking long.
// Only a warning; nothing is stopped for it.
export const QUIET_SECONDS = 300;
const MAX_WHAT = 100;

export function cleanLabel(s) {
  const one = String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > MAX_WHAT ? `${one.slice(0, MAX_WHAT - 1)}…` : one;
}

// A path as seen from the worktree: shorter, and without the user's folder names.
function rel(p, base) {
  const s = String(p ?? '');
  return base && s.startsWith(`${base}/`) ? s.slice(base.length + 1) : s;
}

// "Shell: <command>", with a shell wrapper (`/bin/zsh -lc "rg -n x"`, Codex runs every command so) taken off.
export function shellLabel(command) {
  const c = String(command ?? '').trim();
  const m = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(c);
  return `Shell: ${m ? m[2] : c}`;
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);

// One parsed event -> the activities in it: { kind, what, file? }. Kinds edit, command, read and tool are steps;
// message and thinking show the target is busy; done (a step finished) has no label: the step it ends stays shown.
function claudeActivities(ev, base) {
  if (ev.type !== 'assistant') return ev.type === 'user' ? [{ kind: 'done' }] : [];
  const out = [];
  for (const c of ev.message?.content ?? []) {
    if (c?.type === 'tool_use') {
      const name = String(c.name ?? 'tool');
      const input = c.input ?? {};
      if (EDIT_TOOLS.has(name)) out.push({ kind: 'edit', what: `${name} ${rel(input.file_path ?? input.notebook_path, base)}`, file: rel(input.file_path ?? input.notebook_path, base) });
      else if (name === 'Bash') out.push({ kind: 'command', what: shellLabel(input.command) });
      else if (READ_TOOLS.has(name)) out.push({ kind: 'read', what: `${name} ${rel(input.file_path ?? input.pattern ?? input.path, base)}` });
      else out.push({ kind: 'tool', what: name });
    } else if (c?.type === 'text') out.push({ kind: 'message', what: 'writing a reply' });
    else if (c?.type === 'thinking') out.push({ kind: 'thinking', what: 'thinking' });
  }
  return out;
}

function codexActivities(ev, base) {
  if (ev.type === 'turn.started') return [{ kind: 'thinking', what: 'thinking' }];
  if (ev.type !== 'item.started' && ev.type !== 'item.completed') return [];
  const it = ev.item ?? {};
  const started = ev.type === 'item.started';
  if (it.type === 'command_execution') return started ? [{ kind: 'command', what: shellLabel(it.command) }] : [{ kind: 'done' }];
  if (it.type === 'file_change' && !started) return (it.changes ?? []).map((c) => ({ kind: 'edit', what: `${c?.kind ?? 'edit'} ${rel(c?.path, base)}`, file: rel(c?.path, base) }));
  if (it.type === 'reasoning') return [{ kind: 'thinking', what: 'thinking' }];
  if (it.type === 'agent_message') return [{ kind: 'message', what: 'writing a reply' }];
  if (it.type === 'mcp_tool_call' || it.type === 'web_search' || it.type === 'todo_list') return started ? [{ kind: 'tool', what: it.type.replace(/_/g, ' ') }] : [];
  return [];
}

// Cursor's stream-json: { type: 'tool_call', subtype: 'started' | 'completed', tool_call: { <name>ToolCall: { args } } },
// plus 'assistant' messages, 'thinking' deltas, and the 'result' object at the end.
const CURSOR_EDIT = new Set(['editToolCall', 'writeToolCall', 'deleteToolCall']);
const CURSOR_READ = new Set(['readToolCall', 'grepToolCall', 'globToolCall', 'lsToolCall']);
function cursorActivities(ev, base) {
  if (ev.type === 'assistant') return [{ kind: 'message', what: 'writing a reply' }];
  if (ev.type === 'thinking') return [{ kind: 'thinking', what: 'thinking' }];
  if (ev.type !== 'tool_call' || !ev.tool_call || typeof ev.tool_call !== 'object') return [];
  const [key] = Object.keys(ev.tool_call);
  if (!key) return [];
  const args = ev.tool_call[key]?.args ?? {};
  const name = key.replace(/ToolCall$/, '');
  if (ev.subtype !== 'started') return [{ kind: 'done' }];
  if (CURSOR_EDIT.has(key)) return [{ kind: 'edit', what: `${name} ${rel(args.path, base)}`, file: rel(args.path, base) }];
  if (key === 'shellToolCall') return [{ kind: 'command', what: shellLabel(args.command) }];
  if (CURSOR_READ.has(key)) return [{ kind: 'read', what: `${name} ${rel(args.path ?? args.pattern ?? args.globPattern, base)}` }];
  return [{ kind: 'tool', what: name }];
}

const PARSERS = { claude: claudeActivities, codex: codexActivities, cursor: cursorActivities };

// Feed it the target's stdout lines. `onActivity(activity, progress)` hears each one (the CLI prints them).
// `base`: the worktree path, cut from the start of file paths.
export function createProgress({ target, base, timeoutSeconds, now = () => Date.now(), onActivity } = {}) {
  const parse = PARSERS[target] ?? (() => []);
  const files = new Set();
  const p = { startedAt: new Date(now()).toISOString(), timeoutSeconds: timeoutSeconds ?? null, lastActivityAt: null, lastActivity: null, steps: 0, filesEdited: 0, commands: 0 };
  return {
    feed(line) {
      const text = String(line).trim();
      if (!text.startsWith('{')) return false;
      let ev;
      try {
        ev = JSON.parse(text);
      } catch {
        return false;
      }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
      let acts;
      try {
        acts = parse(ev, base);
      } catch {
        acts = [];
      }
      // Any event at all shows the target is alive, even one without a label of its own.
      p.lastActivityAt = new Date(now()).toISOString();
      for (const a of acts) {
        const what = cleanLabel(a.what);
        if (a.kind === 'edit' || a.kind === 'command' || a.kind === 'read' || a.kind === 'tool') p.steps++;
        if (a.kind === 'command') p.commands++;
        if (a.kind === 'edit' && a.file) {
          files.add(String(a.file));
          p.filesEdited = files.size;
        }
        // The CLI hears steps, and the first of a run of thinking or reply chunks (Cursor streams them in pieces).
        const told = a.kind !== 'done' && !((a.kind === 'thinking' || a.kind === 'message') && what === p.lastActivity);
        p.lastActivity = what || p.lastActivity;
        if (onActivity && what && told) {
          try {
            onActivity({ kind: a.kind, what }, p);
          } catch {
            // a listener must never break the run
          }
        }
      }
      return true;
    },
    snapshot: () => ({ ...p }),
  };
}

// The progress as callers see it, computed at read time. `finishedAt`: elapsed stops there.
export function progressView(progress, { state, startedAt, finishedAt, wallMs, now = Date.now() } = {}) {
  if (!progress || typeof progress !== 'object') return null;
  const start = Date.parse(startedAt ?? progress.startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  const elapsedMs = Number.isFinite(wallMs) && state && state !== 'running' ? wallMs : Number.isFinite(start) ? Math.max(0, end - start) : null;
  const last = Date.parse(progress.lastActivityAt);
  const ref = Number.isFinite(last) ? last : start;
  const silentMs = Number.isFinite(ref) ? Math.max(0, end - ref) : null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    elapsedSeconds: elapsedMs == null ? null : Math.round(elapsedMs / 1000),
    timeoutSeconds: Number.isFinite(progress.timeoutSeconds) ? progress.timeoutSeconds : null,
    lastActivity: { secondsAgo: silentMs == null ? null : Math.round(silentMs / 1000), what: progress.lastActivity ? cleanLabel(progress.lastActivity) : null },
    quiet: state === 'running' && silentMs != null && silentMs >= QUIET_SECONDS * 1000,
    steps: n(progress.steps),
    filesEdited: n(progress.filesEdited),
    commands: n(progress.commands),
  };
}

// "4 s", "6 min", "1 h 05 min": for hints and the CLI.
export function shortDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}
