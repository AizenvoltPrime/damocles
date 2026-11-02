import { describe, expect, it } from 'vitest';
import { inputProblem, MAX_INPUT_VALUE_LENGTH, MAX_PORT_TARGET_HOST_LENGTH, parseLocalPort, parsePortTarget } from '../input-validation';
import { isRelativeFilePath } from '../relative-path';

const POSIX = { windows: false };
const code = (kind: Parameters<typeof inputProblem>[0], value: string): string | undefined => inputProblem(kind, value, POSIX)?.code;

describe('inputProblem', () => {
  it('accepts names git check-ref-format --branch accepts', () => {
    for (const name of ['main', 'feat/login', 'damocles/fix-login', 'v1.2', 'a-b_c', 'ü/ä', 'x@y', 'release/2024.1', 'a.b/c']) {
      expect(inputProblem('branchName', name, POSIX), name).toBeUndefined();
    }
  });

  it('names the ref-name rule a branch name breaks', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['a..b', 'doubleDot'],
      ['a\u0001b', 'control'],
      ['a\u007fb', 'control'],
      ['a\tb', 'control'],
      ['a b', 'space'],
      ['a~b', 'char'],
      ['a^b', 'char'],
      ['a:b', 'char'],
      ['a?b', 'char'],
      ['a*b', 'char'],
      ['a[b', 'char'],
      ['a\\b', 'char'],
      ['/a', 'slashEdge'],
      ['a/', 'slashEdge'],
      ['a//b', 'doubleSlash'],
      ['.a', 'dotPart'],
      ['a/.b', 'dotPart'],
      ['a.lock', 'lockPart'],
      ['a.lock/b', 'lockPart'],
      ['a.', 'trailingDot'],
      ['a@{b', 'atBrace'],
      ['@', 'at'],
      ['-a', 'leadingDash'],
    ];
    for (const [name, expected] of cases) expect(code('branchName', name), name).toBe(expected);
    expect(inputProblem('branchName', 'a[b', POSIX)).toEqual({ code: 'char', char: '[' });
  });

  it('checks a tag name by the ref-name rules, refusing a leading dash, and allows HEAD as a tag', () => {
    for (const name of ['v1.0', 'release/2024.1', 'x@y', 'HEAD']) expect(inputProblem('tagName', name, POSIX), name).toBeUndefined();
    const cases: Array<[string, string]> = [['-d', 'leadingDash'], ['a b', 'space'], ['a..b', 'doubleDot'], ['a.lock', 'lockPart'], ['a^{}', 'char'], ['', 'empty']];
    for (const [name, expected] of cases) expect(code('tagName', name), name).toBe(expected);
  });

  it('refuses HEAD as a branch name', () => {
    expect(code('branchName', 'HEAD')).toBe('head');
    expect(inputProblem('branchName', 'HEADS', POSIX)).toBeUndefined();
  });

  it('takes a relative, normalized path inside the repository', () => {
    for (const path of ['a.ts', 'src/a.ts', 'src/.env', 'a b/c d.txt', '..a/b..']) {
      expect(inputProblem('path', path, POSIX), path).toBeUndefined();
      expect(isRelativeFilePath(path), path).toBe(true);
    }
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['/etc/passwd', 'absolute'],
      ['C:/x', 'absolute'],
      ['c:x', 'absolute'],
      ['src\\a.ts', 'backslash'],
      ['../a.ts', 'outside'],
      ['src/../../a.ts', 'outside'],
      ['src/./a.ts', 'notNormalized'],
      ['src//a.ts', 'notNormalized'],
      ['src/', 'notNormalized'],
      ['a\u0000b', 'control'],
      ['a\nb', 'control'],
    ];
    for (const [path, expected] of cases) {
      expect(code('path', path), path).toBe(expected);
      expect(isRelativeFilePath(path) && expected !== 'control', path).toBe(false);
    }
  });

  it('flags a name Windows would resolve elsewhere only on Windows', () => {
    for (const path of ['src/con.ts', 'a/b.', 'a /b', 'src/a:b', 'NUL']) {
      expect(inputProblem('path', path, { windows: true }), path).toEqual({ code: 'windowsName' });
      expect(inputProblem('path', path, POSIX), path).toBeUndefined();
    }
    expect(inputProblem('path', 'src/console.ts', { windows: true })).toBeUndefined();
  });

  it('accepts a plain remote name and refuses one git could read as an option or a refspec', () => {
    for (const name of ['origin', 'up-stream', 'fork_2', 'a.b']) expect(code('remoteName', name), name).toBeUndefined();
    const cases: Array<[string, string]> = [['-x', 'leadingDash'], ['a b', 'space'], ['a	b', 'control'], ['+main', 'char'], ['.x', 'char'], ['a/b', 'char'], ['a..b', 'doubleDot'], ['x.lock', 'lockPart'], ['x.', 'trailingDot'], ['a'.repeat(101), 'tooLong'], ['', 'empty']];
    for (const [name, expected] of cases) expect(code('remoteName', name), name).toBe(expected);
  });

  it('bounds every kind', () => {
    expect(code('path', 'a'.repeat(MAX_INPUT_VALUE_LENGTH + 1))).toBe('tooLong');
    expect(code('branchName', 'a'.repeat(MAX_INPUT_VALUE_LENGTH + 1))).toBe('tooLong');
    expect(inputProblem('path', 'a'.repeat(MAX_INPUT_VALUE_LENGTH), POSIX)).toBeUndefined();
  });
});

describe('port inputs', () => {
  it('takes a port or host:port as VS Code parseAddress does, the port from 1 to 65535', () => {
    const cases: Array<[string, { host?: string; port: number }]> = [
      ['8080', { port: 8080 }],
      ['1', { port: 1 }],
      ['65535', { port: 65535 }],
      ['00080', { port: 80 }],
      ['db:5432', { host: 'db', port: 5432 }],
      ['localhost:5173', { host: 'localhost', port: 5173 }],
      ['10.0.0.5:9000', { host: '10.0.0.5', port: 9000 }],
      ['api_1.internal-net.example:443', { host: 'api_1.internal-net.example', port: 443 }],
    ];
    for (const [value, expected] of cases) {
      expect(parsePortTarget(value), value).toEqual(expected);
      expect(inputProblem('portTarget', value, POSIX), value).toBeUndefined();
    }
  });

  it('refuses a target with no port, a bad host or a port out of range, naming which', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['0', 'portRange'],
      ['65536', 'portRange'],
      ['000065535', 'portRange'],
      ['db:0', 'portRange'],
      ['db', 'portTarget'],
      ['db:', 'portTarget'],
      [':80', 'portTarget'],
      ['-1', 'portTarget'],
      ['+80', 'portTarget'],
      [' 80', 'portTarget'],
      ['80 ', 'portTarget'],
      ['8080.5', 'portTarget'],
      ['0x50', 'portTarget'],
      ['a..b:80', 'portTarget'],
      ['.a:80', 'portTarget'],
      ['a.:80', 'portTarget'],
      ['user@db:80', 'portTarget'],
      ['http://db:80', 'portTarget'],
      ['[::1]:80', 'portTarget'],
      ['db:80/x', 'portTarget'],
      ['db:80:81', 'portTarget'],
      ['d b:80', 'portTarget'],
      ['db\n:80', 'portTarget'],
      ['８０', 'portTarget'],
      [`${'a'.repeat(MAX_PORT_TARGET_HOST_LENGTH + 1)}:80`, 'portTarget'],
      // the daemon refuses an option-like host, which would end the connection
      ['-db:5432', 'portTarget'],
      ['--proxy:80', 'portTarget'],
      ['db.-x:80', 'portTarget'],
    ];
    for (const [value, expected] of cases) {
      expect(code('portTarget', value), JSON.stringify(value)).toBe(expected);
      expect(parsePortTarget(value), JSON.stringify(value)).toBeUndefined();
    }
    expect(parsePortTarget(`${'a'.repeat(MAX_PORT_TARGET_HOST_LENGTH)}:80`)).toEqual({ host: 'a'.repeat(MAX_PORT_TARGET_HOST_LENGTH), port: 80 });
  });

  it('checks a long hostile target in linear time', () => {
    const value = `${'a.'.repeat(2000)}!`;
    const started = performance.now();
    expect(code('portTarget', value)).toBe('portTarget');
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('takes a local port of digits only, 1 to 65535', () => {
    for (const [value, port] of [['9100', 9100], ['1', 1], ['65535', 65535], ['05174', 5174]] as const) {
      expect(parseLocalPort(value), value).toBe(port);
      expect(inputProblem('localPort', value, POSIX), value).toBeUndefined();
    }
    const cases: Array<[string, string]> = [['', 'empty'], ['0', 'portRange'], ['65536', 'portRange'], ['99999999', 'portRange'], ['-1', 'portDigits'], ['9100 ', 'portDigits'], ['91a', 'portDigits'], ['1e3', 'portDigits'], ['localhost:9100', 'portDigits'], ['٩١٠٠', 'portDigits']];
    for (const [value, expected] of cases) {
      expect(code('localPort', value), JSON.stringify(value)).toBe(expected);
      expect(parseLocalPort(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});
