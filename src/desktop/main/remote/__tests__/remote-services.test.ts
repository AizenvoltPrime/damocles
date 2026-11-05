import { describe, expect, it, vi } from 'vitest';
import { NO_USER_RELAYS } from '../../core-services/host-services';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { SpawnSpec } from '../../../../core/process-launcher';
import { windowsExplorer } from '../../../../core/system-tools';
import type { Disposable } from '../../../../platform/disposable';
import { hostExtras } from '../../core-services/__tests__/host-deps';
import { createDesktopNotificationService } from '../../platform/notification-service';
import { namespacedSecrets, remoteServices } from '../remote-services';
import { OutsideFilesUnsupportedError } from '../../workspace/remote-workspace';
import { RefusedPathError } from '../../documents/document-service';
import { LocalizedError } from '../../../../shared/localized-text';
import { ERROR_CODEC } from '../../../core-protocol/errors';

const none = (): Disposable => ({ dispose: () => undefined });
const PROJECT = { key: 'loopback|/srv/app', fsPath: '/srv/app', name: 'app' };

function services(wslDistro?: string, openNamed: (targetPath: string) => Promise<void> = async () => undefined) {
  const main = createFakePlatform({ chatBrowserPane: true });
  const logged: string[] = [];
  const reviews: unknown[] = [];
  const previews: unknown[] = [];
  const settingsFiles: unknown[] = [];
  const opened: unknown[] = [];
  const reads: string[] = [];
  const shown: unknown[] = [];
  const notices: unknown[] = [];
  const diffs: unknown[] = [];
  const picks: unknown[] = [];
  const links: string[] = [];
  const runs: SpawnSpec[] = [];
  const deps = remoteServices({
    authority: 'loopback',
    hostId: 'loopback',
    ...(wslDistro !== undefined ? { wslDistro } : {}),
    hostName: () => 'Local daemon',
    os: () => 'linux',
    openLink: async (url) => {
      links.push(url);
      return false;
    },
    // this computer's editor withholds a host's context from this computer's core, so only the pane's reaches a remote core
    platform: { ...main, editor: { ...main.editor, getActiveContext: () => ({ filePath: undefined, selection: undefined }), onDidChangeActiveContext: () => none() } },
    runProcess: async (spec) => {
      runs.push(spec);
    },
    projects: () => [PROJECT],
    fileRoots: () => [PROJECT],
    onProjectsChanged: none,
    workspace: () => ({
      files: {
        readText: async (target: string) => {
          reads.push(target);
          return 'text';
        },
      },
    }) as never,
    // the pane's own context of any machine, which the platform's editor already filters for this computer's core
    activeContext: () => main.editor.getActiveContext(),
    onDidChangeActiveContext: (listener) => main.editor.onDidChangeActiveContext(listener),
    trust: { trustedKeys: () => [], onDidGrant: none, requestTrust: async () => false },
    openNamedPath: async (...args) => {
      opened.push(args);
      await openNamed(args[0]);
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
    notices: createDesktopNotificationService({
      notice: async (_severity, message) => {
        notices.push(message);
        return undefined;
      },
      ask: async () => undefined,
      t: (message) => message,
      log: () => undefined,
    }),
    user: { ...NO_USER_RELAYS, credentials: async () => ({ type: 'none' }), speak: async () => undefined, gitCredential: async () => ({ kind: 'none' }), browserTool: async () => ({ content: [] }) },
    base: { terminalToggle: () => ({ shown: false, shortcut: '' }), createView: () => { throw new Error('no view'); }, git: { available: true }, e2eHooks: false, ...hostExtras(), log: (line) => logged.push(line) },
    t: (message, ...args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message),
  });
  return { deps, main, opened, reads, shown, notices, diffs, logged, reviews, previews, settingsFiles, picks, links, runs };
}

describe('a remote core\'s services', () => {
  it('refuses a clipboard write, a reload, the trash and a proxy lookup', async () => {
    const { deps } = services();
    await expect(deps.platform.clipboard.writeText('x')).rejects.toThrow('not available to a remote core');
    await expect(deps.platform.lifecycle.reload()).rejects.toThrow('not available');
    await expect(deps.ui.trash('/srv/app/a.ts')).rejects.toThrow('not available');
    await expect(deps.resolveProxy('https://example.com')).rejects.toThrow('not available');
  });

  it("sends the core's own openExternal to the link checks that always ask, never straight to this computer's browser", async () => {
    const { deps, main, links } = services();
    const openExternal = vi.spyOn(main.shell, 'openExternal');
    await expect(deps.platform.shell.openExternal('http://localhost:8085/cb')).resolves.toBe(false);
    expect(links).toEqual(['http://localhost:8085/cb']);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('answers false for a folder or path of the target the OS file manager would show, and a picker opens the folder browser of the host, never a native dialog', async () => {
    const { deps, main, notices, picks, runs } = services();
    const openFolder = vi.spyOn(main.shell, 'openFolder');
    const revealPath = vi.spyOn(main.shell, 'revealPath');
    const pickFolder = vi.spyOn(main.dialogs, 'pickFolder');
    await expect(deps.platform.shell.openFolder('/srv/app')).resolves.toBe(false);
    await expect(deps.platform.shell.revealPath('/srv/app/a.ts')).resolves.toBeUndefined();
    const pickFile = vi.spyOn(main.dialogs, 'pickFile');
    await expect(deps.platform.dialogs.pickFolder({ title: { message: 'x' }, defaultPath: '/srv/app', buttonLabel: { message: 'Use' } })).resolves.toBeUndefined();
    await expect(deps.platform.dialogs.pickFile({ title: { message: 'y' }, defaultPath: '/srv/app', filters: { Markdown: ['md'] } })).resolves.toBe('/srv/app/plan.md');
    expect(picks).toEqual([
      ['folder', { title: 'x', defaultPath: '/srv/app', buttonLabel: 'Use' }],
      ['file', { title: 'y', defaultPath: '/srv/app', extensions: ['md'] }],
    ]);
    expect(notices).toEqual([]);
    expect(pickFile).not.toHaveBeenCalled();
    expect(openFolder).not.toHaveBeenCalled();
    expect(revealPath).not.toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
    expect(runs).toEqual([]);
  });

  // Explorer runs a file named on its command line, even after /e, or /root,; /select only selects it
  it('selects a WSL distro\'s folder inside its projects in File Explorer through \\\\wsl.localhost, never opening the path, and no other target path', async () => {
    const { deps, main, runs } = services('Ubuntu-24.04');
    const openFolder = vi.spyOn(main.shell, 'openFolder').mockResolvedValue(true);
    const revealPath = vi.spyOn(main.shell, 'revealPath').mockResolvedValue();
    await expect(deps.platform.shell.openFolder('/srv/app')).resolves.toBe(true);
    await deps.platform.shell.revealPath('/srv/app/src/a.ts');
    expect(runs).toEqual([{ file: windowsExplorer(), args: ['/select,"\\\\wsl.localhost\\Ubuntu-24.04\\srv\\app"'], windowsVerbatimArguments: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }]);
    expect(revealPath).toHaveBeenCalledWith('\\\\wsl.localhost\\Ubuntu-24.04\\srv\\app\\src\\a.ts');
    await expect(deps.platform.shell.openFolder('/etc')).resolves.toBe(false);
    await deps.platform.shell.revealPath('/srv/app/../../etc/passwd');
    // a quote would end the verbatim argument
    await expect(deps.platform.shell.openFolder('/srv/app/x" /root,"C:')).resolves.toBe(false);
    expect(runs).toHaveLength(1);
    expect(openFolder).not.toHaveBeenCalled();
    expect(revealPath).toHaveBeenCalledTimes(1);
  });

  it('shows the active editor\'s context only while it shows a file of this host, project or not, at attach and on every change', () => {
    const { deps, main } = services();
    const local = { filePath: '/home/me/local/secret.ts', selection: { text: 'API_KEY=sk-local', startLine: 1, endLine: 1 } };
    const own = { filePath: '/srv/app/a.ts', selection: { text: 'export const a', startLine: 1, endLine: 1 } };
    const bashrc = { filePath: '/home/me/.bashrc', selection: undefined };
    const empty = { filePath: undefined, selection: undefined };
    main.editor.setActiveContext(local, '/home/me/local');
    expect(deps.platform.editor.getActiveContext()).toEqual(empty);
    const heard: unknown[] = [];
    deps.platform.editor.onDidChangeActiveContext((context) => heard.push(context));
    main.editor.setActiveContext(own, 'loopback|/srv/app');
    expect(deps.platform.editor.getActiveContext()).toEqual(own);
    expect(deps.platform.editor.activeAuthority()).toBe('loopback');
    main.editor.setActiveContext(bashrc, undefined, 'loopback');
    expect(deps.platform.editor.getActiveContext()).toEqual(bashrc);
    expect(deps.platform.editor.activeProjectKey()).toBeUndefined();
    main.editor.setActiveContext(local, '/home/me/local');
    expect(deps.platform.editor.activeAuthority()).toBeUndefined();
    main.editor.setActiveContext(own, 'ssh+h1|/srv/app');
    main.editor.setActiveContext(bashrc, undefined, 'ssh+h1');
    main.editor.setActiveContext(local);
    main.editor.setActiveContext(undefined);
    expect(heard).toEqual([own, bashrc, empty, empty, empty, empty, undefined]);
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

  it('opens any host path through the host\'s workspace, never on this computer, and passes its refusal on as it is', async () => {
    const refusal = new RefusedPathError('/mnt/share/x', 'share');
    const { deps, opened } = services(undefined, async (target) => {
      if (target === '/mnt/share/x') throw refusal;
    });
    await deps.platform.editor.openFile('/srv/app/src/a.ts', { line: 3 });
    await deps.platform.editor.openFile('/home/me/.bashrc', { line: 4, preserveFocus: true });
    expect(opened).toEqual([['/srv/app/src/a.ts', 3, true], ['/home/me/.bashrc', 4, false]]);
    // a reply to the core never names the host as this computer calls it, and reaches it as a LocalizedError
    const refused = await deps.platform.editor.openFile('/mnt/share/x').catch((err: unknown) => err as Error);
    expect(refused).toBe(refusal);
    expect(refusal.message).not.toContain('Local daemon');
    const crossed = ERROR_CODEC.decode(ERROR_CODEC.encode(refused, () => undefined)!, 'editor.openFile');
    expect(crossed).toBeInstanceOf(LocalizedError);
    expect((crossed as LocalizedError).text).toEqual(refusal.text);
  });

  it('reads the text of any absolute host path through the host, and refuses a relative one', async () => {
    const { deps, reads } = services();
    await expect(deps.platform.editor.readText('/etc/passwd')).resolves.toBe('text');
    await expect(deps.platform.editor.readText('/srv/app/a.ts')).resolves.toBe('text');
    await expect(deps.platform.editor.readText('notes.txt')).rejects.toThrow('notes.txt is not an absolute path');
    expect(reads).toEqual(['/etc/passwd', '/srv/app/a.ts']);
  });

  it('answers an old server\'s missing outside routes with an error that names no host, and says why in the log', async () => {
    const { deps, logged } = services(undefined, async () => { throw new OutsideFilesUnsupportedError('loopback'); });
    const older = await deps.platform.editor.openFile('/home/me/.bashrc').catch((err: unknown) => err);
    expect(older).toBeInstanceOf(LocalizedError);
    expect((older as LocalizedError).text).toEqual({ message: 'The Damocles server is older than this app and opens no file outside its projects.' });
    expect(logged).toEqual(['[remote] loopback\'s daemon opens no file outside its projects, so /home/me/.bashrc stays closed']);
    const failing = services(undefined, async () => { throw new Error('the connection ended'); });
    await expect(failing.deps.platform.editor.openFile('/home/me/.bashrc')).rejects.toThrow('the connection ended');
  });

  it('shows notifications through the host-labeled notices, never this computer\'s own', async () => {
    const { deps, main, notices } = services();
    const info = vi.spyOn(main.notifications, 'info');
    await deps.platform.notifications.info({ message: 'Pushed' });
    expect(notices).toEqual(['Pushed']);
    expect(info).not.toHaveBeenCalled();
  });

  it('hands a diff to main\'s remote diff, which resolves its paths inside the host\'s projects', async () => {
    const { deps, diffs } = services();
    await deps.platform.editor.showDiff({ title: (name) => ({ message: '{0}', args: [name] }), filePath: '/srv/app/a.ts', left: { path: '/srv/app/a.ts' }, right: { name: 'a.ts', content: 'x' }, purpose: 'proposal' });
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

describe('the key-value state', () => {
  // a remote core's state is its daemon's own, and a device's language reaches it as clientLanguage
  it('shows a remote core none of this computer\'s state and takes no write', async () => {
    const { deps } = services();
    expect(deps.state.snapshot('global')).toEqual({});
    expect(deps.state.global.get('userLanguagePreference')).toBeUndefined();
    await expect(deps.state.global.update('userLanguagePreference', 'en')).rejects.toThrow('not available');
  });
});
