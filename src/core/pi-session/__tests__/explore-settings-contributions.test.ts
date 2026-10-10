import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODELS, TEAM_EFFORT_LEVELS } from '../../../shared/types/constants';
import { readContributedConfiguration } from '../../config/contributed-configuration';

/** Static-JSON drift guard: the `damocles.explore.*` enums must track `DEFAULT_MODELS` and the effort levels. */
const packageJsonUrl = new URL('../../../../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), 'utf8')) as {
  contributes: {
    commands: { command: string }[];
    configuration: { properties: Record<string, { enum?: string[]; enumItemLabels?: string[]; default?: unknown; scope?: string }> };
  };
};
const properties = pkg.contributes.configuration.properties;

describe('explore settings contributions: enum sync guard', () => {
  it('damocles.explore.model enum and labels equal Default plus every DEFAULT_MODELS entry', () => {
    expect(properties['damocles.explore.model']!.enum).toEqual(['', ...DEFAULT_MODELS.map((m) => m.value)]);
    expect(properties['damocles.explore.model']!.enumItemLabels).toEqual(['%configuration.explore.modelDefault%', ...DEFAULT_MODELS.map((m) => m.displayName)]);
    expect(properties['damocles.explore.model']!.default).toBe('');
  });

  it("damocles.explore.effort enum equals ['', ...TEAM_EFFORT_LEVELS], one label per value", () => {
    const effort = properties['damocles.explore.effort']!;
    expect(effort.enum).toEqual(['', ...TEAM_EFFORT_LEVELS]);
    expect(effort.enumItemLabels).toHaveLength(effort.enum!.length);
    expect(effort.default).toBe('');
  });

  // The spawn reads them with no folder, so a project value would follow the selected project rather than the chat's, and an untrusted repo could pick a billed model.
  it('declares both keys application scope, which only user settings set', () => {
    const userOnly = readContributedConfiguration(fileURLToPath(new URL('../../../../', import.meta.url))).userOnlyKeys;
    for (const key of ['damocles.explore.model', 'damocles.explore.effort']) {
      expect(properties[key]!.scope).toBe('application');
      expect(userOnly).toContain(key);
    }
  });

  it('no longer contributes the retired provider keys or the Explore key command', () => {
    for (const key of ['damocles.explore.enabled', 'damocles.explore.provider', 'damocles.explore.modelByProvider']) expect(properties[key]).toBeUndefined();
    expect(pkg.contributes.commands.map((c) => c.command)).not.toContain('damocles.setExploreApiKey');
  });
});
