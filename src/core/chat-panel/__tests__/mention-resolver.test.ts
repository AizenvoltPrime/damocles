import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { FileConfinement, LinkRule } from '../../../platform/file-confinement';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { folderKey } from '../../workspace-folders/folder-key';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import { mentionInChat, resolveMention } from '../mention-resolver';
import { installWorktreeProjectLookup } from '../../worktrees/personal-config';

let root: string;
let project: string;
let other: string;
let folders: { resolve(key: string): FolderTarget | undefined };
let worktree: string;
let deps: { folders: typeof folders; confinement: FileConfinement; trust: { isTrusted(folder: string): boolean } };

function target(fsPath: string, projectScope = true): FolderTarget {
  return { key: folderKey(fsPath), fsPath, name: path.basename(fsPath), label: path.basename(fsPath), projectScope };
}

const trusting = (trusted: boolean): typeof deps => ({ ...deps, trust: { isTrusted: () => trusted } });

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mention-')));
  project = path.join(root, 'proj');
  other = path.join(root, 'other');
  worktree = path.join(root, 'wt');
  fs.mkdirSync(path.join(project, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(other);
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(project, 'src', 'deep', 'a.ts'), '');
  fs.writeFileSync(path.join(other, 'b.ts'), '');
  const known = [target(project), target(other), target(worktree), target(os.homedir(), false)];
  folders = { resolve: (key) => known.find((candidate) => candidate.key === key) };
  const platform = createFakePlatform();
  deps = { folders, confinement: platform.confinement, trust: platform.trust };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the wrong-copy guard of a worktree chat (AD12)', () => {
  const lookup = () => installWorktreeProjectLookup({ projectOf: (f) => (folderKey(f).startsWith(folderKey(worktree)) ? project : undefined), recordsOfProject: () => [], chatRecordFor: () => undefined, get: () => undefined });

  it('refuses a project-folder file with its own reason, and the chat posts A.5\'s refusal', async () => {
    const installed = lookup();
    try {
      expect(await resolveMention(deps, { projectKey: folderKey(project), relativePath: 'src/deep/a.ts' }, worktree)).toEqual({ ok: false, reason: 'projectCopy' });
      const warn = vi.fn(async () => undefined);
      await mentionInChat({ ...deps, notifications: { warn } as never, post: () => undefined }, { projectKey: folderKey(project), relativePath: 'src/deep/a.ts' }, worktree);
      expect(warn).toHaveBeenCalledWith({ message: 'This file is in the project folder. This chat works in its worktree.' });
    } finally {
      installed.dispose();
    }
  });

  it('refuses a link in the worktree onto the project folder\'s copy in a trusted chat, by the realpath', async () => {
    fs.symlinkSync(path.join(project, 'src'), path.join(worktree, 'lnk'), 'junction');
    const installed = lookup();
    try {
      expect(await resolveMention(trusting(true), { projectKey: folderKey(worktree), relativePath: 'lnk/deep/a.ts' }, worktree)).toEqual({ ok: false, reason: 'projectCopy' });
      expect(await resolveMention(trusting(true), { path: path.join(worktree, 'lnk', 'deep', 'a.ts') }, worktree)).toEqual({ ok: false, reason: 'projectCopy' });
    } finally {
      installed.dispose();
    }
  });
});

describe('resolveMention', () => {
  it('resolves a file of the chat\'s project to the display an @ pick inserts', async () => {
    expect(await resolveMention(deps, { projectKey: folderKey(project), relativePath: 'src/deep/a.ts' }, project)).toEqual({
      ok: true,
      path: path.join(project, 'src', 'deep', 'a.ts'),
      display: 'src/deep/a.ts',
    });
  });

  it('displays the path relative to a chat folder inside the project', async () => {
    expect(await resolveMention(deps, { projectKey: folderKey(project), relativePath: 'src/deep/a.ts' }, path.join(project, 'src'))).toMatchObject({ ok: true, display: 'deep/a.ts' });
  });

  it('refuses a file of another project than the chat\'s', async () => {
    expect(await resolveMention(deps, { projectKey: folderKey(other), relativePath: 'b.ts' }, project)).toEqual({ ok: false, reason: 'outsideChat' });
  });

  it.each([['../other/b.ts'], ['src/../../other/b.ts'], ['C:/x'], ['/etc/passwd'], ['']])('refuses the relative path %j', async (relativePath) => {
    expect(await resolveMention(deps, { projectKey: folderKey(project), relativePath }, project)).toEqual({ ok: false, reason: 'outsideProject' });
  });

  it('refuses a link out of an untrusted project, and an unknown or home key', async () => {
    fs.symlinkSync(other, path.join(project, 'out'), 'junction');
    const untrusted = trusting(false);
    expect(await resolveMention(untrusted, { projectKey: folderKey(project), relativePath: 'out/b.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
    expect(await resolveMention(untrusted, { path: path.join(project, 'out', 'b.ts') }, project)).toEqual({ ok: false, reason: 'outsideChat' });
    expect(await resolveMention(deps, { projectKey: 'nope', relativePath: 'b.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
    expect(await resolveMention(deps, { projectKey: folderKey(os.homedir()), relativePath: 'b.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
  });

  it('follows a link out of a trusted project and displays the path through the link', async () => {
    fs.symlinkSync(other, path.join(project, 'out'), 'junction');
    const trusted = trusting(true);
    expect(await resolveMention(trusted, { projectKey: folderKey(project), relativePath: 'out/b.ts' }, project)).toEqual({ ok: true, path: path.join(other, 'b.ts'), display: 'out/b.ts' });
    expect(await resolveMention(trusted, { path: path.join(project, 'out', 'b.ts') }, project)).toEqual({ ok: true, path: path.join(other, 'b.ts'), display: 'out/b.ts' });
    // the chat-folder check reads the path through the link, which lies outside a chat folder below the project
    expect(await resolveMention(trusted, { projectKey: folderKey(project), relativePath: 'out/b.ts' }, path.join(project, 'src'))).toEqual({ ok: false, reason: 'outsideChat' });
  });

  it('resolves a path main holds only inside the chat\'s folder', async () => {
    expect(await resolveMention(deps, { path: path.join(other, 'b.ts') }, project)).toEqual({ ok: false, reason: 'outsideChat' });
    expect(await resolveMention(deps, { path: path.join(project, 'src', 'deep', 'a.ts') }, project)).toMatchObject({ ok: true });
    expect(await resolveMention(deps, { path: 'relative.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
  });

  it('reports a missing file', async () => {
    expect(await resolveMention(deps, { projectKey: folderKey(project), relativePath: 'none.ts' }, project)).toEqual({ ok: false, reason: 'missing' });
  });

  it('resolves the file only through the host\'s confinement, never with a realpath of its own', async () => {
    const asked: Array<[string, string, string]> = [];
    const refusing: FileConfinement = {
      confineExisting: async (folder, relativePath, rule) => {
        asked.push([folder, relativePath, rule]);
        return { ok: false, reason: 'outside' };
      },
    };
    const realpath = vi.spyOn(fs.promises, 'realpath');
    try {
      expect(await resolveMention({ ...trusting(true), confinement: refusing }, { projectKey: folderKey(project), relativePath: 'src/deep/a.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
      expect(await resolveMention({ ...trusting(false), confinement: refusing }, { path: path.join(project, 'src', 'deep', 'a.ts') }, project)).toEqual({ ok: false, reason: 'outsideChat' });
      expect(asked).toEqual([[project, 'src/deep/a.ts', 'throughLinks'], [project, 'src/deep/a.ts', 'withinProject']]);
      expect(realpath.mock.calls.map(([file]) => String(file))).not.toContain(path.join(project, 'src', 'deep', 'a.ts'));
    } finally {
      realpath.mockRestore();
    }
  });

  it('follows links in a named project only while both the chat\'s folder and that project are trusted', async () => {
    const rules: LinkRule[] = [];
    const recording: FileConfinement = {
      confineExisting: async (_folder, _relativePath, rule) => {
        rules.push(rule);
        return { ok: false, reason: 'outside' };
      },
    };
    const trustingOnly = (...trusted: string[]): typeof deps => ({ ...deps, confinement: recording, trust: { isTrusted: (folder) => trusted.some((one) => folderKey(one) === folderKey(folder)) } });
    const named = { projectKey: folderKey(project), relativePath: 'src/deep/a.ts' };
    for (const trusted of [[root], [project], [root, project]]) await resolveMention(trustingOnly(...trusted), named, root);
    expect(rules).toEqual(['withinProject', 'withinProject', 'throughLinks']);
  });
});

// A real junction to a local folder, whose readlink answers a share or WSL path, as in asset-walk.test.ts.
describe.runIf(process.platform === 'win32')('a mention through a link onto a network path on Windows', () => {
  it.each([['\\\\host\\share\\x', true], ['\\\\wsl.localhost\\Ubuntu\\x', true], ['\\\\host\\share\\x', false]])('refuses the link onto %s (trusted: %s) without touching it or its target', async (unc, trusted) => {
    const link = path.join(project, 'nas');
    fs.symlinkSync(other, link, 'junction');
    const uncCalls: string[] = [];
    // every call but lstat naming a path at or under the link: the target behind it
    const throughLink: string[] = [];
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => (folderKey(String(file)) === folderKey(link) ? unc : readlink(file))) as never);
    for (const name of ['lstat', 'stat', 'realpath', 'open', 'readdir'] as const) {
      const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
        const spelled = String(file);
        if (/^[\\/]{2}/.test(spelled)) {
          uncCalls.push(spelled);
          throw new Error(`reached ${spelled}`);
        }
        if (name !== 'lstat' && (folderKey(spelled) === folderKey(link) || folderKey(spelled).startsWith(`${folderKey(link)}${path.sep}`))) throughLink.push(`${name} ${spelled}`);
        return original(file, ...rest);
      }) as never);
    }
    const chatDeps = trusting(trusted);
    expect(await resolveMention(chatDeps, { projectKey: folderKey(project), relativePath: 'nas/b.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
    expect(await resolveMention(chatDeps, { path: path.join(link, 'b.ts') }, project)).toEqual({ ok: false, reason: 'outsideChat' });
    expect(uncCalls).toEqual([]);
    expect(throughLink).toEqual([]);
  });
});

describe('mentionInChat', () => {
  it('posts insertMention for a file of the chat, and warns with nothing inserted for one outside it', async () => {
    const platform = createFakePlatform();
    const posted: ExtensionToWebviewMessage[] = [];
    const deps = { folders, confinement: platform.confinement, trust: platform.trust, notifications: platform.notifications, post: (message: ExtensionToWebviewMessage) => posted.push(message) };

    expect(await mentionInChat(deps, { projectKey: folderKey(project), relativePath: 'src/deep/a.ts' }, project)).toBe(true);
    expect(await mentionInChat(deps, { projectKey: folderKey(other), relativePath: 'b.ts' }, project)).toBe(false);

    expect(posted).toEqual([{ type: 'insertMention', path: path.join(project, 'src', 'deep', 'a.ts'), display: 'src/deep/a.ts' }]);
    expect(platform.notifications.calls).toEqual([{ level: 'warn', message: "This file is outside this chat's project", text: { message: "This file is outside this chat's project" }, actions: [] }]);
  });
});
