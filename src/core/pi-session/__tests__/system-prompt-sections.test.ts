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

function withEnv(over: Partial<SystemPromptEnv>, rest: Partial<DamoclesSystemPromptInputs> = {}): DamoclesSystemPromptInputs {
  return inputs({ ...rest, env: { ...env, ...over } });
}

/** Asserts that moving one input from `before` to `after` leaves the preamble and every other section byte-identical. */
function expectOnly(before: DamoclesSystemPromptInputs, after: DamoclesSystemPromptInputs, expected: SectionDiff): void {
  const a = assembleDamoclesSystemPrompt(before);
  const b = assembleDamoclesSystemPrompt(after);
  expect(b.preamble).toBe(a.preamble);
  expect(diffSections(a.sections, b.sections)).toEqual(expected);
  const touched = new Set([...expected.added, ...expected.removed, ...expected.changed]);
  for (const key of Object.keys(a.sections).filter((k) => !touched.has(k))) expect(b.sections[key], key).toBe(a.sections[key]);
}

const none: SectionDiff = { added: [], removed: [], changed: [] };

describe('system prompt sections — each runtime input moves only its own section', () => {
  it('a model switch changes only damocles_model', () => {
    expectOnly(withEnv({ model: 'claude-opus-5-5' }), withEnv({ model: 'claude-haiku-5-5' }), { ...none, changed: ['damocles_model'] });
    const haiku = assembleDamoclesSystemPrompt(withEnv({ model: 'claude-haiku-5-5' }));
    expect(haiku.sections['damocles_model']).toContain('You are powered by the model named Haiku 5.5. The exact model ID is claude-haiku-5-5.');
    expect(haiku.sections['damocles_model']).toContain('Assistant knowledge cutoff is June 2026.');
  });

  it('turning thinking off adds damocles_output_form, and turning it on removes the key', () => {
    expectOnly(withEnv({ thinkingDisabled: false }), withEnv({ thinkingDisabled: true }), { ...none, added: ['damocles_output_form'] });
    expectOnly(withEnv({ thinkingDisabled: true }), withEnv({ thinkingDisabled: false }), { ...none, removed: ['damocles_output_form'] });
    expect(assembleDamoclesSystemPrompt(withEnv({ thinkingDisabled: true })).sections['damocles_output_form']).toContain('# Output form');
  });

  // The Compass guide and the Explore fallback are mutually exclusive, so the toggle swaps one for the other.
  it('enabling Compass swaps damocles_explore for compass', () => {
    expectOnly(withEnv({ compassEnabled: false }), withEnv({ compassEnabled: true }), { added: ['compass'], removed: ['damocles_explore'], changed: [] });
    expectOnly(withEnv({ compassEnabled: true }), withEnv({ compassEnabled: false }), { added: ['damocles_explore'], removed: ['compass'], changed: [] });
  });

  it('enabling web search adds damocles_web_verification', () => {
    expectOnly(inputs({ webSearchEnabled: false }), inputs({ webSearchEnabled: true }), { ...none, added: ['damocles_web_verification'] });
    expectOnly(inputs({ webSearchEnabled: true }), inputs({ webSearchEnabled: false }), { ...none, removed: ['damocles_web_verification'] });
  });

  it('enabling teams adds damocles_team', () => {
    expectOnly(inputs({ teamEnabled: false }), inputs({ teamEnabled: true }), { ...none, added: ['damocles_team'] });
    expectOnly(inputs({ teamEnabled: true }), inputs({ teamEnabled: false }), { ...none, removed: ['damocles_team'] });
  });

  it('a cwd change changes only damocles_environment', () => {
    expectOnly(withEnv({ cwd: '/repo' }), withEnv({ cwd: '/other' }), { ...none, changed: ['damocles_environment'] });
  });

  it('a git repository appearing changes only damocles_environment', () => {
    expectOnly(withEnv({ isGitRepo: false }), withEnv({ isGitRepo: true }), { ...none, changed: ['damocles_environment'] });
  });

  it('a platform, shell or OS change changes only damocles_environment', () => {
    for (const over of [{ platform: 'linux' }, { shell: '/bin/zsh' }, { osVersion: 'Linux 6.8' }]) {
      expectOnly(withEnv({}), withEnv(over), { ...none, changed: ['damocles_environment'] });
    }
  });
});

describe('system prompt sections — the preamble depends on no runtime input', () => {
  it('builds one preamble across every combination of inputs', () => {
    const preambles = new Set<string>();
    const flags = [false, true];
    for (const model of ['claude-opus-5-5', 'claude-haiku-5-5', 'gpt-6-astra', 'unknown-model']) {
      for (const place of [{}, { cwd: '/other', isGitRepo: false, platform: 'darwin', shell: '/bin/zsh', osVersion: 'Darwin 25' }]) {
        for (const thinkingDisabled of flags) {
          for (const compassEnabled of flags) {
            for (const webSearchEnabled of flags) {
              for (const teamEnabled of flags) {
                for (const memoryEnabled of flags) {
                  for (const planMode of flags) {
                    const built = assembleDamoclesSystemPrompt(withEnv({ model, thinkingDisabled, compassEnabled, ...place }, { webSearchEnabled, teamEnabled, memoryEnabled, planMode }));
                    preambles.add(built.preamble);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(preambles.size).toBe(1);
  });
});

describe('system prompt sections — map shape', () => {
  it('never carries an empty-valued section and never uses preamble as a key', () => {
    for (const planMode of [false, true]) {
      for (const memoryEnabled of [false, true]) {
        for (const toggles of [false, true]) {
          const built = assembleDamoclesSystemPrompt(
            withEnv({ thinkingDisabled: toggles, compassEnabled: toggles }, { planMode, memoryEnabled, webSearchEnabled: toggles, teamEnabled: toggles }),
          );
          expect(built.preamble.length).toBeGreaterThan(0);
          expect(Object.keys(built.sections)).not.toContain('preamble');
          for (const [key, value] of Object.entries(built.sections)) {
            expect(value, `section ${key} is empty`).not.toBe('');
            // pi validates section names and throws on anything outside this shape.
            expect(key).toMatch(/^[a-z][a-z0-9_-]*$/);
          }
        }
      }
    }
  });

  // The model reads cwd and platform closest to its first tool call, and the tone reminder must be last.
  it('ends with environment, model, output form and tone', () => {
    expect(Object.keys(assembleDamoclesSystemPrompt(withEnv({ thinkingDisabled: true })).sections).slice(-4)).toEqual([
      'damocles_environment',
      'damocles_model',
      'damocles_output_form',
      'damocles_tone',
    ]);
    expect(Object.keys(assembleDamoclesSystemPrompt(withEnv({ thinkingDisabled: false })).sections).slice(-3)).toEqual([
      'damocles_environment',
      'damocles_model',
      'damocles_tone',
    ]);
  });
});
