import { execSafe } from './exec';

export interface GitAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/** Set once by a host that probed git at startup, after resolving its login-shell PATH. */
let hostAnswer: GitAvailability | null = null;

export function setCheckpointGitAvailability(availability: GitAvailability): void {
  hostAnswer = availability;
}

/** Whether checkpoints can run git: the host's startup answer, or else a `git --version` probe. */
export async function checkpointGitAvailability(): Promise<GitAvailability> {
  if (hostAnswer) return hostAnswer;
  const probe = await execSafe('git', ['--version']);
  return probe.ok ? { available: true } : { available: false, reason: probe.error };
}
