import type { TeamCheckpoint } from '../types';

/** A checkpoint writer that writes nothing, for a runner whose collaborators a test injects instead of `run` building them. */
export function stubCheckpointWriter(): Record<string, unknown> {
  return {
    schedule: () => undefined,
    seal: (build: () => TeamCheckpoint) => build(),
    flush: async () => true,
    hasLanded: true,
  };
}
