// The version pause's prompt (PD-29): a design version arrived after the plan was approved, and the user chooses to update the
// plan or to finish the approved version first. Raised by the parent's design delivery, never by a tool call.
import { randomUUID } from 'node:crypto';
import type { DesignChange, DesignVersionChoice } from '../../../shared/types/design';
import { registerAbortablePrompt, type PermissionState } from '../state';
import type { PendingDesignVersion, PostMessageFn } from '../types';

/** What the prompt asks: design `toVersion` arrived after the plan was approved against `fromVersion` (0: none). */
export interface DesignVersionAsk {
  readonly designId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changes: readonly DesignChange[];
}

export class DesignVersionManager {
  private readonly state: PermissionState;
  private readonly getPostMessage: () => PostMessageFn | null;

  constructor(state: PermissionState, getPostMessage: () => PostMessageFn | null) {
    this.state = state;
    this.getPostMessage = getPostMessage;
  }

  /**
   * Raises the prompt until the user answers or `signal` aborts, which resolves undefined. It registers with no webview attached
   * too: `repostPendingPrompts` shows it to the next one, as every pending prompt.
   */
  requestDesignVersionDecision(ask: DesignVersionAsk, signal: AbortSignal): Promise<DesignVersionChoice | undefined> {
    const promptId = `designversion-${randomUUID()}`;
    return new Promise<DesignVersionChoice | undefined>((resolve) => {
      const onAborted = (): void => {
        if (this.state.removePendingDesignVersion(promptId)) this.getPostMessage()?.({ type: 'designVersionDecisionClosed', promptId });
        resolve(undefined);
      };
      const request: PendingDesignVersion['request'] = {
        type: 'requestDesignVersionDecision',
        promptId,
        designId: ask.designId,
        fromVersion: ask.fromVersion,
        toVersion: ask.toVersion,
        changes: [...ask.changes],
        owner: this.state.promptOwner(null),
      };
      registerAbortablePrompt({
        signal,
        toolUseId: promptId,
        register: () => {
          this.state.addPendingDesignVersion(promptId, { resolve, cleanup: () => signal.removeEventListener('abort', onAborted), request });
          this.getPostMessage()?.(request);
        },
        onAborted,
      });
    });
  }

  /** The user's answer from any view; every view drops the prompt. One for a prompt no longer open is ignored. */
  resolveDesignVersionDecision(promptId: string, choice: DesignVersionChoice): void {
    const pending = this.state.removePendingDesignVersion(promptId);
    if (!pending) return;
    pending.cleanup();
    this.getPostMessage()?.({ type: 'designVersionDecisionClosed', promptId });
    pending.resolve(choice);
  }
}
