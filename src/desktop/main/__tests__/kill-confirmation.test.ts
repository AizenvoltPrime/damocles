import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_PREVIEW_LINES, MAX_OVERLAY_LABEL_LENGTH } from '../../preload/overlay-channels';
import { killQuestion, terminalsToConfirm, type KillCandidate } from '../terminal/kill-confirmation';
import { parseMessageRequest } from '../overlay';

const t = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? '');

describe('terminalsToConfirm', () => {
  const idle: KillCandidate = { status: 'running', running: null };
  const busy: KillCandidate = { status: 'running', running: 'npm test' };
  const unreported: KillCandidate = { status: 'running', running: '' };
  const starting: KillCandidate = { status: 'starting', running: null };
  const exited: KillCandidate = { status: 'exited', running: null };

  it('running: asks about terminals that run something, a command whose line was not reported included', () => {
    expect(terminalsToConfirm('running', [idle, busy, exited, unreported, starting])).toEqual([busy, unreported]);
    expect(terminalsToConfirm('running', [idle, starting, exited])).toEqual([]);
  });

  it('always: asks about every live terminal; never: about none', () => {
    expect(terminalsToConfirm('always', [idle, busy, exited, starting])).toEqual([idle, busy, starting]);
    expect(terminalsToConfirm('always', [exited])).toEqual([]);
    expect(terminalsToConfirm('never', [idle, busy, unreported])).toEqual([]);
  });

  it('keeps the order given and the caller\'s own objects', () => {
    const a = { ...busy, id: 'a' };
    const b = { ...busy, id: 'b' };
    expect(terminalsToConfirm('running', [b, a])).toEqual([b, a]);
    expect(terminalsToConfirm('running', [b, a])[0]).toBe(b);
  });
});

describe('killQuestion', () => {
  it('asks VS Code\'s singular question with the terminal and its command, Terminate focused', () => {
    const question = killQuestion([{ name: 'server', command: 'node -e "setInterval(()=>{},1000)"' }], t);
    expect(question).toEqual({
      severity: 'warning',
      message: 'Do you want to terminate the active terminal session?',
      detail: 'Its shell and anything running in it stop.',
      preview: ['server: node -e "setInterval(()=>{},1000)"'],
      actions: ['Terminate'],
      cancelLabel: 'Cancel',
      defaultAction: 0,
    });
    expect(parseMessageRequest({ kind: 'message', ...question })).toBeDefined();
  });

  it('lists several terminals in one question, an idle one by name, folding what the preview cannot hold', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({ name: `T${index}`, command: index === 0 ? null : `cmd ${index}` }));
    const question = killQuestion(entries, t);
    expect(question.message).toBe('Do you want to terminate the 12 active terminal sessions?');
    expect(question.preview).toHaveLength(MAX_MESSAGE_PREVIEW_LINES);
    expect(question.preview?.[0]).toBe('T0');
    expect(question.preview?.at(-1)).toBe('and 5 more');
    expect(killQuestion(entries.slice(0, MAX_MESSAGE_PREVIEW_LINES), t).preview).toHaveLength(MAX_MESSAGE_PREVIEW_LINES);
    expect(parseMessageRequest({ kind: 'message', ...question })).toBeDefined();
  });

  it('cuts a preview line to the overlay\'s label bound', () => {
    const [line] = killQuestion([{ name: 'n'.repeat(150), command: 'c'.repeat(100) }], t).preview!;
    expect(line).toHaveLength(MAX_OVERLAY_LABEL_LENGTH);
    expect(line!.endsWith('…')).toBe(true);
  });

  it('never leaves half of a surrogate pair where it cuts a line', () => {
    const [line] = killQuestion([{ name: `${'n'.repeat(MAX_OVERLAY_LABEL_LENGTH - 2)}🚀🚀`, command: null }], t).preview!;
    expect(line).toBe(`${'n'.repeat(MAX_OVERLAY_LABEL_LENGTH - 2)}…`);
  });
});
