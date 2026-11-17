import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

// koffi is reached through `require`, which vi.mock does not intercept, so a fake binding is put in its cache entry.
const nodeRequire = createRequire(import.meta.url);
const koffiId = nodeRequire.resolve('koffi');
const realKoffi = nodeRequire.cache[koffiId];

/** One QueryDosDeviceW answer: the target to write, or the Win32 error the call fails with. */
type Answer = { readonly target: string } | { readonly error: number };

/** queryDosDevice over a fake kernel32 that gives `answers` in turn, and the buffer lengths each call offered. */
async function withAnswers(answers: Answer[]): Promise<{ query: (name: string) => string | undefined; lengths: number[] }> {
  let lastError = 0;
  const lengths: number[] = [];
  const queryDosDevice = (_name: string, buffer: Buffer, length: number): number => {
    lengths.push(length);
    const answer = answers.shift()!;
    if ('error' in answer) {
      lastError = answer.error;
      return 0;
    }
    buffer.write(answer.target, 'utf16le');
    return answer.target.length;
  };
  const kernel32 = { func: (_convention: string, name: string) => (name === 'QueryDosDeviceW' ? queryDosDevice : () => lastError) };
  nodeRequire.cache[koffiId] = { id: koffiId, filename: koffiId, loaded: true, exports: { load: () => kernel32 } } as unknown as NodeJS.Module;
  vi.resetModules();
  const { queryDosDevice: query } = await import('../dos-devices');
  return { query, lengths };
}

afterEach(() => {
  if (realKoffi) nodeRequire.cache[koffiId] = realKoffi;
  else delete nodeRequire.cache[koffiId];
});

describe.runIf(process.platform === 'win32')('queryDosDevice (win32, fake kernel32)', () => {
  it('answers the first target of the list Windows writes', async () => {
    const { query } = await withAnswers([{ target: '\\Device\\HarddiskVolume2\0\\Device\\Old\0\0' }]);
    expect(query('C:')).toBe('\\Device\\HarddiskVolume2');
  });

  it('reads ERROR_FILE_NOT_FOUND as no such drive, not as a failure', async () => {
    const { query } = await withAnswers([{ error: 2 }]);
    expect(query('Q:')).toBeUndefined();
  });

  it('asks again with a larger buffer on ERROR_INSUFFICIENT_BUFFER, up to the longest target there can be', async () => {
    const grown = await withAnswers([{ error: 122 }, { error: 122 }, { target: '\\Device\\Mup\\x\0\0' }]);
    expect(grown.query('Z:')).toBe('\\Device\\Mup\\x');
    expect(grown.lengths).toEqual([1024, 2048, 4096]);
    const endless = await withAnswers(Array.from({ length: 8 }, () => ({ error: 122 })));
    expect(() => endless.query('Z:')).toThrow('Win32 error 122');
    expect(endless.lengths.at(-1)).toBe(65536);
  });

  it('throws any other failure with its Win32 code', async () => {
    const { query } = await withAnswers([{ error: 5 }]);
    expect(() => query('Z:')).toThrow('QueryDosDeviceW(Z:) failed with Win32 error 5');
  });
});
