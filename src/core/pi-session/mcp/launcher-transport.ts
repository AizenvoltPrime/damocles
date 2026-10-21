/*
 * pi-mcp's StdioTransport (`@earendil-works/pi-mcp` `dist/transports/stdio.js`, 1.3.0) with its process started on the
 * process launcher, so a slow process start blocks no host thread. Keep the two in step, except for the two departures
 * docs/invariants.md "MCP client and config sources" names: the kill after a server exits during a close, and stdin errors.
 */
import type { JsonRpcMessage, McpTransport, McpTransportCloseListener, McpTransportErrorListener, McpTransportMessageListener } from '@earendil-works/pi-mcp';
import { processLauncher, type LaunchedProcess } from '../../process-launcher';
import type { McpModule } from './mcp-client-loader';

// pi-mcp's DEFAULT_MAX_MESSAGE_BYTES and DEFAULT_MAX_STDERR_BYTES
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
/** How long a server gets to exit on its own after stdin closes, before it is told to stop. */
const STDIN_CLOSE_GRACE_MS = 500;
const CLOSE_TIMEOUT_MS = 2_000;
const USE_PROCESS_GROUPS = process.platform !== 'win32';

/** Process groups of running servers, signalled if the host exits without closing them. */
const liveProcessGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const pid of liveProcessGroups) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // the group is gone
      }
    }
  });
}

export interface LauncherStdioTransportOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  // the server's whole environment; nothing of the host's is inherited
  readonly env: Readonly<Record<string, string>>;
  readonly stderr: 'pipe' | 'inherit';
}

export class LauncherStdioTransport implements McpTransport {
  private child: LaunchedProcess | undefined;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBuffer = Buffer.alloc(0);
  private started = false;
  private spawned = false;
  private exited = false;
  private closed = false;
  private closeEmitted = false;
  private readonly messageListeners = new Set<McpTransportMessageListener>();
  private readonly errorListeners = new Set<McpTransportErrorListener>();
  private readonly closeListeners = new Set<McpTransportCloseListener>();

  private readonly mcp: McpModule;
  private readonly options: LauncherStdioTransportOptions;

  constructor(mcp: McpModule, options: LauncherStdioTransportOptions) {
    this.mcp = mcp;
    this.options = options;
  }

  get stderr(): string {
    return this.stderrBuffer.toString('utf8');
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('MCP stdio transport already started');
    if (this.closed) throw new this.mcp.McpConnectionClosedError();
    this.started = true;
    const { command, args, cwd, env, stderr } = this.options;
    const child = processLauncher().launch({
      file: command,
      args,
      ...(cwd !== undefined ? { cwd } : {}),
      env,
      crossSpawn: true,
      stdio: ['pipe', 'pipe', stderr === 'inherit' ? 'inherit' : 'pipe'],
      windowsHide: true,
      // Its own process group, so closing the transport ends the server's children too.
      detached: USE_PROCESS_GROUPS,
    });
    this.child = child;
    child.onData('stdout', (chunk) => this.handleStdout(chunk));
    child.onData('stderr', (chunk) => this.handleStderr(chunk));
    child.exited.then(() => {
      this.exited = true;
    }, () => undefined);
    child.closed.then(() => this.handleClose(), (error: unknown) => {
      // a start error rejects start(), as Node's spawn error does; a later one is the connection's
      if (this.spawned && !this.closed) this.emitError(error);
      this.handleClose();
    });
    const pid = await child.pid;
    this.spawned = true;
    if (USE_PROCESS_GROUPS) {
      installExitHook();
      liveProcessGroups.add(pid);
      void child.exited.then(() => liveProcessGroups.delete(pid), () => liveProcessGroups.delete(pid));
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!this.started || this.closed || this.exited || !child) throw new this.mcp.McpConnectionClosedError();
    await child.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) {
      this.emitClose();
      return;
    }
    if (this.exited) {
      child.end();
      return;
    }
    // Shutdown per the spec: close stdin and let the server exit, then SIGTERM its group, then SIGKILL it. Windows has no
    // graceful signal, and a .cmd shim runs the server under cmd.exe, so there the first step terminates its job.
    await new Promise<void>((resolve) => {
      const timers = [
        setTimeout(() => child.kill({ tree: true, signal: 'SIGTERM' }), STDIN_CLOSE_GRACE_MS),
        setTimeout(() => child.kill({ tree: true, signal: 'SIGKILL' }), STDIN_CLOSE_GRACE_MS + CLOSE_TIMEOUT_MS),
      ];
      // What the server left running would outlive it. POSIX: SIGTERM to its group, reachable until the close. Windows:
      // its job is terminated, reaching every descendant, detached ones included; pi skips this, holding only a reusable pid.
      child.exited.then(() => child.kill({ tree: true, signal: 'SIGTERM' }), () => undefined);
      const done = (): void => {
        for (const timer of timers) clearTimeout(timer);
        resolve();
      };
      child.closed.then(done, done);
      child.end();
    });
  }

  private handleClose(): void {
    this.child = undefined;
    if (this.stdoutBuffer.toString('utf8').trim()) this.emitError(new Error('MCP stdio server closed with an incomplete JSON-RPC message'));
    this.stdoutBuffer = Buffer.alloc(0);
    this.emitClose();
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.length > MAX_MESSAGE_BYTES) {
          this.stdoutBuffer = Buffer.alloc(0);
          this.emitError(new Error(`MCP stdio message exceeds ${MAX_MESSAGE_BYTES} bytes`));
        }
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.length > MAX_MESSAGE_BYTES) {
        this.emitError(new Error(`MCP stdio message exceeds ${MAX_MESSAGE_BYTES} bytes`));
        continue;
      }
      const text = line.toString('utf8').replace(/\r$/, '');
      if (!text.trim()) continue;
      try {
        const message = this.mcp.parseJsonRpcMessage(JSON.parse(text));
        for (const listener of this.messageListeners) listener(message);
      } catch (error) {
        this.emitError(error);
      }
    }
  }

  private handleStderr(chunk: Buffer): void {
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk]);
    if (this.stderrBuffer.length > MAX_STDERR_BYTES) this.stderrBuffer = this.stderrBuffer.subarray(-MAX_STDERR_BYTES);
  }

  private emitError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.errorListeners) listener(normalized);
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closeListeners) listener();
  }
}
