import type { SessionState } from '@/stores/useSessionStore';

/** Classes for the status row's mark and label. */
export interface SessionStateTreatment {
  iconClass: string;
  labelClass: string;
}

/**
 * A run parked on a prompt has to read as parked at a glance, so it differs from a working run by
 * mark, colour and motion at once. Colour alone fails for a user who cannot see the hue, and a label
 * alone fails for a user who is not reading the row.
 */
export function sessionStateTreatment(state: SessionState): SessionStateTreatment {
  switch (state) {
    case 'running':
      return {
        iconClass: 'text-(--d-accent) animate-[d-spin_.9s_linear_infinite]',
        labelClass: 'text-(--d-muted) italic',
      };
    case 'requires_action':
      return {
        iconClass: 'bg-(--d-warning) animate-[d-pulse_1.2s_infinite]',
        labelClass: 'text-(--d-warning) font-medium',
      };
    case 'idle':
      return {
        iconClass: '',
        labelClass: 'text-(--d-muted) italic',
      };
  }
}
