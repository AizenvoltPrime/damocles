import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { EvaluatorManager } from '../evaluator-manager';
import { PermissionState } from '../../state';
import { DAMOCLES_PLANS_DIR } from '../../../auth/paths';
import type { PermissionMode } from '../../types';

const buildEvaluator = (overrides: Partial<Pick<PermissionState, 'permissionMode' | 'dangerouslySkipPermissions'>> = {}) => {
  const state = new PermissionState();
  state.permissionMode = overrides.permissionMode ?? 'default';
  state.dangerouslySkipPermissions = overrides.dangerouslySkipPermissions ?? false;
  return new EvaluatorManager(state);
};

const planFile = (name: string) => path.join(DAMOCLES_PLANS_DIR, name);

describe('EvaluatorManager.evaluate — DAMOCLES_PLANS_DIR auto-allow', () => {
  const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits'];

  for (const mode of modes) {
    it(`allows Write to <DAMOCLES_PLANS_DIR>/<slug>.md in ${mode} mode`, async () => {
      const evaluator = buildEvaluator({ permissionMode: mode });
      const result = await evaluator.evaluate('Write', { file_path: planFile('foo.md') }, null);
      expect(result).toBe('allow');
    });
  }

  it('allows Edit to <DAMOCLES_PLANS_DIR>/<slug>.md', async () => {
    const evaluator = buildEvaluator();
    const result = await evaluator.evaluate('Edit', { file_path: planFile('foo.md') }, null);
    expect(result).toBe('allow');
  });

  it('asks for Write to a workspace-relative .md file', async () => {
    const evaluator = buildEvaluator();
    const workspaceFile = path.resolve('foo.md');
    const result = await evaluator.evaluate('Write', { file_path: workspaceFile }, null);
    expect(result).toBe('ask');
  });

  it('asks for Write that uses .. traversal to escape DAMOCLES_PLANS_DIR (path.resolve neutralizes ..)', async () => {
    const evaluator = buildEvaluator();
    const traversal = path.join(DAMOCLES_PLANS_DIR, '..', '.credentials.json');
    const result = await evaluator.evaluate('Write', { file_path: traversal }, null);
    expect(result).toBe('ask');
  });

  it('asks for Write to <DAMOCLES_PLANS_DIR>/<slug>.txt (non-.md extension)', async () => {
    const evaluator = buildEvaluator();
    const result = await evaluator.evaluate('Write', { file_path: planFile('foo.txt') }, null);
    expect(result).toBe('ask');
  });

  it('asks for Write to a sibling directory whose name shares the plans/ prefix', async () => {
    const evaluator = buildEvaluator();
    const lookalike = `${path.resolve(DAMOCLES_PLANS_DIR)}-evil${path.sep}foo.md`;
    const result = await evaluator.evaluate('Write', { file_path: lookalike }, null);
    expect(result).toBe('ask');
  });

  it('does not affect Bash commands that mention plan files', async () => {
    const evaluator = buildEvaluator();
    const result = await evaluator.evaluate(
      'Bash',
      { command: `rm ${planFile('foo.md')}` },
      null,
    );
    expect(result).toBe('ask');
  });
});
