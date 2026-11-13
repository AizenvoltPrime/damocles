import { describe, expect, it } from 'vitest';
import { isSafeAlias, SSH_UNSAFE } from '../ssh-alias';

describe('isSafeAlias', () => {
  it('takes an alias ssh reads as written and refuses an option, a user, a URI, a pattern or a control character', () => {
    for (const alias of ['prod-1', 'build.example.com', 'a'.repeat(255), 'prod_2', 'github_work']) expect(isSafeAlias(alias), alias).toBe(true);
    for (const alias of ['', '-oProxyCommand=x', 'a b', ' a', 'a*', 'a?', '!a', 'a\u0001', 'a\u200B', 'a'.repeat(256), 'bob@prod', 'ssh://prod:2200']) expect(isSafeAlias(alias), JSON.stringify(alias)).toBe(false);
  });

  it('refuses a line or paragraph separator, which a terminal would break the line at', () => {
    expect(isSafeAlias('a\u2028')).toBe(false);
    expect(isSafeAlias('a\u2029b')).toBe(false);
  });
});

describe('SSH_UNSAFE', () => {
  it('matches control, format and line or paragraph separator characters', () => {
    for (const text of ['a\u0000', 'a\u001b[0m', 'a\u007f', 'a\u0085', 'a\u200B', 'a\u202E', 'a\u2066', 'a\uFEFF', 'a\u2028', 'a\u2029']) expect(SSH_UNSAFE.test(text), JSON.stringify(text)).toBe(true);
  });

  it('leaves printable text alone, spaces and non-ASCII letters included', () => {
    for (const text of ['prod-1', 'a b', 'Ελλάδα', 'C:\\Users\\me', '"quoted"']) expect(SSH_UNSAFE.test(text), text).toBe(false);
  });

  it('keeps no state between tests, so several modules may share it', () => {
    expect(SSH_UNSAFE.global || SSH_UNSAFE.sticky).toBe(false);
    expect(SSH_UNSAFE.test('a\u0001')).toBe(true);
    expect(SSH_UNSAFE.test('a\u0001')).toBe(true);
  });
});
