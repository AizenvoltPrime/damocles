import { useI18n } from 'vue-i18n';

export function useNodeFormatting() {
  const { t } = useI18n();

  function formatAge(timestamp: string): string {
    const diffMs = Date.now() - new Date(timestamp).getTime();
    if (diffMs < 60_000) return t('time.justNow');
    if (diffMs < 3_600_000) return t('time.minutesAgo', { n: Math.floor(diffMs / 60_000) });
    if (diffMs < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diffMs / 3_600_000) });
    return t('time.daysAgo', { n: Math.floor(diffMs / 86_400_000) });
  }

  function outcomeBadgeClass(outcome: string): string {
    switch (outcome) {
      case 'resolved': return 'border-emerald-500/70 text-emerald-300 bg-emerald-500/20';
      case 'partial': return 'border-amber-500/70 text-amber-300 bg-amber-500/20';
      case 'abandoned': return 'border-red-500/70 text-red-300 bg-red-500/20';
      default: return 'border-muted-foreground/30 text-muted-foreground';
    }
  }

  return { formatAge, outcomeBadgeClass };
}
