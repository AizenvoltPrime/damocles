import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';

// A holder refreshes its lock, and a waiter its ticket, every UPDATE_MS; one not refreshed for STALE_MS belongs to a worker
// that died or hung, and is taken over.
const STALE_MS = 10_000;
const UPDATE_MS = 2_000;
const RETRY_MS = 250;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const tickets = (queue: string): number[] => fs.readdirSync(queue).filter((name) => /^\d+$/.test(name)).map(Number);

// One past the highest ticket in the queue, holding this worker's pid; the exclusive create gives two workers that read the
// same highest ticket different ones.
function takeTicket(queue: string): number {
  fs.mkdirSync(queue, { recursive: true });
  for (let ticket = Math.max(0, ...tickets(queue)) + 1; ; ticket++) {
    try {
      fs.writeFileSync(path.join(queue, String(ticket)), String(process.pid), { flag: 'wx' });
      return ticket;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

// A ticket keeps its place while its worker runs and refreshes it; an empty one is still being written.
function keepsPlace(file: string): boolean {
  try {
    const { mtimeMs } = fs.statSync(file);
    const pid = Number(fs.readFileSync(file, 'utf8'));
    return Date.now() - mtimeMs < STALE_MS && (pid === 0 || alive(pid));
  } catch (err) {
    // Windows answers EPERM for a file another worker is deleting.
    if (['ENOENT', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}

function drop(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    // Held open by another worker's read for a moment on Windows; the next poll drops it.
    if (!['EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
}

/** Resolves once no ticket ahead of `ticket` keeps its place, dropping those of dead or hung workers; the count left at `deadline`. */
async function turn(queue: string, ticket: number, deadline: number): Promise<number> {
  for (;;) {
    const all = tickets(queue);
    if (!all.includes(ticket)) throw new Error(`another worker dropped this worker's ticket ${path.join(queue, String(ticket))}: its event loop stalled for over ${STALE_MS / 1000} s`);
    let ahead = 0;
    for (const other of all.filter((n) => n < ticket)) {
      const file = path.join(queue, String(other));
      if (keepsPlace(file)) ahead++;
      else drop(file);
    }
    if (ahead === 0 || Date.now() >= deadline) return ahead;
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/**
 * Takes the proper-lockfile lock on `target` in arrival order across processes, or rejects after `waitMs`. Each caller first
 * takes a ticket in `<target>.queue`, and only the oldest ticket that keeps its place tries the lock, so a worker that
 * releases it and asks again queues behind every worker already waiting. `onCompromised` runs if the held lock is lost.
 */
export async function lockInTurn(target: string, name: string, waitMs: number, onCompromised: (err: Error) => void): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  const stayedHeld = (reason: string): Error => new Error(`The ${name} lock ${target}.lock stayed held for ${waitMs / 1000} s: ${reason}`);
  const queue = `${target}.queue`;
  // Taken before the first await, so the queue's order is the order of the calls.
  const ticket = takeTicket(queue);
  const file = path.join(queue, String(ticket));
  const refresh = setInterval(() => {
    const now = new Date();
    fs.promises.utimes(file, now, now).catch(() => undefined);
  }, UPDATE_MS);
  refresh.unref();
  try {
    const ahead = await turn(queue, ticket, deadline).catch((err: unknown) => {
      throw new Error(`The ${name} lock lost this worker's place: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (ahead > 0) throw stayedHeld(`${ahead} workers are still ahead in ${queue}`);
    // The queue only orders: this lock excludes, detects a lost hold, and also holds off a run of an older checkout on this machine.
    return await lockfile.lock(target, {
      realpath: false,
      onCompromised,
      stale: STALE_MS,
      update: UPDATE_MS,
      // Every acquire error retries, so Windows' EPERM while another worker removes the lock directory counts as contention.
      retries: { forever: true, minTimeout: RETRY_MS, maxTimeout: RETRY_MS, maxRetryTime: Math.max(RETRY_MS, deadline - Date.now()) },
    }).catch((err: unknown) => {
      throw stayedHeld(err instanceof Error ? err.message : String(err));
    });
  } finally {
    clearInterval(refresh);
    drop(file);
  }
}
