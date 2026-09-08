import type { SessionState } from '@/stores/useSessionStore';

/** Which icon the bar draws. `StatusBar.vue` owns the mapping to a component so this module stays plain TypeScript. */
export type SessionStateIcon = 'spinner' | 'exclamation' | null;

export interface SessionStateTreatment {
  icon: SessionStateIcon;
  iconSize: number;
  iconClass: string;
  labelClass: string;
  barClass: string;
}

/**
 * A run parked on a prompt has to read as parked at a glance, so it differs from a working run by
 * icon, colour and motion at once. Colour alone fails for a user who cannot see the hue, and a label
 * alone fails for a user who is not reading the bar.
 */
export function sessionStateTreatment(state: SessionState): SessionStateTreatment {
  switch (state) {
    case 'running':
      return {
        icon: 'spinner',
        iconSize: 52,
        // The spinner draws from its animation JSON and never reads currentColor, so a text colour here paints nothing.
        iconClass: '',
        labelClass: 'text-muted-foreground italic',
        barClass: 'border-border/30 bg-card',
      };
    case 'requires_action':
      return {
        icon: 'exclamation',
        iconSize: 24,
        iconClass: 'text-warning motion-safe:animate-pulse',
        labelClass: 'text-warning',
        barClass: 'border-warning/40 bg-warning/10',
      };
    case 'idle':
      return {
        icon: null,
        iconSize: 0,
        iconClass: 'text-muted-foreground',
        labelClass: 'text-muted-foreground italic',
        barClass: 'border-border/30 bg-card',
      };
  }
}
