import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  executeCommand: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
  openExternal: vi.fn((..._args: unknown[]) => Promise.resolve(true)),
  writeText: vi.fn((..._args: unknown[]) => Promise.resolve()),
  createOutputChannel: vi.fn((name: string) => ({ name, appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
  showOpenDialog: vi.fn((..._args: unknown[]): Promise<Array<{ fsPath: string }> | undefined> => Promise.resolve(undefined)),
  showInputBox: vi.fn((..._args: unknown[]): Promise<string | undefined> => Promise.resolve(undefined)),
  showQuickPick: vi.fn((..._args: unknown[]): Promise<{ id: string } | undefined> => Promise.resolve(undefined)),
  showInformationMessage: vi.fn((..._args: unknown[]) => Promise.resolve<string | undefined>(undefined)),
  showWarningMessage: vi.fn((..._args: unknown[]) => Promise.resolve<string | undefined>(undefined)),
  showErrorMessage: vi.fn((..._args: unknown[]) => Promise.resolve<string | undefined>(undefined)),
  l10nT: vi.fn((message: string, ..._args: unknown[]) => `t:${message}`),
  language: 'el',
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode') & Record<string, unknown>>();
  class CancellationTokenSource {
    private listeners: Array<() => void> = [];
    disposed = false;
    token = {
      isCancellationRequested: false,
      onCancellationRequested: (cb: () => void) => {
        this.listeners.push(cb);
        return { dispose: () => undefined };
      },
    };
    cancel(): void {
      this.token.isCancellationRequested = true;
      this.listeners.forEach((cb) => cb());
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return {
    ...actual,
    CancellationTokenSource,
    l10n: { t: H.l10nT },
    env: { ...actual.env, openExternal: H.openExternal, clipboard: { writeText: H.writeText }, get language() { return H.language; } },
    commands: { ...actual.commands, executeCommand: H.executeCommand },
    window: {
      ...actual.window,
      createOutputChannel: H.createOutputChannel,
      showOpenDialog: H.showOpenDialog,
      showInputBox: H.showInputBox,
      showQuickPick: H.showQuickPick,
      showInformationMessage: H.showInformationMessage,
      showWarningMessage: H.showWarningMessage,
      showErrorMessage: H.showErrorMessage,
    },
  };
});

import * as vscode from 'vscode';
import { createVsCodeShellService } from '../shell-service';
import { createVsCodeClipboardService } from '../clipboard-service';
import { createVsCodeHostLifecycle } from '../host-lifecycle';
import { createVsCodeLogSinkFactory } from '../log-sink-factory';
import { createVsCodeLocalizationService } from '../localization-service';
import { createVsCodeDialogService } from '../dialog-service';
import { createVsCodeNotificationService } from '../notification-service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('shell', () => {
  it('opens a web url in its canonical form, a folder as a file uri, and reveals a path in the explorer', async () => {
    const shell = createVsCodeShellService();
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-shell-'));

    await expect(shell.openExternal('HTTPS://Example.test/a b?b=1')).resolves.toBe(true);
    await expect(shell.openFolder(folder)).resolves.toBe(true);
    await shell.revealPath('/ws/src');

    expect(H.openExternal).toHaveBeenNthCalledWith(1, vscode.Uri.parse('https://example.test/a%20b?b=1'));
    expect(H.openExternal).toHaveBeenNthCalledWith(2, vscode.Uri.file(folder));
    expect(H.executeCommand).toHaveBeenCalledWith('revealInExplorer', vscode.Uri.file('/ws/src'));
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it.each(['file:///etc/passwd', 'vscode://settings', 'javascript:alert(1)', 'command:workbench.action.reloadWindow', 'not a url'])('declines %s, as the desktop host does', async (url) => {
    await expect(createVsCodeShellService().openExternal(url)).resolves.toBe(false);
    expect(H.openExternal).not.toHaveBeenCalled();
  });

  it('opens a folder but never a file, which the OS would launch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-shell-'));
    const script = path.join(dir, 'run.bat');
    fs.writeFileSync(script, 'echo hi');
    await expect(createVsCodeShellService().openFolder(script)).resolves.toBe(false);
    await expect(createVsCodeShellService().openFolder(path.join(dir, 'missing'))).resolves.toBe(false);
    expect(H.openExternal).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('clipboard, lifecycle, log sinks, localization', () => {
  it('writes the clipboard, reloads the window and creates a named output channel', async () => {
    await createVsCodeClipboardService().writeText('copied');
    await createVsCodeHostLifecycle().reload();
    const sink = createVsCodeLogSinkFactory().create('Damocles Voice');

    expect(H.writeText).toHaveBeenCalledWith('copied');
    expect(H.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
    expect(H.createOutputChannel).toHaveBeenCalledWith('Damocles Voice');
    expect(sink).toBe(H.createOutputChannel.mock.results[0]!.value);
  });

  it('translates through vscode.l10n.t with positional args and reads the display language on each access', () => {
    const l10n = createVsCodeLocalizationService();

    expect(l10n.t('Switch to {0}? {1}', 'beta', 2)).toBe('t:Switch to {0}? {1}');
    expect(H.l10nT).toHaveBeenCalledWith('Switch to {0}? {1}', 'beta', 2);
    expect(l10n.language).toBe('el');
    H.language = 'en';
    expect(l10n.language).toBe('en');
  });
});

describe('dialogs', () => {
  it('picks one file with the filters, title and folder the caller gives', async () => {
    H.showOpenDialog.mockResolvedValueOnce([{ fsPath: '/ws/plan.md' }]);

    const picked = await createVsCodeDialogService().pickFile({ filters: { Markdown: ['md'] }, title: 'Select', defaultPath: '/ws' });

    expect(picked).toBe('/ws/plan.md');
    expect(H.showOpenDialog).toHaveBeenCalledWith({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Markdown: ['md'] },
      title: 'Select',
      defaultUri: vscode.Uri.file('/ws'),
    });
  });

  it('resolves undefined when the pick is cancelled or empty', async () => {
    const dialogs = createVsCodeDialogService();
    H.showOpenDialog.mockResolvedValueOnce(undefined);
    await expect(dialogs.pickFile({})).resolves.toBeUndefined();
    H.showOpenDialog.mockResolvedValueOnce([]);
    await expect(dialogs.pickFile({})).resolves.toBeUndefined();
  });

  it('passes only the input box options the caller set', async () => {
    H.showInputBox.mockResolvedValueOnce('sk-key');

    const value = await createVsCodeDialogService().inputBox({ prompt: 'Key', password: true, placeholder: '' });

    expect(value).toBe('sk-key');
    expect(H.showInputBox.mock.calls[0]![0]).toEqual({ prompt: 'Key', password: true, placeHolder: '' });
    expect(H.showInputBox.mock.calls[0]![0]).not.toHaveProperty('ignoreFocusOut');
  });

  it('dismisses the box when the signal aborts, then disposes the token source', async () => {
    let token!: { isCancellationRequested: boolean; onCancellationRequested(cb: () => void): unknown };
    H.showInputBox.mockImplementationOnce((_opts, t) => new Promise((resolve) => {
      token = t as typeof token;
      token.onCancellationRequested(() => resolve(undefined));
    }));
    const abort = new AbortController();

    const pending = createVsCodeDialogService().inputBox({ prompt: 'Code', ignoreFocusOut: true }, abort.signal);
    abort.abort();

    await expect(pending).resolves.toBeUndefined();
    expect(token.isCancellationRequested).toBe(true);
  });

  it('opens an already dismissed box for an already aborted signal', async () => {
    const abort = new AbortController();
    abort.abort();

    await createVsCodeDialogService().inputBox({ prompt: 'Code' }, abort.signal);

    const token = H.showInputBox.mock.calls[0]![1] as { isCancellationRequested: boolean };
    expect(token.isCancellationRequested).toBe(true);
  });

  it('shows a quick pick of the items and resolves the picked item id', async () => {
    H.showQuickPick.mockImplementationOnce((items) => Promise.resolve((items as Array<{ id: string }>)[1]));

    const picked = await createVsCodeDialogService().quickPick(
      [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', description: 'second', detail: 'more' }],
      { title: 'Pick', placeholder: 'Type to filter' },
    );

    expect(picked).toBe('b');
    expect(H.showQuickPick.mock.calls[0]![0]).toEqual([{ label: 'Alpha', id: 'a' }, { label: 'Beta', id: 'b', description: 'second', detail: 'more' }]);
    expect(H.showQuickPick.mock.calls[0]![1]).toEqual({ title: 'Pick', placeHolder: 'Type to filter' });
  });

  it('dismisses the quick pick when the signal aborts', async () => {
    H.showQuickPick.mockImplementationOnce((_items, _opts, t) => new Promise((resolve) => {
      (t as { onCancellationRequested(cb: () => void): unknown }).onCancellationRequested(() => resolve(undefined));
    }));
    const abort = new AbortController();

    const pending = createVsCodeDialogService().quickPick([{ id: 'a', label: 'Alpha' }], {}, abort.signal);
    abort.abort();

    await expect(pending).resolves.toBeUndefined();
  });
});

describe('notifications', () => {
  it('passes a modal prompt through as vscode MessageOptions with its actions', async () => {
    H.showWarningMessage.mockResolvedValueOnce('Delete');

    const choice = await createVsCodeNotificationService().warn('Remove everything?', { modal: true }, 'Delete');

    expect(choice).toBe('Delete');
    expect(H.showWarningMessage).toHaveBeenCalledWith('Remove everything?', { modal: true }, 'Delete');
  });

  it('passes a plain message and its actions with no options argument', async () => {
    const notifications = createVsCodeNotificationService();

    await notifications.info('Saved', 'Open', 'Dismiss');
    await notifications.error('Failed');

    expect(H.showInformationMessage).toHaveBeenCalledWith('Saved', 'Open', 'Dismiss');
    expect(H.showErrorMessage).toHaveBeenCalledWith('Failed');
    expect(H.showErrorMessage.mock.calls[0]).toHaveLength(1);
  });
});
