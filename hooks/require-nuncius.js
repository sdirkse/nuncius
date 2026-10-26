#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: Bash). Blocks direct Codex / Cursor / headless Claude runs so every
// delegated task goes through `nuncius`, which logs usage and enforces budgets.
// Housekeeping commands (login, status, --version, ...) stay allowed.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOLS = {
  codex: { allow: new Set(['login', 'logout', '--version', '-V', '--help', '-h', 'help', 'mcp', 'mcp-server', 'completion']), use: 'nuncius codex "<prompt>"' },
  // Plain `claude` is the user's interactive CLI; only headless runs (-p / --print) are delegations.
  claude: { allow: null, directIf: (rest) => rest.some((w) => w === '-p' || w === '--print' || /^-[a-zA-Z]*p$/.test(w)), use: 'nuncius claude "<prompt>"' },
  'cursor-agent': { allow: new Set(['login', 'logout', 'status', 'whoami', '--version', '-v', '--help', '-h', 'help', 'update', 'ls']), use: 'nuncius cursor "<prompt>"' },
};
// Cursor's installer also links the same CLI as `agent`.
TOOLS.agent = TOOLS['cursor-agent'];

// Shell words that start a command after them (`if codex ...`, `! codex ...`, `do codex ...`).
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', 'coproc']);

// Words that run (part of) the rest of the line as a command. Parsing every option of every one of
// these is a losing game, so once one appears the rest of the segment is scanned fail-closed.
const PREFIXES = new Set(['env', 'exec', 'time', 'nohup', 'command', 'builtin', 'sudo', 'doas', 'npx', 'bunx', 'xargs', 'eval', 'nice', 'timeout', 'stdbuf', 'caffeinate', 'bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'script', 'unbuffer', 'expect', 'watch']);

const clean = (w) => w.replace(/^[\\"']+|["']+$/g, '');

// The tool a word names, also when wrapped as `--opt=codex`, `-Scodex` or `-S'codex`.
function toolIn(word) {
  for (const cand of [word, word.slice(word.lastIndexOf('=') + 1), word.replace(/^-S/, '')]) {
    let name = path.basename(clean(cand));
    if (name === '@openai/codex') name = 'codex';
    if (Object.hasOwn(TOOLS, name)) return name === 'agent' ? 'cursor-agent' : name;
  }
  return null;
}

function hit(words, i) {
  const name = toolIn(words[i]);
  if (!name) return null;
  const tool = TOOLS[name];
  if (tool.directIf) return tool.directIf(words.slice(i + 1)) ? { tool: name, use: tool.use } : null;
  const sub = words[i + 1];
  if (sub && tool.allow.has(sub)) return null;
  return { tool: name, use: tool.use };
}

// `nuncius ... --force` overrides budgets. The CLI only honours it on a terminal, but an agent can make
// one (script, unbuffer), so the hook also refuses it, wrapped or not: overriding is the user's call.
const FORCE = { tool: 'nuncius --force', reason: 'Budget overrides are for the user, not agents. Tell the user which budget was hit; they can run the command with --force in their own terminal or raise the budget in ~/.nuncius/config.json.' };

// Quotes and backslashes are dropped first (`--for""ce`, `--fo\rce`). Expansions like `$F` cannot be
// resolved here; nuncius itself refuses --force under an agent (bin/nuncius.js), which sees the real argv.
// Changing nuncius's own settings (budgets, sandbox, which tools it runs) or removing this guard is
// also the user's call: `nuncius config set|unset|add|remove`, `nuncius setup`, `nuncius uninstall-hook`,
// `nuncius install-statusline` / `uninstall-statusline` (the bridge feeds Claude's window budgets).
const SETTINGS = { tool: 'nuncius settings', reason: 'Changing nuncius\'s settings is for the user, not agents. Tell the user what you would change and the exact command (e.g. `nuncius config set budgets.cursor.maxRunsPerDay 50`); they can run it in their own terminal. Reading settings is fine: `nuncius config list` / `nuncius config get <key>`.' };

// Quotes, backslashes and the brackets of a command substitution are not part of a word's meaning
// (`--for""ce`, `"$(nuncius setup)"`).
const plainWord = (w) => w.replace(/["'\\`()]/g, '');
const isNuncius = (w) => /^nuncius(\.js)?$/.test(path.basename(plainWord(w)));

// `words` starts at a nuncius invocation (nuncius, or the nuncius.js a runtime runs).
function nunciusGuard(words) {
  const rest = words.slice(1).map(plainWord);
  if (rest.some((w) => /^--force(=|$)/.test(w))) return FORCE;
  const [sub, action] = rest.filter((w) => !w.startsWith('-'));
  if (['setup', 'uninstall-hook', 'install-statusline', 'uninstall-statusline'].includes(sub) || (sub === 'config' && ['set', 'unset', 'add', 'remove'].includes(action))) return SETTINGS;
  return null;
}

// Interpreters run code, from a script (`node bin/nuncius.js setup`), from an argument (`node -e`,
// `python3 -c`) or from a heredoc. That code can start nuncius in ways no text check can follow, so
// for these every word of the command (and of code fed to them) is checked, fail-closed.
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl', 'php', 'lua']);
// Shells that run what a heredoc feeds them (`bash <<EOF ... EOF`): their heredoc bodies are commands.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh']);
// The only commands whose heredoc is plain data: they copy it to a file or stdout (`cat > f <<EOF`).
const DATA_SINKS = new Set(['cat', 'tee']);

// Words in code or text, split finely enough that `os.system('nuncius setup')` yields nuncius, setup.
const codeWords = (text) => text.split(/[^\w./-]+/).filter(Boolean);

// The command word of a segment: after FOO=bar assignments and shell keywords.
function commandStart(words) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || KEYWORDS.has(words[i]))) i++;
  return i;
}

// Split a command line into the simple commands the shell would run, like the shell does where it
// matters here: separators (; & | newline, ( ) { }) and command substitutions ($( `, <( >( ) start
// a new command, but not inside quotes, so `git commit -m "fix; nuncius setup"` stays one command.
// Inside double quotes $( and backticks still run commands, so those still split.
// Heredoc bodies: commands when a shell reads them; plain data only in the one exact form that
// writes a file and nothing else (see dataHeredoc); every other heredoc (an interpreter, a pipe, a
// group, an unknown command) gets its body checked word by word, fail-closed. `<<` inside arithmetic
// ($(( )), (( ))) is a shift. Comments are skipped, as the shell skips them.
// Returns [{ text, code }]: `code` marks text that some program will interpret as code.
export function commandSegments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  let arith = 0;
  const pending = []; // heredocs opened on the current line: { delim, dash, as: 'commands' | 'data' | 'code' }
  const cut = () => {
    out.push({ text: cur, code: false });
    cur = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    // A comment runs to the end of the line: an apostrophe in it opens no quote. As in the shell, #
    // starts one only at the start of a word (never in ${#x} or $#). Telling exactly where the shell
    // sees a word start (escapes, substitutions) is where parsers differ, so the comment text is still
    // checked word by word: guessing wrong can make the hook stricter, never let a call through.
    if (quote === null && c === '#' && (i === 0 || ' \t\n;&|()'.includes(command[i - 1]))) {
      const nl = command.indexOf('\n', i);
      const end = nl < 0 ? command.length : nl;
      // If this is no comment for the shell, what it holds (a quote, <<, $( or a pipe) can change how
      // every later line is read: `echo \ #'` opens a quote the shell closes on the next line, after
      // which a command runs. No rule about which characters matter has held up, so the whole rest
      // of the input is checked word by word, whatever the comment holds.
      out.push({ text: command.slice(i + 1), comment: true });
      i = end - 1;
      continue;
    }
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      cur += c + (command[i + 1] ?? '');
      i++;
      continue;
    }
    if (quote === '"') {
      if ((c === '$' && command[i + 1] === '(') || c === '`') {
        cut();
        if (c === '$') i++;
        continue;
      }
      cur += c;
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    // Arithmetic: $(( ... )) and (( ... )). Inside it, << is a shift, not a heredoc.
    if (command.startsWith('$((', i) || command.startsWith('((', i)) {
      arith++;
      cut();
      i += command[i] === '$' ? 2 : 1;
      continue;
    }
    if (arith > 0 && command.startsWith('))', i)) {
      arith--;
      cut();
      i++;
      continue;
    }
    if (arith === 0 && c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(command.slice(i));
      if (m) {
        const words = cur.trim().split(/\s+/).filter(Boolean).map(clean);
        const cmd = path.basename(plainWord(words[commandStart(words)] ?? ''));
        const lineStart = command.lastIndexOf('\n', i) + 1;
        const lineEnd = command.indexOf('\n', i);
        const line = command.slice(lineStart, lineEnd < 0 ? command.length : lineEnd);
        const shell = SHELLS.has(cmd) || (PREFIXES.has(cmd) && words.some((w) => SHELLS.has(path.basename(w))));
        // Data only as the very first line of the whole input: nothing before it can open a group,
        // continue a line or pipe what it writes into something that runs it.
        const data = lineStart === 0 && out.length === 0 && !line.includes('\\') && dataHeredoc(line, m[3]);
        pending.push({ delim: m[3], dash: m[1] === '-', as: shell ? 'commands' : data ? 'data' : 'code' });
        cur += ' ';
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '\n') {
      cut();
      arith = 0; // arithmetic never spans lines here; a stray (( cannot hide later heredocs
      // Heredoc bodies start on the next line and end at a line that is just the delimiter.
      for (const h of pending) {
        const lines = [];
        let j = i + 1;
        for (;;) {
          const nl = command.indexOf('\n', j);
          const line = command.slice(j, nl < 0 ? command.length : nl);
          j = nl < 0 ? command.length : nl + 1;
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim || nl < 0) {
            if (line !== h.delim && !(h.dash && line.replace(/^\t+/, '') === h.delim)) lines.push(line);
            break;
          }
          lines.push(line);
        }
        if (h.as === 'commands') out.push(...commandSegments(lines.join('\n')));
        else if (h.as === 'code') out.push({ text: lines.join('\n'), code: true });
        i = j - 1;
      }
      pending.length = 0;
      continue;
    }
    if ((c === '$' || c === '<' || c === '>') && command[i + 1] === '(') {
      cut();
      i++;
      continue;
    }
    if (';&|(){}`'.includes(c)) {
      cut();
      continue;
    }
    cur += c;
  }
  cut();
  return out.filter((s) => s.text.trim());
}

// A heredoc is plain data only in the exact form that copies it to a file or stdout and does nothing
// else: `cat [> file] <<EOF`, `cat <<EOF > file`, `tee [-a] file <<EOF`, as the first line of the
// whole input (the caller checks that). Anything else could pass the text on to something that runs it.
function dataHeredoc(line, delim) {
  const word = String.raw`[\w./~@%+=:,-]+`;
  const redirect = String.raw`\s*(?:>>?|1>>?)\s*${word}`;
  const re = new RegExp(String.raw`^\s*(?:cat|tee)(?:\s+-{1,2}[\w-]+|\s+${word}|${redirect})*\s*<<-?\s*(['"]?)${delim}\1(?:${redirect}|\s+${word})*\s*$`);
  return re.test(line);
}

// Fail-closed check of code or arguments: a nuncius call anywhere among the words.
function nunciusAnywhere(words) {
  for (let j = 0; j < words.length; j++) {
    const g = isNuncius(words[j]) ? nunciusGuard(words.slice(j)) : null;
    if (g) return g;
  }
  return null;
}

// This is a guardrail for well-meaning agents, not a security boundary (the target sandbox is).
// It looks at what a command runs, not at text it merely mentions: `grep "nuncius setup" README.md`,
// a commit message or `cat > notes.md <<EOF` are fine. Inside commands that run other commands
// (bash -c, sudo, env, xargs, eval, ...) and in code an interpreter runs, it stays fail-closed.
export function findDirectCall(command) {
  for (const segment of commandSegments(command)) {
    if (segment.code || segment.comment) {
      const words = codeWords(segment.text);
      const g = nunciusAnywhere(words);
      if (g) return g;
      // A comment might not be one (see commandSegments): direct tool calls in it count too.
      if (segment.comment)
        for (let j = 0; j < words.length; j++) {
          const h = hit(words, j);
          if (h) return h;
        }
      continue;
    }
    const words = segment.text.trim().split(/\s+/).filter(Boolean).map(clean).filter(Boolean);
    const i = commandStart(words);
    if (i >= words.length) continue;
    const cmd = path.basename(plainWord(words[i]));
    if (PREFIXES.has(cmd)) {
      // Fail closed: any tool name or nuncius call later in a wrapped command counts, even after
      // `nuncius` (`sudo -u nuncius codex ...` must not pass). Agents call `nuncius codex ...` unwrapped.
      for (let j = i + 1; j < words.length; j++) {
        const g = isNuncius(words[j]) ? nunciusGuard(words.slice(j)) : null;
        if (g) return g;
        const h = hit(words, j);
        if (h) return h;
      }
      continue;
    }
    if (isNuncius(words[i])) {
      const g = nunciusGuard(words.slice(i));
      if (g) return g;
      continue;
    }
    if (INTERPRETERS.has(cmd)) {
      // `node --require x bin/nuncius.js setup`, `node -e "...nuncius setup..."`, `python3 -c "..."`:
      // every argument counts, as code.
      const g = nunciusAnywhere(codeWords(words.slice(i + 1).join(' ')));
      if (g) return g;
    }
    // Plain command: only the command word matters, so `grep codex README.md` stays allowed.
    const h = hit(words, i);
    if (h) return h;
  }
  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let command = '';
  try {
    command = JSON.parse(input).tool_input?.command ?? '';
  } catch {
    return; // not our concern; let Claude Code continue
  }
  const hit = findDirectCall(command);
  if (!hit) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: hit.reason ?? `Direct ${hit.tool} runs are not logged. Use \`${hit.use}\` instead (add --project/--agent if useful). It logs usage per project and enforces budgets.`,
      },
    }),
  );
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) main();
