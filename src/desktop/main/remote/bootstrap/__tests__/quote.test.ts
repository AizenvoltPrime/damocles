import { describe, expect, it } from 'vitest';
import { psQuote, shellQuote, StageParameterError } from '../quote';
import { powerShell, runPowerShell, runSh } from './shells';

// spaces, both quotes, $ and backticks, a backslash, PowerShell's typographic quotes, glob and option characters, non-ASCII
const VALUES = [
  '/srv/my app',
  "it's",
  "''",
  '"quoted"',
  '$HOME $(id) ${PATH}',
  '`id` `$x`',
  'back\\slash\\',
  '\u2018left\u2019 \u201alow\u201b',
  '* ? [a] -n --',
  'na\u00efve \u2713 \u65e5\u672c',
  '',
];

describe('shellQuote', () => {
  it('round-trips every value through a real sh as one literal word', async () => {
    const script = VALUES.map((value) => `printf '%s\\n' ${shellQuote(value)}`).join('\n');
    const { exit, stdout } = await runSh(script);
    expect(exit?.code).toBe(0);
    expect(stdout.toString('utf8').split('\n').slice(0, -1)).toEqual(VALUES);
  });

  it('writes a single quote as close, escaped quote, reopen', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it('refuses a newline, a carriage return and a NUL before any stage text exists', () => {
    for (const value of ['a\nb', 'a\rb', 'a\0b']) expect(() => shellQuote(value)).toThrow(StageParameterError);
  });
});

describe('psQuote', async () => {
  const shell = await powerShell();

  it.skipIf(shell === undefined)('round-trips every value through a real PowerShell as one literal string', async () => {
    const script = [
      '$out = [Console]::OpenStandardOutput()',
      ...VALUES.map((value) => `$b = [Text.Encoding]::UTF8.GetBytes(${psQuote(value)} + [char]10); $out.Write($b, 0, $b.Length)`),
    ].join('\n');
    const { exit, stdout, stderr } = await runPowerShell(shell!, script);
    expect(stderr.toString('utf8')).toBe('');
    expect(exit?.code).toBe(0);
    expect(stdout.toString('utf8').split('\n').slice(0, -1)).toEqual(VALUES);
  });

  it('doubles every quote PowerShell ends a single-quoted string at', () => {
    expect(psQuote("a'b\u2019c")).toBe("'a''b\u2019\u2019c'");
  });

  it('refuses a newline, a carriage return and a NUL', () => {
    for (const value of ['a\nb', 'a\rb', 'a\0b']) expect(() => psQuote(value)).toThrow(StageParameterError);
  });
});
