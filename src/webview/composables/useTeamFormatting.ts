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
    case 'awaiting-review':
      return 'bg-amber-500/30 text-amber-400 border-amber-500/30';
    case 'standby':
      return 'bg-cyan-500/30 text-cyan-400 border-cyan-500/30';
    case 'monitoring':
      return 'bg-blue-500/30 text-blue-300 border-blue-500/30';
    case 'pending':
    default:
      return 'bg-foreground/10 text-foreground/50 border-foreground/20';
  }
}
