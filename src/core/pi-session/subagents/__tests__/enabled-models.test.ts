import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Files the link policy refuses, as it does on Windows for one linked onto another share; any other file it judges itself.
const refused = vi.hoisted(() => new Set<string>());
vi.mock('../../../config/local-config-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/local-config-path')>();
  return {
    ...actual,
    configLinkPolicy: (bases: readonly string[]) => {
      const judged = actual.configLinkPolicy(bases);
      return (file: string): boolean => !refused.has(file) && judged(file);
    },
  };
});

import { installFakePlatform } from '../../../../__mocks__/fake-platform';
import { PI_AGENT_DIR } from '../../agent-dir';
import { resolveEnabledModels, isModelInScope, readEnabledModels } from '../enabled-models';

const registry = {
  getAvailableSnapshot: () => [
    { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Sonnet' },
    { provider: 'anthropic', id: 'claude-opus-4-8', name: 'Opus' },
    { provider: 'openai', id: 'gpt-6-luna', name: 'GPT' },
  ],
};

describe('resolveEnabledModels / isModelInScope', () => {
  it('returns undefined (no scope) when no patterns are given', () => {
    expect(resolveEnabledModels(undefined, registry)).toBeUndefined();
    expect(resolveEnabledModels([], registry)).toBeUndefined();
  });

  it('resolves exact provider/modelId patterns (case-insensitive) and validates scope', () => {
    const scope = resolveEnabledModels(['anthropic/claude-opus-4-8', 'OPENAI/GPT-6-LUNA'], registry);
    expect(scope).toBeDefined();
    expect(isModelInScope({ provider: 'anthropic', id: 'claude-opus-4-8' }, scope!)).toBe(true);
    expect(isModelInScope({ provider: 'openai', id: 'gpt-6-luna' }, scope!)).toBe(true);
    expect(isModelInScope({ provider: 'anthropic', id: 'claude-sonnet-5-5' }, scope!)).toBe(false);
  });

  it('denies all (empty set) when an allowlist is configured but nothing resolves', () => {
    // bare-id (no slash) and unmatched patterns resolve to nothing — a configured-but-unresolvable
    // allowlist must deny every model, NOT silently widen to "allow any" (undefined).
    const bare = resolveEnabledModels(['claude-opus-4-8'], registry);
    expect(bare).toBeInstanceOf(Set);
    expect(bare!.size).toBe(0);
    expect(isModelInScope({ provider: 'anthropic', id: 'claude-opus-4-8' }, bare!)).toBe(false);

    const unmatched = resolveEnabledModels(['anthropic/does-not-exist'], registry);
    expect(unmatched).toBeInstanceOf(Set);
    expect(unmatched!.size).toBe(0);
  });

  it('reserves undefined for "no allowlist configured" (allow any)', () => {
    expect(resolveEnabledModels(undefined, registry)).toBeUndefined();
    expect(resolveEnabledModels([], registry)).toBeUndefined();
  });

  it('reflects a registry change between calls (no stale caching)', () => {
    const dynamic = { models: [{ provider: 'anthropic', id: 'claude-opus-4-8', name: 'Opus' }], getAvailableSnapshot() { return this.models; } };
    // Model not present yet → configured allowlist resolves to nothing → deny-all (empty set).
    const before = resolveEnabledModels(['anthropic/gpt-x'], dynamic);
    expect(before).toBeInstanceOf(Set);
    expect(before!.size).toBe(0);
    // Provider/model becomes available → the very next call resolves it (no stale cache).
    dynamic.models.push({ provider: 'anthropic', id: 'gpt-x', name: 'GPT-X' });
    const after = resolveEnabledModels(['anthropic/gpt-x'], dynamic);
    expect(after && isModelInScope({ provider: 'anthropic', id: 'gpt-x' }, after)).toBe(true);
  });
});

describe('readEnabledModels trust gate', () => {
  const dirs: string[] = [];
  afterEach(() => {
    refused.clear();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function projectWith(models: string[]): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-enabled-'));
    dirs.push(cwd);
    fs.mkdirSync(path.join(cwd, '.pi'));
    fs.writeFileSync(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ enabledModels: models }));
    return cwd;
  }

  it('reads the project file in a trusted window', () => {
    expect(readEnabledModels(projectWith(['probe/project-only-model']))).toEqual(['probe/project-only-model']);
  });

  it('reads a project file that starts with a BOM', () => {
    const cwd = projectWith(['probe/project-only-model']);
    const file = path.join(cwd, '.pi', 'settings.json');
    fs.writeFileSync(file, `\uFEFF${fs.readFileSync(file, 'utf8')}`);
    expect(readEnabledModels(cwd)).toEqual(['probe/project-only-model']);
  });

  it('ignores the project file in a restricted window', () => {
    const cwd = projectWith(['probe/project-only-model']);
    const fake = installFakePlatform({ trusted: false });
    expect(readEnabledModels(cwd) ?? []).not.toContain('probe/project-only-model');
    expect(fake.trust.checkedPaths).toEqual([cwd]);
  });

  it('reads no settings file pi\'s link policy refuses, as pi loads no allowlist from it, and tells the user once per file', () => {
    const fake = installFakePlatform();
    const cwd = projectWith(['probe/project-only-model']);
    const project = path.join(cwd, '.pi', 'settings.json');
    const global = path.join(PI_AGENT_DIR, 'settings.json');
    refused.add(project);
    refused.add(global);
    expect(readEnabledModels(cwd)).toBeUndefined();
    expect(fake.notifications.calls.map((call) => call.text)).toEqual([
      { message: '{0} links to a network share or WSL path, so Damocles does not read it.', args: [project] },
      { message: '{0} links to a network share or WSL path, so Damocles does not read it.', args: [global] },
    ]);
  });
});
