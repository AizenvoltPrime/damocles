import { describe, expect, it, vi } from 'vitest';
import { runForgeLink, type ForgeLinkCommandDeps } from '../forge-link-commands';
import type { ForgeLinkRequest, ForgeLinkResult } from '../../../shared/forge/links';
import { LocalizedError } from '../../../shared/localized-text';

const fill = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? '');

function deps(...results: ForgeLinkResult[]): ForgeLinkCommandDeps & { show: ReturnType<typeof vi.fn>; pushed: string[] } {
  const queue = [...results];
  const pushed: string[] = [];
  const show = vi.fn(async (_severity: string, _message: string, actions: readonly string[]) => (actions.length > 0 ? 0 : undefined));
  return {
    link: vi.fn(async () => queue.shift()!),
    notify: { show },
    t: fill,
    render: (text) => fill(text.message, ...(text.args ?? []).map(String)),
    push: async (repoId) => {
      pushed.push(repoId);
      return true;
    },
    log: vi.fn(),
    show,
    pushed,
  };
}

const PERMALINK: ForgeLinkRequest = { action: 'copyPermalink', repoId: 'r1', path: 'src/a.ts', startLine: 3, endLine: 7 };
const COMMIT: ForgeLinkRequest = { action: 'openCommit', repoId: 'r1', sha: '4e1a9c2d'.padEnd(40, '0') };

describe('runForgeLink', () => {
  it('says what it copied, as a polite info toast', async () => {
    const run = deps({ kind: 'copied', serverName: 'gitlab.indigital.gr', label: 'src/a.ts', dirty: false });
    await runForgeLink(run, PERMALINK);
    expect(run.link).toHaveBeenCalledWith(PERMALINK);
    expect(run.show).toHaveBeenCalledWith('info', 'Copied the permalink to src/a.ts on gitlab.indigital.gr.', []);
  });

  it('names a commit by its short hash when it opened it', async () => {
    const run = deps({ kind: 'opened', serverName: 'gitlab.indigital.gr', label: '4e1a9c2', dirty: false });
    await runForgeLink(run, COMMIT);
    expect(run.show).toHaveBeenCalledWith('info', 'Opened Commit 4e1a9c2 on gitlab.indigital.gr in your browser.', []);
  });

  it('names a reference as it reads in the message: !45, #123 and owner/repo#12', async () => {
    const run = deps(
      { kind: 'opened', serverName: 'gitlab.indigital.gr', label: '!45', dirty: false },
      { kind: 'opened', serverName: 'gitlab.indigital.gr', label: 'owner/repo#12', dirty: false },
    );
    await runForgeLink(run, { action: 'openReference', repoId: 'r1', reference: { sigil: '!', number: 45 } });
    await runForgeLink(run, { action: 'openReference', repoId: 'r1', reference: { sigil: '#', number: 12, path: 'owner/repo' } });
    expect(run.show.mock.calls.map(([severity, message]) => [severity, message])).toEqual([
      ['info', 'Opened !45 on gitlab.indigital.gr in your browser.'],
      ['info', 'Opened owner/repo#12 on gitlab.indigital.gr in your browser.'],
    ]);
  });

  it('warns that the lines may not match for a file with uncommitted changes, after opening it', async () => {
    const run = deps({ kind: 'opened', serverName: 'gitlab.com', label: 'src/a.ts', dirty: true });
    await runForgeLink(run, { ...PERMALINK, action: 'openFile' });
    expect(run.show).toHaveBeenCalledWith('warning', 'Opened src/a.ts on gitlab.com in your browser. The file has uncommitted changes, so its lines may not match.', []);
  });

  it('offers Push for an unpushed commit, pushes that repository, and asks for the link again', async () => {
    const run = deps(
      { kind: 'unpushed', serverName: 'gitlab.indigital.gr', label: '4e1a9c2', canPush: true },
      { kind: 'opened', serverName: 'gitlab.indigital.gr', label: '4e1a9c2', dirty: false },
    );
    await runForgeLink(run, COMMIT);
    expect(run.show).toHaveBeenNthCalledWith(1, 'warning', 'Commit 4e1a9c2 is not on gitlab.indigital.gr yet, so its page would not open. Push it first.', ['Push']);
    expect(run.pushed).toEqual(['r1']);
    expect(run.link).toHaveBeenCalledTimes(2);
    expect(run.show).toHaveBeenLastCalledWith('info', 'Opened Commit 4e1a9c2 on gitlab.indigital.gr in your browser.', []);
  });

  it('offers no Push when pushing HEAD\'s branch would not publish the commit', async () => {
    const run = deps({ kind: 'unpushed', serverName: 'gitlab.com', label: '4e1a9c2', canPush: false });
    await runForgeLink(run, COMMIT);
    expect(run.show).toHaveBeenCalledWith('warning', 'Commit 4e1a9c2 is not on gitlab.com yet, so its page would not open. Push the branch that holds it first.', []);
    expect(run.pushed).toEqual([]);
  });

  it('does not ask again when the user leaves the warning', async () => {
    const run = deps({ kind: 'unpushed', serverName: 'gitlab.com', label: 'src/a.ts', canPush: true });
    run.show.mockResolvedValueOnce(undefined);
    await runForgeLink(run, PERMALINK);
    expect(run.pushed).toEqual([]);
    expect(run.link).toHaveBeenCalledTimes(1);
  });

  it('shows the reason a link is unavailable', async () => {
    const run = deps({ kind: 'unavailable', reason: 'This repository has no remote on a server you signed in to.' });
    await runForgeLink(run, PERMALINK);
    expect(run.show).toHaveBeenCalledWith('warning', 'This repository has no remote on a server you signed in to.', []);
  });

  it('says core\'s own reason when core refused the link', async () => {
    const run = deps();
    vi.mocked(run.link).mockRejectedValueOnce(new LocalizedError({ message: 'The commit {0} is not in this repository.', args: ['4e1a9c2'] }));
    await runForgeLink(run, COMMIT);
    expect(run.show).toHaveBeenCalledWith('error', 'The commit 4e1a9c2 is not in this repository.', []);
  });

  it('says a file\'s version is unpushed with no Push when pushing HEAD\'s branch would not publish it', async () => {
    const run = deps({ kind: 'unpushed', serverName: 'gitlab.com', label: 'src/a.ts', canPush: false });
    await runForgeLink(run, PERMALINK);
    expect(run.show).toHaveBeenCalledWith('warning', 'This version of src/a.ts is not on gitlab.com yet, so its link would not open. Push the branch that holds it first.', []);
  });

  it('logs a failure and tells the user', async () => {
    const run = deps();
    vi.mocked(run.link).mockRejectedValueOnce(new Error('core restarted'));
    await runForgeLink(run, PERMALINK);
    expect(run.log).toHaveBeenCalledWith('[forge] the copyPermalink link failed: core restarted');
    expect(run.show).toHaveBeenCalledWith('error', 'Damocles could not make this link.', []);
  });
});
