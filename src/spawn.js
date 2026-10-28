import { spawn } from 'node:child_process';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Output kept in memory per stream; past this the rest is dropped (a target can print without end).
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// After the child exits, how long to wait for its pipes to close. A process that left the group
// (setsid) can hold them open for ever; the run must still end, on time and with a usage record.
const PIPE_GRACE_MS = 2000;
// A stdout line longer than this is not handed to onLine (it is still kept in the output).
const MAX_LINE_CHARS = 8 * 1024 * 1024;

// Run a CLI and capture its output. stderr is echoed when `echoStderr` is set (the interactive CLI),
// so a person still sees progress. After `timeoutMs` the child gets SIGTERM, then SIGKILL 5s later.
// The child leads its own process group, so a timeout, its exit, or nuncius being stopped also ends
// every process it started in the background (except ones that left the group on purpose).
// `onSpawn(pid)` is told the child's pid (= its process group), so a supervisor can end it later.
// `onLine(line)` hears each complete stdout line as it arrives (progress of a running task).
export function run(bin, args, { cwd, env = process.env, timeoutMs = 0, echoStderr = false, onSpawn, onLine, input }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let child;
    try {
      // stdin carries only what the caller hands over (task-account secrets), never the terminal.
      child = spawn(bin, args, { cwd, env, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
      if (input != null) {
        child.stdin.on('error', () => {}); // the target may exit before reading it all
        child.stdin.end(input);
      }
    } catch (err) {
      resolve({ code: 127, stdout, stderr: String(err), spawnError: err, timedOut });
      return;
    }
    if (child.pid && onSpawn) {
      try {
        onSpawn(child.pid);
      } catch {
        // supervision is best effort; the run itself goes on
      }
    }
    const killGroup = (sig) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // group already gone
      }
    };
    const onSignal = (sig) => {
      killGroup('SIGKILL');
      for (const s of SIGNALS) process.removeListener(s, onSignal);
      process.kill(process.pid, sig); // then stop the way we would have without this handler
    };
    for (const s of SIGNALS) process.on(s, onSignal);

    let killTimer;
    const timer =
      timeoutMs > 0 &&
      setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
      }, timeoutMs);
    let settled = false;
    let graceTimer;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      for (const s of SIGNALS) process.removeListener(s, onSignal);
      killGroup('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ ...result, timedOut, ...(truncated ? { truncated } : {}) });
    };
    const keep = (buf, d) => {
      if (buf.length + d.length <= MAX_OUTPUT_BYTES) return buf + d;
      truncated = true;
      return buf + d.slice(0, Math.max(0, MAX_OUTPUT_BYTES - buf.length));
    };
    // Decode as a stream: a multibyte character split across two chunks stays intact.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Lines are cut from the stream separately from what is kept, and a line longer than the cap is dropped.
    let partial = '';
    const lines = (d) => {
      partial += d;
      let nl;
      while ((nl = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, nl);
        partial = partial.slice(nl + 1);
        try {
          onLine(line);
        } catch {
          // a listener must never break the run
        }
      }
      if (partial.length > MAX_LINE_CHARS) partial = '';
    };
    child.stdout.on('data', (d) => {
      stdout = keep(stdout, d);
      if (onLine) lines(d);
    });
    child.stderr.on('data', (d) => {
      stderr = keep(stderr, d);
      if (echoStderr) process.stderr.write(d);
    });
    // Leftover background processes would keep the pipes open (and 'close' from firing).
    let exitCode = null;
    child.on('exit', (code) => {
      exitCode = code;
      killGroup('SIGKILL');
      graceTimer = setTimeout(() => done({ code: exitCode ?? 1, stdout, stderr }), PIPE_GRACE_MS);
    });
    child.on('error', (err) => done({ code: 127, stdout, stderr: stderr + String(err), spawnError: err }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}
