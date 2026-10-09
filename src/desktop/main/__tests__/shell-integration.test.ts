import { describe, expect, it } from 'vitest';
import { MAX_SHELL_SEQUENCE_CHARS, MAX_TERMINAL_CWD_CHARS, MAX_TERMINAL_TITLE_CHARS } from '../../preload/terminal-channels';
import { cwdFolderName, deserializeShellValue, newShellNonce, Osc633Stream, parseShellCwd, parseShellSequence, sanitizeTitle } from '../terminal/shell-integration';

const NONCE = '0123456789abcdef0123456789abcdef';

// Feeds the chunks through one stream and returns what it forwarded, the sequences' fields and the stripped count.
function run(...chunks: string[]): { data: string; fields: string[][]; offsets: number[]; stripped: number } {
  const stream = new Osc633Stream();
  let data = '';
  const fields: string[][] = [];
  const offsets: number[] = [];
  let stripped = 0;
  for (const chunk of chunks) {
    const parsed = stream.push(chunk);
    for (const sequence of parsed.sequences) {
      fields.push([...sequence.fields]);
      offsets.push(data.length + sequence.offset);
    }
    data += parsed.data;
    stripped += parsed.stripped;
  }
  return { data, fields, offsets, stripped };
}

describe('Osc633Stream', () => {
  it('removes BEL and ESC \\ terminated sequences and reports each at its offset in the forwarded text', () => {
    const result = run(`ab\x1b]633;A;${NONCE}\x07cd\x1b]633;E;ls;${NONCE}\x1b\\ef`);
    expect(result.data).toBe('abcdef');
    expect(result.fields).toEqual([['A', NONCE], ['E', 'ls', NONCE]]);
    expect(result.offsets).toEqual([2, 4]);
    expect(result.stripped).toBe(`\x1b]633;A;${NONCE}\x07`.length + `\x1b]633;E;ls;${NONCE}\x1b\\`.length);
  });

  it('gives the same result for every split of the input into two chunks', () => {
    const input = `x\x1b]0;title\x07y\x1b]633;D;0;${NONCE}\x1b\\z\x1b[31mred\x1b]633;P;Cwd=/a;${NONCE}\x07!`;
    const whole = run(input);
    expect(whole.data).toBe('x\x1b]0;title\x07yz\x1b[31mred!');
    for (let cut = 0; cut <= input.length; cut++) {
      const split = run(input.slice(0, cut), input.slice(cut));
      expect(split, `cut at ${cut}`).toEqual(whole);
    }
  });

  it('forwards every other OSC, CSI and lone ESC untouched, holding only a possible 633 introducer', () => {
    expect(run('\x1b]8;;http://x\x07link\x1b]8;;\x07').data).toBe('\x1b]8;;http://x\x07link\x1b]8;;\x07');
    expect(run('\x1b]6330;x\x07', '').data).toBe('\x1b]6330;x\x07');
    expect(run('\x1b]63x').data).toBe('\x1b]63x');
    const held = new Osc633Stream();
    expect(held.push('a\x1b]63').data).toBe('a');
    expect(held.push('2;x\x07').data).toBe('\x1b]632;x\x07');
    expect(run('\x1b').data).toBe('');
    expect(run('\x1b', 'x').data).toBe('\x1bx');
  });

  it('strips the forms xterm also reads as 633: leading zeros and the C1 introducer', () => {
    expect(run(`a\x1b]0633;A;${NONCE}\x07b\x9d633;B;${NONCE}\x07c`)).toMatchObject({ data: 'abc', fields: [['A', NONCE], ['B', NONCE]] });
  });

  it('never ends a sequence at C1 ST, and aborts one at ESC, CAN or SUB without trusting it', () => {
    expect(run(`\x1b]633;E;a\x9c\x1b]633;A;${NONCE}\x07z`)).toMatchObject({ data: 'z', fields: [['A', NONCE]] });
    expect(run(`\x1b]633;E;evil\x1b[31mred`)).toMatchObject({ data: '\x1b[31mred', fields: [] });
    expect(run(`\x1b]633;E;evil\x18after`)).toMatchObject({ data: 'after', fields: [] });
    expect(run(`\x1b]633;E;evil\x1aafter`)).toMatchObject({ data: 'after', fields: [] });
  });

  it('drops a sequence holding a raw C0 control or DEL, which the scripts always escape, and leaves a raw C1 one to its field', () => {
    expect(run(`\x1b]633;E;a\rb;${NONCE}\x07ok`)).toMatchObject({ data: 'ok', fields: [] });
    expect(run(`\x1b]633;E;a\x7fb;${NONCE}\x07ok`)).toMatchObject({ data: 'ok', fields: [] });
    expect(run(`\x1b]633;P;Cwd=/a\x85b;${NONCE}\x07ok`)).toMatchObject({ data: 'ok', fields: [['P', 'Cwd=/a\x85b', NONCE]] });
    expect(parseShellSequence(['P', 'Cwd=/a\x85b', NONCE], NONCE, 'posix')).toEqual({ type: 'cwd', cwd: null });
    expect(run(`\x1b]633\x07ok`)).toMatchObject({ data: 'ok', fields: [] });
  });

  it('strips an ident of leading zeros longer than xterm would still read as 633, through its end', () => {
    const zeros = '0'.repeat(40);
    expect(run(`a\x1b]${zeros}633;E;x;${NONCE}\x07b`)).toMatchObject({ data: 'ab', fields: [] });
    expect(run(`a\x1b]${'0'.repeat(10)}633;A;${NONCE}\x07b`)).toMatchObject({ data: 'ab', fields: [['A', NONCE]] });
    const split = run(`a\x1b]${zeros.slice(0, 9)}`, `${zeros.slice(9)}633;E;x\x07b`);
    expect(split).toMatchObject({ data: 'ab', fields: [] });
    expect(split.stripped).toBe(2 + zeros.length + 'E;x'.length + 4 + 1);
  });

  it('drops a sequence longer than MAX_SHELL_SEQUENCE_CHARS whole, through its end, counting every character stripped', () => {
    const body = `E;${'x'.repeat(MAX_SHELL_SEQUENCE_CHARS)};${NONCE}`;
    const result = run(`a\x1b]633;${body.slice(0, 5000)}`, body.slice(5000), `\x07b\x1b]633;A;${NONCE}\x07c`);
    expect(result).toMatchObject({ data: 'abc', fields: [['A', NONCE]] });
    expect(result.stripped + result.data.length).toBe(1 + `\x1b]633;${body}\x07`.length + 1 + `\x1b]633;A;${NONCE}\x07`.length + 1);
    const exact = `E;${'y'.repeat(MAX_SHELL_SEQUENCE_CHARS - 2)}`;
    expect(run(`\x1b]633;${exact}\x07`).fields).toEqual([exact.split(';')]);
    expect(run(`\x1b]633;${exact}z\x07`).fields).toEqual([]);
  });

  it('counts a long unterminated body as stripped while it streams, so flow control never waits on it', () => {
    const stream = new Osc633Stream();
    expect(stream.push(`\x1b]633;E;${'x'.repeat(100_000)}`).stripped).toBe(`\x1b]633;E;${'x'.repeat(100_000)}`.length);
    expect(stream.push('y'.repeat(50_000)).stripped).toBe(50_000);
  });
});

describe('parseShellSequence', () => {
  it('trusts each type only with the nonce last and its exact field count', () => {
    expect(parseShellSequence(['A', NONCE], NONCE, 'win32')).toEqual({ type: 'promptStart' });
    expect(parseShellSequence(['B', NONCE], NONCE, 'win32')).toEqual({ type: 'commandStart' });
    expect(parseShellSequence(['C', NONCE], NONCE, 'win32')).toEqual({ type: 'commandExecuted' });
    expect(parseShellSequence(['D', '', NONCE], NONCE, 'win32')).toEqual({ type: 'commandFinished', exitCode: null });
    expect(parseShellSequence(['D', '127', NONCE], NONCE, 'win32')).toEqual({ type: 'commandFinished', exitCode: 127 });
    expect(parseShellSequence(['E', 'git status', NONCE], NONCE, 'win32')).toEqual({ type: 'commandLine', commandLine: 'git status' });
    for (const fields of [
      ['A'], ['A', ''], ['A', NONCE.toUpperCase()], ['A', `${NONCE}0`], ['A', 'x', NONCE], ['C', NONCE, NONCE], ['D', NONCE], ['D', '0', '0', NONCE],
      ['E', NONCE], ['E', 'ls'], ['E', 'ls', NONCE, NONCE], ['P', 'Cwd=/a'], ['P', 'Prompt=x', NONCE], ['F', NONCE], ['X', 'y', NONCE],
    ]) expect(parseShellSequence(fields, NONCE, 'posix'), fields.join(';')).toBeUndefined();
  });

  it('reads exit codes strictly', () => {
    for (const code of ['-1', '0', '4294967295', '-2147483648']) expect(parseShellSequence(['D', code, NONCE], NONCE, 'win32')).toEqual({ type: 'commandFinished', exitCode: Number(code) });
    for (const code of ['0x10', '1e3', ' 1', '1 ', '+1', '4294967296', '-2147483649', '12345678901', '1.5', 'NaN']) {
      expect(parseShellSequence(['D', code, NONCE], NONCE, 'win32'), code).toBeUndefined();
    }
  });

  it('unescapes the command line as VS Code does and keeps only \\n and \\t among controls', () => {
    expect(parseShellSequence(['E', 'a\\\\b\\x3bc\\x0ad\\x09e\\q', NONCE], NONCE, 'win32')).toEqual({ type: 'commandLine', commandLine: 'a\\b;c\nd\te\\q' });
    for (const value of ['\\x1b[31m', '\\x07', '\\x00', 'a\u202Eb', 'a\u2066b', 'a\u200Bb', 'a\u2028b', 'a\u0085b', 'a\u009bb']) expect(parseShellSequence(['E', value, NONCE], NONCE, 'win32'), value).toBeUndefined();
  });

  it('maps and validates the working directory per path style', () => {
    expect(parseShellSequence(['P', 'Cwd=C:\\x5cwork\\x5c..\\x5capp', NONCE], NONCE, 'win32')).toEqual({ type: 'cwd', cwd: 'C:\\app' });
    expect(parseShellSequence(['P', 'Cwd=/home/me', NONCE], NONCE, 'win32')).toEqual({ type: 'cwd', cwd: null });
  });
});

describe('parseShellCwd', () => {
  it('accepts absolute paths in the shell\'s style, normalized', () => {
    expect(parseShellCwd('C:/Users/me/My Project/src', 'win32')).toBe('C:\\Users\\me\\My Project\\src');
    expect(parseShellCwd('c:\\work\\.\\a\\..\\b', 'win32')).toBe('c:\\work\\b');
    expect(parseShellCwd('/home/me/../you/Δοκιμή', 'posix')).toBe('/home/you/Δοκιμή');
    expect(parseShellCwd('/mnt/d/work/app', 'wsl')).toBe('D:\\work\\app');
    expect(parseShellCwd('/mnt/c', 'wsl')).toBe('C:\\');
  });

  it('refuses relative, UNC, device, drive-relative, foreign-style, oversized and control-laden paths', () => {
    for (const [value, style] of [
      ['src', 'win32'], ['C:relative', 'win32'], ['\\\\server\\share', 'win32'], ['//server/share', 'win32'], ['\\\\?\\C:\\x', 'win32'], ['\\\\.\\pipe\\x', 'win32'],
      ['/c/Users', 'win32'], ['relative/dir', 'posix'], ['C:\\x', 'posix'], ['/home/me', 'wsl'], ['/mnt/cd/x', 'wsl'], ['', 'posix'],
      ['/a\nb', 'posix'], ['/a\u202Eb', 'posix'], ['C:\\a\x00b', 'win32'], [`/${'a'.repeat(MAX_TERMINAL_CWD_CHARS)}`, 'posix'],
    ] as const) expect(parseShellCwd(value, style), `${style} ${value.slice(0, 40)}`).toBeNull();
    expect(parseShellCwd(`/${'a'.repeat(MAX_TERMINAL_CWD_CHARS - 1)}`, 'posix')).not.toBeNull();
  });
});

describe('titles', () => {
  it('keeps the first line, removes control, bidi and format characters, collapses whitespace and cuts with an ellipsis', () => {
    expect(sanitizeTitle('npm   test\nsecond')).toBe('npm test');
    expect(sanitizeTitle('evil\u202Etxt.exe\u2066 \u200B\x1b[2J\u0085')).toBe('eviltxt.exe [2J');
    expect(sanitizeTitle('\tvim\tfile ')).toBe('vim file');
    expect(sanitizeTitle('👩‍💻 run')).toBe('👩‍💻 run');
    expect(sanitizeTitle(' \u200E ')).toBeNull();
    const long = sanitizeTitle('y'.repeat(500))!;
    expect(long).toHaveLength(MAX_TERMINAL_TITLE_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(sanitizeTitle(`${'y'.repeat(MAX_TERMINAL_TITLE_CHARS - 2)}😀😀`)).toBe(`${'y'.repeat(MAX_TERMINAL_TITLE_CHARS - 2)}…`);
    expect(sanitizeTitle('z'.repeat(MAX_TERMINAL_TITLE_CHARS))).toBe('z'.repeat(MAX_TERMINAL_TITLE_CHARS));
  });

  it('describes a terminal by its folder only when it left the project folder', () => {
    expect(cwdFolderName('C:\\work\\alpha', 'c:\\Work\\Alpha\\', 'win32')).toBeNull();
    expect(cwdFolderName('C:\\work\\alpha\\src', 'C:\\work\\alpha', 'win32')).toBe('src');
    expect(cwdFolderName('C:\\', 'C:\\work\\alpha', 'win32')).toBe('C:\\');
    expect(cwdFolderName('/work/Alpha', '/work/alpha', 'posix')).toBe('Alpha');
  });
});

describe('deserializeShellValue and the nonce', () => {
  it('decodes only \\\\ and \\xAB', () => {
    expect(deserializeShellValue('\\\\x41\\x41\\X41\\x4g\\n')).toBe('\\x41AA\\x4g\\n');
  });

  it('draws 128 random bits per call', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newShellNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });
});
