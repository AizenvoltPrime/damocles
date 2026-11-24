// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { RenderAppearance } from '@shared/themes/agent';
import type { CharacterView, ShownCharacters } from '@shared/themes/characters';
import { CSS_REGIONS, type Arrangement } from '@shared/themes/schema';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { installPlatformBridge, usePlatformBridge } from '@/composables/usePlatformBridge';
import { CODE_HIGHLIGHTER } from '@/composables/code-highlighter';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { shellI18n } from '../../i18n';
import { FakeResizeObserver } from '../../__tests__/fakes';
import { chatListRows } from '../../chat-list';
import SampleWindow from '../SampleWindow.vue';
import SampleTranscript from '../SampleTranscript.vue';
import { createRenderBridge, inertTitleBarApi } from '../render-bridge';
import { RENDER_HIGHLIGHTER } from '../render-highlighter';
import { SAMPLE_SELECTED_CHAT, SAMPLE_SELECTED_PROJECT, sampleChats, sampleMessages } from '../sample-window';

// The theme render page's sample window: the shell's and the chat view's own components with sample content, mounted with no
// preload and no host bridge, laid out in the job's arrangement, its code block highlighted with nothing loaded lazily.

const ARRANGEMENT: Required<Arrangement> = {
  grid: { slots: { main: 'chat', side: 'editor', bottom: 'terminal' }, visible: { editor: true, terminal: true }, sideWidth: 420, bottomHeight: 200 },
  sidebarWidth: 280,
  sectionOrder: ['projects', 'chats', 'files', 'scm', 'graph', 'repos', 'search'],
  sections: {
    projects: { collapsed: false, size: 180 },
    chats: { collapsed: false },
    files: { collapsed: true, size: 200 },
    scm: { collapsed: true, size: 200 },
    graph: { collapsed: true, size: 200 },
    repos: { collapsed: true, size: 200 },
    search: { collapsed: true, size: 200 },
  },
};
const still = (name: string) => ({ url: `app://damocles/theme-blob/${name}`, moves: false, playable: false });
const PIP: CharacterView = { name: 'Pip', states: { idle: still('idle'), running: still('running'), waiting: still('waiting') } };
const CHARACTERS: ShownCharacters = { characters: [PIP], pins: {}, motion: 'still', selection: 'outline' };
const appearance = (overrides: Partial<RenderAppearance> = {}): RenderAppearance => ({
  kind: 'dark', css: '', trustedCss: '', arrangement: ARRANGEMENT, platform: 'win32', characters: CHARACTERS, ...overrides,
});

const mounted: VueWrapper[] = [];
beforeAll(() => {
  // what the page installs: no preload put a bridge on window
  installPlatformBridge(createRenderBridge());
});
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function sampleWindow(overrides: Partial<RenderAppearance> = {}): Promise<VueWrapper> {
  const shell = mount(SampleWindow, { props: { appearance: appearance(overrides), now: Date.now() }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(shell);
  const slot = shell.find<HTMLElement>('[data-testid="sample-chat-slot"]').element;
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore(pinia).setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
  mounted.push(mount(SampleTranscript, { props: { messages: sampleMessages(Date.now()) }, global: { plugins: [pinia, i18n], provide: { [CODE_HIGHLIGHTER as symbol]: RENDER_HIGHLIGHTER } }, attachTo: slot }));
  await flushPromises();
  return shell;
}

describe('the sample window', () => {
  it('mounts with no preload and no host bridge, and sends nothing', async () => {
    expect((window as { damoclesShell?: unknown }).damoclesShell).toBeUndefined();
    expect(window.damoclesBridge).toBeUndefined();
    await sampleWindow();
    expect(document.querySelector('[data-testid="title-bar"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="sample-sidebar"] [data-project-row]')).toHaveLength(4);
    expect(document.querySelectorAll('[data-testid="sample-sidebar"] [data-chat-row]')).toHaveLength(3);
    expect(document.querySelector('[data-testid="sample-transcript"] [data-tool-card][data-tool="Read"]')).not.toBeNull();
    // a click is the only way a sample component sends, and the page takes none
    expect(() => usePlatformBridge().postMessage({ type: 'log', message: 'x' })).toThrow('sends no messages');
  });

  it("answers the title bar's update pill with the appearance's platform and nothing to show", async () => {
    expect(await inertTitleBarApi('win32').getUpdate()).toEqual({ state: { kind: 'disabled' }, lastCheckedAt: null, platform: 'win32' });
    expect((await inertTitleBarApi('darwin').getUpdate()).platform).toBe('darwin');
  });

  it('carries every region\'s scope root', async () => {
    await sampleWindow();
    for (const region of CSS_REGIONS) expect(document.querySelector(`[data-theme-scope~="${region}"]`), region).not.toBeNull();
    // the sidebar crop's region
    expect(document.querySelector('[data-render-region="sidebar"]')?.getAttribute('data-wallpaper-panel')).toBe('sidebar');
  });

  it('marks the selected project and chat, and outlines the selected project\'s character', async () => {
    await sampleWindow();
    const selected = document.querySelectorAll('[data-project-row][data-selected]');
    expect([...selected].map((row) => row.getAttribute('data-project-key'))).toEqual([SAMPLE_SELECTED_PROJECT]);
    expect(selected[0]!.querySelector('[data-avatar="character"]')?.hasAttribute('data-selected')).toBe(true);
    expect(selected[0]!.querySelector('[data-avatar="character"]')?.getAttribute('data-selection')).toBe('outline');
    expect([...document.querySelectorAll('[data-chat-row][data-selected]')].map((row) => row.getAttribute('data-chat-id'))).toEqual([SAMPLE_SELECTED_CHAT]);
    // idle, running and waiting characters, and the remote project's host badge
    const states = [...document.querySelectorAll('[data-project-row] [data-character-state]')].map((avatar) => avatar.getAttribute('data-character-state'));
    expect(new Set(states)).toEqual(new Set(['idle', 'running', 'waiting']));
    expect(document.querySelectorAll('[data-project-row] [data-testid="host-badge"]')).toHaveLength(1);
  });

  it('places the panes, the sidebar width and the sections in the arrangement it is given', async () => {
    const arrangement: Required<Arrangement> = {
      ...ARRANGEMENT,
      grid: { slots: { main: 'editor', side: 'terminal', bottom: 'chat' }, visible: { editor: true, terminal: true }, sideWidth: 360, bottomHeight: 240 },
      sidebarWidth: 312,
      sectionOrder: ['chats', 'projects', 'files', 'scm', 'graph', 'repos', 'search'],
    };
    await sampleWindow({ arrangement });
    const pane = (name: string) => document.querySelector<HTMLElement>(`[data-testid="sample-pane-${name}"]`)!;
    expect([pane('editor').dataset['slot'], pane('terminal').dataset['slot'], pane('chat').dataset['slot']]).toEqual(['main', 'side', 'bottom']);
    expect(pane('chat').style.gridArea).toBe('bottom');
    const grid = document.querySelector<HTMLElement>('[data-testid="sample-grid"]')!;
    expect(grid.style.gridTemplateColumns).toBe('minmax(0, 1fr) 0.3125rem 360px');
    expect(grid.style.gridTemplateRows).toBe('minmax(0, 1fr) 0.3125rem 240px');
    expect(document.querySelector<HTMLElement>('[data-render-region="sidebar"]')!.style.width).toBe('312px');
    const sections = [...document.querySelectorAll('[data-testid^="sample-section-"]')].map((section) => section.getAttribute('data-testid'));
    expect(sections.slice(0, 2)).toEqual(['sample-section-chats', 'sample-section-projects']);

    // a hidden pane's slot collapses, and its neighbour takes the room
    document.body.innerHTML = '';
    await sampleWindow({ arrangement: { ...arrangement, grid: { ...arrangement.grid, visible: { editor: true, terminal: false } } } });
    expect(document.querySelector<HTMLElement>('[data-testid="sample-pane-terminal"]')!.style.display).toBe('none');
    expect(document.querySelector<HTMLElement>('[data-testid="sample-grid"]')!.style.gridTemplateColumns).toBe('minmax(0, 1fr) 0rem 0px');
  });

  it('lists its chats under Today alone, just after midnight too', () => {
    for (const now of [new Date(2026, 0, 15, 0, 10), new Date(2026, 0, 15, 14, 0)]) {
      const rows = chatListRows(sampleChats(now.getTime()), now);
      expect(rows.flatMap((row) => (row.kind === 'group' ? [row.group] : [])), now.toTimeString()).toEqual(['today']);
      expect(rows.filter((row) => row.kind === 'chat')).toHaveLength(3);
    }
  });

  it('refuses an arrangement without a section', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { search: _search, ...sections } = ARRANGEMENT.sections;
    expect(() => mount(SampleWindow, { props: { appearance: appearance({ arrangement: { ...ARRANGEMENT, sections } }), now: Date.now() }, global: { plugins: [shellI18n] } })).toThrow('no search section');
  });

  it('highlights the reply\'s code block with the bundled grammar, in the desktop\'s token theme', async () => {
    await sampleWindow();
    const code = document.querySelector('.code-block-content pre.shiki');
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain('export function readable');
    // a keyword in the Damocles theme's syntax token, not the escaped fallback's plain text
    expect([...code!.querySelectorAll('span')].some((span) => span.getAttribute('style')?.includes('var(--s-kw)'))).toBe(true);
  });
});
