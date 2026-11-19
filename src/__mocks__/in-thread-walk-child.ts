import type { ProcessExit } from '../core/process-launcher';
import type { WalkChild } from '../core/search-walk/walk-host';
import type { WalkReply, WalkRequest } from '../core/search-walk/walk-protocol';

/**
 * The walk process's body on the test's own thread, behind a message channel: each message arrives a turn later as a structured
 * clone, as a utility process's port delivers it, so a test's fs spies see the walk's calls. Production never walks in its own process.
 */
export class InThreadWalkChild implements WalkChild {
  killed = false;
  readonly requests: WalkRequest[] = [];
  readonly exited: Promise<ProcessExit>;
  private readonly replies: Array<(reply: unknown) => void> = [];
  private readonly faults: Array<(reason: string) => void> = [];
  private readonly stderr: Array<(text: string) => void> = [];
  private readonly receive: Promise<(request: WalkRequest) => void>;
  private exit!: (exit: ProcessExit) => void;

  constructor() {
    this.exited = new Promise((resolve) => (this.exit = resolve));
    const post = (reply: WalkReply): void => {
      const copy = structuredClone(reply);
      setImmediate(() => {
        if (!this.killed) for (const listener of this.replies) listener(copy);
      });
    };
    // imported at the first walk, so the walk's modules load after a test's vi.mock calls
    this.receive = import('../core/search-walk/walk-serve').then(({ serveWalks }) => {
      let listener: (request: WalkRequest) => void = () => undefined;
      serveWalks({ send: post, onRequest: (onRequest) => {
        listener = onRequest;
      } });
      return (request) => listener(request);
    });
  }

  onReply(listener: (reply: unknown) => void, onFault: (reason: string) => void): void {
    this.replies.push(listener);
    this.faults.push(onFault);
  }

  onStderr(listener: (text: string) => void): void {
    this.stderr.push(listener);
  }

  /** Sends a reply as the process's own, as a broken process would, at once. */
  emit(reply: unknown): void {
    for (const listener of this.replies) listener(reply);
  }

  /** Breaks the channel's contract, as a line too long would. */
  fault(reason: string): void {
    for (const listener of this.faults) listener(reason);
  }

  /** Writes text to the process's stderr. */
  emitStderr(text: string): void {
    for (const listener of this.stderr) listener(text);
  }

  async send(request: WalkRequest): Promise<void> {
    if (this.killed) throw new Error('The process has closed');
    const copy = structuredClone(request);
    this.requests.push(copy);
    void this.receive.then((receive) => setImmediate(() => {
      if (!this.killed) receive(copy);
    }));
  }

  kill(): void {
    this.end({ code: null, signal: 'SIGKILL' });
  }

  /** Ends as a process that exited on its own. */
  end(exit: ProcessExit): void {
    if (this.killed) return;
    this.killed = true;
    this.exit(exit);
  }
}
