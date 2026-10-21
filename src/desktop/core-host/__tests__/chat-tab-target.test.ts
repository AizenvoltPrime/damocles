import { describe, expect, it, vi } from 'vitest';
import type { PanelHost } from '../../../platform/window-service';
import { resolveChatTab, type ChatTabSources } from '../chat-tab-target';

function fakeHost(name: string): PanelHost {
  return { reveal: vi.fn(), name } as unknown as PanelHost;
}

function sources(init: { panels: Array<[string, PanelHost]>; selected?: unknown; chats: unknown[]; opened?: PanelHost }): ChatTabSources & { openChat: ReturnType<typeof vi.fn> } {
  const panels = new Map(init.panels.map(([id, host]) => [id, { host }]));
  return {
    panels: () => panels,
    selected: () => init.selected,
    chats: () => init.chats,
    openChat: vi.fn(async () => {
      if (!init.opened) throw new Error('unexpected open');
      panels.set('host-9', { host: init.opened, webviewReady: Promise.resolve() } as { host: PanelHost });
      return 'host-9';
    }),
  };
}

describe('resolveChatTab', () => {
  const a = fakeHost('a');
  const b = fakeHost('b');
  // A chat whose panel core has not registered yet, or no longer holds.
  const unregistered = fakeHost('closing');

  it('picks the requesting chat while it is loaded', async () => {
    const s = sources({ panels: [['host-1', a], ['host-2', b]], selected: a, chats: [a, b] });
    expect(await resolveChatTab(s, 'host-2')).toEqual({ panelId: 'host-2', host: b });
  });

  it('falls back to the selected chat, then the first loaded chat', async () => {
    expect(await resolveChatTab(sources({ panels: [['host-1', a], ['host-2', b]], selected: b, chats: [a, b] }), 'host-7')).toEqual({ panelId: 'host-2', host: b });
    expect(await resolveChatTab(sources({ panels: [['host-1', a], ['host-2', b]], chats: [unregistered, b, a] }), undefined)).toEqual({ panelId: 'host-2', host: b });
  });

  it('opens a chat in the selected project when none is loaded, after its webview is ready', async () => {
    const opened = fakeHost('new');
    const s = sources({ panels: [], selected: unregistered, chats: [unregistered], opened });
    expect(await resolveChatTab(s, 'host-1')).toEqual({ panelId: 'host-9', host: opened });
    expect(s.openChat).toHaveBeenCalledOnce();
  });
});
