import { describe, expect, it } from 'vitest';
import type { WorktreeRegistry } from '../../../core/worktrees/registry';
import { createFinishHolds, worktreeCalls } from '../worktrees';

// Main renders a refusal core throws (worktrees.call) in its own language, so it crosses as Damocles' text, not English.
describe("worktrees.call's own refusals", () => {
  const calls = worktreeCalls({
    registry: { get: () => undefined } as unknown as WorktreeRegistry,
    git: () => undefined,
    isTrusted: () => true,
    holds: createFinishHolds(),
    log: () => undefined,
  });

  it('refuses without git in localized text', async () => {
    await expect(Promise.resolve().then(() => calls.options('/p'))).rejects.toMatchObject({ text: { message: 'Git was not found, so the worktree action cannot run.' } });
  });

  it('refuses a worktree that is gone in localized text', async () => {
    await expect(Promise.resolve().then(() => calls.uncommittedFiles('w1'))).rejects.toMatchObject({ text: { message: 'This worktree no longer exists.' } });
  });
});
