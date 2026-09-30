import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createEditorHandlers } from '../editor-handlers';
import { useEditorStore } from '@/stores/useEditorStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { HandlerContext } from '../../types';
import { VSCODE_HOST_CAPABILITIES, type EditorDocument, type ExtensionToWebviewMessage } from '@shared/types/messages';

const text = (content: string): EditorDocument => ({ name: 'a.ts', path: '/w/a.ts', body: { kind: 'text', content, languageId: 'typescript' } });

const MESSAGES: ExtensionToWebviewMessage[] = [
  { type: 'editorShowDiff', viewId: 'v1', title: 'a.ts', purpose: 'proposal', approvalId: 'tool-1', original: text('a'), modified: text('b') },
  { type: 'editorOpenFile', viewId: 'v2', title: 'a.ts', document: text('a'), line: 3 },
  { type: 'editorCloseView', viewId: 'v2' },
  { type: 'settingsFileContent', file: { scope: 'user', status: 'ready', path: '/h/.damocles/settings.json', exists: true, content: '{}', version: 'abc' } },
  { type: 'settingsFileSaveResult', scope: 'user', ok: true, version: 'def' },
  { type: 'settingsFileChanged', scope: 'user', version: 'ghi' },
  { type: 'settingsFileAvailability', files: { user: { available: true }, project: { available: false, reason: 'untrusted' }, local: { available: false, reason: 'untrusted' } } },
];

function dispatch(msg: ExtensionToWebviewMessage): void {
  const ctx = { stores: { settingsStore: useSettingsStore() } } as unknown as HandlerContext;
  const handler = createEditorHandlers()[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no editor handler for ${msg.type}`);
  handler(msg, ctx);
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

describe('editor handlers', () => {
  it('ignore every editor and settings-file message while the host has monaco off, and say so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const msg of MESSAGES) dispatch(msg);

    const store = useEditorStore();
    expect(store.view).toBeNull();
    expect(store.hasOpenOverlay).toBe(false);
    expect(store.settingsFiles).toEqual({});
    expect(store.saveResults).toEqual({});
    expect(store.changedVersions).toEqual({});
    expect(store.settingsFileAvailability).toBeNull();
    expect(warn).toHaveBeenCalledTimes(MESSAGES.length);
  });

  it('route each message into the store once monaco is on', () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, monaco: true, settingsSources: true });
    const store = useEditorStore();

    dispatch(MESSAGES[0]!);
    expect(store.view).toMatchObject({ kind: 'diff', viewId: 'v1', purpose: 'proposal', approvalId: 'tool-1' });

    dispatch(MESSAGES[3]!);
    dispatch(MESSAGES[4]!);
    dispatch(MESSAGES[5]!);
    dispatch(MESSAGES[6]!);
    expect(store.settingsFiles.user).toMatchObject({ status: 'ready', version: 'abc' });
    expect(store.saveResults.user).toEqual({ ok: true, version: 'def' });
    expect(store.changedVersions.user).toEqual({ version: 'ghi' });
    expect(store.settingsFileAvailability?.project).toEqual({ available: false, reason: 'untrusted' });
  });
});

describe('editor store', () => {
  it('keeps one host view: a new request replaces the open one', () => {
    const store = useEditorStore();
    store.showDiff(MESSAGES[0] as Extract<ExtensionToWebviewMessage, { type: 'editorShowDiff' }>);
    store.openFile(MESSAGES[1] as Extract<ExtensionToWebviewMessage, { type: 'editorOpenFile' }>);

    expect(store.view).toMatchObject({ kind: 'file', viewId: 'v2', line: 3 });
  });

  it('closes only the view the host names, so a stale close leaves its replacement open', () => {
    const store = useEditorStore();
    store.showDiff(MESSAGES[0] as Extract<ExtensionToWebviewMessage, { type: 'editorShowDiff' }>);
    store.openFile(MESSAGES[1] as Extract<ExtensionToWebviewMessage, { type: 'editorOpenFile' }>);

    store.closeView('v1');
    expect(store.view?.viewId).toBe('v2');
    store.closeView('v2');
    expect(store.view).toBeNull();
  });

  it('opens the settings editor with no leftover load, save or change from before', () => {
    const store = useEditorStore();
    store.setSettingsFile({ scope: 'project', status: 'unavailable', reason: 'untrusted' });
    store.setSaveResult({ type: 'settingsFileSaveResult', scope: 'project', ok: false, error: 'x' });
    store.noteSettingsFileChanged('project', 'v');

    store.openSettingsEditor('project');
    expect(store.settingsEditorScope).toBe('project');
    expect(store.hasOpenOverlay).toBe(true);
    expect(store.settingsFiles.project).toBeUndefined();
    expect(store.saveResults.project).toBeUndefined();
    expect(store.changedVersions.project).toBeUndefined();

    store.closeSettingsEditor();
    expect(store.hasOpenOverlay).toBe(false);
  });

  it('never replaces an open settings editor: its own scope stays, another scope waits for the editor to answer', () => {
    const store = useEditorStore();
    store.openSettingsEditor('user');
    store.setSettingsFile({ scope: 'user', status: 'ready', path: '/h/settings.json', exists: true, content: '{}', version: 'v1' });

    store.openSettingsEditor('user');
    expect(store.settingsFiles.user).toMatchObject({ version: 'v1' });
    expect(store.requestedSettingsScope).toBeNull();

    store.openSettingsEditor('project');
    expect(store.settingsEditorScope).toBe('user');
    expect(store.requestedSettingsScope).toBe('project');

    store.cancelSettingsFileRequest();
    expect(store.requestedSettingsScope).toBeNull();

    store.openSettingsEditor('project');
    store.switchToRequestedSettingsFile();
    expect(store.settingsEditorScope).toBe('project');
    expect(store.requestedSettingsScope).toBeNull();
  });
});
