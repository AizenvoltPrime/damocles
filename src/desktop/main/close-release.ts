// The questions a close or quit asks before it goes on: docs/invariants.md "Desktop host", the quit lifecycle.
import type { RemoteRelease } from './remote/close-remote';

export interface CloseReleaseDeps {
  // the remote agents' question; undefined when the user cancelled, else what the close does with the runs once it goes on
  readonly remote: ((unattended: boolean) => Promise<RemoteRelease | undefined>) | undefined;
  // running terminals; false when the user cancelled
  readonly terminals: () => Promise<boolean>;
  // unsaved editors; false when the user cancelled
  readonly editors: () => Promise<boolean>;
}

/**
 * Remote agents first, then running terminals, then unsaved editors; the remote answer acts only once every question passed,
 * so a later Cancel leaves the agents as they were. The answers hold until a cancel or a new window, so the window's own close
 * event does not ask twice.
 */
export class CloseRelease {
  private readonly deps: CloseReleaseDeps;
  private remoteReleased = false;
  private terminalsReleased = false;
  private unattended = false;

  constructor(deps: CloseReleaseDeps) {
    this.deps = deps;
  }

  /** The close under way passed the terminals' question (the window's close event closes at once only then). */
  get terminalsAgreed(): boolean {
    return this.terminalsReleased;
  }

  /** An OS shutdown or an update's quit: the next close keeps the remote runs with no question, unless it is cancelled. */
  keepRunsWithoutAsking(): void {
    this.unattended = true;
  }

  /** A window opened: its close asks every question again. */
  windowOpened(): void {
    this.remoteReleased = false;
    this.terminalsReleased = false;
  }

  /** true when the close may go on. */
  async release(): Promise<boolean> {
    let released = false;
    try {
      released = await this.ask();
      return released;
    } finally {
      if (!released) {
        this.terminalsReleased = false;
        this.unattended = false;
      }
    }
  }

  private async ask(): Promise<boolean> {
    let remote: RemoteRelease | undefined;
    if (this.deps.remote && !this.remoteReleased) {
      remote = await this.deps.remote(this.unattended);
      if (!remote) return false;
    }
    if (!this.terminalsReleased) this.terminalsReleased = await this.deps.terminals();
    if (!this.terminalsReleased || !(await this.deps.editors())) return false;
    if (remote) {
      await remote();
      this.remoteReleased = true;
    }
    return true;
  }
}
