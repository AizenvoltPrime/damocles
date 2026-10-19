import type { AgentWindDown } from '@shared/types/wind-down';

/** What a stopped agent's card, or the main chat's status bar, says while its run winds down, from core's reading alone. */
export function windDownText(windDown: AgentWindDown, t: (key: string, params: Record<string, unknown>) => string): string {
  const waiting = windDown.phase === 'run'
    ? t('status.windDown.run', {})
    : t('status.windDown.handlers', { events: windDown.events.join(', ') });
  if (windDown.extensions.length === 0) return waiting;
  const extensions = windDown.extensions.join(', ');
  return `${waiting} ${t(windDown.phase === 'run' ? 'status.windDown.loaded' : 'status.windDown.withHandler', { extensions })}`;
}
