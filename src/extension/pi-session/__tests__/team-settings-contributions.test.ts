import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODELS, TEAM_EFFORT_LEVELS } from '../../../shared/types/constants';

/**
 * Static-JSON ⟷ code drift guard. The six `damocles.team.*` VS Code contributions in package.json
 * carry hardcoded enum lists that MUST track `DEFAULT_MODELS` (the catalog) and the team effort levels.
 * This repo has shipped silent drift before (a model added to the catalog but not the enum), so assert
 * the enums stay in lockstep with the code's single source of truth. `none` is intentionally EXCLUDED
 * from the team effort enums (no catalog model advertises it), so the guard tracks `TEAM_EFFORT_LEVELS`.
 */
const packageJsonUrl = new URL('../../../../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { enum?: string[] }> } };
};
const properties = pkg.contributes.configuration.properties;

const MODEL_VALUES = ['', ...DEFAULT_MODELS.map((m) => m.value)];
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

  for (const key of EFFORT_KEYS) {
    it(`${key} enum equals ['', ...TEAM_EFFORT_LEVELS]`, () => {
      expect(properties[key]).toBeDefined();
      expect(properties[key]!.enum).toEqual(EFFORT_VALUES);
    });
  }
});
