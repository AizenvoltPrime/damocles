import { describe, it, expect } from 'vitest';
import { buildPlanModeGuidance } from '../plan-mode-guidance';

describe('buildPlanModeGuidance', () => {
  it('names the concrete plan path when provided', () => {
    const out = buildPlanModeGuidance('/home/.damocles/plans/do-the-thing-abcd1234.md');
    expect(out).toContain('/home/.damocles/plans/do-the-thing-abcd1234.md');
    expect(out).not.toContain('named in your system prompt');
  });

  it('falls back to the system-prompt reference when no path is given (subagent path)', () => {
    const out = buildPlanModeGuidance();
    expect(out).toContain('named in your system prompt');
  });

  it('emits the same adaptive-guidance body on both branches (only the plan-file clause differs)', () => {
    const withPath = buildPlanModeGuidance('/p/x.md');
    const without = buildPlanModeGuidance();
    for (const marker of ['Plan mode is active', 'Clarify continuously', 'Explore subagent', 'Plan subagent', 'Verification', 'ExitPlanMode']) {
      expect(withPath).toContain(marker);
      expect(without).toContain(marker);
    }
  });

  it('keeps the read-only carve-out: research/design only, write only the plan file', () => {
    const out = buildPlanModeGuidance('/p/x.md');
    expect(out).toContain('do NOT edit files or run any non-read-only command');
    expect(out).toContain('ONE exception');
  });
});
