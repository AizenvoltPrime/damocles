// An engine restart reopens each chat with the permission mode and YOLO its ended core published; a launch and a reopened
// window start from the defaults (docs/invariants.md "Desktop host"). Held in memory only, so no relaunch sees them.
import type { ChatPermissions } from '../core-protocol';

export class KeptPermissions {
  // by chat view id
  private kept: ReadonlyMap<string, ChatPermissions> = new Map();

  /**
   * A core ended with these chat views open: each keeps what that core published for it, else what main handed that core
   * for it, else nothing, which a reopen gives the defaults.
   */
  coreEnded(viewIds: readonly string[], published: (viewId: string) => ChatPermissions | undefined): void {
    const previous = this.kept;
    this.kept = new Map(viewIds.flatMap((viewId) => {
      const permissions = published(viewId) ?? previous.get(viewId);
      return permissions ? [[viewId, permissions] as const] : [];
    }));
  }

  /** What a reopen hands the next core, by chat view; a reopen that follows no core's end forgets them. */
  reopening(afterRestart: boolean): ReadonlyMap<string, ChatPermissions> {
    if (!afterRestart) this.kept = new Map();
    return this.kept;
  }
}
