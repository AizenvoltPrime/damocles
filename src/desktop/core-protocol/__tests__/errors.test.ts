import { describe, expect, it } from 'vitest';
import { ERROR_CODEC } from '../errors';
import { createCoreEndpoint, createLoopback, createMainEndpoint, CoreProtocolError } from '..';
import { englishText, LocalizedError, type LocalizedText } from '../../../shared/localized-text';
import { StashKeptError, SyncBranchChangedError } from '../../../core/scm/errors';
import { MAX_MESSAGE_CHARS } from '../messages';

const quiet = (): void => undefined;
const greek = (text: LocalizedText): string => `[el] ${englishText(text)}`;

// main renders core's text in its own language; core and a daemon pass it on in English
function channel() {
  const { main, core } = createLoopback();
  const violations: CoreProtocolError[] = [];
  const logs: string[] = [];
  return {
    main: createMainEndpoint(main, (line) => logs.push(line), (error) => violations.push(error), undefined, greek),
    core: createCoreEndpoint(core, (line) => logs.push(line), (error) => violations.push(error)),
    violations,
    logs,
  };
}

const deep = (depth: number): LocalizedText => (depth === 0 ? { message: 'leaf' } : { message: '{0}', args: [deep(depth - 1)] });

// each is LocalizedText's type, but outside what the wire's parser takes
const OUTSIDE_THE_WIRE: ReadonlyArray<readonly [string, LocalizedText]> = [
  ['a NaN number', { message: '{0} files', args: [{ number: Number.NaN }] }],
  ['an infinite number argument', { message: '{0}', args: [Number.POSITIVE_INFINITY] }],
  ['an argument over the message bound', { message: 'Failed: {0}', args: ['x'.repeat(MAX_MESSAGE_CHARS + 1)] }],
  ['more than 64 arguments', { message: 'many', args: Array.from({ length: 65 }, () => 'a') }],
  ['nesting past 8 levels', deep(10)],
];

describe('the error codec', () => {
  it('carries a system error\'s code, so the other side words a full disk or a permission problem itself', () => {
    const fault = ERROR_CODEC.encode(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }), quiet);
    expect(fault).toEqual({ name: 'Errno', data: { code: 'ENOSPC' } });
    const rebuilt = ERROR_CODEC.decode(fault!, 'ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
    expect(rebuilt).toBeInstanceOf(Error);
    expect([rebuilt.message, rebuilt.code]).toEqual(['ENOSPC: no space left on device, write', 'ENOSPC']);
  });

  it('carries an error with no system code as its message only, and rebuilds no Errno whose code is not one', () => {
    expect(ERROR_CODEC.encode(new Error('plain'), quiet)).toBeUndefined();
    expect(ERROR_CODEC.encode(Object.assign(new Error('node'), { code: 'ERR_INVALID_ARG_VALUE' }), quiet)).toBeUndefined();
    expect(ERROR_CODEC.decode({ name: 'Errno', data: { code: 'not a code' } }, 'x')).toBeUndefined();
    expect(ERROR_CODEC.decode({ name: 'Errno', data: {} }, 'x')).toBeUndefined();
  });

  it.each(OUTSIDE_THE_WIRE)('never encodes a text fault decode would refuse: %s', (_name, text) => {
    const logs: string[] = [];
    for (const err of [new LocalizedError(text), new StashKeptError(text, 'failed', undefined), new SyncBranchChangedError(text, 'pull', { branch: 'b', remote: 'r', upstreamBranch: 'u' }, null)]) {
      expect(ERROR_CODEC.encode(err, (line) => logs.push(line))).toBeUndefined();
    }
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatch(/LocalizedError's text is outside the wire's LocalizedText/);
  });
});

describe('a LocalizedError across the channel', () => {
  const TEXT: LocalizedText = { message: 'Could not delete the worktree "{0}": {1}', args: ['wt', { message: 'Files were added to it after you confirmed.' }] };

  it('reaches main as a LocalizedError with its text, its message in main\'s language', async () => {
    const { main, core, violations } = channel();
    core.serve('scm.call', () => Promise.reject(new LocalizedError(TEXT)));
    const err = await main.request('scm.call', { method: 'refresh', args: [] }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(LocalizedError);
    expect((err as LocalizedError).text).toEqual(TEXT);
    expect((err as LocalizedError).message).toBe(greek(TEXT));
    expect(violations).toEqual([]);
  });

  it('reaches core in English, as a daemon passes it on', async () => {
    const { main, core, violations } = channel();
    main.serve('network.resolveProxy', () => Promise.reject(new LocalizedError(TEXT)));
    const err = await core.request('network.resolveProxy', { url: 'https://a/' }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(LocalizedError);
    expect((err as LocalizedError).text).toEqual(TEXT);
    expect((err as LocalizedError).message).toBe(englishText(TEXT));
    expect(violations).toEqual([]);
  });

  it.each(OUTSIDE_THE_WIRE)('crosses core to main as its message, logged, never as a violation: %s', async (_name, text) => {
    const { main, core, violations, logs } = channel();
    core.serve('scm.call', () => Promise.reject(new LocalizedError(text)));
    const err = await main.request('scm.call', { method: 'refresh', args: [] }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LocalizedError);
    expect((err as Error).message).toBe(englishText(text).slice(0, 64 * 1024));
    expect(violations).toEqual([]);
    expect(logs.some((line) => line.includes('outside the wire\'s LocalizedText'))).toBe(true);
  });

  it.each(OUTSIDE_THE_WIRE)('crosses main to core as its message, logged, never as a violation: %s', async (_name, text) => {
    const { main, core, violations, logs } = channel();
    main.serve('network.resolveProxy', () => Promise.reject(new LocalizedError(text)));
    const err = await core.request('network.resolveProxy', { url: 'https://a/' }).catch((error: unknown) => error);
    expect(err).not.toBeInstanceOf(LocalizedError);
    expect((err as Error).message).toBe(englishText(text).slice(0, 64 * 1024));
    expect(violations).toEqual([]);
    expect(logs.some((line) => line.includes('outside the wire\'s LocalizedText'))).toBe(true);
  });
});
