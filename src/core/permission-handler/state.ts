import type {
  PendingApproval,
  PendingQuestion,
  PendingForm,
  PendingPlanApproval,
  PendingSkillApproval,
  PendingElicitation,
  PostMessageFn,
  PermissionMode,
  PermissionRequiredNotifier,
  CanUseToolContext,
} from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { PromptApprover, PromptOwner } from '../../shared/types/permissions';
import type { PendingKind, RaisedPrompt } from '../pi-session/session-state';
import { log } from '../logger';

/**
 * Register a pending prompt against the signal that can cancel it.
 *
 * A signal that already aborted never fires `abort` again, so a listener added after the fact never
 * runs: the entry registers and never settles, `pendingPrompts()` keeps it for the life of the
 * panel, the panel pins on `requires_action`, and the `canUseTool` promise behind it never resolves.
 * Settling through the same handler the listener would have called keeps the already-aborted case
 * indistinguishable from an ordinary abort for every caller. Nothing may run after this call: the
 * live-prompt work belongs in `register`, or it also runs on the aborted path.
 */
export function registerAbortablePrompt(options: {
  signal: AbortSignal;
  toolUseId: string;
  register: () => void;
  onAborted: () => void;
}): void {
  const { signal, toolUseId, register, onAborted } = options;
  if (signal.aborted) {
    log('[PermissionState] prompt %s arrived on an already-aborted signal, denying it now', toolUseId);
    onAborted();
    return;
  }
  register();
  signal.addEventListener('abort', onAborted, { once: true });
}

/** What an open prompt keeps so it can be decided again when the permission state changes. */
export function unaskedCheck(context: CanUseToolContext): { runsUnasked?: () => boolean; parentToolUseId?: string | null } {
  return {
    ...(context.runsUnasked ? { runsUnasked: context.runsUnasked } : {}),
    ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
  };
}

/** Tells the webview an open prompt closed because `approvedBy` approved it. */
export function postApprovedUnasked(
  postMessage: PostMessageFn | null,
  toolUseId: string,
  pending: { parentToolUseId?: string | null },
  approvedBy: PromptApprover,
): void {
  postMessage?.({
    type: 'permissionAutoResolved',
    toolUseId,
    ...(pending.parentToolUseId !== undefined ? { parentToolUseId: pending.parentToolUseId } : {}),
    approvedBy,
  });
}

export class PermissionState {
  pendingApprovals: Map<string, PendingApproval> = new Map();
  pendingQuestions: Map<string, PendingQuestion> = new Map();
  pendingForms: Map<string, PendingForm> = new Map();
  pendingPlanApprovals: Map<string, PendingPlanApproval> = new Map();
  pendingSkillApprovals: Map<string, PendingSkillApproval> = new Map();
  pendingElicitations: Map<string, PendingElicitation> = new Map();
  /** The exact message each live prompt was posted with, in the order they were raised, so a webview
   *  reload can put the same dialogs back on screen without rebuilding a payload. */
  pendingPromptRequests: Map<string, ExtensionToWebviewMessage> = new Map();
  autoApprovedSkills: Set<string> = new Set();
  /** The image model each approved GenerateImage prompt showed, by tool use id, until the tool takes it. */
  approvedImageModels: Map<string, string> = new Map();
  postMessageToWebview: PostMessageFn | null = null;
  permissionRequiredNotifier: PermissionRequiredNotifier | null = null;
  permissionMode: PermissionMode = 'default';
  dangerouslySkipPermissions = false;
  workspacePath: string | null = null;
  /** The folder the session's tools resolve relative paths against; file rules match relative to it. */
  cwd: string | null = null;
  /** Fired on every add and every remove so a listener re-derives from the maps, never from a count. */
  onPendingChanged: (() => void) | null = null;
  /** Resolves who raised a prompt from its `parentToolUseId`; the session that runs the nested agents supplies it. */
  promptOwnerResolver: ((parentToolUseId: string | null | undefined) => PromptOwner) | null = null;

  /** The owner a prompt raised now states on its message; with no session there is no nested agent to name. */
  promptOwner(parentToolUseId: string | null | undefined): PromptOwner {
    return this.promptOwnerResolver?.(parentToolUseId) ?? { kind: 'main' };
  }

  /** The kind of the prompt map holding `id`; a new prompt map must map to a kind here. */
  private kindOf(id: string): PendingKind | undefined {
    if (this.pendingApprovals.has(id) || this.pendingSkillApprovals.has(id)) return 'approval';
    if (this.pendingQuestions.has(id)) return 'question';
    if (this.pendingPlanApprovals.has(id)) return 'plan';
    if (this.pendingForms.has(id) || this.pendingElicitations.has(id)) return 'input';
    return undefined;
  }

  /** The unanswered prompts in the order raised, each with the message it was posted with. */
  pendingPrompts(): RaisedPrompt[] {
    return [...this.pendingPromptRequests].flatMap(([id, request]) => {
      const kind = this.kindOf(id);
      return kind ? [{ id, kind, request }] : [];
    });
  }

  addPendingApproval(toolUseId: string, approval: PendingApproval): void {
    this.pendingApprovals.set(toolUseId, approval);
    this.pendingPromptRequests.set(toolUseId, approval.request);
    this.onPendingChanged?.();
  }

  removePendingApproval(toolUseId: string): PendingApproval | undefined {
    const approval = this.pendingApprovals.get(toolUseId);
    this.pendingApprovals.delete(toolUseId);
    this.pendingPromptRequests.delete(toolUseId);
    this.onPendingChanged?.();
    return approval;
  }

  addPendingQuestion(toolUseId: string, question: PendingQuestion): void {
    this.pendingQuestions.set(toolUseId, question);
    this.pendingPromptRequests.set(toolUseId, question.request);
    this.onPendingChanged?.();
  }

  removePendingQuestion(toolUseId: string): PendingQuestion | undefined {
    const question = this.pendingQuestions.get(toolUseId);
    this.pendingQuestions.delete(toolUseId);
    this.pendingPromptRequests.delete(toolUseId);
    this.onPendingChanged?.();
    return question;
  }

  addPendingForm(toolUseId: string, form: PendingForm): void {
    this.pendingForms.set(toolUseId, form);
    this.pendingPromptRequests.set(toolUseId, form.request);
    this.onPendingChanged?.();
  }

  removePendingForm(toolUseId: string): PendingForm | undefined {
    const form = this.pendingForms.get(toolUseId);
    this.pendingForms.delete(toolUseId);
    this.pendingPromptRequests.delete(toolUseId);
    this.onPendingChanged?.();
    return form;
  }

  addPendingPlanApproval(toolUseId: string, approval: PendingPlanApproval): void {
    this.pendingPlanApprovals.set(toolUseId, approval);
    this.pendingPromptRequests.set(toolUseId, approval.request);
    this.onPendingChanged?.();
  }

  removePendingPlanApproval(toolUseId: string): PendingPlanApproval | undefined {
    const approval = this.pendingPlanApprovals.get(toolUseId);
    this.pendingPlanApprovals.delete(toolUseId);
    this.pendingPromptRequests.delete(toolUseId);
    this.onPendingChanged?.();
    return approval;
  }

  addPendingSkillApproval(toolUseId: string, approval: PendingSkillApproval): void {
    this.pendingSkillApprovals.set(toolUseId, approval);
    this.pendingPromptRequests.set(toolUseId, approval.request);
    this.onPendingChanged?.();
  }

  removePendingSkillApproval(toolUseId: string): PendingSkillApproval | undefined {
    const approval = this.pendingSkillApprovals.get(toolUseId);
    this.pendingSkillApprovals.delete(toolUseId);
    this.pendingPromptRequests.delete(toolUseId);
    this.onPendingChanged?.();
    return approval;
  }

  addPendingElicitation(elicitationId: string, elicitation: PendingElicitation): void {
    this.pendingElicitations.set(elicitationId, elicitation);
    this.pendingPromptRequests.set(elicitationId, elicitation.request);
    this.onPendingChanged?.();
  }

  removePendingElicitation(elicitationId: string): PendingElicitation | undefined {
    const elicitation = this.pendingElicitations.get(elicitationId);
    this.pendingElicitations.delete(elicitationId);
    this.pendingPromptRequests.delete(elicitationId);
    this.onPendingChanged?.();
    return elicitation;
  }

  clearAll(): void {
    // Teardown, not a user decision: the diagnostic keeps `userAnswered` absent, so the deny cannot be
    // mistaken for an unexplained "no" and end a turn that is already being torn down.
    const cleanupMap = <T extends { cleanup: () => void; resolve: (result: { approved: false; customMessage: string }) => void }>(
      map: Map<string, T>
    ) => {
      for (const [, pending] of map) {
        try {
          pending.cleanup();
          pending.resolve({ approved: false, customMessage: 'The session ended before this request was answered' });
        } catch {
          // Ignore cleanup errors to ensure all maps are processed
        }
      }
      map.clear();
    };

    cleanupMap(this.pendingApprovals);
    cleanupMap(this.pendingQuestions);
    cleanupMap(this.pendingForms);
    cleanupMap(this.pendingPlanApprovals);
    cleanupMap(this.pendingSkillApprovals);

    // An elicitation resolves with an action rather than an approval, so it cannot share cleanupMap.
    for (const [, pending] of this.pendingElicitations) {
      try {
        pending.cleanup();
        pending.resolve({ action: 'cancel' });
      } catch {
        // Ignore cleanup errors to ensure all maps are processed
      }
    }
    this.pendingElicitations.clear();
    this.pendingPromptRequests.clear();

    this.autoApprovedSkills.clear();
    this.approvedImageModels.clear();
    this.onPendingChanged?.();
  }
}
