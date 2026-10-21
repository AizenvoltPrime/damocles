import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StructuredCompletionRequest } from '../../../core/pi-session/structured-completion';
import { backgroundCompletion, type SubCallRuntime } from '../commit-message-completion';

const projectPath = path.resolve('/projects/repo');

describe('the Background model sub-call', () => {
  const request: StructuredCompletionRequest = { systemPrompt: 's', userMessage: 'u', outputToolName: 'o', outputToolDescription: 'd', schema: {}, purpose: 'commit-message', attribution: { cwd: projectPath } };

  function fakeRuntime(order: string[], folder: () => Promise<unknown> = async () => undefined): SubCallRuntime {
    return {
      folder: async (cwd) => {
        order.push(`folder:${cwd}`);
        return folder();
      },
      syncCustomProviders: async () => void order.push('sync'),
      runStructuredCompletion: async () => {
        order.push('run');
        return { kind: 'answered', value: { message: 'Subject' } } as never;
      },
    };
  }

  it('creates the runtime and the project\'s folder runtime before any chat has, then runs', async () => {
    const order: string[] = [];
    let created = 0;
    const complete = backgroundCompletion(() => {
      created++;
      return fakeRuntime(order);
    }, async () => undefined, () => undefined);
    expect(await complete(request)).toEqual({ kind: 'answered', value: { message: 'Subject' } });
    expect(created).toBe(1);
    expect(order).toEqual([`folder:${projectPath}`, 'sync', 'run']);
  });

  it('answers unreachable once the runtime is retired, or when it cannot start', async () => {
    expect(await backgroundCompletion(() => null, async () => undefined, () => undefined)(request)).toEqual({ kind: 'unreachable' });
    const lines: string[] = [];
    const order: string[] = [];
    const failing = backgroundCompletion(() => fakeRuntime(order, async () => { throw new Error('pi failed to load'); }), async () => undefined, (line) => lines.push(line));
    expect(await failing(request)).toEqual({ kind: 'unreachable' });
    expect(order).toEqual([`folder:${projectPath}`]);
    expect(lines).toEqual(['[scm] the model runtime could not start: pi failed to load']);
  });
});
