import * as path from 'node:path';
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

const none = (): Disposable => ({ dispose: () => undefined });
const PROJECT = { key: 'loopback|/srv/app', fsPath: '/srv/app', name: 'app' };

function services(wslDistro?: string, openPlan: (targetPath: string) => Promise<boolean> = async () => false) {
  const main = createFakePlatform({ chatBrowserPane: true });
  const logged: string[] = [];
  const reviews: unknown[] = [];
  const previews: unknown[] = [];
  const settingsFiles: unknown[] = [];
  const opened: unknown[] = [];
  const plans: unknown[] = [];
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
    openLink: async (url) => {
      links.push(url);
      return false;
    },
    platform: main,
    runProcess: async (spec) => {
      runs.push(spec);
    },
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
    openPlan: async (...args) => {
      plans.push(args);
      return openPlan(args[0]);
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
  return { deps, main, opened, plans, shown, notices, diffs, logged, reviews, previews, settingsFiles, picks, links, runs };
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

  it('opens a path outside the host\'s projects only through the host\'s plans rule, and refuses every other one as before', async () => {
    const plan = '/home/me/.damocles/plans/fix-it-0123abcd.md';
    const accepted = services(undefined, async (target) => target === plan);
    await accepted.deps.platform.editor.openFile(plan, { line: 4, preserveFocus: true });
    expect(accepted.plans).toEqual([[plan, 4, false]]);
    expect(accepted.opened).toEqual([]);
    for (const target of ['/home/me/.bashrc', '/home/me/.damocles/plans/notes.txt']) {
      await expect(accepted.deps.platform.editor.openFile(target)).rejects.toThrow(new Error(`${target} is not in an open project`));
    }
    // a project file never reaches the plans rule
    await accepted.deps.platform.editor.openFile('/srv/app/src/a.ts');
    expect(accepted.plans.map((args) => (args as unknown[])[0])).toEqual([plan, '/home/me/.bashrc', '/home/me/.damocles/plans/notes.txt']);
    expect(accepted.opened).toEqual([['loopback|/srv/app', 'src/a.ts', undefined, true]]);
  });

  it('refuses a plan path as before when the host\'s daemon does not carry files outside its projects, and says why in the log', async () => {
    const plan = '/home/me/.damocles/plans/fix-it-0123abcd.md';
    const { deps, logged } = services(undefined, async () => { throw new OutsideFilesUnsupportedError('loopback'); });
    await expect(deps.platform.editor.openFile(plan)).rejects.toThrow(new Error(`${plan} is not in an open project`));
    expect(logged).toEqual([`[remote] loopback's daemon opens no file outside its projects, so ${plan} stays closed`]);
    const failing = services(undefined, async () => { throw new Error('the connection ended'); });
    await expect(failing.deps.platform.editor.openFile(plan)).rejects.toThrow('the connection ended');
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
