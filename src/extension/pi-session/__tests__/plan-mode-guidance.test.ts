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
    for (const marker of ['Plan mode is active', 'Clarify continuously', 'Explore subagent', 'Plan subagent', 'Verification', 'ExitPlanMode', 'vertical slice', 'not horizontal', 'fewest', 'Consolidate closely-related']) {
      expect(withPath).toContain(marker);
      expect(without).toContain(marker);
    }
  });

  it('prefers the fewest slices and consolidates closely-related behavior (guards over-decomposition)', () => {
    for (const out of [buildPlanModeGuidance('/p/x.md'), buildPlanModeGuidance()]) {
      expect(out).toContain('Prefer the **fewest** slices that each deliver a demoable behavior');
      expect(out).toContain('Consolidate closely-related behaviors into a single slice');
      expect(out).toContain('do not manufacture slices to appear thorough');
      // The anti-horizontal-layering rule is preserved, not replaced.
      expect(out).toContain('vertical slices, not horizontal layers');
    }
  });

  it('mandates two-level dependency ordering (slices, then foundation-first steps within a slice)', () => {
    const withPath = buildPlanModeGuidance('/p/x.md');
    const without = buildPlanModeGuidance();
    for (const out of [withPath, without]) {
      expect(out).toContain('Order by dependency at two levels');
      expect(out).toContain('foundation-first');
    }
  });

  it('keeps the read-only carve-out: research/design only, write only the plan file', () => {
    const out = buildPlanModeGuidance('/p/x.md');
    expect(out).toContain('MAY run read-only shell commands');
    expect(out).toContain('do NOT edit files');
    expect(out).toContain('ONE');
  });

  it('mandates a team run per slice ONLY when teams are enabled', () => {
    const teamOn = buildPlanModeGuidance('/p/x.md', { teamEnabled: true });
    expect(teamOn).toContain('deliver each slice as its own team run');
    expect(teamOn).toContain('one specialist per layer');
    expect(teamOn).toContain('per-slice spawn instruction in the plan');
  });

  it('routes each slice spec through the create_team brief, keeping title a short label (teams on)', () => {
    const teamOn = buildPlanModeGuidance('/p/x.md', { teamEnabled: true });
    expect(teamOn).toContain('create_team `brief` argument');
    expect(teamOn).toContain('never smuggle the detailed intent through `title`');
  });

  it('omits the brief-routing instruction when teams are disabled', () => {
    for (const out of [buildPlanModeGuidance('/p/x.md'), buildPlanModeGuidance('/p/x.md', { teamEnabled: false })]) {
      expect(out).not.toContain('create_team `brief` argument');
    }
  });

  it('tells the implementer not to silently downgrade a team-run slice to solo work', () => {
    const teamOn = buildPlanModeGuidance('/p/x.md', { teamEnabled: true });
    expect(teamOn).toContain('must not silently downgrade');
    expect(teamOn).toContain('raises that with the user');
  });

  it('directs sequential slices (no team framing) when teams are disabled (the default)', () => {
    for (const out of [buildPlanModeGuidance('/p/x.md'), buildPlanModeGuidance('/p/x.md', { teamEnabled: false })]) {
      expect(out).toContain('implement the slices sequentially in dependency order');
      expect(out).not.toContain('team run');
      expect(out).not.toContain('specialist per layer');
    }
  });

  it('mandates the Plan subagent first-draft for complex tasks (hard rule)', () => {
    const out = buildPlanModeGuidance('/p/x.md');
    expect(out).toContain('hard rule');
    expect(out).toContain('first draft');
    expect(out).toContain('MUST');
  });
});
