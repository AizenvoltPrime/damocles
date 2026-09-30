import { describe, it, expect, vi } from 'vitest';
import { ApprovalManager } from '../managers/approval-manager';
import { PermissionState } from '../state';
import type { DiffManager } from '../diff-manager';
import type { CanUseToolContext } from '../types';

function ctx(): CanUseToolContext {
  return { signal: new AbortController().signal, toolUseID: 'c1', parentToolUseId: null };
}

describe('permission_required notifier (US-009)', () => {
  it('fires at the shell approval wait with the command payload', () => {
    const state = new PermissionState();
    const notifier = vi.fn();
    state.permissionRequiredNotifier = notifier;
    const mgr = new ApprovalManager(
      state,
      {} as DiffManager,
      () => () => {},
      () => state.permissionRequiredNotifier,
    );
    // Don't await — the wait promise resolves only on user/abort; the notifier fires synchronously.
    void mgr.handleShellPermission('Bash', { command: 'rm -rf /' }, ctx());
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Bash', command: 'rm -rf /' }),
    );
  });

  it('does nothing when no notifier is registered (lazy, no crash)', () => {
    const state = new PermissionState();
    const mgr = new ApprovalManager(state, {} as DiffManager, () => () => {}, () => state.permissionRequiredNotifier);
    expect(() => void mgr.handleShellPermission('Bash', { command: 'ls' }, ctx())).not.toThrow();
  });
});
