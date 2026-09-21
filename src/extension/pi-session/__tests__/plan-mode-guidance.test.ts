import { describe, it, expect } from 'vitest';
import { buildPlanModeGuidance } from '../plan-mode-guidance';
import { mechanismRecordRule, sliceMechanismRungs } from '../delivery-mechanisms';
import { buildPlanMechanismBlock } from '../subagents/prompts';

/**
 * Count occurrences so the ordering assertions can insist the load step appears EXACTLY once — a stray
 * second copy would let a mis-ordered prompt still satisfy `loadStep < prescription`.
 */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

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
    expect(out).toContain('Do NOT edit files');
    expect(out).toContain('ONE');
  });

  it('states the shell allowances the classifier actually grants, and the browser toolset', () => {
    const out = buildPlanModeGuidance('/p/x.md');
    expect(out).toContain('2>/dev/null');
    expect(out).toContain('cd <dir>');
    expect(out).toContain('BrowserRequestInput');
  });

  // A prompt must never name a tool outside the active set without saying how to obtain it. Browser has
  // been DEFERRED since 2.17.0, so calling it "available" was a dead end. The literal ToolSearch call is
  // pinned verbatim because that exact string is what the model copies.
  it('tells the model HOW to load the deferred browser toolset before naming its tools', () => {
    for (const out of [buildPlanModeGuidance('/p/x.md'), buildPlanModeGuidance()]) {
      expect(out).toContain('ToolSearch({tools:["browser"]})');
      expect(out).toContain('The browser tools are NOT loaded at the start of your turn');
      expect(out).toContain('They are callable from your next step');
      // The load step goes in FRONT of the inspection preference and credentials rule, not instead of
      // them. Names are spelled in full, matching default-agents.ts: the old `BrowserOpen/Navigate/…`
      // shorthand named seven tools that do not exist, and the model copies these into calls.
      expect(out).toContain('prefer the read-only inspections (BrowserOpen, BrowserNavigate, BrowserSnapshot, BrowserQuery, BrowserScreenshot, BrowserConsole, BrowserNetwork, BrowserAccessibility)');
      expect(out).toContain('never type credentials yourself. Ask the user via BrowserRequestInput');
      expect(out).not.toContain('BrowserOpen/Navigate/Snapshot/Query/Screenshot/Console/Network/Accessibility');
      // The pre-slice-2 claim that the toolset is simply "available" must not survive.
      expect(out).not.toContain('its full tool set is available too');

      // Placement is the requirement, not mere presence — the same standard the compass prompt tests
      // hold their load step to: a model that reads "prefer the read-only inspections" before it reads
      // "the tools are not loaded" has already made the failing call.
      const loadStep = out.indexOf('The browser tools are NOT loaded at the start of your turn');
      const prescription = out.indexOf('prefer the read-only inspections');
      expect(occurrences(out, 'The browser tools are NOT loaded at the start of your turn')).toBe(1);
      expect(prescription).toBeGreaterThan(-1);
      expect(loadStep).toBeLessThan(prescription);
    }
  });

  // `damocles.pi.webSearch.enabled` is off by default, and while it is off the web tools are not in the
  // session's eligible set — `ToolSearch({tools:["web"]})` answers "Not available in this session".
  // These two cases pin BOTH branches: the guidance appears exactly when the capability does.
  it('tells the model HOW to load the deferred web tools BEFORE telling it to verify what is current (web on)', () => {
    for (const out of [
      buildPlanModeGuidance('/p/x.md', { webSearchEnabled: true }),
      buildPlanModeGuidance(undefined, { webSearchEnabled: true }),
    ]) {
      expect(out).toContain('ToolSearch({tools:["web"]})');
      expect(out).toContain('The web tools are NOT loaded at the start of your turn');
      expect(out).toContain('WebSearch/WebFetch are callable from your next step');
      // The trigger condition that makes verification worth doing stays attached to the load step.
      expect(out).toContain("when correctness depends on what is current (library versions, breaking changes, a tool's current API)");
      expect(out).toContain('verify with the web tools before baking it into the plan');
      // The bare "verify with WebSearch/WebFetch" dead end (no load step) must not come back.
      expect(out).not.toContain('verify with WebSearch/WebFetch before baking it into the plan');

      // Ordering, held to the same standard as the browser clause beside it and the compass prompts.
      const loadStep = out.indexOf('The web tools are NOT loaded at the start of your turn');
      const prescription = out.indexOf('verify with the web tools before baking it into the plan');
      expect(occurrences(out, 'The web tools are NOT loaded at the start of your turn')).toBe(1);
      expect(prescription).toBeGreaterThan(-1);
      expect(loadStep).toBeLessThan(prescription);
    }
  });

  it('emits NO web guidance when the web tools are disabled (the default)', () => {
    for (const out of [
      buildPlanModeGuidance('/p/x.md'),
      buildPlanModeGuidance('/p/x.md', { webSearchEnabled: false }),
      buildPlanModeGuidance(),
    ]) {
      expect(out).not.toContain('ToolSearch({tools:["web"]})');
      expect(out).not.toContain('web tools');
      expect(out).not.toContain('WebSearch');
      expect(out).not.toContain('WebFetch');
      // The surrounding design-standards bullet is NOT web guidance and must survive the gating —
      // reaching for the current standard is still actionable from the repo itself.
      expect(out).toContain('Reach for the current standard rather than your training-data default.');
      // The browser clause is gated separately and must be unaffected by the web flag.
      expect(out).toContain('ToolSearch({tools:["browser"]})');
    }
  });

  // The mechanism is a per-slice judgment, not a fixed answer. The old "every slice is a team run"
  // directive must not come back: it told the implementer to spend a team on edits it could make itself.
  it('names all three delivery mechanisms when teams are enabled', () => {
    const teamOn = buildPlanModeGuidance('/p/x.md', { teamEnabled: true });
    expect(teamOn).toContain('pick the smallest one that fits');
    for (const rung of sliceMechanismRungs(true)) expect(teamOn).toContain(rung);
    expect(teamOn).toContain('create_team `brief` argument');
    expect(teamOn).not.toContain('MUST call the team tool');
    expect(teamOn).not.toContain('each slice as its own team run');
  });

  // With teams off the team tools are absent from the session, so naming them points the model at a
  // tool it cannot call. The two cheaper rungs still apply.
  it('offers the two-way choice and names no team tool when teams are disabled (the default)', () => {
    for (const out of [buildPlanModeGuidance('/p/x.md'), buildPlanModeGuidance('/p/x.md', { teamEnabled: false })]) {
      expect(out).toContain('pick the smallest one that fits');
      for (const rung of sliceMechanismRungs(false)) expect(out).toContain(rung);
      expect(out).toContain('`Frontend Developer`, `Backend Architect`, `Test Automation Engineer`');
      expect(out).not.toContain('create_team');
      expect(out).not.toContain('A team (');
    }
  });

  // The labels offered track the rungs offered: a teams-off planner must not be told to mark a slice
  // `team`, because the implementer it writes for cannot start one.
  it('records a mechanism plus a reason per slice and marks the assignments a recommendation', () => {
    for (const teamEnabled of [true, false]) {
      const out = buildPlanModeGuidance('/p/x.md', { teamEnabled });
      expect(out).toContain(mechanismRecordRule(teamEnabled));
      expect(out).toContain('may pick a different mechanism');
      expect(out).toContain('which slice, which mechanism, and why, in its next message');
    }
    expect(buildPlanModeGuidance('/p/x.md')).toContain('as one of direct or specialist');
    expect(buildPlanModeGuidance('/p/x.md', { teamEnabled: true })).toContain('as one of direct, specialist or team');
  });

  // The Plan agent drafts the plan and the main agent refines it, so the two must describe the same
  // rungs in the same words. One module supplies both; this fails if either stops reading it.
  it('states the rungs in the same words as the Plan agent block', () => {
    for (const teamEnabled of [true, false]) {
      const guidance = buildPlanModeGuidance('/p/x.md', { teamEnabled });
      const block = buildPlanMechanismBlock(teamEnabled);
      for (const rung of sliceMechanismRungs(teamEnabled)) {
        expect(guidance).toContain(rung);
        expect(block).toContain(rung);
      }
      expect(block).toContain(mechanismRecordRule(teamEnabled));
    }
  });

  it('routes complex tasks through the Plan subagent for the first draft as a hard rule', () => {
    for (const out of [
      buildPlanModeGuidance('/p/x.md'),
      buildPlanModeGuidance('/p/x.md', { teamEnabled: true }),
    ]) {
      expect(out).toContain('first draft');
      expect(out).toContain('Plan subagent');
      // Binding, not advisory: the main prompt's "keep spawn counts low" must not be read as licence to
      // skip the Explore→Plan handoff.
      // The precedence sits on the hard rule, which is the instruction "keep spawn counts low" pulls
      // against. Putting it on the exemption inverted it: an exemption from spawning cannot outrank a
      // bullet that also says don't spawn.
      expect(out).toContain('This is a hard rule, not a suggestion, and it outranks the main prompt\'s "keep spawn counts low"');
      expect(out).toContain('you MUST produce the first draft of the plan through the Plan subagent');
      // Both exemptions in one list, so the text never says "only X is exempt" and then names a second.
      expect(out).toContain('Two things exempt a task: a genuinely small, well-understood, single-file change');
      expect(out).toContain('a change where you have already read in full every file it touches, which you plan directly and say so in your first message');
      expect(out).toContain('Nothing else exempts a complex task');
      expect(out).not.toContain('Only a genuinely small, well-understood, single-file change is exempt');
      // Research is delegated SEEDED, not cold: orienting first is what lets the Explore prompt carry
      // known facts, so the subagent spends its turn on depth instead of re-deriving the obvious.
      expect(out).toContain('Orient yourself first');
      expect(out).toContain('not re-derive');
    }
  });
});
