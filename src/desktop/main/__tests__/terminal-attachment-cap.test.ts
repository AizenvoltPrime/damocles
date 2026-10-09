import { describe, expect, it } from 'vitest';
import { capTerminalText, MAX_TERMINAL_ATTACHMENT_CHARS, MAX_TERMINAL_ATTACHMENT_LINES } from '../../preload/terminal-attachment-cap';

describe('capTerminalText', () => {
  it('folds CRLF and CR, strips escape sequences and refused characters, and keeps \\n and \\t', () => {
    expect(capTerminalText('a\r\nb\rc')).toEqual({ text: 'a\nb\nc', omittedLines: 0 });
    expect(capTerminalText('\x1b[1;31mred\x1b[0m \x9b2Jx \x1b]8;;http://e\x07link\x1b]8;;\x1b\\ \x1bPq#0\x1b\\done\x1b7\x1b(B')).toEqual({ text: 'red x link done', omittedLines: 0 });
    expect(capTerminalText('a\tb\x07\x00\u0085\u202Eevil\u2066\u200B\u2028c 👩‍💻')).toEqual({ text: 'a\tbevilc 👩‍💻', omittedLines: 0 });
    expect(capTerminalText('unterminated \x1b]0;title')).toEqual({ text: 'unterminated ', omittedLines: 0 });
  });

  it('strips C1 strings with their payload: OSC, DCS, SOS, PM and APC, to ST, BEL or the end', () => {
    expect(capTerminalText('a\x9d8;;https://x\x9clink\x9d8;;\x9c b')).toEqual({ text: 'alink b', omittedLines: 0 });
    expect(capTerminalText('a\x9d0;title\x07b \x1b]0;mixed\x9cc')).toEqual({ text: 'ab c', omittedLines: 0 });
    expect(capTerminalText('a\x90q#0;1\x9cb\x98sos\x1b\\c\x9epm\x9cd\x9fapc\x9ce')).toEqual({ text: 'abcde', omittedLines: 0 });
    expect(capTerminalText('a\x1bPq\x9cb')).toEqual({ text: 'ab', omittedLines: 0 });
    expect(capTerminalText('unterminated \x9d0;title')).toEqual({ text: 'unterminated ', omittedLines: 0 });
    expect(capTerminalText('lone \x9cST')).toEqual({ text: 'lone ST', omittedLines: 0 });
  });

  it('keeps the last MAX_TERMINAL_ATTACHMENT_LINES lines', () => {
    const lines = Array.from({ length: MAX_TERMINAL_ATTACHMENT_LINES + 25 }, (_, index) => `line ${index}`);
    const capped = capTerminalText(lines.join('\n'));
    expect(capped.omittedLines).toBe(25);
    expect(capped.text.split('\n')).toEqual(lines.slice(25));
  });

  it('drops whole leading lines until MAX_TERMINAL_ATTACHMENT_CHARS remain', () => {
    const line = 'x'.repeat(999);
    const text = Array.from({ length: 100 }, () => line).join('\n');
    const capped = capTerminalText(text);
    expect(capped.text.length).toBeLessThanOrEqual(MAX_TERMINAL_ATTACHMENT_CHARS);
    expect(capped.text.split('\n').every((kept) => kept === line)).toBe(true);
    expect(capped.omittedLines).toBe(100 - Math.floor((MAX_TERMINAL_ATTACHMENT_CHARS + 1) / 1000));
    expect(capped.text.length).toBe((100 - capped.omittedLines) * 1000 - 1);
  });

  it('keeps the end of a single line longer than the cap, never starting inside a surrogate pair', () => {
    // the odd tail puts the cut inside a pair, whose low half goes
    const capped = capTerminalText(`head${'😀'.repeat(MAX_TERMINAL_ATTACHMENT_CHARS)}z`);
    expect(capped.omittedLines).toBe(0);
    expect(capped.text).toHaveLength(MAX_TERMINAL_ATTACHMENT_CHARS - 1);
    expect(capped.text.charCodeAt(0)).toBe(0xd83d);
    expect(capTerminalText(`a\n${'b'.repeat(MAX_TERMINAL_ATTACHMENT_CHARS + 10)}`)).toEqual({ text: 'b'.repeat(MAX_TERMINAL_ATTACHMENT_CHARS), omittedLines: 1 });
  });

  it('is idempotent, so main can apply it again to what the shell already cut', () => {
    const once = capTerminalText(`\x1b[2J${Array.from({ length: 3000 }, (_, index) => `${index}\r`).join('\n')}`);
    expect(capTerminalText(once.text)).toEqual({ text: once.text, omittedLines: 0 });
  });
});
