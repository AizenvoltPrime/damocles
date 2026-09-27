import { i18n } from '@/i18n';
import type { MemoryAuditResult } from '@shared/types/memory-audit';

/** The applied or reverted count, then each non-zero rejected, stale or skipped count. */
export function auditResultText(result: MemoryAuditResult): string {
  const { t } = i18n.global;
  const count = (key: string, n: number): string => t(`memoryAudit.result.${key}`, { count: n }, n);
  const parts = result.action === 'apply'
    ? [
        count('applied', result.applied),
        ...(result.rejected > 0 ? [count('rejected', result.rejected)] : []),
        ...(result.stale > 0 ? [count('stale', result.stale)] : []),
      ]
    : [count('reverted', result.reverted), ...(result.skipped > 0 ? [count('skipped', result.skipped)] : [])];
  return parts.join(' ');
}
