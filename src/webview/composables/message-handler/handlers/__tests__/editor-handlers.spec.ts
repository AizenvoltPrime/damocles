import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createEditorHandlers } from '../editor-handlers';
import { settingsViewHandlers } from '../settings-handlers';
import { useEditorStore } from '@/stores/useEditorStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { HandlerContext } from '../../types';
import { VSCODE_HOST_CAPABILITIES, type EditorDocument, type ExtensionToWebviewMessage } from '@shared/types/messages';

const text = (content: string): EditorDocument => ({ name: 'a.ts', path: '/w/a.ts', body: { kind: 'text', content, languageId: 'typescript' } });

const MESSAGES: ExtensionToWebviewMessage[] = [
  { type: 'editorShowDiff', viewId: 'v1', title: 'a.ts', purpose: 'proposal', approvalId: 'tool-1', original: text('a'), modified: text('b') },
  { type: 'editorCloseView', viewId: 'v1' },
  { type: 'settingsFileAvailability', files: { user: { available: true }, project: { available: false, reason: 'untrusted' }, local: { available: false, reason: 'untrusted' } } },
];

function dispatch(msg: ExtensionToWebviewMessage): void {
  const ctx = { stores: { settingsStore: useSettingsStore() } } as unknown as HandlerContext;
  // settingsFileAvailability is a settings view message, also read by the desktop settings modal's footer.
  const handler = { ...settingsViewHandlers, ...createEditorHandlers() }[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no editor handler for ${msg.type}`);
  handler(msg, ctx);
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

describe('editor handlers', () => {
  it('ignore every editor message while the host has monaco off, and say so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const msg of MESSAGES) dispatch(msg);

    const store = useEditorStore();
    expect(store.view).toBeNull();
    expect(store.hasOpenOverlay).toBe(false);
    expect(store.settingsFileAvailability).toBeNull();
    expect(warn).toHaveBeenCalledTimes(MESSAGES.length);
  });

  it('route each message into the store once monaco is on', () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, monaco: true, settingsSources: true });
    const store = useEditorStore();

    dispatch(MESSAGES[0]!);
    expect(store.view).toBeNull();
    expect(store.openProposal('tool-1')).toBe(true);
    expect(store.view).toMatchObject({ viewId: 'v1', purpose: 'proposal', approvalId: 'tool-1' });

    dispatch(MESSAGES[1]!);
    expect(store.view).toBeNull();
    expect(store.openProposal('tool-1')).toBe(false);

    dispatch(MESSAGES[2]!);
    expect(store.settingsFileAvailability?.project).toEqual({ available: false, reason: 'untrusted' });
  });
});
