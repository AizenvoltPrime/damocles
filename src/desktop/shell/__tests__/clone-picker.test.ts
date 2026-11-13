import { describe, expect, it } from 'vitest';
import { applyAnswer, initialSections, isPending, looksLikeUrl, noResults, queryMatches, startSearch } from '../overlay/clone-picker';
import type { CloneAccount, CloneRow } from '../../../shared/forge/clone';

// sample data
const IDG: CloneAccount = { accountId: 'idg|1', login: 'astefanopoulos', serverId: 'idg', serverName: 'gitlab.indigital.gr', kind: 'gitlab', needsSignIn: false };
const GLC: CloneAccount = { accountId: 'glc|2', login: 'alexios-s', serverId: 'glc', serverName: 'gitlab.com', kind: 'gitlab', needsSignIn: false };
const GH: CloneAccount = { accountId: 'gh|3', login: 'alexios', serverId: 'gh', serverName: 'github.com', kind: 'github', needsSignIn: true };
const INTRANET: CloneRow = { key: 'k1', namespace: 'grp/platform', name: 'intranet', description: 'Company intranet', visibility: 'internal' };

describe('clone picker sections', () => {
  it('starts every account loading, except one that must sign in again, which is never searched', () => {
    const sections = initialSections([IDG, GH]);
    expect(sections.map((section) => section.state)).toEqual([{ status: 'loading' }, { status: 'error', error: 'signInAgain' }]);
    expect(startSearch(sections, GH.accountId, 4)[1]).toBe(sections[1]);
  });

  it('loads each section on its own: one answer fills its section and leaves the other loading', () => {
    let sections = initialSections([IDG, GLC]);
    sections = startSearch(sections, IDG.accountId, 1);
    sections = startSearch(sections, GLC.accountId, 2);
    const answered = applyAnswer(sections, { requestId: 2, accountId: GLC.accountId, rows: [] });
    expect(answered.map((section) => section.state.status)).toEqual(['loading', 'ready']);
    expect(isPending(answered)).toBe(true);
  });

  it('drops an answer to an older search of the same section', () => {
    let sections = startSearch(initialSections([IDG]), IDG.accountId, 1);
    sections = startSearch(sections, IDG.accountId, 2);
    expect(applyAnswer(sections, { requestId: 1, accountId: IDG.accountId, rows: [INTRANET] })).toBe(sections);
    expect(applyAnswer(sections, { requestId: 2, accountId: IDG.accountId, rows: [INTRANET] })[0]!.state).toEqual({ status: 'ready', rows: [INTRANET] });
  });

  it('keeps an unreachable server in its own section, and a retry searches only that one again', () => {
    let sections = startSearch(startSearch(initialSections([IDG, GLC]), IDG.accountId, 1), GLC.accountId, 2);
    sections = applyAnswer(sections, { requestId: 1, accountId: IDG.accountId, rows: [INTRANET] });
    sections = applyAnswer(sections, { requestId: 2, accountId: GLC.accountId, error: 'unreachable' });
    expect(sections[1]!.state).toEqual({ status: 'error', error: 'unreachable' });
    const retried = startSearch(sections, GLC.accountId, 3);
    expect(retried[0]).toBe(sections[0]);
    expect(retried[1]!.state).toEqual({ status: 'loading' });
  });

  it('says no results only once every section answered with no row for a typed query', () => {
    const empty = applyAnswer(startSearch(initialSections([IDG]), IDG.accountId, 1), { requestId: 1, accountId: IDG.accountId, rows: [] });
    expect(noResults(empty, 'zzz')).toBe(true);
    expect(noResults(empty, '  ')).toBe(false);
    expect(noResults(startSearch(empty, IDG.accountId, 2), 'zzz')).toBe(false);
    expect(noResults([], 'zzz')).toBe(false);
  });

  it('says no results beside a server that did not answer, but not when every server failed', () => {
    let sections = startSearch(startSearch(initialSections([IDG, GLC]), IDG.accountId, 1), GLC.accountId, 2);
    sections = applyAnswer(sections, { requestId: 2, accountId: GLC.accountId, error: 'unreachable' });
    expect(noResults(sections, 'zzz')).toBe(false);
    expect(noResults(applyAnswer(sections, { requestId: 1, accountId: IDG.accountId, rows: [] }), 'zzz')).toBe(true);
    expect(noResults(applyAnswer(sections, { requestId: 1, accountId: IDG.accountId, error: 'unreachable' }), 'zzz')).toBe(false);
  });
});

describe('clone picker text', () => {
  it('treats URLs and scp-like addresses as a paste, and plain words as a search', () => {
    expect(looksLikeUrl(' https://gitlab.indigital.gr/grp/damocles.git ')).toBe(true);
    expect(looksLikeUrl('git@github.com:alexios/dotfiles.git')).toBe(true);
    expect(looksLikeUrl('ssh://git@git.indigital.gr/platform/api.git')).toBe(true);
    expect(looksLikeUrl('file:///srv/git/tool.git')).toBe(true);
    expect(looksLikeUrl('git.indigital.gr:platform/api.git')).toBe(true);
    expect(looksLikeUrl('intra')).toBe(false);
    expect(looksLikeUrl('')).toBe(false);
    expect(looksLikeUrl('grp/platform intranet')).toBe(false);
  });

  it('treats an absolute folder as a paste, as Git: Clone\'s box took a local repository', () => {
    expect(looksLikeUrl('/srv/git/tool.git')).toBe(true);
    expect(looksLikeUrl('C:\\repos\\tool')).toBe(true);
    expect(looksLikeUrl('D:/repos/tool')).toBe(true);
    expect(looksLikeUrl('\\\\server\\share\\tool.git')).toBe(true);
    expect(looksLikeUrl('repos tool')).toBe(false);
  });

  it('reads a README\'s git clone command and a folder path with spaces as a paste, as core does, and never a URL with spaces', () => {
    expect(looksLikeUrl('git clone https://gitlab.indigital.gr/grp/damocles.git')).toBe(true);
    expect(looksLikeUrl('C:\\My Repos\\tool')).toBe(true);
    expect(looksLikeUrl('git clone /home/john doe/tool')).toBe(true);
    expect(looksLikeUrl('https://gitlab.indigital.gr/grp/my repo')).toBe(false);
    expect(looksLikeUrl('host:a b')).toBe(false);
    expect(looksLikeUrl('-oProxyCommand=x:p')).toBe(false);
    expect(looksLikeUrl('git clone')).toBe(false);
  });

  it('highlights the query\'s first case-insensitive occurrence', () => {
    expect(queryMatches('grp/platform/intranet', 'INTRA')).toEqual([[13, 18]]);
    expect(queryMatches('grp/platform/intranet', ' ')).toEqual([]);
    expect(queryMatches('grp/platform/intranet', 'zzz')).toEqual([]);
  });

  it('highlights nothing in text whose lower case has another length, rather than a shifted range', () => {
    expect(queryMatches('İstanbul tools', 'tools')).toEqual([]);
  });
});
