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
} from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { log } from '../logger';

/**
 * Register a pending prompt against the signal that can cancel it.
 *
 * A signal that already aborted never fires `abort` again, so a listener added after the fact never
 * runs: the entry registers and never settles, `hasPendingPrompts()` stays true for the life of the
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
  autoApprovedSubagents: Set<string> = new Set();
  postMessageToWebview: PostMessageFn | null = null;
  permissionRequiredNotifier: PermissionRequiredNotifier | null = null;
  permissionMode: PermissionMode = 'default';
  dangerouslySkipPermissions = false;
  workspacePath: string | null = null;
  sessionAborting = false;
  /** Fired on every add and every remove so a listener re-derives from the maps, never from a count. */
  onPendingChanged: (() => void) | null = null;

  /** Whether any prompt map on this state still holds an unanswered prompt. */
  hasPendingPrompts(): boolean {
    return (
      this.pendingApprovals.size > 0 ||
      this.pendingQuestions.size > 0 ||
      this.pendingForms.size > 0 ||
      this.pendingPlanApprovals.size > 0 ||
      this.pendingSkillApprovals.size > 0 ||
      this.pendingElicitations.size > 0
    );
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
    this.autoApprovedSubagents.clear();
    this.onPendingChanged?.();
  }
}
