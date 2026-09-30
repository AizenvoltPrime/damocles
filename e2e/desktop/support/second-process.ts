import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { ChildCommand, ChildEvent, ChildReply } from '../second-process/protocol';
import { REPO_ROOT } from './hermetic';

export const SECOND_PROCESS_BUNDLE = path.join(REPO_ROOT, 'dist', 'e2e', 'second-process.cjs');

type Posted = { type?: string } & Record<string, unknown>;

/** A headless Damocles host in its own Node process: core over fake platform objects, on the same HOME. */
export class SecondProcess {
  readonly posted: Posted[] = [];
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly waiters = new Set<{ match: (m: Posted) => boolean; resolve: (m: Posted) => void }>();
  private nextId = 0;
  private stderr = '';
  private readonly exited: Promise<number | null>;
  readonly ready: Promise<void>;

  /** `folder` '-' targets the home directory, as a host with no project does; `settings` is the user scope. */
  constructor(folder: string, env: Record<string, string>, settings: Record<string, unknown> = {}) {
    this.child = fork(SECOND_PROCESS_BUNDLE, [folder, REPO_ROOT, JSON.stringify(settings)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child.stdout!.on('data', (d: Buffer) => (this.stderr += d.toString()));
    this.child.stderr!.on('data', (d: Buffer) => (this.stderr += d.toString()));
    this.exited = new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
    this.exited.then((code) => {
      for (const p of this.pending.values()) p.reject(new Error(`second process exited (${code}) with a command pending\n${this.log()}`));
      this.pending.clear();
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.exited.then((code) => reject(new Error(`second process exited (${code}) before ready\n${this.log()}`)));
      this.child.on('message', (raw: ChildEvent | ChildReply) => {
        if (raw.kind === 'ready') resolve();
        else if (raw.kind === 'posted') this.onPosted(raw.message as Posted);
        else this.onReply(raw);
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** The child's own log (core log lines and stderr), for failure artifacts. */
  log(): string {
    return this.stderr;
  }

  call(cmd: ChildCommand): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ ...cmd, id });
    });
  }

  /** Resolves with the first panel message (already posted or future) that matches. */
  waitForPosted(match: (m: Posted) => boolean, timeoutMs = 60_000): Promise<Posted> {
    const existing = this.posted.find(match);
    if (existing) return Promise.resolve(existing);
    // Captured here so a timeout reports the spec line that waited, not this timer.
    const origin = new Error('waited from');
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (m: Posted) => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        const recent = this.posted.slice(-15).map((m) => m.type).join(', ');
        reject(new Error(`second process posted no matching message within ${timeoutMs} ms (last posted: ${recent})\n${origin.stack}\n${this.log().slice(-4000)}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** Sends a chat message and resolves with the session id once the turn is idle again. */
  async chat(text: string): Promise<string> {
    const before = this.posted.length;
    await this.call({ cmd: 'webviewMessage', message: { type: 'sendMessage', content: text } });
    await this.waitForPosted((m) => this.posted.indexOf(m) >= before && m.type === 'stopInfo');
    const idle = this.posted.filter((m) => m.type === 'sessionStateChanged' && m['state'] === 'idle').at(-1);
    if (!idle) throw new Error('turn ended without an idle session state');
    return String(idle['sessionId']);
  }

  kill(): Promise<number | null> {
    this.child.kill('SIGKILL');
    return this.exited;
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await this.call({ cmd: 'dispose' });
    this.child.kill();
    await this.exited;
  }

  private onPosted(message: Posted): void {
    this.posted.push(message);
    for (const w of [...this.waiters]) {
      if (w.match(message)) {
        this.waiters.delete(w);
        w.resolve(message);
      }
    }
  }

  private onReply(reply: ChildReply): void {
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(`second process command failed: ${reply.error}`));
  }
}
