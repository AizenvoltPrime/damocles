import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { resolveGitExecutable } from '../../git-executable';
import { piSessionDir } from '../../pi-session/session-store/session-dir';
import { ProjectRelocations } from '../index';
import { parseStore } from '../identity-store';
import { mountPointOf } from '../../workspace-folders/folder-presence-probe';
import { RELOCATION_STEPS } from '../types';
import type { GitRunner } from '../../scm/git-runner';

let dir: string;
let relocations: ProjectRelocations;
const sessionDirs: string[] = [];
const trusted = new Set<string>();

const repoAt = (folder: string, url: string): void => {
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
};

const chatOf = (folder: string): void => {
  const sessions = piSessionDir(folder);
  sessionDirs.push(sessions);
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, '2026-01-01T10-00-00-000Z_0b0c0d0e-0000-4000-8000-000000000001.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: '0b0c0d0e-0000-4000-8000-000000000001', timestamp: '2026-01-01T10:00:00.000Z', cwd: folder })}\n`);
};

// Real git, with no user or system config, in a repository of one commit.
function committedRepo(folder: string): void {
  const git = resolveGitExecutable()!;
  const config = path.join(dir, 'neutral.gitconfig');
  fs.writeFileSync(config, '[user]\n\tname = Identity Tests\n\temail = identity@damocles.invalid\n[commit]\n\tgpgsign = false\n');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  fs.mkdirSync(folder, { recursive: true });
  execFileSync(git, ['init', '-q', '--template=', '-b', 'main'], { cwd: folder, env });
  fs.writeFileSync(path.join(folder, 'a.txt'), 'one\n');
  execFileSync(git, ['add', '-A'], { cwd: folder, env });
  execFileSync(git, ['commit', '-q', '-m', 'first'], { cwd: folder, env });
}

function open(git?: () => GitRunner | undefined): ProjectRelocations {
  return new ProjectRelocations({
    ...(git ? { git } : {}),
    requestedBy: 'desktop',
    watcherFactory: createFakePlatform().fileWatchers,
    metaIndex: { move: async () => undefined, meta: async () => null },
    memory: { relocateWorkspace: async () => ({}) },
    hostState: { mcp: { relocateFolders: async () => undefined } },
    trust: { isTrusted: (folder) => trusted.has(folder), onDidGrantTrust: () => ({ dispose: () => undefined }) },
    projectFolders: () => [path.join(dir, 'old')],
    log: () => undefined,
    file: path.join(dir, 'project-relocations.json'),
    identitiesFile: path.join(dir, 'folder-identities.json'),
    lockDir: path.join(dir, 'locks'),
  });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-record-')));
  relocations = open();
});

afterEach(() => {
  relocations.dispose();
  trusted.clear();
  for (const sessions of sessionDirs.splice(0)) fs.rmSync(sessions, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProjectRelocations identities', () => {
  it('records a project folder while it exists, then offers its chats to a clone of its repository once it is gone', async () => {
    const old = path.join(dir, 'old');
    repoAt(old, 'https://alice:pw@github.com/acme/widgets.git');
    chatOf(old);
    // a POSIX folder's mount point is recorded with it, unless it is the system root
    const mount = process.platform === 'win32' ? '/' : await mountPointOf(old);

    await relocations.recordIdentities();
    const stored = fs.readFileSync(path.join(dir, 'folder-identities.json'), 'utf8');
    expect(stored).not.toContain('alice');
    expect(parseStore(stored, () => undefined)).toEqual([{ path: old, subpath: '', remotes: ['github.com/acme/widgets'], roots: [], seenAt: expect.any(Number), ...(mount !== '/' ? { mount } : {}) }]);

    fs.rmSync(old, { recursive: true });
    // a folder that is gone keeps what was recorded for it
    await relocations.recordIdentities();
    const clone = path.join(dir, 'clone');
    repoAt(clone, 'git@github.com:acme/widgets.git');
    const other = path.join(dir, 'other');
    repoAt(other, 'https://github.com/someone/else.git');
    expect(await relocations.movedFrom(clone)).toEqual([{ from: old, chats: 1 }]);
    expect(await relocations.movedFrom(other)).toEqual([]);

    const preflight = await relocations.preflight({ from: old, to: other, listed: [] });
    expect(preflight).toMatchObject({ ok: true, notices: [{ code: 'otherRepository' }] });
    expect(await relocations.preflight({ from: old, to: clone, listed: [clone] })).toMatchObject({ ok: true, mode: 'merge', notices: [{ code: 'merge' }] });
  });

  it('offers a folder again that a finished relocation moved away, once it was re-created, gained chats and went missing', async () => {
    const old = path.join(dir, 'old');
    const steps = Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: 'done' }]));
    const moved = { id: 'r1', seq: 1, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: old, to: path.join(dir, 'moved') }], chats: 1, state: 'coreDone', steps, startedAt: Date.parse('2025-12-01T00:00:00.000Z'), finishedAt: Date.parse('2025-12-01T00:00:01.000Z') };
    fs.writeFileSync(path.join(dir, 'project-relocations.json'), JSON.stringify({ version: 1, relocations: [moved], hostAliases: [] }));
    relocations.dispose();
    relocations = open();
    // the re-created folder's chat begins after the relocation
    repoAt(old, 'https://github.com/acme/widgets.git');
    chatOf(old);
    await relocations.recordIdentities();
    fs.rmSync(old, { recursive: true });

    const clone = path.join(dir, 'clone');
    repoAt(clone, 'git@github.com:acme/widgets.git');
    expect(await relocations.movedFrom(clone)).toEqual([{ from: old, chats: 1 }]);
  });

  it('runs no git in a trusted folder when no recorded folder could match it by its root commits', async () => {
    const run = vi.fn<GitRunner['run']>(async () => { throw new Error('git ran'); });
    relocations.dispose();
    relocations = open(() => ({ run }) as unknown as GitRunner);
    const old = path.join(dir, 'old');
    repoAt(old, 'https://github.com/acme/widgets.git');
    chatOf(old);
    await relocations.recordIdentities();
    run.mockClear();
    fs.rmSync(old, { recursive: true });
    const clone = path.join(dir, 'clone');
    repoAt(clone, 'git@github.com:acme/widgets.git');
    const other = path.join(dir, 'other');
    repoAt(other, 'https://github.com/someone/else.git');
    trusted.add(clone);
    trusted.add(other);
    expect(await relocations.movedFrom(clone)).toEqual([{ from: old, chats: 1 }]);
    expect(await relocations.movedFrom(other)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('offers no folder another app version is relocating', async () => {
    const old = path.join(dir, 'old');
    repoAt(old, 'https://github.com/acme/widgets.git');
    chatOf(old);
    await relocations.recordIdentities();
    fs.rmSync(old, { recursive: true });
    const foreign = { id: 'f1', seq: 1, state: 'running', futureField: true, folders: [{ kind: 'project', from: old, to: path.join(dir, 'elsewhere') }] };
    fs.writeFileSync(path.join(dir, 'project-relocations.json'), JSON.stringify({ version: 1, relocations: [foreign], hostAliases: [] }));
    relocations.dispose();
    relocations = open();
    const clone = path.join(dir, 'clone');
    repoAt(clone, 'git@github.com:acme/widgets.git');
    expect(await relocations.movedFrom(clone)).toEqual([]);
  });

  it('reads root commits with git only while a folder is trusted, and matches a copy with no remote by them', async () => {
    const old = path.join(dir, 'old');
    committedRepo(old);
    chatOf(old);
    await relocations.recordIdentities();
    expect(parseStore(fs.readFileSync(path.join(dir, 'folder-identities.json'), 'utf8'), () => undefined)[0]!.roots).toEqual([]);
    trusted.add(old);
    await relocations.recordIdentities();
    const [recorded] = parseStore(fs.readFileSync(path.join(dir, 'folder-identities.json'), 'utf8'), () => undefined);
    expect(recorded!.roots).toHaveLength(1);

    const copy = path.join(dir, 'copy');
    fs.renameSync(old, copy);
    expect(await relocations.movedFrom(copy)).toEqual([]);
    trusted.add(copy);
    expect(await relocations.movedFrom(copy)).toEqual([{ from: old, chats: 1 }]);
  });
});
