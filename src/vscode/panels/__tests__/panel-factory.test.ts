import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  groups: [] as Array<{ viewColumn: number | undefined; tabs: Array<{ input: unknown }> }>,
  executeCommand: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode') & Record<string, unknown>>();
  class TabInputWebview {
    readonly viewType: string;
    constructor(viewType: string) {
      this.viewType = viewType;
    }
  }
  return {
    ...actual,
    TabInputWebview,
    ViewColumn: { ...actual.ViewColumn, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
    commands: { ...actual.commands, executeCommand: H.executeCommand },
    window: {
      ...actual.window,
      createWebviewPanel: vi.fn(actual.window.createWebviewPanel),
      tabGroups: { get all() { return H.groups; } },
    },
  };
});

import * as vscode from 'vscode';
import { __webviewPanels } from 'vscode';
import { createPanel, createPanelInOwnColumn } from '../panel-factory';

const webviewTab = (viewType: string) => ({ input: new (vscode as unknown as { TabInputWebview: new (v: string) => unknown }).TabInputWebview(viewType) });
const textTab = () => ({ input: {} });
const createCalls = () => vi.mocked(vscode.window.createWebviewPanel).mock.calls;

beforeEach(() => {
  H.groups = [];
  H.executeCommand.mockClear();
  vi.mocked(vscode.window.createWebviewPanel).mockClear();
  __webviewPanels.length = 0;
});

describe('createPanel, browser kind', () => {
  // A hidden browser tab must cost no renderer, and a page may load nothing from the extension.
  it('creates the webview with scripts, no resource roots and no retained context, in the active column without focus', () => {
    createPanel({ kind: 'browser', title: 'example.com', localResourceRoots: [] });

    expect(createCalls()).toHaveLength(1);
    const [viewType, title, showOptions, options] = createCalls()[0]!;
    expect(viewType).toBe('damocles-browser-view');
    expect(title).toBe('example.com');
    expect(showOptions).toEqual({ viewColumn: vscode.ViewColumn.Active, preserveFocus: true });
    expect(options).toEqual({ enableScripts: true, localResourceRoots: [] });
    expect(options).not.toHaveProperty('retainContextWhenHidden');
  });

  it('opens in the column it is given', () => {
    createPanel({ kind: 'browser', title: 't', localResourceRoots: [], column: 3 });

    expect(createCalls()[0]![2]).toEqual({ viewColumn: 3, preserveFocus: true });
  });
});

describe('createPanel, chat kind', () => {
  it('creates a retained chat webview limited to the given roots, taking focus', () => {
    createPanel({ kind: 'chat', title: 'Damocles', localResourceRoots: ['/ext/dist/webview', '/ext/resources'], column: 2 });

    const [viewType, title, showOptions, options] = createCalls()[0]!;
    expect(viewType).toBe('damocles.chat');
    expect(title).toBe('Damocles');
    expect(showOptions).toEqual({ viewColumn: 2, preserveFocus: false });
    expect(options).toEqual({
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file('/ext/dist/webview'), vscode.Uri.file('/ext/resources')],
    });
  });

  it('opens a fork with no source column in the active column', () => {
    createPanel({ kind: 'chat', title: 'Damocles', localResourceRoots: [] });

    expect(createCalls()[0]![2]).toEqual({ viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
  });
});

describe('createPanelInOwnColumn', () => {
  it('reuses a column holding only chat panels and does not lock it again', async () => {
    H.groups = [
      { viewColumn: 1, tabs: [textTab()] },
      { viewColumn: 2, tabs: [webviewTab('mainThreadWebview-damocles.chat'), webviewTab('mainThreadWebview-damocles.chat')] },
    ];

    await createPanelInOwnColumn({ kind: 'chat', title: 'Damocles', localResourceRoots: [] });

    expect(createCalls()[0]![2]).toEqual({ viewColumn: 2, preserveFocus: false });
    expect(H.executeCommand).not.toHaveBeenCalled();
  });

  it('skips a column that mixes a chat panel with anything else, and an empty one', async () => {
    H.groups = [
      { viewColumn: 1, tabs: [] },
      { viewColumn: 2, tabs: [webviewTab('mainThreadWebview-damocles.chat'), textTab()] },
    ];

    await createPanelInOwnColumn({ kind: 'chat', title: 'Damocles', localResourceRoots: [] });

    expect(createCalls()[0]![2]).toEqual({ viewColumn: 3, preserveFocus: false });
    expect(H.executeCommand).toHaveBeenCalledWith('workbench.action.lockEditorGroup');
  });

  it('opens the first unused column and locks its group before resolving', async () => {
    H.groups = [{ viewColumn: 1, tabs: [textTab()] }, { viewColumn: 3, tabs: [textTab()] }];
    let lockedBeforeResolve = false;
    H.executeCommand.mockImplementationOnce(async () => { lockedBeforeResolve = true; });

    const host = await createPanelInOwnColumn({ kind: 'chat', title: 'Damocles', localResourceRoots: [] });

    expect(createCalls()[0]![2]).toEqual({ viewColumn: 2, preserveFocus: false });
    expect(H.executeCommand).toHaveBeenCalledTimes(1);
    expect(lockedBeforeResolve).toBe(true);
    expect(host.column).toBe(__webviewPanels[0]!.viewColumn);
  });

  it('opens beside when all nine columns are taken', async () => {
    H.groups = Array.from({ length: 9 }, (_, i) => ({ viewColumn: i + 1, tabs: [textTab()] }));

    await createPanelInOwnColumn({ kind: 'chat', title: 'Damocles', localResourceRoots: [] });

    expect(createCalls()[0]![2]).toEqual({ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
  });
});
