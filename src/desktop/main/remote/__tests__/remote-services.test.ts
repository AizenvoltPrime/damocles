import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { Disposable } from '../../../../platform/disposable';
import type { HostState } from '../../core-services/host-services';
import { hostExtras } from '../../core-services/__tests__/host-deps';
import { namespacedSecrets, remoteServices } from '../remote-services';

const none = (): Disposable => ({ dispose: () => undefined });
const PROJECT = { key: 'loopback|/srv/app', fsPath: '/srv/app', name: 'app' };

function services() {
  const main = createFakePlatform({ chatBrowserPane: true });
  const logged: string[] = [];
  const reviews: unknown[] = [];
  const previews: unknown[] = [];
  const settingsFiles: unknown[] = [];
  const opened: unknown[] = [];
  const shown: unknown[] = [];
  const notices: unknown[] = [];
  const diffs: unknown[] = [];
  const picks: unknown[] = [];
  const state: HostState = {
    global: { get: ((key: string) => (key === 'userLanguagePreference' ? 'el' : 'secret')) as HostState['global']['get'], update: vi.fn(async () => undefined) },
    workspace: { get: (() => undefined) as HostState['workspace']['get'], update: vi.fn(async () => undefined) },
    snapshot: () => ({ userLanguagePreference: 'el', 'damocles.secretThing': 1 }),
    onDidUpdate: none,
  };
  const deps = remoteServices({
    authority: 'loopback',
    hostId: 'loopback',
    hostName: () => 'Local daemon',
    platform: main,
    state,
    projects: () => [PROJECT],
    fileRoots: () => [PROJECT],
    onProjectsChanged: none,
    workspace: () => ({
      files: {
        projectOfPath: async (_projects: unknown, target: string) => (target.startsWith('/srv/app/') ? { project: PROJECT, relativePath: path.posix.relative('/srv/app', target), path: target } : undefined),
        readText: async () => 'text',
      },
    }) as never,
    trust: { trustedKeys: () => [], onDidGrant: none, requestTrust: async () => false },
    openInEditor: async (...args) => {
      opened.push(args);
    },
    showLog: (...args) => shown.push(args),
    showDiff: async (request) => {
      diffs.push(request.filePath);
      return { close: async () => undefined, closed: Promise.resolve() };
    },
    showMarkdown: async (...args) => {
      previews.push(args);
    },
    showChatReview: async (...args) => {
      reviews.push(args);
    },
    openSettingsFile: async (scope, key) => {
      settingsFiles.push([scope, key]);
    },
    pick: async (...args) => {
      picks.push(args);
      return args[0] === 'file' ? '/srv/app/plan.md' : undefined;
    },
    ui: { ask: async () => 0, askpass: async () => ({ cancelled: true }), worktrees: hostExtras().ui.worktrees },
    notices: {
      info: async (message: string) => {
        notices.push(message);
        return undefined;
      },
      warn: async () => undefined,
      error: async () => undefined,
    },
    user: { credentials: async () => ({ type: 'none' }), speak: async () => undefined, gitCredential: async () => ({ kind: 'none' }) },
    base: { terminalToggle: () => ({ shown: false, shortcut: '' }), createView: () => { throw new Error('no view'); }, git: { available: true }, e2eHooks: false, ...hostExtras(), log: (line) => logged.push(line) },
    t: (message, ...args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message),
  });
  return { deps, main, opened, shown, notices, diffs, logged, reviews, previews, settingsFiles, picks };
}

describe('a remote core\'s services', () => {
  it('refuses a clipboard write, a reload, the trash and a proxy lookup', async () => {
    const { deps } = services();
    await expect(deps.platform.clipboard.writeText('x')).rejects.toThrow('not available to a remote core');
    await expect(deps.platform.lifecycle.reload()).rejects.toThrow('not available');
    await expect(deps.ui.trash('/srv/app/a.ts')).rejects.toThrow('not available');
    await expect(deps.resolveProxy('https://example.com')).rejects.toThrow('not available');
  });

  it('answers false for a folder or path of the target the OS file manager would show, and a picker opens the folder browser of the host, never a native dialog', async () => {
    const { deps, main, notices, picks } = services();
    const openFolder = vi.spyOn(main.shell, 'openFolder');
    const revealPath = vi.spyOn(main.shell, 'revealPath');
    const pickFolder = vi.spyOn(main.dialogs, 'pickFolder');
    await expect(deps.platform.shell.openFolder('/srv/app')).resolves.toBe(false);
    await expect(deps.platform.shell.revealPath('/srv/app/a.ts')).resolves.toBeUndefined();
    const pickFile = vi.spyOn(main.dialogs, 'pickFile');
    await expect(deps.platform.dialogs.pickFolder({ title: 'x', defaultPath: '/srv/app', buttonLabel: 'Use' })).resolves.toBeUndefined();
    await expect(deps.platform.dialogs.pickFile({ title: 'y', defaultPath: '/srv/app', filters: { Markdown: ['md'] } })).resolves.toBe('/srv/app/plan.md');
    expect(picks).toEqual([
      ['folder', { title: 'x', defaultPath: '/srv/app', buttonLabel: 'Use' }],
      ['file', { title: 'y', defaultPath: '/srv/app', extensions: ['md'] }],
    ]);
    expect(notices).toEqual([]);
    expect(pickFile).not.toHaveBeenCalled();
    expect(openFolder).not.toHaveBeenCalled();
    expect(revealPath).not.toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it('shows the active editor\'s context only while it shows a file of this host, at attach and on every change', () => {
    const { deps, main } = services();
    const local = { filePath: '/home/me/local/secret.ts', selection: { text: 'API_KEY=sk-local', startLine: 1, endLine: 1 } };
    const own = { filePath: '/srv/app/a.ts', selection: { text: 'export const a', startLine: 1, endLine: 1 } };
    const empty = { filePath: undefined, selection: undefined };
    main.editor.setActiveContext(local, '/home/me/local');
    expect(deps.platform.editor.getActiveContext()).toEqual(empty);
    const heard: unknown[] = [];
    deps.platform.editor.onDidChangeActiveContext((context) => heard.push(context));
    main.editor.setActiveContext(own, 'loopback|/srv/app');
    expect(deps.platform.editor.getActiveContext()).toEqual(own);
    main.editor.setActiveContext(local, '/home/me/local');
    main.editor.setActiveContext(own, 'ssh+h1|/srv/app');
    main.editor.setActiveContext(local);
    main.editor.setActiveContext(undefined);
    expect(heard).toEqual([own, empty, empty, empty, undefined]);
  });

  it('shows a chat review of this core by its core panel id, a Markdown preview of the text it sent, and the host\'s settings file', async () => {
    const { deps, reviews, previews, settingsFiles } = services();
    await deps.platform.editor.showChatReview('host-3', 'turn');
    await deps.platform.editor.showMarkdownPreview('/tmp/damocles-system-prompt.md', { panelId: 'host-3', content: '# Prompt' });
    await expect(deps.platform.editor.showMarkdownPreview('/tmp/damocles-system-prompt.md')).rejects.toThrow('not available');
    await deps.platform.editor.openSettingsFile('user', { key: 'damocles.model' });
    expect(reviews).toEqual([['host-3', 'turn']]);
    expect(previews).toEqual([['/tmp/damocles-system-prompt.md', '# Prompt']]);
    expect(settingsFiles).toEqual([['user', 'damocles.model']]);
  });

  it('opens a target file through the authority\'s projects and refuses one outside them', async () => {
    const { deps, opened } = services();
    await deps.platform.editor.openFile('/srv/app/src/a.ts', { line: 3 });
    expect(opened).toEqual([['loopback|/srv/app', 'src/a.ts', 3, true]]);
    // a reply to the core never names the host as this computer calls it
    await expect(deps.platform.editor.openFile('/home/me/.ssh/id_rsa')).rejects.toThrow(new Error('/home/me/.ssh/id_rsa is not in an open project'));
    await expect(deps.platform.editor.readText('/etc/passwd')).rejects.toThrow(new Error('/etc/passwd is not in an open project'));
    await expect(deps.platform.editor.readText('/srv/app/a.ts')).resolves.toBe('text');
  });

  it('shows notifications through the host-labeled notices, never this computer\'s own', async () => {
    const { deps, main, notices } = services();
    const info = vi.spyOn(main.notifications, 'info');
    await deps.platform.notifications.info('Pushed');
    expect(notices).toEqual(['Pushed']);
    expect(info).not.toHaveBeenCalled();
  });

  it('hands a diff to main\'s remote diff, which resolves its paths inside the host\'s projects', async () => {
    const { deps, diffs } = services();
    await deps.platform.editor.showDiff({ title: (name) => name, filePath: '/srv/app/a.ts', left: { path: '/srv/app/a.ts' }, right: { name: 'a.ts', content: 'x' }, purpose: 'proposal' });
    expect(diffs).toEqual(['/srv/app/a.ts']);
  });

  it('shows a target log by name through the host\'s log reader', () => {
    const { deps, shown } = services();
    deps.ui.showLog('Git', false);
    expect(shown).toEqual([['Git', false]]);
  });
});

describe('namespacedSecrets', () => {
  it('uses only keys under remote/<hostId>/ and lists only those', async () => {
    const { main } = services();
    await main.secrets.store('remote/loopback/token', 'a');
    await main.secrets.store('openai-api-key', 'sk');
    await main.secrets.store('remote/other/token', 'b');
    const secrets = namespacedSecrets(main.secrets, 'loopback', () => undefined);
    await expect(secrets.get('remote/loopback/token')).resolves.toBe('a');
    await expect(secrets.get('openai-api-key')).rejects.toThrow('remote/loopback/');
    await expect(secrets.get('remote/other/token')).rejects.toThrow('remote/loopback/');
    await expect(secrets.store('remote/loopback', 'x')).rejects.toThrow('remote/loopback/');
    await expect(secrets.delete('openai-api-key')).rejects.toThrow();
    await expect(secrets.keys()).resolves.toEqual(['remote/loopback/token']);
  });

  it('logs the name of each secret it refuses, never a value', async () => {
    const { deps, logged } = services();
    await expect(deps.platform.secrets.get('openai-api-key')).rejects.toThrow('remote/loopback/');
    await expect(deps.platform.secrets.store('anthropic-api-key', 'sk-never-logged')).rejects.toThrow('remote/loopback/');
    expect(logged).toEqual([
      '[remote] refused the secret "openai-api-key" to the core of host loopback',
      '[remote] refused the secret "anthropic-api-key" to the core of host loopback',
    ]);
  });
});

describe('clientState', () => {
  it('shows a remote core only the client state keys and never writes', async () => {
    const { deps } = services();
    expect(deps.state.snapshot('global')).toEqual({ userLanguagePreference: 'el' });
    expect(deps.state.global.get('damocles.secretThing')).toBeUndefined();
    expect(deps.state.global.get('userLanguagePreference')).toBe('el');
    await expect(deps.state.global.update('userLanguagePreference', 'en')).rejects.toThrow('not available');
  });
});
