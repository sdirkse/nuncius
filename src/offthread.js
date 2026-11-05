import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// Some nuncius work is synchronous and can take long: creating a task's worktree (git diff/apply,
// copying untracked files), the automatic cleanup (git per open worktree) and closing a task's worktree. The MCP server answers
// every client on one event loop, so it runs that work here, in a worker thread, and stays responsive
// to wait_task, get_task and pings meanwhile.

const JOBS = {
  async submit(args) {
    const { submitTask } = await import('./tasks.js');
    return submitTask(args);
  },
  async cleanup() {
    const { autoCleanup } = await import('./cleanup.js');
    return autoCleanup({ force: true });
  },
  async close({ id, keep }) {
    const { closeTask } = await import('./cleanup.js');
    return closeTask(id, { keep });
  },
};

export function offThread(job, args) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { job, args } });
    w.once('message', (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
    w.once('error', reject);
    w.once('exit', (code) => code !== 0 && reject(new Error(`worker for ${job} exited with code ${code}`)));
  });
}

if (!isMainThread && workerData?.job && Object.hasOwn(JOBS, workerData.job)) {
  JOBS[workerData.job](workerData.args).then(
    (value) => parentPort.postMessage({ ok: true, value }),
    (err) => parentPort.postMessage({ ok: false, error: String(err?.message ?? err) }),
  );
}
