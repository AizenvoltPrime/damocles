import type { WorktreePhase } from './types/messages';

// What keeps a loaded chat from unloading (plan AD8), shared by desktop main's chat pool and core's unload check.

/** Whether a chat's last reported activity keeps it loaded; `background` stays true until a later event clears it. */
export function isActiveActivity(activity: { readonly state: 'idle' | 'running' | 'requires_action'; readonly background: boolean } | undefined): boolean {
  return activity !== undefined && (activity.state !== 'idle' || activity.background);
}

// Creating a worktree, running its setup, or showing the setup's or the creation's failure holds the first prompt, so the
// chat stays loaded; only an opt-in with no git work yet (pending) leaves like any empty chat (slice 12a rule 6).
export function holdsWorktreeSetup(phase: WorktreePhase | undefined): boolean {
  return phase === 'creating' || phase === 'settingUp' || phase === 'setupFailed' || phase === 'createFailed';
}
