// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ContentBounds, DamoclesShellApi, ShellChat, ShellState } from '../../preload/shell-channels';
import App from '../App.vue';
import ChatsSection from '../components/ChatsSection.vue';
import ProjectsSection from '../components/ProjectsSection.vue';
import RowSash from '../components/RowSash.vue';
import Sidebar from '../components/Sidebar.vue';
import { shellI18n } from '../i18n';
import { watchContentBounds } from '../content-bounds';
import { chatGroupOf, chatListRows, tagCounts } from '../chat-list';
import { avatarHue, avatarInitial } from '../project-avatar';
import { providerLogoSvg } from '@/components/icons/provider-logos';
import { FakeResizeObserver, STATE, chat, fakeShellApi } from './fakes';

const mounted: Array<VueWrapper> = [];
function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('chat list helpers', () => {
  const now = new Date(2026, 4, 12, 9, 30);

  it('groups by local midnight into Today, Yesterday and Earlier', () => {
    expect(chatGroupOf(new Date(2026, 4, 12, 0, 0).getTime(), now)).toBe('today');
    expect(chatGroupOf(new Date(2026, 4, 11, 23, 59).getTime(), now)).toBe('yesterday');
    expect(chatGroupOf(new Date(2026, 4, 11, 0, 0).getTime(), now)).toBe('yesterday');
    expect(chatGroupOf(new Date(2026, 4, 10, 23, 59).getTime(), now)).toBe('earlier');
  });

  it('puts each group under one header, keeps the order inside a group and drops empty groups', () => {
    const rows = chatListRows([
      chat({ id: 'old', timestamp: new Date(2026, 3, 1).getTime() }),
      chat({ id: 'a', timestamp: new Date(2026, 4, 12, 9).getTime() }),
      chat({ id: 'b', timestamp: new Date(2026, 4, 12, 8).getTime() }),
    ], now);
    expect(rows.map((row) => (row.kind === 'group' ? `#${row.group}` : row.chat.id))).toEqual(['#today', 'a', 'b', '#earlier', 'old']);
  });

  it('counts tags, most used first then alphabetical', () => {
    const counts = tagCounts([chat({ id: '1', tag: 'ui' }), chat({ id: '2', tag: 'bug' }), chat({ id: '3', tag: 'ui' }), chat({ id: '4', tag: 'api' }), chat({ id: '5' })]);
    expect(counts).toEqual([{ tag: 'ui', count: 2 }, { tag: 'api', count: 1 }, { tag: 'bug', count: 1 }]);
  });

  it('derives a stable avatar hue and initial from the project name', () => {
    expect(avatarHue('damocles')).toBe(avatarHue('damocles'));
    expect(avatarHue('damocles')).not.toBe(avatarHue('acme-api'));
    expect(avatarHue('x')).toBeGreaterThanOrEqual(0);
    expect(avatarHue('x')).toBeLessThan(360);
    expect(avatarInitial(' ελληνικά')).toBe('Ε');
    expect(avatarInitial('')).toBe('?');
  });

  it('maps known providers to vendored logos and unknown or inherited keys to none', () => {
    expect(providerLogoSvg('anthropic')).toMatch(/^<svg aria-hidden="true"/);
    expect(providerLogoSvg('openai-codex')).toBe(providerLogoSvg('openai'));
    expect(providerLogoSvg('my-gateway')).toBeUndefined();
    expect(providerLogoSvg('constructor')).toBeUndefined();
  });
});

describe('content bounds', () => {
  it('reports on start, on resize only when the rectangle changed, and on every DPR change', () => {
    const changeListeners: Array<() => void> = [];
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      addEventListener: (_: string, listener: () => void) => changeListeners.push(listener),
      removeEventListener: vi.fn(),
    })));
    let rect = { left: 240.4, top: 40.6, right: 1000.2, bottom: 700 };
    const content = document.createElement('main');
    content.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, toJSON: () => rect });
    const neighbour = document.createElement('header');
    const reports: ContentBounds[] = [];

    const stop = watchContentBounds(content, [neighbour], (bounds) => reports.push(bounds));
    const observer = FakeResizeObserver.instances[0]!;

    expect(observer.observed).toEqual([content, neighbour]);
    expect(reports).toEqual([{ x: 240, y: 41, width: 760, height: 659 }]);
    observer.callback();
    expect(reports).toHaveLength(1);
    rect = { left: 0, top: 40.6, right: 1000.2, bottom: 700 };
    observer.callback();
    expect(reports.at(-1)).toEqual({ x: 0, y: 41, width: 1000, height: 659 });
    changeListeners[0]!();
    expect(reports).toHaveLength(3);
    stop();
    expect(observer.observed).toEqual([]);
  });
});

function mountApp(api: DamoclesShellApi) {
  return track(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
}

describe('App and title bar', () => {
  it('shows the project › chat breadcrumb and reports the chat slot rectangle', async () => {
    const api = fakeShellApi();
    const wrapper = mountApp(api);
    await flushPromises();

    expect(wrapper.get('[data-testid="breadcrumb-project"]').text()).toBe('alpha');
    expect(wrapper.get('[data-testid="breadcrumb-chat"]').text()).toBe('Fix login');
    expect(api.reportContentBounds).toHaveBeenCalled();
    expect(wrapper.get('[data-testid="chat-slot"]').text()).toBe('');

    const { selectedChat: _chat, ...rest } = STATE;
    api.push({ ...rest, locale: 'el', selected: { projectKey: 'p1' } });
    await flushPromises();
    expect(document.documentElement.lang).toBe('el');
    expect(wrapper.find('[data-testid="breadcrumb-chat"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="chat-slot"]').text()).toContain('Δεν έχει επιλεγεί συνομιλία');
  });

  it('labels a chat with no title as a new chat', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => ({ ...STATE, selectedChat: { id: 'new:1', title: '' } })) });
    const wrapper = mountApp(api);
    await flushPromises();
    expect(wrapper.get('[data-testid="breadcrumb-chat"]').text()).toBe('New chat');
  });

  it('shows the home folder when the selected project key is not an open project', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => ({ ...STATE, projects: [], selected: { projectKey: 'home' } })) });
    const wrapper = mountApp(api);
    await flushPromises();
    expect(wrapper.get('[data-testid="breadcrumb-project"]').text()).toBe('Home folder');
    expect(api.listChats).toHaveBeenCalledWith('home');
    expect(wrapper.get('[data-testid="chats-empty"]').text()).toContain('No chats in Home folder yet.');
  });

  it('asks for no chats before main names a project, then lists the one it names', async () => {
    const { selectedChat: _chat, ...rest } = STATE;
    const api = fakeShellApi(CHATS, { getState: vi.fn(async () => ({ ...rest, projects: [], selected: {} })) });
    const wrapper = mountApp(api);
    await flushPromises();
    expect(api.listChats).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="chats-load-failed"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="chats-empty"]').exists()).toBe(false);

    api.push(STATE);
    await flushPromises();
    expect(api.listChats).toHaveBeenCalledWith('p1');
    expect(wrapper.findAll('[data-chat-id]')).toHaveLength(3);
  });

  it('opens the app menu below the logo and drives the sidebar and theme toggles', async () => {
    const api = fakeShellApi();
    const wrapper = mountApp(api);
    await flushPromises();

    const logo = wrapper.get('[data-testid="app-menu"]');
    (logo.element as HTMLElement).getBoundingClientRect = () => ({ left: 4, top: 5, right: 120, bottom: 35, x: 4, y: 5, width: 116, height: 30, toJSON: () => ({}) });
    await logo.trigger('click');
    expect(api.openAppMenu).toHaveBeenCalledWith({ x: 4, y: 35 });
    // WCAG 2.5.3: the accessible name contains the visible text.
    expect(logo.text()).toBe('Damocles');
    expect(logo.attributes('aria-label')).toBe('Damocles application menu');

    const sidebarToggle = wrapper.get('[data-testid="toggle-sidebar"]');
    expect(sidebarToggle.attributes('aria-pressed')).toBe('true');
    expect(sidebarToggle.attributes('title')).toBe('Toggle sidebar (Ctrl+B)');
    await sidebarToggle.trigger('click');
    expect(api.toggleSidebar).toHaveBeenCalled();

    const theme = wrapper.get('[data-testid="toggle-theme"]');
    expect(theme.attributes('aria-label')).toBe('Switch to light theme');
    await theme.trigger('click');
    expect(api.toggleTheme).toHaveBeenCalled();

    api.push({ ...STATE, effectiveTheme: 'light', layout: { ...STATE.layout, sidebarVisible: false } });
    await flushPromises();
    expect(wrapper.get('[data-testid="toggle-theme"]').attributes('aria-label')).toBe('Switch to dark theme');
    expect(wrapper.get('[data-testid="toggle-sidebar"]').attributes('aria-pressed')).toBe('false');
    const sidebar = wrapper.get('[data-testid="sidebar"]');
    expect(sidebar.attributes()).toHaveProperty('inert');
    expect((sidebar.element as HTMLElement).style.marginLeft).toBe('-300px');
  });

  it('reserves the traffic-light inset only on macOS and shows the pane toggle only with a pane', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => ({ ...STATE, platform: 'darwin' as const, pane: { open: true } })) });
    const wrapper = mountApp(api);
    await flushPromises();
    expect(wrapper.get('[data-testid="title-bar"]').classes()).toContain('title-bar-darwin');
    const pane = wrapper.get('[data-testid="toggle-pane"]');
    expect(pane.attributes('title')).toBe('Hide browser pane (Ctrl+Shift+B)');
    await pane.trigger('click');
    expect(api.togglePane).toHaveBeenCalledWith();

    const plain = mountApp(fakeShellApi());
    await flushPromises();
    expect(plain.get('[data-testid="title-bar"]').classes()).not.toContain('title-bar-darwin');
    expect(plain.find('[data-testid="toggle-pane"]').exists()).toBe(false);
  });

  it('focuses the selected chat row when main moves F6 to the sidebar', async () => {
    const api = fakeShellApi([chat({ id: 'c0' }), chat({ id: 'c1' })]);
    const wrapper = mountApp(api);
    await flushPromises();

    api.focusPart('sidebar');
    await flushPromises();
    const list = wrapper.get('[data-testid="chat-list"]');
    expect(document.activeElement).toBe(list.element);
    expect(list.attributes('aria-activedescendant')).toBe(wrapper.get('[data-chat-id="c1"]').attributes('id'));
    expect(api.reportFocusedPart).toHaveBeenLastCalledWith('sidebar');

    (document.activeElement as HTMLElement).blur();
    expect(api.reportFocusedPart).toHaveBeenLastCalledWith(null);
  });
});

function mountProjects(api: DamoclesShellApi, selectedKey = 'p1') {
  return track(mount(ProjectsSection, {
    props: { api, projects: STATE.projects, selectedKey, collapsed: false, size: 150 },
    global: { plugins: [shellI18n] },
    attachTo: document.body,
  }));
}

describe('projects section', () => {
  it('is a listbox of projects with avatar, branch, Untrusted and activity badges', () => {
    const wrapper = mountProjects(fakeShellApi());
    const options = wrapper.findAll('[role="option"]');
    expect(options.map((o) => o.attributes('data-project-key'))).toEqual(['p1', 'p2']);
    expect(options[0]!.attributes('aria-selected')).toBe('true');
    expect(options[0]!.find('[data-testid="untrusted-badge"]').exists()).toBe(false);
    expect(options[0]!.get('[data-testid="activity-badge"]').text()).toBe('1 running');
    expect(options[1]!.text()).toContain('main');
    expect(options[1]!.get('[data-testid="untrusted-badge"]').text()).toBe('Untrusted');
    expect(options[1]!.get('[data-testid="activity-badge"]').text()).toBe('1 waiting');
    expect(wrapper.get('[data-testid="add-project"]').attributes('aria-label')).toBe('Open a project folder');
  });

  it('opens the trust prompt from the Untrusted badge without selecting the project', async () => {
    const api = fakeShellApi();
    const wrapper = mountProjects(api);
    await wrapper.get('[data-project-key="p2"] [data-testid="untrusted-badge"]').trigger('click');
    expect(api.grantTrust).toHaveBeenCalledWith('p2');
    expect(api.selectProject).not.toHaveBeenCalled();
  });

  it('moves with the arrow keys and selects with Enter', async () => {
    const api = fakeShellApi();
    const wrapper = mountProjects(api);
    const list = wrapper.get('[role="listbox"]');
    expect(list.attributes('aria-activedescendant')).toBe(wrapper.findAll('[role="option"]')[0]!.attributes('id'));
    await list.trigger('keydown', { key: 'ArrowDown' });
    expect(list.attributes('aria-activedescendant')).toBe(wrapper.findAll('[role="option"]')[1]!.attributes('id'));
    expect(api.selectProject).not.toHaveBeenCalled();
    await list.trigger('keydown', { key: 'Enter' });
    expect(api.selectProject).toHaveBeenCalledWith('p2');
  });

  it('offers Trust and Remove project in the overlay menu and shows a refused remove', async () => {
    const api = fakeShellApi([], { removeProject: vi.fn(async () => ({ ok: false as const, reason: 'a chat is running' })) });
    api.answerNext({ kind: 'menu', itemId: 'remove' });
    const wrapper = mountProjects(api);
    await wrapper.get('[data-project-key="p2"]').trigger('contextmenu', { clientX: 30, clientY: 40 });
    await flushPromises();

    const request = api.overlayRequests[0];
    expect(request).toMatchObject({ kind: 'menu', label: 'Actions for beta', anchor: { x: 30, y: 40, width: 0, height: 0 } });
    expect(request?.kind === 'menu' && request.items.map((item) => (item.kind === 'item' ? item.label : '-'))).toEqual(['Trust project', '-', 'Remove project']);
    expect(api.removeProject).toHaveBeenCalledWith('p2');
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not remove project beta: a chat is running');
  });
});

// A test that reads the day groups fakes Date at NOW, so the run's own clock never moves a chat across midnight.
const NOW = new Date(2026, 4, 12, 15, 0).getTime();
const LONG_AGO = new Date(2020, 0, 2).getTime();
const CHATS: ShellChat[] = [
  chat({ id: 'c1', title: 'Fix login', timestamp: NOW, status: 'running', loaded: true, model: { provider: 'anthropic', id: 'claude-sonnet-5-5' }, tag: 'auth' }),
  chat({ id: 'c2', title: 'Write docs', timestamp: NOW - 1000, status: 'waiting', tag: 'docs' }),
  chat({ id: 'c3', title: 'Old idea', timestamp: LONG_AGO, model: { provider: 'my-gateway', id: 'custom-model' } }),
];

function mountChats(api: DamoclesShellApi, selectedChatId: string | undefined = 'c1') {
  return track(mount(ChatsSection, {
    props: { api, projectKey: 'p1', projectName: 'alpha', selectedChatId, newChatShortcut: 'Ctrl+N', collapsed: false },
    global: { plugins: [shellI18n] },
    attachTo: document.body,
  }));
}

describe('chats section', () => {
  it('lists the project chats as a listbox grouped by day with status, model and tag', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const api = fakeShellApi(CHATS);
    const wrapper = mountChats(api);
    await flushPromises();

    expect(api.listChats).toHaveBeenCalledWith('p1');
    const list = wrapper.get('[role="listbox"]');
    expect(list.attributes('aria-label')).toBe('Chats in alpha');
    expect(list.text()).toMatch(/Today[\s\S]*Fix login[\s\S]*Write docs[\s\S]*Earlier[\s\S]*Old idea/);
    expect(list.text()).not.toContain('Yesterday');
    const first = wrapper.get('[data-chat-id="c1"]');
    expect(first.attributes('aria-selected')).toBe('true');
    expect(first.attributes('data-status')).toBe('running');
    expect(first.text()).toContain('Running');
    expect(first.text()).toContain('Sonnet 5.5');
    expect(first.find('.provider-logo svg').exists()).toBe(true);
    expect(first.get('[data-testid="chat-tag"]').text()).toBe('auth');
    expect(wrapper.get('[data-chat-id="c2"]').text()).toContain('Needs you');
    const unknown = wrapper.get('[data-chat-id="c3"]');
    expect(unknown.text()).toContain('custom-model');
    expect(unknown.find('.provider-logo').exists()).toBe(false);
  });

  it('shows today\'s and yesterday\'s chat times on a 24-hour clock in English and Greek', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 12, 15, 0));
    const api = fakeShellApi([
      chat({ id: 'pm', timestamp: new Date(2026, 4, 12, 14, 5).getTime() }),
      chat({ id: 'night', timestamp: new Date(2026, 4, 11, 0, 5).getTime() }),
    ]);
    const wrapper = mountChats(api, undefined);
    await flushPromises();
    expect(wrapper.get('[data-chat-id="pm"]').text()).toContain('14:05');
    expect(wrapper.get('[data-chat-id="night"]').text()).toContain('00:05');
    expect(wrapper.text()).not.toMatch(/AM|PM/);

    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(wrapper.get('[data-chat-id="pm"]').text()).toContain('14:05');
    expect(wrapper.get('[data-chat-id="night"]').text()).toContain('00:05');
  });

  it('skips group headers with the arrow keys and selects with Enter', async () => {
    const api = fakeShellApi(CHATS);
    const wrapper = mountChats(api);
    await flushPromises();
    const list = wrapper.get('[role="listbox"]');
    const idOf = (chatId: string): string | undefined => wrapper.get(`[data-chat-id="${chatId}"]`).attributes('id');

    expect(list.attributes('aria-activedescendant')).toBe(idOf('c1'));
    await list.trigger('keydown', { key: 'ArrowDown' });
    await list.trigger('keydown', { key: 'ArrowDown' });
    expect(list.attributes('aria-activedescendant')).toBe(idOf('c3'));
    await list.trigger('keydown', { key: 'ArrowDown' });
    expect(list.attributes('aria-activedescendant')).toBe(idOf('c3'));
    await list.trigger('keydown', { key: 'Home' });
    expect(list.attributes('aria-activedescendant')).toBe(idOf('c1'));
    await list.trigger('keydown', { key: 'End' });
    await list.trigger('keydown', { key: 'Enter' });
    expect(api.selectChat).toHaveBeenCalledWith('c3');
  });

  it('keeps the selection where main left it when a select is refused', async () => {
    const api = fakeShellApi(CHATS, { selectChat: vi.fn(async () => ({ ok: false as const, reason: 'leased' as const })) });
    const wrapper = mountChats(api);
    await flushPromises();
    await wrapper.get('[data-chat-id="c2"]').trigger('click');
    await flushPromises();
    expect(api.selectChat).toHaveBeenCalledWith('c2');
    expect(wrapper.get('[data-chat-id="c1"]').attributes('aria-selected')).toBe('true');
    expect(wrapper.get('[data-chat-id="c2"]').attributes('aria-selected')).toBe('false');
  });

  it('builds the context menu from the chat and runs the chosen action', async () => {
    const api = fakeShellApi(CHATS);
    const wrapper = mountChats(api);
    await flushPromises();
    const labels = (index: number): string[] => {
      const request = api.overlayRequests[index];
      return request?.kind === 'menu' ? request.items.map((item) => (item.kind === 'item' ? item.label : '-')) : [];
    };

    api.answerNext({ kind: 'menu', itemId: 'removeTag' });
    await wrapper.get('[data-chat-id="c1"]').trigger('contextmenu', { clientX: 10, clientY: 20 });
    await flushPromises();
    expect(api.overlayRequests[0]).toMatchObject({ label: 'Actions for Fix login' });
    expect(labels(0)).toEqual(['Open', '-', 'Rename session', 'Change tag', 'Remove tag', '-', 'Delete session']);
    expect(api.tagChat).toHaveBeenCalledWith('c1', null);

    api.answerNext({ kind: 'menu', itemId: 'open' });
    await wrapper.get('[data-chat-id="c3"]').trigger('contextmenu', { clientX: 10, clientY: 20 });
    await flushPromises();
    expect(labels(1)).toEqual(['Open', '-', 'Rename session', 'Tag session', '-', 'Delete session']);
    expect(api.selectChat).toHaveBeenCalledWith('c3');

    const list = wrapper.get('[role="listbox"]');
    await list.trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    expect(api.overlayRequests[2]?.kind).toBe('menu');
  });

  it('offers only Open and Delete for a chat with no saved conversation, by menu, row buttons and F2', async () => {
    const api = fakeShellApi([chat({ id: 'new:panel-1', title: '' }), ...CHATS]);
    const wrapper = mountChats(api, 'new:panel-1');
    await flushPromises();

    await wrapper.get('[data-chat-id="new:panel-1"]').trigger('contextmenu', { clientX: 10, clientY: 20 });
    await flushPromises();
    const request = api.overlayRequests[0];
    expect(request).toMatchObject({ label: 'Actions for New chat' });
    expect(request?.kind === 'menu' && request.items.map((item) => (item.kind === 'item' ? item.label : '-'))).toEqual(['Open', '-', 'Delete session']);

    const row = wrapper.get('[data-chat-id="new:panel-1"]');
    expect(row.find('[data-testid="chat-action-rename"]').exists()).toBe(false);
    expect(row.find('[data-testid="chat-action-tag"]').exists()).toBe(false);
    expect(row.find('[data-testid="chat-action-delete"]').exists()).toBe(true);
    await wrapper.get('[role="listbox"]').trigger('keydown', { key: 'F2' });
    expect(wrapper.find('[data-testid="chat-rename"]').exists()).toBe(false);
  });

  it('confirms a delete in the overlay, warns for a running or waiting chat and deletes only when confirmed', async () => {
    const api = fakeShellApi(CHATS);
    const wrapper = mountChats(api);
    await flushPromises();

    api.answerNext({ kind: 'confirm', confirmed: false });
    await wrapper.get('[data-chat-id="c1"] [data-testid="chat-action-delete"]').trigger('click');
    await flushPromises();
    expect(api.overlayRequests[0]).toEqual({
      kind: 'confirm',
      title: 'Delete Session',
      message: 'Delete this session? This action cannot be undone.',
      detail: { label: 'Session:', text: 'Fix login' },
      warning: { text: 'This chat is still running. Deleting it stops the agent.', running: true },
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    expect(api.deleteChat).not.toHaveBeenCalled();

    await wrapper.get('[data-chat-id="c2"] [data-testid="chat-action-delete"]').trigger('click');
    await flushPromises();
    expect(api.overlayRequests[1]).toMatchObject({ warning: { text: 'This chat is waiting for you. Deleting it stops the agent.', running: false } });

    api.answerNext({ kind: 'confirm', confirmed: true });
    const list = wrapper.get('[role="listbox"]');
    await list.trigger('keydown', { key: 'End' });
    await list.trigger('keydown', { key: 'Delete' });
    await flushPromises();
    expect(api.overlayRequests[2]).not.toHaveProperty('warning');
    expect(api.deleteChat).toHaveBeenCalledWith('c3');
  });

  it('renames inline with F2, trims the name and cancels with Escape', async () => {
    const api = fakeShellApi(CHATS);
    const wrapper = mountChats(api);
    await flushPromises();
    const list = wrapper.get('[role="listbox"]');

    await list.trigger('keydown', { key: 'F2' });
    await flushPromises();
    const input = wrapper.get('[data-testid="chat-rename"] input');
    expect(input.attributes('placeholder')).toBe('Enter new name…');
    // The editor replaces the option, so the listbox names no active descendant until it closes.
    expect(list.attributes('aria-activedescendant')).toBeUndefined();
    expect(document.activeElement).toBe(input.element);
    await input.setValue('  Login fix  ');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.renameChat).toHaveBeenCalledWith('c1', 'Login fix');
    expect(wrapper.find('[data-testid="chat-rename"]').exists()).toBe(false);
    expect(list.attributes('aria-activedescendant')).toBe(wrapper.get('[data-chat-id="c1"]').attributes('id'));

    await wrapper.get('[data-chat-id="c2"] [data-testid="chat-action-rename"]').trigger('click');
    await wrapper.get('[data-testid="chat-rename"] input').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('[data-testid="chat-rename"]').exists()).toBe(false);
    expect(api.renameChat).toHaveBeenCalledTimes(1);
  });

  it('tags through the overlay tag picker', async () => {
    const api = fakeShellApi(CHATS);
    api.answerNext({ kind: 'tagPicker', tag: 'later' });
    const wrapper = mountChats(api);
    await flushPromises();
    await wrapper.get('[data-chat-id="c3"] [data-testid="chat-action-tag"]').trigger('click');
    await flushPromises();
    expect(api.overlayRequests[0]).toMatchObject({ kind: 'tagPicker', tags: ['auth', 'docs'], placeholder: 'Enter tag…' });
    expect(api.overlayRequests[0]).not.toHaveProperty('current');
    expect(api.tagChat).toHaveBeenCalledWith('c3', 'later');
  });

  it('filters by tag chip, searches through main and shows the empty texts', async () => {
    vi.useFakeTimers();
    const api = fakeShellApi(CHATS);
    const wrapper = mountChats(api);
    await flushPromises();

    const chip = wrapper.get('[data-testid="tag-chip"][data-tag="docs"]');
    await chip.trigger('click');
    expect(chip.attributes('aria-pressed')).toBe('true');
    expect(wrapper.findAll('[role="option"]').map((o) => o.attributes('data-chat-id'))).toEqual(['c2']);
    await chip.trigger('click');

    await wrapper.get('[data-testid="chat-search-toggle"]').trigger('click');
    await wrapper.get('[data-testid="chat-search"]').setValue('nothing here');
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    expect(api.searchChats).toHaveBeenCalledWith('p1', 'nothing here');
    expect(wrapper.get('[data-testid="chats-no-match"]').text()).toBe('No sessions found');

    const empty = mountChats(fakeShellApi([]), undefined);
    await flushPromises();
    expect(empty.get('[data-testid="chats-empty"]').text()).toContain('No chats in alpha yet.');
    await empty.get('[data-testid="chats-empty"] button').trigger('click');
  });

  it('hides chips that wrap behind an "all tags" menu of at most 100 most used tags, the active filter included', async () => {
    const many = Array.from({ length: 120 }, (_, i) => chat({ id: `t${i}`, tag: `tag-${String(i).padStart(3, '0')}` }));
    many.push(chat({ id: 'extra', tag: 'tag-119' }));
    const api = fakeShellApi(many);
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function offsetTop(this: HTMLElement) {
      return this.dataset['testid'] === 'tag-chip' && [...(this.parentElement?.children ?? [])].indexOf(this) >= 3 ? 20 : 0;
    });
    const wrapper = mountChats(api);
    await flushPromises();
    FakeResizeObserver.instances.find((observer) => observer.observed[0]?.getAttribute('role') === 'group')!.callback();
    await flushPromises();

    const allTags = wrapper.get('[data-testid="all-tags"]');
    expect(allTags.text()).toBe('+117');
    expect(allTags.attributes('aria-label')).toBe('+117 more tags');
    expect(wrapper.findAll('[data-testid="tag-chip"].invisible')).toHaveLength(117);
    // The least used tag sorts last, past the first 100, until it is the active filter.
    await wrapper.get('[data-testid="tag-chip"][data-tag="tag-118"]').trigger('click');
    api.answerNext({ kind: 'menu', itemId: '99' });
    await allTags.trigger('click');
    await flushPromises();
    const request = api.overlayRequests[0];
    expect(request?.kind === 'menu' && request.items).toHaveLength(100);
    expect(request).toMatchObject({ label: 'All tags', filterPlaceholder: 'Filter 100 tags' });
    expect(request?.kind === 'menu' && request.items[0]).toMatchObject({ label: 'tag-000', shortcut: '1', checked: false });
    expect(request?.kind === 'menu' && request.items.find((item) => item.kind === 'item' && item.label === 'tag-118')).toMatchObject({ checked: true });
    expect(request?.kind === 'menu' && request.items.some((item) => item.kind === 'item' && item.label === 'tag-119')).toBe(true);
    expect(wrapper.get('[data-testid="tag-chip"][data-tag="tag-119"]').attributes('aria-pressed')).toBe('true');
  });

  it('starts a new chat in the shown project and refetches when main reports a change', async () => {
    const api = fakeShellApi(CHATS);
    const wrapper = mountChats(api);
    await flushPromises();
    const button = wrapper.get('[data-testid="new-chat"]');
    expect(button.attributes('title')).toBe('New chat (Ctrl+N)');
    await button.trigger('click');
    expect(api.newChat).toHaveBeenCalledWith();

    api.chatsChanged('p2');
    api.chatsChanged('p1');
    await flushPromises();
    expect(api.listChats).toHaveBeenCalledTimes(2);
  });

  it('names no active descendant for a selected chat the virtual list has not rendered', async () => {
    const many = Array.from({ length: 60 }, (_, i) => chat({ id: `m${i}` }));
    const wrapper = mountChats(fakeShellApi(many), 'm59');
    await flushPromises();
    expect(wrapper.find('[data-chat-id="m59"]').exists()).toBe(false);
    expect(wrapper.get('[role="listbox"]').attributes('aria-activedescendant')).toBeUndefined();
  });

  it('drops the previous project\'s chats when the new project\'s list fails, and retries on request', async () => {
    const api = fakeShellApi(CHATS);
    const wrapper = mountChats(api);
    await flushPromises();
    expect(wrapper.findAll('[role="option"]')).toHaveLength(3);

    vi.mocked(api.listChats).mockRejectedValueOnce(new Error('Unknown project'));
    await wrapper.setProps({ projectKey: 'p2', projectName: 'beta' });
    await flushPromises();
    expect(wrapper.findAll('[role="option"]')).toHaveLength(0);
    expect(wrapper.get('[data-testid="chats-load-failed"] [role="alert"]').text()).toBe('Damocles could not load the chats.');

    await wrapper.get('[data-testid="chats-load-failed"] button').trigger('click');
    await flushPromises();
    expect(api.listChats).toHaveBeenLastCalledWith('p2');
    expect(wrapper.find('[data-testid="chats-load-failed"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="option"]')).toHaveLength(3);
  });

  it('ignores a failed load that a later refresh superseded', async () => {
    const api = fakeShellApi(CHATS);
    const wrapper = mountChats(api);
    await flushPromises();
    let fail!: (err: Error) => void;
    vi.mocked(api.listChats).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    api.chatsChanged('p1');
    api.chatsChanged('p1');
    await flushPromises();
    fail(new Error('Unknown project'));
    await flushPromises();
    expect(wrapper.find('[data-testid="chats-load-failed"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="option"]')).toHaveLength(3);
  });
});

describe('sidebar layout', () => {
  it('reports a section collapse with main\'s sidebar visibility and keeps the sash at 60px or more', async () => {
    const api = fakeShellApi(CHATS);
    const state: ShellState = STATE;
    const wrapper = track(mount(Sidebar, { props: { api, state }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();

    const sash = wrapper.getComponent(RowSash);
    await sash.trigger('keydown', { key: 'Home' });
    expect(api.reportLayout).toHaveBeenLastCalledWith(expect.objectContaining({ sections: expect.objectContaining({ projects: { collapsed: false, size: 60 } }) }));
    await sash.trigger('keydown', { key: 'ArrowUp' });
    expect(api.reportLayout).toHaveBeenLastCalledWith(expect.objectContaining({ sections: expect.objectContaining({ projects: { collapsed: false, size: 60 } }) }));

    await wrapper.get('[data-testid="sidebar-projects"] button[aria-expanded]').trigger('click');
    expect(api.reportLayout).toHaveBeenLastCalledWith(expect.objectContaining({
      sidebarVisible: true,
      sidebarWidth: 300,
      sections: { projects: { collapsed: true, size: 60 }, chats: { collapsed: false } },
    }));
    expect(wrapper.findComponent(RowSash).exists()).toBe(false);
    expect(wrapper.get('[data-testid="sidebar-projects"] button[aria-expanded]').attributes('aria-expanded')).toBe('false');
    // A collapsed body stays in the DOM so its height can animate, but leaves the focus order and the accessibility tree.
    const bodyId = wrapper.get('[data-testid="sidebar-projects"] button[aria-expanded]').attributes('aria-controls')!;
    expect(wrapper.get(`[id="${bodyId}"]`).attributes()).toHaveProperty('inert');
    expect((wrapper.get('[data-testid="sidebar"]').element as HTMLElement).style.transition).toContain('margin-left');
  });

  it('keeps a Projects/Chats sash drag through state pushes, then adopts only a layout main changed', async () => {
    const api = fakeShellApi(CHATS);
    const wrapper = track(mount(Sidebar, { props: { api, state: STATE }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();
    const sidebarSize = FakeResizeObserver.instances.find((observer) => observer.observed[0]?.getAttribute('data-testid') === 'sidebar')!;
    (sidebarSize.callback as (entries: unknown[]) => void)([{ contentBoxSize: [{ inlineSize: 300, blockSize: 800 }] }]);
    await flushPromises();
    const sash = wrapper.get('[data-testid="row-sash"]');
    const size = (): string | undefined => wrapper.get('[data-testid="row-sash"]').attributes('aria-valuenow');
    const push = (projects: { collapsed: boolean; size: number }) =>
      wrapper.setProps({ state: { ...STATE, layout: { ...STATE.layout, sections: { ...STATE.layout.sections, projects } } } });
    expect(size()).toBe('150');

    await sash.trigger('pointerdown', { button: 0, pointerId: 1, clientY: 200 });
    await sash.trigger('pointermove', { pointerId: 1, clientY: 300 });
    expect(size()).toBe('250');
    // Main pushes a whole new state, unchanged and then changed, between the last move and the release.
    await push({ collapsed: false, size: 150 });
    expect(size()).toBe('250');
    await push({ collapsed: false, size: 120 });
    expect(size()).toBe('250');
    await sash.trigger('pointerup', { pointerId: 1 });
    expect(api.reportLayout).toHaveBeenLastCalledWith(expect.objectContaining({ sections: { projects: { collapsed: false, size: 250 }, chats: { collapsed: false } } }));

    await push({ collapsed: false, size: 120 });
    expect(size()).toBe('250');
    await push({ collapsed: false, size: 100 });
    expect(size()).toBe('100');
  });

  it('resizes the sidebar from the keyboard within 220px and the space the chat slot leaves', async () => {
    vi.stubGlobal('innerWidth', 900);
    const api = fakeShellApi(CHATS);
    const wrapper = track(mount(Sidebar, { props: { api, state: STATE }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();
    const sash = wrapper.get('[data-testid="sidebar-sash"]');
    await sash.trigger('keydown', { key: 'Home' });
    expect(api.reportLayout).toHaveBeenLastCalledWith(expect.objectContaining({ sidebarWidth: 220 }));
    await sash.trigger('keydown', { key: 'End' });
    expect(api.reportLayout).toHaveBeenLastCalledWith(expect.objectContaining({ sidebarWidth: 540 }));
  });
});
