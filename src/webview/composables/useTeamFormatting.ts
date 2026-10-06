import type { Component } from 'vue';
import { Ban, CircleAlert, CircleCheck, CircleX, Clock, Eye, LoaderCircle } from 'lucide-vue-next';
import type { TeamAgent, TeamAgentStatus } from '@shared/types/team';

// `avatar` colours an initial on a tint of its own colour (style.css `.d-tone-*`).
const AGENT_COLORS = [
  { border: 'border-(--d-accent)', dot: 'bg-(--d-accent)', text: 'text-(--d-accent)', avatar: 'd-tone-accent', stripe: 'bg-(--d-accent)' },
  { border: 'border-(--d-info)', dot: 'bg-(--d-info)', text: 'text-(--d-info)', avatar: 'd-tone-info', stripe: 'bg-(--d-info)' },
  { border: 'border-(--d-warning)', dot: 'bg-(--d-warning)', text: 'text-(--d-warning)', avatar: 'd-tone-warning', stripe: 'bg-(--d-warning)' },
  { border: 'border-(--d-success)', dot: 'bg-(--d-success)', text: 'text-(--d-success)', avatar: 'd-tone-success', stripe: 'bg-(--d-success)' },
  { border: 'border-(--d-danger)', dot: 'bg-(--d-danger)', text: 'text-(--d-danger)', avatar: 'd-tone-danger', stripe: 'bg-(--d-danger)' },
];

const UNKNOWN_COLOR = { border: 'border-(--d-border2)', dot: 'bg-(--d-faint)', text: 'text-(--d-faint)', avatar: 'd-tone-faint', stripe: 'bg-(--d-border2)' };

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

interface LocaleNumberFormats {
  oneDecimal: Intl.NumberFormat;
  cents: Intl.NumberFormat;
  subCent: Intl.NumberFormat;
}

const numberFormats = new Map<string, LocaleNumberFormats>();

function numberFormatsFor(locale: string): LocaleNumberFormats {
  let formats = numberFormats.get(locale);
  if (!formats) {
    const usd = (digits: number) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
    formats = {
      oneDecimal: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      cents: usd(2),
      subCent: usd(4),
    };
    numberFormats.set(locale, formats);
  }
  return formats;
}

/** `locale` is the UI locale (`useI18n().locale`), which sets the decimal separator. */
export function formatTokenCount(num: number, locale: string): string {
  const { oneDecimal } = numberFormatsFor(locale);
  if (num >= 1_000_000) return `${oneDecimal.format(num / 1_000_000)}M`;
  if (num >= 1_000) return `${oneDecimal.format(num / 1_000)}K`;
  return num.toString();
}

/** The one USD formatter for costs, in the UI locale. A nonzero amount under a cent keeps four decimals, so it never reads as $0.00. */
export function formatCost(cost: number, locale: string): string {
  const { cents, subCent } = numberFormatsFor(locale);
  return (cost !== 0 && Math.abs(cost) < 0.01 ? subCent : cents).format(cost);
}

export interface AgentStatusChip {
  icon: Component;
  /** A `.d-tone-*` class (style.css): chips and the result box tint from its `--tone`, and the text takes the tone's AA shade. */
  color: string;
  /** The agent is working now: its icon turns and a header dot breathes. */
  live: boolean;
  /** The agent waits on the user: its icon and a header dot breathe (`.d-pulsing`). */
  attention: boolean;
  labelKey: `team.statusLabel.${TeamAgentStatus | 'needsYou'}`;
}

type ChipStyle = Omit<AgentStatusChip, 'labelKey' | 'attention'>;

/** The one status presentation for subagents, teams and team members (Chat Panel.dc.html `STATUS`), on every card and overlay. */
const AGENT_STATUS_CHIPS: Record<TeamAgentStatus, ChipStyle> = {
  pending: { icon: Clock, color: 'd-tone-muted', live: false },
  running: { icon: LoaderCircle, color: 'd-tone-accent', live: true },
  completed: { icon: CircleCheck, color: 'd-tone-success', live: false },
  failed: { icon: CircleX, color: 'd-tone-danger', live: false },
  cancelled: { icon: Ban, color: 'd-tone-muted', live: false },
  'awaiting-review': { icon: Clock, color: 'd-tone-warning', live: false },
  standby: { icon: Clock, color: 'd-tone-info', live: false },
  monitoring: { icon: Eye, color: 'd-tone-info', live: false },
};

// The chat header's and the desktop sidebar's "needs you": warning tone and an alert mark.
const NEEDS_YOU_CHIP: AgentStatusChip = { icon: CircleAlert, color: 'd-tone-warning', live: false, attention: true, labelKey: 'team.statusLabel.needsYou' };

/** `awaitingUser`: the session state names a pending prompt of this agent, or of a member of this team, which outranks the status. */
export function agentStatusChip(status: TeamAgentStatus, awaitingUser = false): AgentStatusChip {
  return awaitingUser ? NEEDS_YOU_CHIP : { ...AGENT_STATUS_CHIPS[status], attention: false, labelKey: `team.statusLabel.${status}` };
}

const WORKING: ReadonlySet<TeamAgentStatus> = new Set(['pending', 'running', 'awaiting-review', 'standby', 'monitoring']);

/** The members a team is still working with: the overlay's and card's active count and the Stop team confirmation. */
export function workingAgentCount(agents: readonly Pick<TeamAgent, 'status'>[]): number {
  return agents.filter((agent) => WORKING.has(agent.status)).length;
}
