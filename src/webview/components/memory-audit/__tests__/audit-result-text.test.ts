import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { auditResultText } from '../audit-result-text';

describe('the audit result line', () => {
  it('says how many accepted changes could not be saved on the computer, and nothing of failures when none failed', () => {
    const { t } = i18n.global;
    expect(auditResultText({ action: 'apply', applied: 2, stale: 0, rejected: 0, failed: 1 })).toBe(`${t('memoryAudit.result.applied', { count: 2 }, 2)} ${t('memoryAudit.result.failed', { count: 1 }, 1)}`);
    expect(auditResultText({ action: 'apply', applied: 2, stale: 0, rejected: 0 })).toBe(t('memoryAudit.result.applied', { count: 2 }, 2));
  });
});
