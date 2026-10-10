import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODELS, TEAM_EFFORT_LEVELS } from '../../../shared/types/constants';
import { readContributedConfiguration } from '../../config/contributed-configuration';
import { MEMORY_JUDGE_CLASSIFIERS } from '../../../shared/memory-judge';

/**
 * Static-JSON ⟷ code drift guard. The six `damocles.team.*` VS Code contributions in package.json
 * carry hardcoded enum lists that MUST track `DEFAULT_MODELS` (the catalog) and the team effort levels.
 * This repo has shipped silent drift before (a model added to the catalog but not the enum), so assert
 * the enums stay in lockstep with the code's single source of truth. `none` is intentionally EXCLUDED
 * from the team effort enums (no catalog model advertises it), so the guard tracks `TEAM_EFFORT_LEVELS`.
 */
const packageJsonUrl = new URL('../../../../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { enum?: string[]; enumItemLabels?: string[]; scope?: string }> } };
};
const properties = pkg.contributes.configuration.properties;

const MODEL_VALUES = ['', ...DEFAULT_MODELS.map((m) => m.value)];
const MODEL_LABELS = ['%configuration.team.modelDefault%', ...DEFAULT_MODELS.map((m) => m.displayName)];
const EFFORT_VALUES = ['', ...TEAM_EFFORT_LEVELS];

const MODEL_KEYS = [
  'damocles.team.leadModel',
  'damocles.team.implementorModel',
  'damocles.team.reviewerModel',
] as const;

const EFFORT_KEYS = [
  'damocles.team.leadEffort',
  'damocles.team.implementorEffort',
  'damocles.team.reviewerEffort',
] as const;

describe('team role settings contributions — enum sync guard', () => {
  for (const key of MODEL_KEYS) {
    it(`${key} enum equals ['', ...DEFAULT_MODELS values]`, () => {
      expect(properties[key]).toBeDefined();
      expect(properties[key]!.enum).toEqual(MODEL_VALUES);
    });
  }

  // VS Code pairs `enum[i]` with `enumItemLabels[i]` positionally, so an unpaired edit to either list
  // silently relabels every model below it.
  for (const key of MODEL_KEYS) {
    it(`${key} enumItemLabels equals ['%configuration.team.modelDefault%', ...DEFAULT_MODELS displayNames]`, () => {
      expect(properties[key]).toBeDefined();
      expect(properties[key]!.enumItemLabels).toEqual(MODEL_LABELS);
    });
  }

  for (const key of EFFORT_KEYS) {
    it(`${key} enum equals ['', ...TEAM_EFFORT_LEVELS]`, () => {
      expect(properties[key]).toBeDefined();
      expect(properties[key]!.enum).toEqual(EFFORT_VALUES);
    });
  }
});

describe('background settings contributions: enum sync guard', () => {
  it('damocles.background.model enum and labels equal Automatic plus every DEFAULT_MODELS entry', () => {
    expect(properties['damocles.background.model']!.enum).toEqual(MODEL_VALUES);
    expect(properties['damocles.background.model']!.enumItemLabels).toEqual(['%configuration.background.modelAutomatic%', ...DEFAULT_MODELS.map((m) => m.displayName)]);
  });

  it("damocles.background.effort enum equals ['', ...TEAM_EFFORT_LEVELS]", () => {
    expect(properties['damocles.background.effort']!.enum).toEqual(EFFORT_VALUES);
  });

  // Memory spans workspaces, so a project file must not pick the model it runs on.
  it('declares both keys application scope, which the desktop store reads from user settings only', () => {
    const userOnly = readContributedConfiguration(fileURLToPath(new URL('../../../../', import.meta.url))).userOnlyKeys;
    for (const key of ['damocles.background.model', 'damocles.background.effort']) {
      expect(properties[key]!.scope).toBe('application');
      expect(userOnly).toContain(key);
    }
  });
});

describe('memory judge settings contributions: enum sync guard', () => {
  it('damocles.memory.judge enum and labels equal Automatic, the classifier choices and every DEFAULT_MODELS entry', () => {
    const classifiers = MEMORY_JUDGE_CLASSIFIERS.map((entry) => entry.choice);
    expect(properties['damocles.memory.judge']!.enum).toEqual(['', ...classifiers, ...DEFAULT_MODELS.map((m) => m.value)]);
    expect(properties['damocles.memory.judge']!.enumItemLabels).toEqual([
      '%configuration.background.modelAutomatic%',
      'Jev (TypeSafe)',
      'Jev (OpenRouter)',
      'GPT-6 Luna (Decisions API)',
      ...DEFAULT_MODELS.map((m) => m.displayName),
    ]);
  });

  // One stored value must name one judge, so no classifier choice may equal a catalog model id.
  it('keeps every classifier choice distinct from every catalog model id', () => {
    const models = new Set(DEFAULT_MODELS.map((m) => m.value));
    for (const { choice } of MEMORY_JUDGE_CLASSIFIERS) expect(models.has(choice), choice).toBe(false);
  });

  it("damocles.memory.judgeEffort enum equals ['', ...TEAM_EFFORT_LEVELS]", () => {
    expect(properties['damocles.memory.judgeEffort']!.enum).toEqual(EFFORT_VALUES);
  });

  // Memory spans workspaces, so a project file must not pick its judge.
  it('declares both keys application scope, which the desktop store reads from user settings only', () => {
    const userOnly = readContributedConfiguration(fileURLToPath(new URL('../../../../', import.meta.url))).userOnlyKeys;
    for (const key of ['damocles.memory.judge', 'damocles.memory.judgeEffort']) {
      expect(properties[key]!.scope).toBe('application');
      expect(userOnly).toContain(key);
    }
  });
});
