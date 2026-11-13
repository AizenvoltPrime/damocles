import { describe, expect, it } from 'vitest';
import type { ForgeKind } from '../../../shared/forge/accounts';
import type { RemoteEndpoint } from '../../../shared/forge/bindings';
import { buildLink, encodedPath, lineAnchor, linkUrl, type LinkServer } from '../links';

const server = (id: string, kind: ForgeKind, gitHosts: readonly string[] = [id.split('/')[0]!]): LinkServer => ({ id, kind, webUrl: `https://${id}`, record: { gitHosts } });
const INDIGITAL = server('gitlab.indigital.gr', 'gitlab', ['gitlab.indigital.gr', 'git.indigital.gr']);
const GITHUB = server('github.com', 'github', ['github.com', 'ssh.github.com']);
const PREFIXED = server('code.example.com/gitlab', 'gitlab');
const SHA = '3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a';
const SHA256 = 'a'.repeat(64);

const https = (remote: string, host: string, path: string): RemoteEndpoint => ({ remote, fetch: { protocol: 'https', host, path, aliasResolved: false } });
const ssh = (remote: string, host: string, path: string): RemoteEndpoint => ({ remote, fetch: { protocol: 'ssh', host, path, aliasResolved: true } });

describe('links on GitLab', () => {
  it('copies lines 3-7 of src/a.ts as https://gitlab.indigital.gr/grp/proj/-/blob/<sha>/src/a.ts#L3-7', () => {
    const outcome = buildLink([INDIGITAL], { endpoints: [https('origin', 'gitlab.indigital.gr', 'grp/proj.git')] }, { kind: 'file', sha: SHA, path: 'src/a.ts', range: { start: 3, end: 7 } });
    expect(outcome).toEqual({ ok: true, url: `https://gitlab.indigital.gr/grp/proj/-/blob/${SHA}/src/a.ts#L3-7`, server: INDIGITAL, remote: 'origin' });
  });

  it('keeps a rendered file\'s line anchor as GitLab builds it', () => {
    const outcome = buildLink([INDIGITAL], { endpoints: [https('origin', 'gitlab.indigital.gr', 'grp/proj.git')] }, { kind: 'file', sha: SHA, path: 'README.md', range: { start: 3, end: 7 } });
    expect(outcome).toMatchObject({ url: `https://gitlab.indigital.gr/grp/proj/-/blob/${SHA}/README.md#L3-7` });
  });

  it('maps a remote on a git host other than the web host, and builds the commit link', () => {
    const outcome = buildLink([INDIGITAL], { endpoints: [ssh('origin', 'git.indigital.gr', 'grp/sub/proj.git')] }, { kind: 'commit', sha: SHA });
    expect(outcome).toMatchObject({ ok: true, url: `https://gitlab.indigital.gr/grp/sub/proj/-/commit/${SHA}` });
  });

  it('keeps a path prefix, a single line and a whole file', () => {
    const endpoints = [https('origin', 'code.example.com', 'gitlab/grp/proj.git')];
    expect(buildLink([PREFIXED], { endpoints }, { kind: 'file', sha: SHA, path: 'a.ts', range: { start: 9, end: 9 } })).toMatchObject({ url: `https://code.example.com/gitlab/grp/proj/-/blob/${SHA}/a.ts#L9` });
    expect(buildLink([PREFIXED], { endpoints }, { kind: 'file', sha: SHA, path: 'a.ts' })).toMatchObject({ url: `https://code.example.com/gitlab/grp/proj/-/blob/${SHA}/a.ts` });
  });
});

describe('links on GitHub', () => {
  it('builds blob/<sha>/<path>#L<a>-L<b>, #L<a> and /commit/<sha>', () => {
    const repo = { endpoints: [ssh('origin', 'github.com', 'octo/app.git')] };
    expect(buildLink([GITHUB], repo, { kind: 'file', sha: SHA, path: 'src/a.ts', range: { start: 3, end: 7 } })).toMatchObject({ url: `https://github.com/octo/app/blob/${SHA}/src/a.ts#L3-L7` });
    expect(buildLink([GITHUB], repo, { kind: 'file', sha: SHA, path: 'src/a.ts', range: { start: 4, end: 4 } })).toMatchObject({ url: `https://github.com/octo/app/blob/${SHA}/src/a.ts#L4` });
    expect(buildLink([GITHUB], repo, { kind: 'commit', sha: SHA256 })).toMatchObject({ url: `https://github.com/octo/app/commit/${SHA256}` });
  });

  it('uses the tracking remote, then origin, then the first remote on a managed server, and names that remote', () => {
    const endpoints = [https('fork', 'github.com', 'me/app'), https('origin', 'github.com', 'octo/app'), https('upstream', 'github.com', 'org/app')];
    expect(buildLink([GITHUB], { endpoints, pushRemote: 'upstream' }, { kind: 'commit', sha: SHA })).toMatchObject({ url: `https://github.com/org/app/commit/${SHA}`, remote: 'upstream' });
    expect(buildLink([GITHUB], { endpoints }, { kind: 'commit', sha: SHA })).toMatchObject({ url: `https://github.com/octo/app/commit/${SHA}`, remote: 'origin' });
    expect(buildLink([GITHUB], { endpoints: [https('other', 'gitlab.example.com', 'x/y'), endpoints[0]!] }, { kind: 'commit', sha: SHA })).toMatchObject({ url: `https://github.com/me/app/commit/${SHA}`, remote: 'fork' });
  });

  it('in a fork clone, links files and commits on the fork and references on the repository it came from', () => {
    // origin is the user's fork, upstream the organization's repository, and the branch tracks origin
    const repo = { endpoints: [ssh('origin', 'github.com', 'me/app.git'), https('upstream', 'github.com', 'org/app.git')], pushRemote: 'origin' };
    expect(buildLink([GITHUB], repo, { kind: 'file', sha: SHA, path: 'src/a.ts' })).toMatchObject({ url: `https://github.com/me/app/blob/${SHA}/src/a.ts`, remote: 'origin' });
    expect(buildLink([GITHUB], repo, { kind: 'commit', sha: SHA })).toMatchObject({ url: `https://github.com/me/app/commit/${SHA}` });
    expect(buildLink([GITHUB], repo, { kind: 'reference', reference: { sigil: '#', number: 123 } })).toMatchObject({ url: 'https://github.com/org/app/issues/123', remote: 'upstream' });
    // with no upstream, references fall back to origin
    expect(buildLink([GITHUB], { endpoints: [repo.endpoints[0]!] }, { kind: 'reference', reference: { sigil: '#', number: 123 } })).toMatchObject({ url: 'https://github.com/me/app/issues/123' });
  });

  it.each([
    ['README.md', true], ['docs/guide.MARKDOWN', true], ['notes.rst', true], ['book.adoc', true], ['analysis.ipynb', true],
    ['src/a.ts', false], ['md', false], ['.md', false],
  ])('adds ?plain=1 before the line anchor of %s only when GitHub renders it', (path, rendered) => {
    const repo = { endpoints: [ssh('origin', 'github.com', 'octo/app.git')] };
    const url = `https://github.com/octo/app/blob/${SHA}/${path}${rendered ? '?plain=1' : ''}#L3-L7`;
    expect(buildLink([GITHUB], repo, { kind: 'file', sha: SHA, path, range: { start: 3, end: 7 } })).toMatchObject({ url });
    // a whole file has no anchor, and shows rendered
    expect(buildLink([GITHUB], repo, { kind: 'file', sha: SHA, path })).toMatchObject({ url: `https://github.com/octo/app/blob/${SHA}/${path}` });
  });
});

describe('path encoding', () => {
  it.each([
    ['docs/my file.txt', 'docs/my%20file.txt'],
    ['a#b/c?d.ts', 'a%23b/c%3Fd.ts'],
    ['src/ελληνικά/ü.ts', 'src/%CE%B5%CE%BB%CE%BB%CE%B7%CE%BD%CE%B9%CE%BA%CE%AC/%C3%BC.ts'],
    ['100%/x&y=z.txt', '100%25/x%26y%3Dz.txt'],
  ])('encodes each segment of %s', (path, encoded) => {
    expect(encodedPath(path)).toBe(encoded);
    expect(linkUrl(GITHUB, 'octo/app', { kind: 'file', sha: SHA, path, range: { start: 1, end: 2 } })).toBe(`https://github.com/octo/app/blob/${SHA}/${encoded}#L1-L2`);
  });

  it.each(['', '/abs.ts', 'a//b.ts', 'a/../../etc/passwd', './a.ts', 'a/', '\ud800.ts'])('refuses %j', (path) => {
    expect(encodedPath(path)).toBeUndefined();
    expect(buildLink([GITHUB], { endpoints: [https('origin', 'github.com', 'octo/app')] }, { kind: 'file', sha: SHA, path })).toEqual({ ok: false, reason: 'target' });
  });
});

describe('what links refuse', () => {
  const repo = { endpoints: [https('origin', 'gitlab.indigital.gr', 'grp/proj')] };

  it('builds nothing for a remote on a server that is not registered', () => {
    expect(buildLink([GITHUB], repo, { kind: 'commit', sha: SHA })).toEqual({ ok: false, reason: 'noServer' });
    expect(buildLink([], repo, { kind: 'commit', sha: SHA })).toEqual({ ok: false, reason: 'noServer' });
    // a look-alike host is another origin
    expect(buildLink([INDIGITAL], { endpoints: [https('origin', 'gitlab.indigital.gr.evil.example', 'grp/proj')] }, { kind: 'commit', sha: SHA })).toEqual({ ok: false, reason: 'noServer' });
  });

  it.each(['3f2a9c1', SHA.toUpperCase(), `${SHA}0`, 'HEAD', '--output=x', `${SHA.slice(0, 39)}g`])('refuses the commit id %s', (sha) => {
    expect(buildLink([INDIGITAL], repo, { kind: 'commit', sha })).toEqual({ ok: false, reason: 'target' });
  });

  it.each([[0, 3], [3, 2], [1.5, 2], [-1, 4], [Number.NaN, 1]])('refuses lines %d-%d', (start, end) => {
    expect(lineAnchor('gitlab', { start, end })).toBeUndefined();
    expect(buildLink([INDIGITAL], repo, { kind: 'file', sha: SHA, path: 'a.ts', range: { start, end } })).toEqual({ ok: false, reason: 'target' });
  });

  it('refuses a repository path with characters a link must not carry', () => {
    expect(buildLink([GITHUB], { endpoints: [https('origin', 'github.com', 'octo/a%2F..')] }, { kind: 'commit', sha: SHA })).toMatchObject({ ok: false });
    expect(buildLink([INDIGITAL], { endpoints: [https('origin', 'gitlab.indigital.gr', 'grp/pro j')] }, { kind: 'commit', sha: SHA })).toEqual({ ok: false, reason: 'repoPath' });
  });
});

describe('reference links', () => {
  const gitlab = { endpoints: [https('origin', 'gitlab.indigital.gr', 'grp/proj.git')] };
  const github = { endpoints: [ssh('origin', 'github.com', 'octo/app.git')] };

  it('opens #123 as an issue, !45 as a merge request and owner/repo#12 in that project on GitLab', () => {
    expect(buildLink([INDIGITAL], gitlab, { kind: 'reference', reference: { sigil: '#', number: 123 } })).toMatchObject({ ok: true, url: 'https://gitlab.indigital.gr/grp/proj/-/issues/123' });
    expect(buildLink([INDIGITAL], gitlab, { kind: 'reference', reference: { sigil: '!', number: 45 } })).toMatchObject({ ok: true, url: 'https://gitlab.indigital.gr/grp/proj/-/merge_requests/45' });
    expect(buildLink([INDIGITAL], gitlab, { kind: 'reference', reference: { sigil: '#', number: 12, path: 'owner/repo' } })).toMatchObject({ ok: true, url: 'https://gitlab.indigital.gr/owner/repo/-/issues/12' });
    expect(buildLink([PREFIXED], { endpoints: [https('origin', 'code.example.com', 'gitlab/grp/proj.git')] }, { kind: 'reference', reference: { sigil: '!', number: 7, path: 'grp/sub/other' } })).toMatchObject({ url: 'https://code.example.com/gitlab/grp/sub/other/-/merge_requests/7' });
  });

  it('opens #12 and owner/repo#12 as issues on GitHub, which redirects a pull request\'s number', () => {
    expect(buildLink([GITHUB], github, { kind: 'reference', reference: { sigil: '#', number: 12 } })).toMatchObject({ url: 'https://github.com/octo/app/issues/12' });
    expect(buildLink([GITHUB], github, { kind: 'reference', reference: { sigil: '#', number: 12, path: 'owner/repo' } })).toMatchObject({ url: 'https://github.com/owner/repo/issues/12' });
  });

  it.each([
    ['! on GitHub', 'github', { sigil: '!', number: 45 }],
    ['a zero', 'gitlab', { sigil: '#', number: 0 }],
    ['a number past 2^31-1', 'gitlab', { sigil: '#', number: 2_147_483_648 }],
    ['a fraction', 'gitlab', { sigil: '#', number: 1.5 }],
    ['a GitHub path of three segments', 'github', { sigil: '#', number: 1, path: 'a/b/c' }],
    ['a path walking up', 'gitlab', { sigil: '#', number: 1, path: 'grp/../x' }],
    ['a path with a host', 'gitlab', { sigil: '#', number: 1, path: 'evil.example:443/x' }],
    ['a path with an encoded slash', 'gitlab', { sigil: '#', number: 1, path: 'grp/a%2F..' }],
  ] as const)('refuses %s', (_name, kind, reference) => {
    const target = { kind: 'reference', reference } as const;
    expect(buildLink(kind === 'github' ? [GITHUB] : [INDIGITAL], kind === 'github' ? github : gitlab, target)).toEqual({ ok: false, reason: 'target' });
    expect(linkUrl(kind === 'github' ? GITHUB : INDIGITAL, 'grp/proj', target)).toBeUndefined();
  });
});
