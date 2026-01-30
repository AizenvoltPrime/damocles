import type { DiffManager } from '../../DiffManager';
import type { PermissionState } from '../state';
import type { PostMessageFn } from '../types';

export class SubagentManager {
  private state: PermissionState;
  private diffManager: DiffManager;
  private getPostMessage: () => PostMessageFn | null;

  constructor(
    state: PermissionState,
    diffManager: DiffManager,
    getPostMessage: () => PostMessageFn | null
  ) {
    this.state = state;
    this.diffManager = diffManager;
    this.getPostMessage = getPostMessage;
  }

  autoApproveSubagent(parentToolUseId: string): void {
    this.state.autoApprovedSubagents.add(parentToolUseId);

    for (const [toolUseId, pending] of this.state.pendingApprovals) {
      if (pending.parentToolUseId === parentToolUseId) {
        if (pending.diffId) {
          this.diffManager.closeDiffView(pending.diffId);
        }
        pending.cleanup();
        pending.resolve({ approved: true });
        this.state.pendingApprovals.delete(toolUseId);

        this.getPostMessage()?.({
          type: 'permissionAutoResolved',
          toolUseId,
          parentToolUseId,
        });
      }
    }
  }

  clearSubagentAutoApprovals(): void {
    this.state.autoApprovedSubagents.clear();
  }
}
