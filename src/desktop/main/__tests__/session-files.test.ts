import { describe, expect, it } from 'vitest';
import type { CoreClient } from '../core-client';
import { CoreNotRunningError } from '../core-host';
import { EngineUnavailableError, sessionFileEngines, type SessionFileEnginesDeps } from '../documents/session-files';
import { SESSION_FILES_FEATURE } from '../workspace/remote-workspace';

type Host = NonNullable<ReturnType<SessionFileEnginesDeps['host']>>;

const client = {
  writeSessionFile: async () => ({ kind: 'changed' as const }),
} as unknown as CoreClient;

const running: Host = { halted: () => false, run: (_label, work) => work({ client }) };

async function absence(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.catch((caught: unknown) => caught);
  return err instanceof EngineUnavailableError ? err.absence : undefined;
}

const write = (engines: ReturnType<typeof sessionFileEngines>, authority: string): Promise<unknown> => engines.write(authority, '/s/a_b.jsonl', new Uint8Array(), null);

describe('the engines that save their own session files', () => {
  it('write through this computer\'s running core', async () => {
    const engines = sessionFileEngines({ host: () => running, features: () => undefined });
    expect(await engines.write('local', 'C:\\s\\a_b.jsonl', new Uint8Array(), null)).toEqual({ kind: 'changed' });
  });

  it('answer stopped for a halted core and for one no reload runs', async () => {
    const halted = sessionFileEngines({ host: () => ({ ...running, halted: () => true }), features: () => undefined });
    const ended = sessionFileEngines({ host: () => ({ halted: () => false, run: () => Promise.reject(new CoreNotRunningError()) }), features: () => undefined });
    expect(await absence(write(halted, 'local'))).toBe('stopped');
    expect(await absence(write(ended, 'local'))).toBe('stopped');
  });

  it('write through a host\'s core only while it is connected and its daemon lists the feature', async () => {
    const offline = sessionFileEngines({ host: () => running, features: () => undefined });
    const older = sessionFileEngines({ host: () => running, features: () => ['files.outside'] });
    const coreless = sessionFileEngines({ host: () => undefined, features: () => [SESSION_FILES_FEATURE] });
    const current = sessionFileEngines({ host: () => running, features: () => [SESSION_FILES_FEATURE] });
    expect(await absence(write(offline, 'ssh-prod'))).toBe('notConnected');
    expect(await absence(write(older, 'ssh-prod'))).toBe('unsupported');
    expect(await absence(write(coreless, 'ssh-prod'))).toBe('notConnected');
    expect(await write(current, 'ssh-prod')).toEqual({ kind: 'changed' });
  });
});
