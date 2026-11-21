import { describe, expect, it } from 'vitest';
import { LocalizedError, type LocalizedText } from '../../../shared/localized-text';
import { filesFailureMessage, settleFilesAction } from '../files/files-failure';

const t = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)]!);
// the user's language, told apart from English by its prefix
const render = (text: LocalizedText): string => `[el] ${t(text.message, ...(text.args ?? []).map(String))}`;
// a file of this computer, whose host is never named
const local = (): string => {
  throw new Error('a local file has no host name');
};

describe('Files failures', () => {
  it('names the entry and the reason of every failed action once, and stays silent for a success or a cancel', () => {
    expect(filesFailureMessage(t, render, 'delete', 'locked.ts', local, { ok: false, reason: 'failed', message: 'EBUSY: resource busy or locked' }))
      .toBe('Damocles could not delete locked.ts: EBUSY: resource busy or locked');
    expect(filesFailureMessage(t, render, 'delete', 'gone.ts', local, { ok: false, reason: 'missing' })).toBe('Damocles could not delete gone.ts: It is no longer there.');
    expect(filesFailureMessage(t, render, 'reveal', 'a.ts', local, { ok: false, reason: 'failed', message: 'no file manager' })).toBe('Damocles could not reveal a.ts: no file manager');
    expect(filesFailureMessage(t, render, 'copyPath', 'a.ts', local, { ok: false, reason: 'failed' })).toBe('Damocles could not copy the path of a.ts: The file system refused it.');
    expect(filesFailureMessage(t, render, 'rename', 'old.ts', local, { ok: false, reason: 'exists' }, 'new.ts')).toBe('Damocles could not rename old.ts: A file or folder named new.ts already exists there.');
    expect(filesFailureMessage(t, render, 'create', 'x', local, { ok: false, reason: 'outside' })).toBe('Damocles could not create x: That location is outside the project.');
    expect(filesFailureMessage(t, render, 'list', 'src', local, { ok: false, reason: 'failed' })).toBe('Damocles could not open the folder src: The file system refused it.');
    expect(filesFailureMessage(t, render, 'list', 'src', local, { ok: true, entries: [] })).toBeUndefined();
    expect(filesFailureMessage(t, render, 'delete', 'a.ts', local, { ok: false, reason: 'cancelled' })).toBeUndefined();
    expect(filesFailureMessage(t, render, 'delete', 'a.ts', local, { ok: true })).toBeUndefined();
  });

  it('names why a user open was refused: a link to a share, a file that is gone, a file system error, an older daemon', () => {
    expect(filesFailureMessage(t, render, 'open', 'x.ts', local, { ok: false, reason: 'outside', refusal: 'share' })).toBe('Damocles could not open x.ts: A link on its path leads to a network share or WSL path.');
    expect(filesFailureMessage(t, render, 'open', 'x.ts', local, { ok: false, reason: 'missing' })).toBe('Damocles could not open x.ts: It is no longer there.');
    expect(filesFailureMessage(t, render, 'open', 'x.ts', local, { ok: false, reason: 'failed', message: 'EACCES: permission denied' })).toBe('Damocles could not open x.ts: EACCES: permission denied');
    expect(filesFailureMessage(t, render, 'open', 'x.ts', () => 'build-box', { ok: false, reason: 'outside', refusal: 'oldDaemon' }))
      .toBe('Damocles could not open x.ts: Update the Damocles server on build-box to open links that lead outside the project.');
    expect(filesFailureMessage(t, render, 'open', 'x.ts', local, { ok: true, tabId: 't' })).toBeUndefined();
  });

  it('names why a folder expand or an entry action on a path through a link was refused', () => {
    expect(filesFailureMessage(t, render, 'list', 'deeper', local, { ok: false, reason: 'outside', refusal: 'share' })).toBe('Damocles could not open the folder deeper: A link on its path leads to a network share or WSL path.');
    expect(filesFailureMessage(t, render, 'list', 'out', () => 'build-box', { ok: false, reason: 'outside', refusal: 'oldDaemon' }))
      .toBe('Damocles could not open the folder out: Update the Damocles server on build-box to open links that lead outside the project.');
    expect(filesFailureMessage(t, render, 'create', 'x', local, { ok: false, reason: 'outside', refusal: 'share' })).toBe('Damocles could not create x: A link on its path leads to a network share or WSL path.');
    expect(filesFailureMessage(t, render, 'rename', 'a.ts', local, { ok: false, reason: 'outside', refusal: 'share' }, 'b.ts')).toBe('Damocles could not rename a.ts: A link on its path leads to a network share or WSL path.');
    expect(filesFailureMessage(t, render, 'delete', 'a.ts', local, { ok: false, reason: 'outside', refusal: 'share' })).toBe('Damocles could not delete a.ts: A link on its path leads to a network share or WSL path.');
  });

  it('names a refusal of an action that would reach chat session files', () => {
    const kept = 'Chat session files are kept there, and only Damocles changes them.';
    expect(filesFailureMessage(t, render, 'delete', 'pi', local, { ok: false, reason: 'sessionFile' })).toBe(`Damocles could not delete pi: ${kept}`);
    expect(filesFailureMessage(t, render, 'rename', 's1.jsonl', local, { ok: false, reason: 'sessionFile' }, 'x.jsonl')).toBe(`Damocles could not rename s1.jsonl: ${kept}`);
    expect(filesFailureMessage(t, render, 'create', 'new.txt', local, { ok: false, reason: 'sessionFile' })).toBe(`Damocles could not create new.txt: ${kept}`);
  });

  it('names a failed walk by its own words in the user\'s language, before the generic text', () => {
    const drive = { message: 'The drive {0} did not answer within a second.', args: ['Q:\\'] };
    expect(filesFailureMessage(t, render, 'open', 'x.ts', local, { ok: false, reason: 'failed', error: drive })).toBe('Damocles could not open x.ts: [el] The drive Q:\\ did not answer within a second.');
    expect(filesFailureMessage(t, render, 'list', 'out', local, { ok: false, reason: 'failed', error: { message: '{0}', args: ['ELOOP: too many symbolic links'] } })).toBe('Damocles could not open the folder out: [el] ELOOP: too many symbolic links');
  });

  it('names an entry, a new name and a failure that hold control or bidi characters by their escapes', () => {
    expect(filesFailureMessage(t, render, 'rename', 'a\u202Eb.ts', local, { ok: false, reason: 'exists' }, 'c\u2066.ts'))
      .toBe('Damocles could not rename a\\u{202E}b.ts: A file or folder named c\\u{2066}.ts already exists there.');
    expect(filesFailureMessage(t, render, 'delete', 'a\u202Eb.ts', local, { ok: false, reason: 'failed', message: "EBUSY: resource busy or locked, unlink 'C:\\p\\a\u202Eb.ts'" }))
      .toBe("Damocles could not delete a\\u{202E}b.ts: EBUSY: resource busy or locked, unlink 'C:\\p\\a\\u{202E}b.ts'");
  });

  it("turns an action that throws into a failure carrying its message, a LocalizedError's in the user's language", async () => {
    const logged: string[] = [];
    expect(await settleFilesAction(async () => { throw new Error('boom'); }, (line) => logged.push(line), render)).toEqual({ ok: false, reason: 'failed', message: 'boom' });
    expect(await settleFilesAction(async () => ({ ok: true as const }), (line) => logged.push(line), render)).toEqual({ ok: true });
    const drive = new LocalizedError({ message: 'The drive {0} did not answer within a second.', args: ['Q:\\'] });
    expect(await settleFilesAction(async () => { throw drive; }, (line) => logged.push(line), render)).toEqual({ ok: false, reason: 'failed', message: '[el] The drive Q:\\ did not answer within a second.' });
    expect(logged).toEqual(['[files] boom', '[files] The drive Q:\\ did not answer within a second.']);
  });
});
