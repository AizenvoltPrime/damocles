import type { TeamAgentStatus } from '@shared/types/team';

const AGENT_COLORS = [
  { border: 'border-blue-500', dot: 'bg-blue-500', text: 'text-blue-400', stripe: 'bg-blue-500' },
  { border: 'border-violet-500', dot: 'bg-violet-500', text: 'text-violet-400', stripe: 'bg-violet-500' },
  { border: 'border-amber-500', dot: 'bg-amber-500', text: 'text-amber-400', stripe: 'bg-amber-500' },
  { border: 'border-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-400', stripe: 'bg-emerald-500' },
  { border: 'border-rose-500', dot: 'bg-rose-500', text: 'text-rose-400', stripe: 'bg-rose-500' },
];

const UNKNOWN_COLOR = { border: 'border-foreground/30', dot: 'bg-foreground/40', text: 'text-foreground/50', stripe: 'bg-foreground/30' };

export function getAgentColor(index: number) {
  if (index < 0) return UNKNOWN_COLOR;
  return AGENT_COLORS[index % AGENT_COLORS.length]!;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function statusBadgeClass(status: TeamAgentStatus): string {
  switch (status) {
    case 'running':
      return 'bg-primary/30 text-primary border-primary/30';
    case 'completed':
      return 'bg-success/30 text-success border-success/30';
    case 'failed':
      return 'bg-error/30 text-error border-error/30';
    case 'cancelled':
      return 'bg-warning/30 text-warning border-warning/30';
    case 'pending':
    default:
      return 'bg-foreground/10 text-foreground/50 border-foreground/20';
  }
}
