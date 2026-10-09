import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_PREVIEW_LINES, MAX_OVERLAY_LABEL_LENGTH } from '../../preload/overlay-channels';
import { MAX_TERMINAL_INPUT_CHARS } from '../../preload/terminal-channels';
import type { MessageQuestion } from '../message-dialog';
import { parseMessageRequest } from '../overlay';
import {
  pasteAsOneLine,
  pasteChunks,
  pasteDecision,
  pastePreview,
  pasteText,
  preparePaste,
  PREVIEW_LINES,
  PREVIEW_WIDTH,
} from '../terminal/terminal-paste';

describe('paste decision', () => {
  it('never asks for one plain line, and never with the setting off', () => {
    expect(pasteDecision('echo hi', 'always', false)).toEqual({ kind: 'paste', text: 'echo hi' });
    expect(pasteDecision('echo\thi', 'auto', false)).toEqual({ kind: 'paste', text: 'echo\thi' });
    expect(pasteDecision('a\nb', 'never', false)).toEqual({ kind: 'paste', text: 'a\nb' });
    expect(pasteDecision('a\x0fb', 'never', false)).toEqual({ kind: 'paste', text: 'a\x0fb' });
  });

  it('auto: asks for two lines with bracketed paste off, and not with it on', () => {
    expect(pasteDecision('a\nb', 'auto', false)).toEqual({ kind: 'ask', text: 'a\nb', lines: ['a', 'b'] });
    expect(pasteDecision('a\nb', 'auto', true)).toEqual({ kind: 'paste', text: 'a\nb' });
  });

  it('auto: drops a single final line break instead of asking, so a copied command does not run by itself', () => {
    expect(pasteDecision('npm test\n', 'auto', false)).toEqual({ kind: 'paste', text: 'npm test' });
    expect(pasteDecision('npm test\r\n  ', 'auto', false)).toEqual({ kind: 'paste', text: 'npm test' });
    expect(pasteDecision('npm test\n', 'auto', true)).toEqual({ kind: 'paste', text: 'npm test\n' });
    expect(pasteDecision('npm test\n', 'always', false)).toEqual({ kind: 'ask', text: 'npm test\n', lines: ['npm test', ''] });
  });

  it('counts a lone CR as a line break, since the pty takes it as Enter', () => {
    expect(pasteDecision('ls\rcurl x|sh\r', 'auto', false)).toEqual({ kind: 'ask', text: 'ls\rcurl x|sh\r', lines: ['ls', 'curl x|sh', ''] });
    expect(pasteDecision('a\r\nb\rc\nd', 'always', true)).toEqual({ kind: 'ask', text: 'a\r\nb\rc\nd', lines: ['a', 'b', 'c', 'd'] });
  });

  it('always: asks whenever there is a line break, bracketed paste or not', () => {
    expect(pasteDecision('a\nb', 'always', true)).toEqual({ kind: 'ask', text: 'a\nb', lines: ['a', 'b'] });
  });

  it('asks for one line carrying a control character a line editor would run, unless the shell brackets the paste', () => {
    expect(pasteDecision('curl x|sh\x0f', 'auto', false)).toEqual({ kind: 'ask', text: 'curl x|sh\x0f', lines: ['curl x|sh\x0f'] });
    expect(pasteDecision('a\x0fb', 'always', false)).toEqual({ kind: 'ask', text: 'a\x0fb', lines: ['a\x0fb'] });
    expect(pasteDecision('npm test\x0f\n', 'auto', false)).toEqual({ kind: 'ask', text: 'npm test\x0f', lines: ['npm test\x0f'] });
    for (const control of ['\x00', '\x03', '\x1b', '\x7f', '\x85', '\x9f']) expect(pasteDecision(`a${control}b`, 'auto', false).kind, JSON.stringify(control)).toBe('ask');
    expect(pasteDecision('a\x0fb', 'auto', true)).toEqual({ kind: 'paste', text: 'a\x0fb' });
    expect(pasteDecision('a\u00a0b\u202eb', 'auto', false)).toEqual({ kind: 'paste', text: 'a\u00a0b\u202eb' });
  });
});

describe('paste transforms', () => {
  it('Paste as One Line removes every line break form', () => {
    expect(pasteAsOneLine('a\r\nb\rc\nd')).toBe('abcd');
  });

  it('prepares the text as xterm does: line breaks become CR, bracketed when the shell asked for it', () => {
    expect(preparePaste('a\r\nb\nc\rd', false)).toBe('a\rb\rc\rd');
    expect(preparePaste('a\nb', true)).toBe('\x1b[200~a\rb\x1b[201~');
  });

  it('removes every ESC inside a bracketed paste, so no nesting ends the bracket early', () => {
    expect(preparePaste('x\x1b[201~rm -rf ~\n', true)).toBe('\x1b[200~x[201~rm -rf ~\r\x1b[201~');
    expect(preparePaste('x\x1b[20\x1b[201~1~y', true)).toBe('\x1b[200~x[20[201~1~y\x1b[201~');
    expect(preparePaste('\x1b[A', false)).toBe('\x1b[A');
  });

  it('splits data into host-sized pieces without splitting a surrogate pair', () => {
    expect(pasteChunks('')).toEqual([]);
    expect(pasteChunks('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(pasteChunks('abc😀d', 4)).toEqual(['abc', '😀d']);
    const big = 'x'.repeat(MAX_TERMINAL_INPUT_CHARS * 2 + 1);
    expect(pasteChunks(big).map((chunk) => chunk.length)).toEqual([MAX_TERMINAL_INPUT_CHARS, MAX_TERMINAL_INPUT_CHARS, 1]);
  });
});

describe('paste preview', () => {
  it('shows control, bidi, zero-width and separator characters as visible symbols', () => {
    expect(pastePreview(['a\tb\x1b[0m\x00\x7f'])).toEqual(['a\u2409b\u241b[0m\u2400\u2421']);
    expect(pastePreview(['evil\u202Etxt.exe', 'a\u200Bb\uFEFF', 'x\u2066y\u061C', 'c1\u0085', 'sep\u2028'])).toEqual([
      'evil<U+202E>txt.exe',
      'a<U+200B>b<U+FEFF>',
      'x<U+2066>y<U+061C>',
      'c1<U+0085>',
      'sep<U+2028>',
    ]);
  });

  it('bounds the line count and width by code point, with an ellipsis for more', () => {
    const lines = Array.from({ length: 9 }, (_, index) => `line ${index}`);
    expect(pastePreview(lines)).toEqual([...lines.slice(0, PREVIEW_LINES), '\u2026']);
    const wide = pastePreview(['😀'.repeat(100), `${'x'.repeat(PREVIEW_WIDTH - 1)}\u202E`]);
    expect(wide[0]).toBe(`${'😀'.repeat(PREVIEW_WIDTH / 2)}\u2026`);
    expect(wide[1]).toBe(`${'x'.repeat(PREVIEW_WIDTH - 1)}\u2026`);
    expect(PREVIEW_LINES + 1).toBeLessThanOrEqual(MAX_MESSAGE_PREVIEW_LINES);
    expect(PREVIEW_WIDTH + 1).toBeLessThanOrEqual(MAX_OVERLAY_LABEL_LENGTH);
  });
});

describe('pasteText', () => {
  const t = (message: string, ...args: Array<string | number>): string => message.replace('{0}', String(args[0]));
  function run(text: string, bracketed: boolean, answer: number | undefined, setting: 'auto' | 'always' | 'never' = 'auto') {
    const asked: MessageQuestion[] = [];
    const written: string[] = [];
    const done = pasteText(text, bracketed, {
      setting,
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(answer);
      },
      t,
      write: (data) => written.push(data),
    });
    return { asked, written, done };
  }

  it('asks with the line count, a preview and Paste / Paste as One Line / Cancel, in a dialog the overlay accepts', async () => {
    const paste = run('echo 1\necho 2\x1b', false, 0);
    await paste.done;
    expect(paste.asked).toEqual([{
      severity: 'warning',
      message: 'Paste 2 lines of text into the terminal?',
      preview: ['echo 1', 'echo 2\u241b'],
      actions: ['Paste', 'Paste as One Line'],
      cancelLabel: 'Cancel',
    }]);
    expect(parseMessageRequest({ kind: 'message', ...paste.asked[0] })).toBeDefined();
    expect(paste.written).toEqual(['echo 1\recho 2\x1b']);
  });

  it('asks about one line with a control character without Paste as One Line, and pastes it as dropped of its final break', async () => {
    const paste = run('npm test\x0f\n', false, 0);
    await paste.done;
    expect(paste.asked).toEqual([{
      severity: 'warning',
      message: 'Paste text with control characters into the terminal?',
      preview: ['npm test\u240f'],
      actions: ['Paste'],
      cancelLabel: 'Cancel',
    }]);
    expect(paste.written).toEqual(['npm test\x0f']);
  });

  it('Paste as One Line sends one line, and Cancel sends nothing', async () => {
    const oneLine = run('echo 1\necho 2', false, 1);
    await oneLine.done;
    expect(oneLine.written).toEqual(['echo 1echo 2']);
    const cancel = run('echo 1\necho 2', false, undefined);
    await cancel.done;
    expect(cancel.written).toEqual([]);
  });

  it('pastes without asking with bracketed paste on, wrapped, and ignores an empty clipboard', async () => {
    const bracketed = run('a\nb', true, undefined);
    await bracketed.done;
    expect(bracketed.asked).toEqual([]);
    expect(bracketed.written).toEqual(['\x1b[200~a\rb\x1b[201~']);
    const empty = run('', false, 0, 'always');
    await empty.done;
    expect(empty.written).toEqual([]);
  });
});
