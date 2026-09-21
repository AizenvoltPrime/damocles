import { describe, it, expect } from 'vitest';
import { assembleDamoclesSystemPrompt, type DamoclesSystemPromptInputs } from '../agent-start';
import type { SystemPromptEnv } from '../permission-gate';

/**
 * The cache-stability proof for the section split. pi sends a mid-conversation system message built by
 * `diffSystemPromptSections`, so a toggle that rewrites more than its own section costs a cache miss on
 * everything after the first changed section. These tests pin "one input changed, one section changed".
 */

const env: SystemPromptEnv = {
  cwd: '/repo',
  model: 'fable-5.1',
  isGitRepo: true,
  platform: 'win32',
  shell: 'pwsh',
  osVersion: '10.0.26100',
  compassEnabled: false,
  thinkingDisabled: false,
};

function inputs(over: Partial<DamoclesSystemPromptInputs> = {}): DamoclesSystemPromptInputs {
  return {
    env,
    memoryEnabled: true,
    planMode: false,
    teamEnabled: false,
    webSearchEnabled: false,
    planFilePath: '/repo/.damocles/plans/plan-abc.md',
    existingPlanFile: undefined,
    contextFiles: [{ path: 'AGENTS.md', content: 'house rules' }],
    skills: [],
    skillFileReadTool: 'read',
    ...over,
  };
}

interface SectionDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

function diffSections(before: Record<string, string>, after: Record<string, string>): SectionDiff {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const changed = Object.keys(before).filter((k) => k in after && before[k] !== after[k]);
  return { added, removed, changed };
}

describe('system prompt sections — plan mode toggles exactly one section', () => {
  it('entering plan mode adds damocles_plan_mode and leaves every other section and the preamble byte-identical', () => {
    const off = assembleDamoclesSystemPrompt(inputs({ planMode: false }));
    const on = assembleDamoclesSystemPrompt(inputs({ planMode: true }));

    // The preamble is the cached prefix, so it is checked first: plan-mode text leaking into it is the
    // most expensive way to break the split.
    expect(on.preamble).toBe(off.preamble);
    expect(diffSections(off.sections, on.sections)).toEqual({ added: ['damocles_plan_mode'], removed: [], changed: [] });
    for (const key of Object.keys(off.sections)) expect(on.sections[key]).toBe(off.sections[key]);
    expect(on.sections['damocles_plan_mode']).toContain(inputs().planFilePath);
  });

  it('leaving plan mode drops the key from the map rather than emptying it', () => {
    const on = assembleDamoclesSystemPrompt(inputs({ planMode: true }));
    const off = assembleDamoclesSystemPrompt(inputs({ planMode: false }));

    // Absence is what makes pi emit `damocles_plan_mode: null` in its patch. An empty string is dropped
    // by pi's `if (content)` check, which would leave the stale section live in the model's view.
    expect('damocles_plan_mode' in off.sections).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(off.sections, 'damocles_plan_mode')).toBe(false);
    expect(Object.keys(off.sections)).not.toContain('damocles_plan_mode');
    expect(diffSections(on.sections, off.sections)).toEqual({ added: [], removed: ['damocles_plan_mode'], changed: [] });
  });

  it('removing the section leaves the order of the surviving keys untouched', () => {
    const on = assembleDamoclesSystemPrompt(inputs({ planMode: true }));
    const off = assembleDamoclesSystemPrompt(inputs({ planMode: false }));
    expect(Object.keys(off.sections)).toEqual(Object.keys(on.sections).filter((k) => k !== 'damocles_plan_mode'));
  });

  it('a session with a bound plan file swaps the plan-file reminder for the plan-mode guidance and nothing else', () => {
    // The reminder and the guidance are mutually exclusive by design, so this toggle moves three keys:
    // the bound plan file carries the execution directive alongside the reminder. The one-section case
    // above is the cache-stability claim and must keep `existingPlanFile` undefined.
    const off = assembleDamoclesSystemPrompt(inputs({ planMode: false, existingPlanFile: '/repo/.damocles/plans/plan-abc.md' }));
    const on = assembleDamoclesSystemPrompt(inputs({ planMode: true, existingPlanFile: undefined }));

    expect(diffSections(off.sections, on.sections)).toEqual({
      added: ['damocles_plan_mode'],
      removed: ['damocles_plan_file', 'damocles_plan_execution'],
      changed: [],
    });
    expect(on.preamble).toBe(off.preamble);
  });
});

describe('system prompt sections — memory toggles exactly one section', () => {
  it('enabling memory adds damocles_memory and leaves every other section and the preamble byte-identical', () => {
    const off = assembleDamoclesSystemPrompt(inputs({ memoryEnabled: false }));
    const on = assembleDamoclesSystemPrompt(inputs({ memoryEnabled: true }));

    expect(diffSections(off.sections, on.sections)).toEqual({ added: ['damocles_memory'], removed: [], changed: [] });
    expect(on.preamble).toBe(off.preamble);
    for (const key of Object.keys(off.sections)) expect(on.sections[key]).toBe(off.sections[key]);
  });

  it('disabling memory drops the key from the map rather than emptying it', () => {
    const on = assembleDamoclesSystemPrompt(inputs({ memoryEnabled: true }));
    const off = assembleDamoclesSystemPrompt(inputs({ memoryEnabled: false }));

    expect('damocles_memory' in off.sections).toBe(false);
    expect(diffSections(on.sections, off.sections)).toEqual({ added: [], removed: ['damocles_memory'], changed: [] });
    expect(Object.keys(off.sections)).toEqual(Object.keys(on.sections).filter((k) => k !== 'damocles_memory'));
  });
});

describe('system prompt sections — map shape', () => {
  it('never carries an empty-valued section and never uses preamble as a key', () => {
    for (const planMode of [false, true]) {
      for (const memoryEnabled of [false, true]) {
        const built = assembleDamoclesSystemPrompt(inputs({ planMode, memoryEnabled }));
        expect(built.preamble.length).toBeGreaterThan(0);
        expect(Object.keys(built.sections)).not.toContain('preamble');
        for (const [key, value] of Object.entries(built.sections)) {
          expect(value, `section ${key} is empty`).not.toBe('');
          // pi validates section names and throws on anything outside this shape.
          expect(key).toMatch(/^[a-z][a-z0-9_-]*$/);
        }
      }
    }
  });
});
