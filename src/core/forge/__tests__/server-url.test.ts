import { describe, expect, it } from 'vitest';
import { flavorOf, parseGitHost, parseServerUrl, serverUrlProblemText, type ServerUrlProblem } from '../server-url';

const ok = (input: string): string => {
  const parsed = parseServerUrl(input);
  if (!parsed.ok) throw new Error(`refused ${input}: ${parsed.problem}`);
  return parsed.url.id;
};

describe('parseServerUrl', () => {
  it.each([
    ['https://gitlab.indigital.gr', 'gitlab.indigital.gr'],
    ['https://GitLab.Indigital.GR/', 'gitlab.indigital.gr'],
    ['gitlab.indigital.gr', 'gitlab.indigital.gr'],
    ['  https://gitlab.indigital.gr//  ', 'gitlab.indigital.gr'],
    ['https://gitlab.indigital.gr:443', 'gitlab.indigital.gr'],
    ['https://gitlab.indigital.gr:8443/', 'gitlab.indigital.gr:8443'],
    ['https://example.com/gitlab/', 'example.com/gitlab'],
    ['https://example.com/a/b', 'example.com/a/b'],
    ['https://bücher.example', 'xn--bcher-kva.example'],
    ['https://10.0.0.5', '10.0.0.5'],
    ['https://[::1]:8443', '[::1]:8443'],
  ])('takes %s as %s', (input, id) => {
    expect(ok(input)).toBe(id);
  });

  it.each<[string, ServerUrlProblem]>([
    ['', 'empty'],
    ['   ', 'empty'],
    ['http://gitlab.example.com', 'notHttps'],
    ['ssh://git@gitlab.example.com', 'notHttps'],
    ['https://user:pass@gitlab.example.com', 'userinfo'],
    ['https://user@gitlab.example.com', 'userinfo'],
    ['https://gitlab.example.com/?x=1', 'query'],
    ['https://gitlab.example.com/?', 'query'],
    ['https://gitlab.example.com/#top', 'fragment'],
    ['https://gitlab .example.com', 'whitespace'],
    ['https://gitlab.example.com/\u0007', 'whitespace'],
    ['https://gitlab.example.com\\gitlab', 'invalid'],
    ['https://gitlab.example.com/a/../b', 'path'],
    ['https://gitlab.example.com/a/%2e%2e', 'path'],
    ['https://gitlab.example.com/a b', 'whitespace'],
    ['https://-bad-.example.com', 'invalid'],
    ['https://', 'invalid'],
  ])('refuses %j as %s', (input, problem) => {
    expect(parseServerUrl(input)).toEqual({ ok: false, problem });
  });

  it('names the fix for every refusal', () => {
    for (const problem of ['empty', 'notHttps', 'userinfo', 'query', 'fragment', 'whitespace', 'invalid', 'path', 'githubPath', 'builtIn'] as const) {
      expect(serverUrlProblemText(problem).message.length).toBeGreaterThan(10);
    }
    expect(serverUrlProblemText('notHttps').message).toContain('https://');
  });
});

describe('flavorOf', () => {
  const url = (input: string) => {
    const parsed = parseServerUrl(input);
    if (!parsed.ok) throw new Error(input);
    return parsed.url;
  };

  it('tells GHES, a ghe.com tenant and self-managed GitLab apart', () => {
    expect(flavorOf('github', url('https://github.indigital.gr'))).toEqual({ ok: true, flavor: 'ghes' });
    expect(flavorOf('github', url('https://octo.ghe.com'))).toEqual({ ok: true, flavor: 'ghe.com' });
    expect(flavorOf('gitlab', url('https://gitlab.indigital.gr'))).toEqual({ ok: true, flavor: 'gitlab' });
    expect(flavorOf('gitlab', url('https://gitlab.com/group'))).toEqual({ ok: true, flavor: 'gitlab' });
  });

  it('refuses the built-in hosts and a GitHub URL with a path', () => {
    expect(flavorOf('github', url('https://github.com'))).toEqual({ ok: false, problem: 'builtIn' });
    expect(flavorOf('github', url('https://api.github.com'))).toEqual({ ok: false, problem: 'builtIn' });
    expect(flavorOf('gitlab', url('https://gitlab.com'))).toEqual({ ok: false, problem: 'builtIn' });
    expect(flavorOf('github', url('https://github.example.com/ghes'))).toEqual({ ok: false, problem: 'githubPath' });
  });

  it('treats a ghe.com host with a port as GHES, which has no API subdomain', () => {
    expect(flavorOf('github', url('https://octo.ghe.com:8443'))).toEqual({ ok: true, flavor: 'ghes' });
  });
});

describe('parseGitHost', () => {
  it('takes host names and ports, lowercase, and refuses paths, userinfo and spaces', () => {
    expect(parseGitHost(' Git.Indigital.GR ')).toBe('git.indigital.gr');
    expect(parseGitHost('git.example.com:8443')).toBe('git.example.com:8443');
    expect(parseGitHost('git.example.com/x')).toBeUndefined();
    expect(parseGitHost('user@git.example.com')).toBeUndefined();
    expect(parseGitHost('git example.com')).toBeUndefined();
    expect(parseGitHost('')).toBeUndefined();
  });
});
