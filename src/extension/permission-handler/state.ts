import type {
  PendingApproval,
  PendingQuestion,
  PendingForm,
  PendingPlanApproval,
  PendingSkillApproval,
  PostMessageFn,
  PermissionMode,
  PermissionRequiredNotifier,
} from './types';

export class PermissionState {
  pendingApprovals: Map<string, PendingApproval> = new Map();
  pendingQuestions: Map<string, PendingQuestion> = new Map();
  pendingForms: Map<string, PendingForm> = new Map();
  pendingPlanApprovals: Map<string, PendingPlanApproval> = new Map();
  pendingSkillApprovals: Map<string, PendingSkillApproval> = new Map();
  autoApprovedSkills: Set<string> = new Set();
  autoApprovedSubagents: Set<string> = new Set();
  postMessageToWebview: PostMessageFn | null = null;
  permissionRequiredNotifier: PermissionRequiredNotifier | null = null;
  permissionMode: PermissionMode = 'default';
  dangerouslySkipPermissions = false;
  sessionAborting = false;

  addPendingApproval(toolUseId: string, approval: PendingApproval): void {
    this.pendingApprovals.set(toolUseId, approval);
  }

  removePendingApproval(toolUseId: string): PendingApproval | undefined {
    const approval = this.pendingApprovals.get(toolUseId);
    this.pendingApprovals.delete(toolUseId);
    return approval;
  }

  addPendingQuestion(toolUseId: string, question: PendingQuestion): void {
    this.pendingQuestions.set(toolUseId, question);
  }

  removePendingQuestion(toolUseId: string): PendingQuestion | undefined {
    const question = this.pendingQuestions.get(toolUseId);
    this.pendingQuestions.delete(toolUseId);
    return question;
  }

  addPendingForm(toolUseId: string, form: PendingForm): void {
    this.pendingForms.set(toolUseId, form);
  }

  removePendingForm(toolUseId: string): PendingForm | undefined {
    const form = this.pendingForms.get(toolUseId);
    this.pendingForms.delete(toolUseId);
    return form;
  }

  addPendingPlanApproval(toolUseId: string, approval: PendingPlanApproval): void {
    this.pendingPlanApprovals.set(toolUseId, approval);
  }

  removePendingPlanApproval(toolUseId: string): PendingPlanApproval | undefined {
    const approval = this.pendingPlanApprovals.get(toolUseId);
    this.pendingPlanApprovals.delete(toolUseId);
    return approval;
  }

  addPendingSkillApproval(toolUseId: string, approval: PendingSkillApproval): void {
    this.pendingSkillApprovals.set(toolUseId, approval);
  }

  removePendingSkillApproval(toolUseId: string): PendingSkillApproval | undefined {
    const approval = this.pendingSkillApprovals.get(toolUseId);
    this.pendingSkillApprovals.delete(toolUseId);
    return approval;
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

    this.autoApprovedSkills.clear();
    this.autoApprovedSubagents.clear();
  }
}
