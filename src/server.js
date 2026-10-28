import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUsage } from './log.js';
import { summarise, latestCodexLimits, taskPage } from './summary.js';
import { loadConfig, configPath } from './config.js';
import { listTasks, readTask, readActivity, taskProgress, queueStatus, TERMINAL, freshCodexLimits } from './tasks.js';
import { openWorktrees, autoCleanup } from './cleanup.js';
import { claudeLimitsHint, readBridgeSeen } from './claude-limits.js';
import { targetStatus } from './targets.js';
import { statuslineInstalled } from './statusline.js';
import { progressView, QUIET_SECONDS } from './progress.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'index.html');

export function buildSummary({ days = 30, project = '' } = {}) {
  autoCleanup();
  const records = readUsage();
  const scoped = project ? records.filter((r) => r.project === project) : records;
  const s = summarise(scoped, { days });
  s.codexLimits = latestCodexLimits(records); // subscription limits are account-wide
  s.allProjects = [...new Set(records.map((r) => r.project).filter((p) => p != null).map(String))].sort();
  if (!s.claudeLimits) s.claudeLimitsHint = claudeLimitsHint({ installed: statuslineInstalled(), seen: readBridgeSeen() });
  s.project = project || null;
  const config = loadConfig();
  s.budgets = config.budgets;
  // Which tools this user has, so the dashboard only shows those (and any with usage in the period).
  s.targets = targetStatus(config).map(({ name, enabled, installed, available, reason }) => ({ name, enabled, installed, available, reason }));
  // Ask Codex for its current windows in the background (cached a minute): the next poll shows them.
  if (s.targets.find((t) => t.name === 'codex')?.available) freshCodexLimits(config).catch(() => {});
  const { queue, activeTasks } = buildLive(config);
  s.queue = queue;
  s.activeTasks = activeTasks;
  s.worktrees = openWorktrees()
    .filter((w) => !project || w.project === project)
    .map((w) => ({ ...w, files: w.files?.length ?? 0 }))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))); // newest first
  return s;
}

// The Now section on its own: cheap (task files only), so the page asks for it every few seconds.
// Live tasks are shown for every project: the queue is shared.
export function buildLive(config = loadConfig()) {
  const live = listTasks({ cached: true }).filter((t) => !TERMINAL.has(t.state));
  const activeTasks = live
    .map((t) => ({ id: t.id, state: t.state, target: t.target, model: t.model, project: t.project, agent: t.agent, createdAt: t.createdAt, startedAt: t.startedAt ?? null, network: !!t.network, promptPreview: String(t.prompt ?? '').slice(0, 160),
      // The page counts the times on itself between polls, so it gets the moments, not just the view.
      progress: liveProgress(t) }));
  return { queue: queueStatus(config, live), activeTasks, generatedAt: new Date().toISOString() };
}

function liveProgress(t) {
  const p = t.state === 'running' ? taskProgress(t) : null;
  return p ? { ...progressView(p, { state: t.state, startedAt: t.startedAt }), lastActivityAt: p.lastActivityAt ?? null, quietSeconds: QUIET_SECONDS } : null;
}

// One page of the task list, with the dashboard's filters (see taskPage).
export function buildTaskPage({ days = 30, project = '', tool = '', outcome = '', q = '', page = 1, size = 25 } = {}) {
  const records = readUsage();
  const scoped = project ? records.filter((r) => String(r.project) === project) : records;
  return taskPage(scoped, { days, tool, outcome, q: String(q).slice(0, 200), page, size });
}

// One task in full, for the dashboard's detail view: the whole prompt and the target's answer.
// Both are shown as text (the answer is target output); the id must be a task id (readTask checks).
// `after`: the number of activity log lines the page already has; only later ones are sent.
export function taskDetail(id, { after = 0 } = {}) {
  const t = readTask(id);
  if (!t) return null;
  const wt = t.worktree;
  return {
    id: t.id, state: t.state, target: t.target, model: t.model, alias: t.alias, project: t.project, agent: t.agent, caller: t.caller,
    network: !!t.network, createdAt: t.createdAt, startedAt: t.startedAt ?? null, finishedAt: t.finishedAt ?? null, wallMs: t.wallMs ?? null,
    prompt: t.prompt, output: t.result?.output ?? '', error: t.result?.error ?? null, usage: t.result?.usage ?? null,
    modelsReported: t.evidence?.models ?? [], blockedHosts: t.egress?.denied ?? [], warnings: t.warnings ?? [],
    worktree: wt ? { branch: wt.branch, changed: wt.changed ?? null, removed: !!wt.removed, files: wt.files ?? [], sensitiveFiles: wt.sensitiveFiles ?? [], review: wt.review ?? null, apply: wt.apply ?? null } : null,
    // What the target did, oldest first, from line `after` of its log (tasks from before the log have none).
    activity: activityOf(t, after),
  };
}

// Only what the task window needs every 2 s while a task runs: its state and the new log lines.
export function taskActivity(id, { after = 0 } = {}) {
  const t = readTask(id);
  return t ? { id: t.id, state: t.state, activity: activityOf(t, after) } : null;
}

function activityOf(t, after) {
  const p = taskProgress(t);
  return p ? { ...readActivity(t.id, { after }), after, ...progressView(p, { state: t.state, startedAt: t.startedAt, finishedAt: t.finishedAt, wallMs: t.wallMs }) } : null;
}

// Only answer requests addressed to loopback by name, so a malicious site cannot read the
// dashboard through DNS rebinding (its Host header would carry the attacker's domain).
export function isAllowedHost(host, port) {
  const h = String(host ?? '').toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].some((name) => h === `${name}:${port}`);
}

// The data API needs the token nuncius prints with the dashboard URL. Loopback alone is not enough:
// every account on this Mac can reach 127.0.0.1, and the API serves prompts and task output. The
// token travels in the URL fragment (never sent to a server, so it stays out of logs and Referer)
// and the page sends it back in a header.
export const newDashboardToken = () => crypto.randomBytes(24).toString('hex');
export function tokenMatches(given, token) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createServer(port, token) {
  if (!token) throw new Error('the dashboard needs a token');
  return http.createServer((req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, port)) {
        res.writeHead(403).end('forbidden host');
        return;
      }
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      if (url.pathname.startsWith('/api/') && !tokenMatches(req.headers['x-nuncius-token'], token)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing or wrong dashboard token: open the URL nuncius dashboard printed' }));
        return;
      }
      if (url.pathname === '/api/summary') {
        const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
        const body = JSON.stringify(buildSummary({ days, project: url.searchParams.get('project') || '' }));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(body);
      } else if (url.pathname === '/api/live') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(buildLive()));
      } else if (url.pathname === '/api/tasks') {
        const p = url.searchParams;
        const body = JSON.stringify(buildTaskPage({
          days: Math.min(365, Math.max(1, Number(p.get('days')) || 30)),
          project: p.get('project') || '', tool: p.get('tool') || '', outcome: p.get('outcome') || '',
          q: p.get('q') || '', page: p.get('page') || 1, size: p.get('size') || 25,
        }));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(body);
      } else if (url.pathname === '/api/task' || url.pathname === '/api/task/activity') {
        const after = Number(url.searchParams.get('after'));
        const read = url.pathname === '/api/task' ? taskDetail : taskActivity;
        const detail = read(url.searchParams.get('id'), { after: Number.isInteger(after) && after > 0 ? after : 0 });
        res.writeHead(detail ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(detail ?? { error: 'no such task' }));
      } else if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(PAGE));
      } else {
        res.writeHead(404).end('not found');
      }
    } catch (err) {
      // A corrupt record or any other fault answers this one request with a 500; the server lives on.
      try {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'internal error' }));
      } catch {
        // headers already sent
      }
    }
  });
}

export function startServer(port) {
  // Bind to loopback only: the log contains prompt previews.
  const token = newDashboardToken();
  const server = createServer(port, token);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE')
      console.error(`nuncius dashboard: port ${port} is already in use by another program.\nPick another one: nuncius dashboard --port <port>, or set it for good: nuncius config set dashboard.port <port>.`);
    else console.error(`nuncius dashboard: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`nuncius dashboard on http://localhost:${port}/#t=${token}  (Ctrl+C to stop)`);
  });
}
