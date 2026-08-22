import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODELS } from '../../../shared/types/constants';

/**
 * Static-JSON ⟷ code drift guard for `damocles.explore.effort`. Its enum MUST track the effort levels
 * the Explore model supports (currently StepFun `step-3.7-flash`), prefixed by `''` (model default).
 * Computed from the catalog's `supportedEffortLevels`, not hardcoded, so a catalog change fails here.
 */
const packageJsonUrl = new URL('../../../../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { enum?: string[]; enumItemLabels?: string[]; default?: unknown }> } };
};
const properties = pkg.contributes.configuration.properties;

const stepFlash = DEFAULT_MODELS.find((m) => m.value === 'step-3.7-flash')!;
const EXPECTED_ENUM = ['', ...stepFlash.supportedEffortLevels!];

describe('explore effort setting contribution — enum sync guard', () => {
  it("damocles.explore.effort enum equals ['', ...step-3.7-flash supportedEffortLevels]", () => {
    expect(properties['damocles.explore.effort']).toBeDefined();
    expect(properties['damocles.explore.effort']!.enum).toEqual(EXPECTED_ENUM);
  });

  it('damocles.explore.effort has a label per enum value and defaults to the model-default sentinel', () => {
    const prop = properties['damocles.explore.effort']!;
    expect(prop.enumItemLabels).toHaveLength(EXPECTED_ENUM.length);
    expect(prop.default).toBe('');
  });
});
