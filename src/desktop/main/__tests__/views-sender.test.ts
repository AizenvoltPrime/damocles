import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() }, WebContentsView: vi.fn(), nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} }));

import { asJsonValue, isPanelSender, isWebviewMessage, isWebviewState } from '../views';
import { OVERLAY_PAGE_URL, SHELL_PAGE_URL, panelPageUrl } from '../protocol';

const ownContents = { id: 1 };
const otherContents = { id: 2 };
const page = panelPageUrl('panel-a');

describe('isPanelSender', () => {
  it('accepts the panel view main frame on its own page', () => {
    expect(isPanelSender({ sender: ownContents, senderFrame: { url: page, parent: null } }, ownContents, page)).toBe(true);
  });

  it('rejects another view, even on the same page URL', () => {
    expect(isPanelSender({ sender: otherContents, senderFrame: { url: page, parent: null } }, ownContents, page)).toBe(false);
  });

  it('rejects another panel page, a subframe, a destroyed frame and a foreign origin', () => {
    expect(isPanelSender({ sender: ownContents, senderFrame: { url: panelPageUrl('panel-b'), parent: null } }, ownContents, page)).toBe(false);
    expect(isPanelSender({ sender: ownContents, senderFrame: { url: page, parent: {} } }, ownContents, page)).toBe(false);
    expect(isPanelSender({ sender: ownContents, senderFrame: null }, ownContents, page)).toBe(false);
    expect(isPanelSender({ sender: ownContents, senderFrame: { url: 'https://example.com/', parent: null } }, ownContents, page)).toBe(false);
  });

  it('pins the overlay to its own view on the exact overlay page', () => {
    expect(isPanelSender({ sender: ownContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } }, ownContents, OVERLAY_PAGE_URL)).toBe(true);
    expect(isPanelSender({ sender: ownContents, senderFrame: { url: SHELL_PAGE_URL, parent: null } }, ownContents, OVERLAY_PAGE_URL)).toBe(false);
    expect(isPanelSender({ sender: ownContents, senderFrame: { url: `${OVERLAY_PAGE_URL}?x`, parent: null } }, ownContents, OVERLAY_PAGE_URL)).toBe(false);
    expect(isPanelSender({ sender: otherContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } }, ownContents, OVERLAY_PAGE_URL)).toBe(false);
  });
});

describe('IPC payload validation', () => {
  it('accepts only objects with a string type as webview messages', () => {
    expect(isWebviewMessage({ type: 'ready' })).toBe(true);
    expect(isWebviewMessage({ type: 1 })).toBe(false);
    expect(isWebviewMessage(['ready'])).toBe(false);
    expect(isWebviewMessage('ready')).toBe(false);
    expect(isWebviewMessage(null)).toBe(false);
  });

  it('accepts a plain object or a cleared state', () => {
    expect(isWebviewState({ sessionId: 'x' })).toBe(true);
    expect(isWebviewState(null)).toBe(true);
    expect(isWebviewState(undefined)).toBe(true);
    expect(isWebviewState('x')).toBe(false);
    expect(isWebviewState([1])).toBe(false);
  });
});

describe('asJsonValue', () => {
  it('gives core the JSON form of a structured-clone payload', () => {
    expect(asJsonValue({ type: 'x', at: new Date(0), tags: new Set([1]) }, 1000)).toEqual({ value: { type: 'x', at: '1970-01-01T00:00:00.000Z', tags: {} } });
    expect(asJsonValue(undefined, 1000)).toEqual({ value: undefined });
  });

  it('drops payloads with no JSON form or over the bound', () => {
    const cyclic: Record<string, unknown> = { type: 'x' };
    cyclic['self'] = cyclic;
    expect(asJsonValue(cyclic, 1000)).toBeUndefined();
    expect(asJsonValue({ type: 'x', n: 1n }, 1000)).toBeUndefined();
    expect(asJsonValue({ type: 'x', text: 'a'.repeat(100) }, 50)).toBeUndefined();
  });
});
