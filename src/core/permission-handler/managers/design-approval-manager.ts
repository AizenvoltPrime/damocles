// FinishDesign's approval prompt: the gate passed, and the user approves the version, asks for changes with a note, or stops
// the designer. A content decision, not a tool permission: no mode, YOLO, rule or hook answers it.
import { randomUUID } from 'node:crypto';
import type { DesignApprovalChoice, DesignApprovalScreen, DesignChange, DesignCheckIssue, DesignResultDecision } from '../../../shared/types/design';
import { registerAbortablePrompt, type PermissionState } from '../state';
import type { DesignApprovalAnswer, PendingDesignApproval, PostMessageFn } from '../types';

/** What the prompt shows: the designer's summary and the version it would make, measured against `previousVersion` (null: none). */
export interface DesignApprovalAsk {
  readonly designId: string;
  readonly summary: string;
  readonly previousVersion: number | null;
  readonly changes: readonly DesignChange[];
  readonly warnings: readonly DesignCheckIssue[];
  readonly decisions: readonly DesignResultDecision[];
  readonly screens: readonly DesignApprovalScreen[];
  readonly hasParent: boolean;
}

export class DesignApprovalManager {
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
  requestDesignApproval(ask: DesignApprovalAsk, signal: AbortSignal): Promise<DesignApprovalAnswer | undefined> {
    const promptId = `designapproval-${randomUUID()}`;
    return new Promise<DesignApprovalAnswer | undefined>((resolve) => {
      const onAborted = (): void => {
        if (this.state.removePendingDesignApproval(promptId)) this.getPostMessage()?.({ type: 'designApprovalClosed', promptId });
        resolve(undefined);
      };
      const request: PendingDesignApproval['request'] = {
        type: 'requestDesignApproval',
        promptId,
        designId: ask.designId,
        summary: ask.summary,
        previousVersion: ask.previousVersion,
        changes: [...ask.changes],
        warnings: [...ask.warnings],
        decisions: [...ask.decisions],
        screens: [...ask.screens],
        hasParent: ask.hasParent,
        owner: this.state.promptOwner(null),
      };
      registerAbortablePrompt({
        signal,
        toolUseId: promptId,
        register: () => {
          this.state.addPendingDesignApproval(promptId, { resolve, cleanup: () => signal.removeEventListener('abort', onAborted), request });
          this.getPostMessage()?.(request);
        },
        onAborted,
      });
    });
  }

  /**
   * The user's answer from any view; every view drops the prompt. One for a prompt no longer open is ignored, and so is
   * `changes` with a blank note, which leaves the prompt open.
   */
  resolveDesignApproval(promptId: string, choice: DesignApprovalChoice, feedback: string | undefined): void {
    const note = feedback?.trim() ?? '';
    if (choice === 'changes' && note === '') return;
    const pending = this.state.removePendingDesignApproval(promptId);
    if (!pending) return;
    pending.cleanup();
    this.getPostMessage()?.({ type: 'designApprovalClosed', promptId });
    pending.resolve(choice === 'changes' ? { choice, feedback: note } : { choice });
  }
}
