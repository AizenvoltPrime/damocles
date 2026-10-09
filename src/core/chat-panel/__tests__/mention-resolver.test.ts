import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { FileConfinement } from '../../../platform/file-confinement';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { folderKey } from '../../workspace-folders/folder-key';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import { mentionInChat, resolveMention } from '../mention-resolver';

let root: string;
let project: string;
let other: string;
let folders: { resolve(key: string): FolderTarget | undefined };
let deps: { folders: typeof folders; confinement: FileConfinement };

function target(fsPath: string, projectScope = true): FolderTarget {
  return { key: folderKey(fsPath), fsPath, name: path.basename(fsPath), label: path.basename(fsPath), projectScope };
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mention-')));
  project = path.join(root, 'proj');
  other = path.join(root, 'other');
  fs.mkdirSync(path.join(project, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(project, 'src', 'deep', 'a.ts'), '');
  fs.writeFileSync(path.join(other, 'b.ts'), '');
  const known = [target(project), target(other), target(os.homedir(), false)];
  folders = { resolve: (key) => known.find((candidate) => candidate.key === key) };
  deps = { folders, confinement: createFakePlatform().confinement };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
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

  it('refuses a link out of the project and an unknown or home key', async () => {
    fs.symlinkSync(other, path.join(project, 'out'), 'junction');
    expect(await resolveMention(deps, { projectKey: folderKey(project), relativePath: 'out/b.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
    expect(await resolveMention(deps, { projectKey: 'nope', relativePath: 'b.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
    expect(await resolveMention(deps, { projectKey: folderKey(os.homedir()), relativePath: 'b.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
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
    const asked: Array<[string, string]> = [];
    const refusing: FileConfinement = {
      confineExisting: async (folder, relativePath) => {
        asked.push([folder, relativePath]);
        return { ok: false, reason: 'outside' };
      },
    };
    const realpath = vi.spyOn(fs.promises, 'realpath');
    try {
      expect(await resolveMention({ folders, confinement: refusing }, { projectKey: folderKey(project), relativePath: 'src/deep/a.ts' }, project)).toEqual({ ok: false, reason: 'outsideProject' });
      expect(await resolveMention({ folders, confinement: refusing }, { path: path.join(project, 'src', 'deep', 'a.ts') }, project)).toEqual({ ok: false, reason: 'outsideChat' });
      expect(asked).toEqual([[project, 'src/deep/a.ts'], [project, 'src/deep/a.ts']]);
      expect(realpath.mock.calls.map(([file]) => String(file))).not.toContain(path.join(project, 'src', 'deep', 'a.ts'));
    } finally {
      realpath.mockRestore();
    }
  });
});

describe('mentionInChat', () => {
  it('posts insertMention for a file of the chat, and warns with nothing inserted for one outside it', async () => {
    const platform = createFakePlatform();
    const posted: ExtensionToWebviewMessage[] = [];
    const deps = { folders, confinement: platform.confinement, notifications: platform.notifications, post: (message: ExtensionToWebviewMessage) => posted.push(message) };

    expect(await mentionInChat(deps, { projectKey: folderKey(project), relativePath: 'src/deep/a.ts' }, project)).toBe(true);
    expect(await mentionInChat(deps, { projectKey: folderKey(other), relativePath: 'b.ts' }, project)).toBe(false);

    expect(posted).toEqual([{ type: 'insertMention', path: path.join(project, 'src', 'deep', 'a.ts'), display: 'src/deep/a.ts' }]);
    expect(platform.notifications.calls).toEqual([{ level: 'warn', message: "This file is outside this chat's project", actions: [] }]);
  });
});
