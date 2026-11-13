import type { ForgeSignInState } from '@shared/forge/accounts';

/** A flow core is running: its panel stays open and shows the phase. */
export function isRunning(state: ForgeSignInState | undefined): boolean {
  return state !== undefined && (state.phase === 'starting' || state.phase === 'browser' || state.phase === 'deviceCode' || state.phase === 'finishing');
}
