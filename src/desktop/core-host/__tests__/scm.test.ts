import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSettings, FakeTrust, folder, git, GIT_PATH, HAS_GIT, MapMemento, makeRepo, useGitSandbox, waitFor, watchers, write } from '../../../core/scm/__tests__/git-harness';
import { parseGitVersion } from '../../../core/scm/git-version';
import type { RepoSnapshot, ScmEvent } from '../../../core/scm/scm-service';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type ScmMirrorPatch } from '../../core-protocol';
import type { CorePlatform } from '../platform';
import { startCoreScm, type CoreScm } from '../scm';

/** Core's scm mirror as main receives it: what goes out for listed and dropped repositories, and before which event. */
useGitSandbox();

type Seen = { readonly patch: ScmMirrorPatch } | { readonly event: ScmEvent };

let running: CoreScm | undefined;
afterEach(() => {
  running?.dispose();
  running = undefined;
});

function start(trusted: string): { seen: Seen[]; call: (method: string, args: unknown[]) => Promise<unknown> } {
  const { main, core } = createLoopback();
  const violations: string[] = [];
  const mainEndpoint = createMainEndpoint(main, () => undefined, (error) => violations.push(error.message));
  const endpoint = createCoreEndpoint(core, () => undefined);
  const trust = new FakeTrust();
  trust.trusted.add(path.resolve(trusted).toLowerCase());
  const platform = {
    endpoint,
    init: { git: { available: true, path: GIT_PATH, version: parseGitVersion(git(['--version'], trusted)) }, paths: { askpass: { askpass: '/a', sshAskpass: '/s', node: '/n', main: '/m' } } },
    localization: { t: (message: string) => message },
    trust,
    fileWatchers: watchers,
    settings: new FakeSettings(),
    state: { global: new MapMemento() },
    notifications: { info: async () => undefined },
    secrets: { get: async () => undefined },
  } as unknown as CorePlatform;
  running = startCoreScm(platform, { appendLine: () => undefined, show: () => undefined, dispose: () => undefined }, () => undefined);
  const seen: Seen[] = [];
  mainEndpoint.onMirror('scm', (patch) => seen.push({ patch }));
  mainEndpoint.onEvent('scm.changed', ({ event }) => seen.push({ event: event as ScmEvent }));
  return {
    seen,
    call: async (method, args) => {
      const result = await mainEndpoint.request('scm.call', { method: method as never, args });
      expect(violations).toEqual([]);
      return result;
    },
  };
}

const patches = (seen: readonly Seen[]): ScmMirrorPatch[] => seen.flatMap((item) => ('patch' in item ? [item.patch] : []));

describe.runIf(HAS_GIT)('core\'s scm mirror', { timeout: 60_000 }, () => {
  it('publishes a listed repository whole once per status revision, its busy flips as flags, and every delta before its event', async () => {
    const repo = makeRepo(folder('mirror'));
    const { seen, call } = start(repo);
    await call('setProjects', [[{ key: 'p', path: repo }]]);
    const whole = (): Array<ScmMirrorPatch & { kind: 'repository' }> => patches(seen).filter((patch): patch is ScmMirrorPatch & { kind: 'repository' } => patch.kind === 'repository' && patch.repository !== undefined);
    const first = await waitFor(() => whole().find((patch) => (patch.repository!.snapshot as RepoSnapshot).status !== undefined), 'a published status');
    const repoId = first.repoId;
    const viewAt = seen.findIndex((item) => 'patch' in item && item.patch.kind === 'view' && (item.patch.view as { repos: unknown[] } | undefined)?.repos.length === 1);
    expect(viewAt).toBeGreaterThanOrEqual(0);
    expect(seen.findIndex((item) => 'patch' in item && item.patch.kind === 'repository')).toBeGreaterThan(viewAt);

    // a stage is an index write, so the queue goes busy and idle around it, and its status lands after
    write(path.join(repo, 'a.txt'), 'two\n');
    const before = seen.length;
    await call('stage', [repoId, ['a.txt']]);
    await waitFor(() => whole().some((patch) => (patch.repository!.snapshot as RepoSnapshot).revision > (first.repository!.snapshot as RepoSnapshot).revision) && seen.slice(before).some((item) => 'patch' in item && item.patch.kind === 'repositoryState' && !item.patch.busy), 'the stage landing');
    const after = patches(seen.slice(before)).filter((patch) => 'repoId' in patch && patch.repoId === repoId);
    expect(after.some((patch) => patch.kind === 'repositoryState' && patch.busy)).toBe(true);
    const revisions = whole().map((patch) => (patch.repository!.snapshot as RepoSnapshot).revision);
    expect(new Set(revisions).size).toBe(revisions.length);

    // each repository event follows a delta for its repository
    seen.forEach((item, index) => {
      if (!('event' in item) || item.event.kind !== 'repository') return;
      const changedRepo = item.event.repoId;
      expect(seen.slice(0, index).some((earlier) => 'patch' in earlier && 'repoId' in earlier.patch && earlier.patch.repoId === changedRepo)).toBe(true);
    });

    // a project removed publishes its repository's close before the repository's event
    const dropAt = seen.length;
    await call('setProjects', [[]]);
    const closedEvent = (item: Seen): boolean => 'event' in item && item.event.kind === 'repository' && item.event.repoId === repoId;
    await waitFor(() => seen.slice(dropAt).some(closedEvent), 'the repository\'s event');
    const dropped = seen.slice(dropAt);
    const closedAt = dropped.findIndex((item) => 'patch' in item && item.patch.kind === 'repository' && item.patch.repoId === repoId && item.patch.repository === undefined);
    expect(closedAt).toBeGreaterThanOrEqual(0);
    expect(closedAt).toBeLessThan(dropped.findIndex(closedEvent));
  });
});
