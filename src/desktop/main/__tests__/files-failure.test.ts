import { describe, expect, it } from 'vitest';
import { filesFailureMessage, settleFilesAction } from '../files/files-failure';

const t = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)]!);

describe('Files failures', () => {
  it('names the entry and the reason of every failed action once, and stays silent for a success or a cancel', () => {
    expect(filesFailureMessage(t, 'delete', 'locked.ts', { ok: false, reason: 'failed', message: 'EBUSY: resource busy or locked' }))
      .toBe('Damocles could not delete locked.ts: EBUSY: resource busy or locked');
    expect(filesFailureMessage(t, 'delete', 'gone.ts', { ok: false, reason: 'missing' })).toBe('Damocles could not delete gone.ts: It is no longer there.');
    expect(filesFailureMessage(t, 'reveal', 'a.ts', { ok: false, reason: 'failed', message: 'no file manager' })).toBe('Damocles could not reveal a.ts: no file manager');
    expect(filesFailureMessage(t, 'copyPath', 'a.ts', { ok: false, reason: 'failed' })).toBe('Damocles could not copy the path of a.ts: The file system refused it.');
    expect(filesFailureMessage(t, 'rename', 'old.ts', { ok: false, reason: 'exists' }, 'new.ts')).toBe('Damocles could not rename old.ts: A file or folder named new.ts already exists there.');
    expect(filesFailureMessage(t, 'create', 'x', { ok: false, reason: 'outside' })).toBe('Damocles could not create x: That location is outside the project.');
    expect(filesFailureMessage(t, 'list', 'src', { ok: false, reason: 'failed' })).toBe('Damocles could not open the folder src: The file system refused it.');
    expect(filesFailureMessage(t, 'list', 'src', { ok: true, entries: [] })).toBeUndefined();
    expect(filesFailureMessage(t, 'delete', 'a.ts', { ok: false, reason: 'cancelled' })).toBeUndefined();
    expect(filesFailureMessage(t, 'delete', 'a.ts', { ok: true })).toBeUndefined();
  });

  it('turns an action that throws into a failure carrying its message', async () => {
    const logged: string[] = [];
    expect(await settleFilesAction(async () => { throw new Error('boom'); }, (line) => logged.push(line))).toEqual({ ok: false, reason: 'failed', message: 'boom' });
    expect(await settleFilesAction(async () => ({ ok: true as const }), (line) => logged.push(line))).toEqual({ ok: true });
    expect(logged).toEqual(['[files] boom']);
  });
});
