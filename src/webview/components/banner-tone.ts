import type { HostUpdate } from '@shared/host-update';

// A status banner's border, fill and text per tone; the shell scans this file by name (src/desktop/shell/style.css @source).
export const BANNER_TONE = {
  warning: 'border-(--d-warning-fill)/25 bg-[color-mix(in_srgb,var(--d-warning-fill)_11%,var(--d-bg))] text-(--d-warning-text)',
  danger: 'border-(--d-danger-fill)/28 bg-[color-mix(in_srgb,var(--d-danger-fill)_11%,var(--d-bg))] text-(--d-danger-text)',
  success: 'border-(--d-success-fill)/28 bg-[color-mix(in_srgb,var(--d-success-fill)_11%,var(--d-bg))] text-(--d-success-text)',
  info: 'border-(--d-info-fill)/28 bg-[color-mix(in_srgb,var(--d-info-fill)_11%,var(--d-bg))] text-(--d-info-text)',
} as const;

/** The update strip's tone, which the shell's edge continues across the gutter and the host card's Update section shares. */
export function hostUpdateTone(update: Pick<HostUpdate, 'phase' | 'required'>): 'info' | 'warning' | 'danger' {
  const state = hostUpdateState(update);
  if (state === 'countdown') return 'danger';
  return state === 'required' || state === 'appOutdated' ? 'warning' : 'info';
}

export type HostUpdateState = HostUpdate['phase'] | 'required' | 'countdown';

/** A server from before terminals survived a switch whose open terminals alone hold it: no agent runs and no damocles --wait is pending. */
export function terminalsHold(update: Pick<HostUpdate, 'terminalsSurvive' | 'runningAgents' | 'runningTerminals' | 'cliWaits'>): boolean {
  return !update.terminalsSurvive && update.runningAgents === 0 && (update.cliWaits ?? 0) === 0 && update.runningTerminals > 0;
}

/** What every update surface shows: a required switch that is still pending reads as required, then as its countdown. */
export function hostUpdateState(update: Pick<HostUpdate, 'phase' | 'required'>): HostUpdateState {
  if (!update.required || update.phase === 'switching' || update.phase === 'appOutdated') return update.phase;
  return update.required.countdown ? 'countdown' : 'required';
}
