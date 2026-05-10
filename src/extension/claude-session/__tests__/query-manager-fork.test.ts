import { describe, it, expect, vi } from 'vitest';
import { QueryManager } from '../query-manager';
import type { SessionOptions, MessageCallbacks } from '../types';

vi.mock('../../logger', () => ({ log: vi.fn() }));
vi.mock('../../shared/sdk-loader', () => ({ loadSdkQuery: () => null }));
vi.mock('../../auth/sdk-env', () => ({ buildSdkEnv: () => ({}) }));

function buildQM(): QueryManager {
  const options = {
    cwd: '/cwd',
    permissionHandler: {} as never,
    onMessage: vi.fn(),
    panelId: 'panel-x',
    resolveThinking: () => ({ thinkingDisabled: false, effort: null, maxThinkingTokens: null }),
  } as unknown as SessionOptions;

  const callbacks: MessageCallbacks = { onMessage: vi.fn() };

  return new QueryManager(
    options,
    callbacks,
    {} as never,
    {} as never,
    () => '',
    {} as never,
    {} as never,
  );
}

describe('QueryManager.buildQueryOptions fork plumbing', () => {
  it('emits forkSession + resume + resumeSessionAt when forkSession is true and not in recall mode', () => {
    const qm = buildQM();
    const abortController = new AbortController();

    const result = (qm as unknown as {
      buildQueryOptions: (a: {
        abortController: AbortController;
        resumeSessionId: string | null;
        resumeSessionAt: string | null;
        ephemeral: boolean;
        forkSession?: boolean;
      }) => { queryOptions: Record<string, unknown> };
    }).buildQueryOptions({
      abortController,
      resumeSessionId: 'abc',
      resumeSessionAt: 'uuid-x',
      ephemeral: false,
      forkSession: true,
    });

    expect(result.queryOptions['resume']).toBe('abc');
    expect(result.queryOptions['resumeSessionAt']).toBe('uuid-x');
    expect(result.queryOptions['forkSession']).toBe(true);
  });

  it('omits forkSession when forkSession is false', () => {
    const qm = buildQM();
    const abortController = new AbortController();

    const result = (qm as unknown as {
      buildQueryOptions: (a: {
        abortController: AbortController;
        resumeSessionId: string | null;
        resumeSessionAt: string | null;
        ephemeral: boolean;
        forkSession?: boolean;
      }) => { queryOptions: Record<string, unknown> };
    }).buildQueryOptions({
      abortController,
      resumeSessionId: 'abc',
      resumeSessionAt: 'uuid-x',
      ephemeral: false,
      forkSession: false,
    });

    expect(result.queryOptions['resume']).toBe('abc');
    expect(result.queryOptions['resumeSessionAt']).toBe('uuid-x');
    expect(result.queryOptions['forkSession']).toBeUndefined();
  });
});
