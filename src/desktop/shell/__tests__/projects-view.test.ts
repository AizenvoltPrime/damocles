// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ProjectsView, ShellProject, ShellProjectGroups } from '../../preload/shell-channels';
import ProjectsSection from '../components/ProjectsSection.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, STATE, fakeShellApi, type FakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const LOCAL = { kind: 'local', key: 'local', name: 'This computer' } as const;
const PROD = { kind: 'ssh', key: 'ssh+h1', hostId: 'h1', name: 'prod-1' } as const;
const STAGING = { kind: 'ssh', key: 'ssh+h2', hostId: 'h2', name: 'staging' } as const;

const project = (key: string, authority: ShellProject['authority'], extra: Partial<ShellProject> = {}): ShellProject => ({
  ...STATE.projects[0]!,
  key,
  name: key,
  fsPath: `/srv/${key}`,
  authority,
  connection: 'connected',
  running: 0,
  waiting: 0,
  ...extra,
});

// local and prod-1 projects interleaved in the one sidebar order
const PROJECTS = [project('a', LOCAL), project('x', PROD), project('b', LOCAL), project('y', PROD)];
const GROUPS: ShellProjectGroups = { order: ['local', 'ssh+h1'], collapsed: [] };

interface Options {
  view?: ProjectsView;
  projects?: readonly ShellProject[];
  groups?: ShellProjectGroups;
  remoteEnabled?: boolean;
  api?: FakeShellApi;
}

function mountSection(options: Options = {}): { wrapper: VueWrapper; api: FakeShellApi } {
  const api = options.api ?? fakeShellApi();
  const wrapper = mount(ProjectsSection, {
    props: {
      api,
      projects: options.projects ?? PROJECTS,
      selectedKey: 'a',
      remoteEnabled: options.remoteEnabled ?? true,
      hosts: [],
      view: options.view ?? 'grouped',
      groups: options.groups ?? GROUPS,
      platform: 'win32',
      collapsed: false,
      bodySize: 200,
    },
    global: { plugins: [shellI18n], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return { wrapper, api };
}

const list = (wrapper: VueWrapper) => wrapper.get('[role="listbox"]');
const activeOf = (wrapper: VueWrapper): Element | null => document.getElementById(list(wrapper).attributes('aria-activedescendant')!);
const header = (wrapper: VueWrapper, group: string) => wrapper.get(`[data-testid="project-group-header"][data-group="${group}"]`);
const press = async (wrapper: VueWrapper, key: string, init: KeyboardEventInit = {}) => {
  await list(wrapper).trigger('keydown', { key, ...init });
  await flushPromises();
};
const menuLabels = (api: FakeShellApi): string[] => {
  const request = api.overlayRequests.at(-1);
  return request?.kind === 'menu' ? request.items.map((item) => (item.kind === 'item' ? `${item.label}${item.disabled ? ' (disabled)' : ''}` : '-')) : [];
};

describe('Projects view toggle', () => {
  it('shows Flat and By host as an equal toggle and sets the view main stores', async () => {
    const { wrapper, api } = mountSection({ view: 'flat' });
    const toggle = wrapper.get('[data-testid="projects-view"]');
    expect(toggle.attributes('aria-label')).toBe('Project view');
    expect(wrapper.get('[data-testid="projects-view-flat"]').text()).toBe('Flat');
    expect(wrapper.get('[data-testid="projects-view-flat"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="projects-view-grouped"]').text()).toBe('By host');
    expect(wrapper.get('[data-testid="segmented-pill"]').attributes('style')).toContain('translateX(0%)');

    await wrapper.get('[data-testid="projects-view-grouped"]').trigger('click');
    expect(api.setProjectsView).toHaveBeenCalledWith('grouped');

    await wrapper.setProps({ view: 'grouped' });
    expect(wrapper.get('[data-testid="projects-view-grouped"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="segmented-pill"]').attributes('style')).toContain('translateX(100%)');
    await wrapper.get('[data-testid="projects-view-flat"]').trigger('click');
    expect(api.setProjectsView).toHaveBeenLastCalledWith('flat');
  });

  it('folds the Untrusted badge of a remote row to its shield in a narrow flat row, so the name keeps room', () => {
    const projects = [project('a', LOCAL, { trusted: false }), project('x', PROD, { trusted: false })];
    const label = (wrapper: VueWrapper, key: string) => wrapper.get(`[data-project-key="${key}"] [data-testid="untrusted-badge"] span:last-child`);
    const flat = mountSection({ view: 'flat', projects });
    expect(label(flat.wrapper, 'x').classes()).toContain('@max-[14.5rem]/row:sr-only');
    expect(label(flat.wrapper, 'x').text()).toBe('Untrusted');
    expect(label(flat.wrapper, 'a').classes()).not.toContain('@max-[14.5rem]/row:sr-only');
    expect(label(mountSection({ projects }).wrapper, 'x').classes()).not.toContain('@max-[14.5rem]/row:sr-only');
  });

  it('draws one list in flat view, each remote row with its host badge', () => {
    const { wrapper } = mountSection({ view: 'flat' });
    expect(wrapper.find('[data-testid="project-group"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="option"]').map((option) => option.attributes('data-project-key'))).toEqual(['a', 'x', 'b', 'y']);
    expect(wrapper.get('[data-project-key="x"] [data-testid="host-badge"]').text()).toBe('prod-1');
  });
});

describe('grouped Projects view', () => {
  it('is one listbox of groups, each labelled by its header row and holding its projects in the one order', () => {
    const { wrapper } = mountSection();
    const groups = wrapper.findAll('[role="listbox"] > [role="group"]');
    expect(groups.map((group) => group.attributes('data-group'))).toEqual(['local', 'ssh+h1']);
    for (const group of groups) {
      expect(document.getElementById(group.attributes('aria-labelledby')!)?.textContent?.trim()).toBe(group.attributes('data-group') === 'local' ? 'This computer' : 'prod-1');
      const options = group.findAll('[role="option"]');
      expect(options[0]!.attributes('data-testid')).toBe('project-group-header');
      expect(options[0]!.attributes('aria-expanded')).toBeUndefined();
    }
    expect(groups[0]!.findAll('[data-project-key]').map((row) => row.attributes('data-project-key'))).toEqual(['a', 'b']);
    expect(groups[1]!.findAll('[data-project-key]').map((row) => row.attributes('data-project-key'))).toEqual(['x', 'y']);
    expect(header(wrapper, 'local').attributes('aria-label')).toBe('This computer, expanded');
    expect(header(wrapper, 'ssh+h1').attributes('aria-label')).toBe('prod-1, Connected, expanded');
    // the group header names the host, so a remote row shows its folder and no badge
    expect(wrapper.get('[data-project-key="x"] [data-testid="project-path"]').text()).toBe('/srv/x');
    expect(wrapper.find('[data-project-key="x"] [data-testid="host-badge"]').exists()).toBe(false);
  });

  it('moves the active descendant across headers and project rows', async () => {
    const { wrapper } = mountSection();
    const seen: string[] = [];
    const name = (element: Element | null): string => element?.getAttribute('data-project-key') ?? `[${element?.getAttribute('data-group')}]`;
    seen.push(name(activeOf(wrapper)));
    for (let step = 0; step < 5; step++) {
      await press(wrapper, 'ArrowDown');
      seen.push(name(activeOf(wrapper)));
    }
    expect(seen).toEqual(['a', 'b', '[ssh+h1]', 'x', 'y', 'y']);
    await press(wrapper, 'Home');
    expect(name(activeOf(wrapper))).toBe('[local]');
  });

  it('toggles a header row with Enter and Space, opens it with Right and closes it with Left', async () => {
    const { wrapper, api } = mountSection();
    await press(wrapper, 'Home');
    await press(wrapper, 'Enter');
    expect(api.setProjectGroupCollapsed).toHaveBeenLastCalledWith('local', true);
    await press(wrapper, ' ');
    expect(api.setProjectGroupCollapsed).toHaveBeenLastCalledWith('local', true);
    await press(wrapper, 'ArrowLeft');
    expect(api.setProjectGroupCollapsed).toHaveBeenLastCalledWith('local', true);
    await press(wrapper, 'ArrowRight');
    expect(api.setProjectGroupCollapsed).toHaveBeenCalledTimes(3);
    expect(api.selectProject).not.toHaveBeenCalled();

    await wrapper.setProps({ groups: { ...GROUPS, collapsed: ['local'] } });
    await press(wrapper, 'ArrowRight');
    expect(api.setProjectGroupCollapsed).toHaveBeenLastCalledWith('local', false);
    await press(wrapper, 'ArrowLeft');
    expect(api.setProjectGroupCollapsed).toHaveBeenCalledTimes(4);
  });

  it('draws a collapsed group without its rows, keeping its status dot and a count of busy chats', async () => {
    const projects = [project('a', LOCAL), project('x', PROD, { running: 1 }), project('y', PROD, { waiting: 1, connection: 'offline' })];
    const { wrapper } = mountSection({ projects, groups: { order: GROUPS.order, collapsed: ['ssh+h1'] } });
    const group = wrapper.get('[data-group="ssh+h1"][data-testid="project-group"]');
    expect(group.attributes('data-collapsed')).toBe('true');
    expect(group.findAll('[data-project-key]')).toHaveLength(0);
    expect(group.get('[data-testid="host-status-dot"]').attributes('data-connection')).toBe('connected');
    const count = group.get('[data-testid="group-activity-badge"]');
    expect(count.text()).toBe('2');
    expect(count.classes()).toContain('d-tone-warning');
    expect(header(wrapper, 'ssh+h1').attributes('aria-label')).toBe('prod-1, Connected, collapsed, 2 chats working or waiting');
    expect(wrapper.find('[data-group="local"] [data-testid="group-activity-badge"]').exists()).toBe(false);
  });

  it('opens the header menu with Shift+F10 and the Menu key, and with a right click', async () => {
    const { wrapper, api } = mountSection();
    await press(wrapper, 'End');
    await press(wrapper, 'ArrowUp');
    await press(wrapper, 'ArrowUp');
    expect(activeOf(wrapper)?.getAttribute('data-group')).toBe('ssh+h1');
    await press(wrapper, 'F10', { shiftKey: true });
    expect(api.overlayRequests.at(-1)).toMatchObject({ kind: 'menu', label: 'Actions for prod-1' });
    expect(menuLabels(api)).toEqual(['Open folder on prod-1...', 'Rename...', '-', 'Move up', 'Move down (disabled)']);
    await press(wrapper, 'ContextMenu');
    expect(api.overlayRequests).toHaveLength(2);
    await header(wrapper, 'local').trigger('contextmenu', { clientX: 5, clientY: 6 });
    await flushPromises();
    expect(api.overlayRequests.at(-1)).toMatchObject({ label: 'Actions for This computer', anchor: { x: 5, y: 6 } });
    expect(menuLabels(api)).toEqual(['Move up (disabled)', 'Move down']);
  });

  it('opens another folder on the host from the header and the project menus', async () => {
    const { wrapper, api } = mountSection();
    api.answerNext({ kind: 'menu', itemId: 'openFolder' });
    await header(wrapper, 'ssh+h1').trigger('contextmenu');
    await flushPromises();
    expect(api.openHostFolder).toHaveBeenLastCalledWith('h1');
    api.answerNext({ kind: 'menu', itemId: 'openFolder' });
    await wrapper.get('[data-project-key="y"]').trigger('contextmenu');
    await flushPromises();
    expect(menuLabels(api)).toEqual(['Open another folder on prod-1...', 'Rename prod-1...', '-', 'Move up', 'Move down (disabled)', '-', 'Remove project']);
    expect(api.openHostFolder).toHaveBeenCalledTimes(2);
    expect(api.openConnect).not.toHaveBeenCalled();
  });

  it('hides every remote entry while remote is disabled, and keeps the views and reordering', async () => {
    const { wrapper, api } = mountSection({ remoteEnabled: false });
    await header(wrapper, 'ssh+h1').trigger('contextmenu');
    await flushPromises();
    expect(menuLabels(api)).toEqual(['Move up', 'Move down (disabled)']);
    await wrapper.get('[data-project-key="x"]').trigger('contextmenu');
    await flushPromises();
    expect(menuLabels(api)).toEqual(['Move up (disabled)', 'Move down', '-', 'Remove project']);
  });
});

describe('reordering by keyboard and menu', () => {
  it('moves a project one place in the whole list in flat view with Alt+Up and Alt+Down', async () => {
    const { wrapper, api } = mountSection({ view: 'flat' });
    await wrapper.get('[data-project-key="x"]').trigger('click');
    await press(wrapper, 'ArrowDown', { altKey: true });
    expect(api.reorderProjects).toHaveBeenLastCalledWith(['a', 'b', 'x', 'y']);
    await press(wrapper, 'ArrowUp', { altKey: true });
    expect(api.reorderProjects).toHaveBeenLastCalledWith(['x', 'a', 'b', 'y']);
    expect(wrapper.get('[data-testid="projects-announcement"]').text()).toBe('Moved x up');
    expect(activeOf(wrapper)?.getAttribute('data-project-key')).toBe('x');
  });

  it('moves a project among its group\'s positions in grouped view, other rows staying where they are', async () => {
    const { wrapper, api } = mountSection();
    await wrapper.get('[data-project-key="x"]').trigger('click');
    await press(wrapper, 'ArrowDown', { altKey: true });
    expect(api.reorderProjects).toHaveBeenLastCalledWith(['a', 'y', 'b', 'x']);
    await press(wrapper, 'ArrowUp', { altKey: true });
    expect(api.reorderProjects).toHaveBeenCalledOnce();
  });

  it('moves a group with Alt+Up on its header, keeping a group with no project shown in its place', async () => {
    const { wrapper, api } = mountSection({ groups: { order: ['local', 'loopback', 'ssh+h1'], collapsed: [] } });
    await header(wrapper, 'ssh+h1').trigger('click');
    await press(wrapper, 'ArrowUp', { altKey: true });
    expect(api.reorderProjectGroups).toHaveBeenLastCalledWith(['ssh+h1', 'loopback', 'local']);
    expect(api.reorderProjects).not.toHaveBeenCalled();
  });

  it('runs Move up and Move down from the project and header menus', async () => {
    const { wrapper, api } = mountSection();
    api.answerNext({ kind: 'menu', itemId: 'moveUp' });
    await wrapper.get('[data-project-key="b"]').trigger('contextmenu');
    await flushPromises();
    expect(api.reorderProjects).toHaveBeenLastCalledWith(['b', 'x', 'a', 'y']);
    api.answerNext({ kind: 'menu', itemId: 'moveDown' });
    await header(wrapper, 'local').trigger('contextmenu');
    await flushPromises();
    expect(api.reorderProjectGroups).toHaveBeenLastCalledWith(['ssh+h1', 'local']);
  });

  it('announces each move, a repeated one too, and nothing main refused', async () => {
    const { wrapper, api } = mountSection({ view: 'flat' });
    const region = wrapper.get('[data-testid="projects-announcement"]');
    const texts: string[] = [];
    new MutationObserver(() => texts.push(region.text())).observe(region.element, { childList: true, characterData: true, subtree: true });
    await wrapper.get('[data-project-key="y"]').trigger('click');
    await press(wrapper, 'ArrowUp', { altKey: true });
    await press(wrapper, 'ArrowUp', { altKey: true });
    expect(texts.filter((text) => text === 'Moved y up')).toHaveLength(2);
    vi.mocked(api.reorderProjects).mockResolvedValue(false);
    texts.length = 0;
    await press(wrapper, 'ArrowUp', { altKey: true });
    expect(texts).toEqual([]);
    // the inline line is the one report of a refused order
    expect(wrapper.get('[data-testid="projects-refusal"]').attributes('role')).toBe('alert');
    expect(wrapper.get('[data-testid="projects-refusal"]').text()).toBe('The order could not be saved. Try again.');
  });
});

describe('reordering by drag', () => {
  // happy-dom lays nothing out, so each test gives the elements it drags over their boxes.
  function layout(boxes: ReadonlyMap<Element, { top: number; height: number }>): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = boxes.get(this) ?? { top: 0, height: 0 };
      return new DOMRect(0, box.top, 200, box.height);
    });
    vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
  }
  const pointer = (type: string, clientY: number): PointerEvent => new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientY });

  it('drops a row on another place in flat view, and a short press still selects', async () => {
    const { wrapper, api } = mountSection({ view: 'flat' });
    const rows = ['a', 'x', 'b', 'y'].map((key) => wrapper.get(`[data-project-key="${key}"]`).element);
    layout(new Map(rows.map((row, index) => [row, { top: index * 35, height: 34 }])));

    // 2px is under the 0.25rem threshold
    rows[0]!.dispatchEvent(pointer('pointerdown', 10));
    window.dispatchEvent(pointer('pointermove', 12));
    await flushPromises();
    expect(rows[0]!.hasAttribute('data-dragging')).toBe(false);
    window.dispatchEvent(pointer('pointerup', 12));
    rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(api.selectProject).toHaveBeenCalledWith('a');
    expect(api.reorderProjects).not.toHaveBeenCalled();

    rows[3]!.dispatchEvent(pointer('pointerdown', 120));
    window.dispatchEvent(pointer('pointermove', 60));
    window.dispatchEvent(pointer('pointermove', 30));
    await flushPromises();
    expect(rows[3]!.getAttribute('data-dragging')).toBe('true');
    window.dispatchEvent(pointer('pointerup', 30));
    list(wrapper).element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(api.reorderProjects).toHaveBeenCalledWith(['a', 'y', 'x', 'b']);
    expect(api.selectProject).toHaveBeenCalledTimes(1);
  });

  it('slides a project dropped on another host\'s group back and says why in the inline alert', async () => {
    const projects = [project('app', PROD), project('billing', PROD), project('web', STAGING)];
    const { wrapper, api } = mountSection({ projects, groups: { order: ['local', 'ssh+h1', 'ssh+h2'], collapsed: [] } });
    const prod = wrapper.get('[data-testid="project-group"][data-group="ssh+h1"]').element;
    const staging = wrapper.get('[data-testid="project-group"][data-group="ssh+h2"]').element;
    const app = wrapper.get('[data-project-key="app"]').element;
    const billing = wrapper.get('[data-project-key="billing"]').element;
    layout(new Map([[prod, { top: 0, height: 100 }], [app, { top: 30, height: 34 }], [billing, { top: 65, height: 34 }], [staging, { top: 100, height: 70 }]]));

    app.dispatchEvent(pointer('pointerdown', 40));
    window.dispatchEvent(pointer('pointermove', 140));
    await flushPromises();
    expect(staging.getAttribute('data-refuse')).toBe('true');
    window.dispatchEvent(pointer('pointerup', 140));
    await flushPromises();

    expect(api.reorderProjects).not.toHaveBeenCalled();
    expect(app.hasAttribute('data-dragging')).toBe(false);
    expect(staging.hasAttribute('data-refuse')).toBe(false);
    const alert = wrapper.get('[data-testid="projects-refusal"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toContain('app is on prod-1. Open a folder on staging instead?');
    await wrapper.get('[data-testid="projects-refusal-action"]').trigger('click');
    expect(api.openHostFolder).toHaveBeenCalledWith('h2');
  });

  it('drops a project among the positions of its group in grouped view, other rows staying where they are', async () => {
    const { wrapper, api } = mountSection();
    const x = wrapper.get('[data-project-key="x"]').element;
    const y = wrapper.get('[data-project-key="y"]').element;
    layout(new Map([[x, { top: 100, height: 34 }], [y, { top: 135, height: 34 }]]));

    y.dispatchEvent(pointer('pointerdown', 150));
    window.dispatchEvent(pointer('pointermove', 105));
    window.dispatchEvent(pointer('pointerup', 105));
    await flushPromises();
    expect(api.reorderProjects).toHaveBeenCalledWith(['a', 'y', 'b', 'x']);
  });

  it('lets a dropped row go when the state after a saved write keeps the old order, so the next drag starts', async () => {
    const { wrapper, api } = mountSection({ view: 'flat' });
    const rows = ['a', 'x', 'b', 'y'].map((key) => wrapper.get(`[data-project-key="${key}"]`).element);
    layout(new Map(rows.map((row, index) => [row, { top: index * 35, height: 34 }])));
    rows[3]!.dispatchEvent(pointer('pointerdown', 120));
    window.dispatchEvent(pointer('pointermove', 30));
    window.dispatchEvent(pointer('pointerup', 30));
    await flushPromises();
    expect(api.reorderProjects).toHaveBeenCalledWith(['a', 'y', 'x', 'b']);
    expect(rows[3]!.getAttribute('data-dragging')).toBe('true');
    // a write that raced this one: main's next state lists the rows as they were
    await wrapper.setProps({ projects: [...PROJECTS] });
    await flushPromises();
    expect(rows[3]!.hasAttribute('data-dragging')).toBe(false);
    rows[3]!.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true, propertyName: 'transform' }));
    await flushPromises();
    rows[0]!.dispatchEvent(pointer('pointerdown', 10));
    window.dispatchEvent(pointer('pointermove', 120));
    await flushPromises();
    expect(rows[0]!.getAttribute('data-dragging')).toBe('true');
  });

  it('drops a group above another by its header', async () => {
    const { wrapper, api } = mountSection();
    const local = wrapper.get('[data-testid="project-group"][data-group="local"]').element;
    const prod = wrapper.get('[data-testid="project-group"][data-group="ssh+h1"]').element;
    layout(new Map([[local, { top: 0, height: 100 }], [prod, { top: 101, height: 100 }]]));

    header(wrapper, 'ssh+h1').element.dispatchEvent(pointer('pointerdown', 110));
    window.dispatchEvent(pointer('pointermove', 20));
    await flushPromises();
    expect(prod.getAttribute('data-dragging')).toBe('true');
    window.dispatchEvent(pointer('pointerup', 20));
    await flushPromises();
    expect(api.reorderProjectGroups).toHaveBeenCalledWith(['ssh+h1', 'local']);
    expect(api.setProjectGroupCollapsed).not.toHaveBeenCalled();
  });
});

describe('renaming a host', () => {
  it('renames in place on the group header: Enter saves, a refusal shows inline and shakes, Escape restores', async () => {
    const api = fakeShellApi([], {
      renameHost: vi.fn(async (_hostId: string, name: string) => (name === 'staging' ? { ok: false as const, reason: 'taken' as const, clashWith: 'staging' } : { ok: true as const, name })),
    });
    const { wrapper } = mountSection({ api });
    api.answerNext({ kind: 'menu', itemId: 'rename' });
    await wrapper.get('[data-project-key="x"]').trigger('contextmenu');
    await flushPromises();
    const group = wrapper.get('[data-testid="project-group"][data-group="ssh+h1"]');
    const input = group.get<HTMLInputElement>('[data-testid="host-name-input"]');
    expect(document.activeElement).toBe(input.element);
    expect(input.element.value).toBe('prod-1');

    await input.setValue('staging');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.renameHost).toHaveBeenLastCalledWith('h1', 'staging');
    expect(group.get('[data-testid="host-name-error"]').text()).toBe('Another host is already called staging');
    expect(input.classes()).toContain('d-shake');

    await input.trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(group.find('[data-testid="host-name-input"]').exists()).toBe(false);
    expect(group.get('[data-testid="project-group-name"]').text()).toBe('prod-1');
    expect(api.renameHost).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(list(wrapper).element);

    api.answerNext({ kind: 'menu', itemId: 'rename' });
    await header(wrapper, 'ssh+h1').trigger('contextmenu');
    await flushPromises();
    await group.get('[data-testid="host-name-input"]').setValue('billing-prod');
    await group.get('[data-testid="host-name-input"]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.renameHost).toHaveBeenLastCalledWith('h1', 'billing-prod');
    expect(group.find('[data-testid="host-name-input"]').exists()).toBe(false);
  });

  it('saves on leaving the field, and restores the old name when main refuses it there', async () => {
    const api = fakeShellApi([], {
      renameHost: vi.fn(async (_hostId: string, name: string) => (name === 'staging' ? { ok: false as const, reason: 'taken' as const, clashWith: 'staging' } : { ok: true as const, name })),
    });
    const { wrapper } = mountSection({ api });
    const outside = document.body.appendChild(document.createElement('button'));
    const group = wrapper.get('[data-testid="project-group"][data-group="ssh+h1"]');
    const rename = async (name: string): Promise<void> => {
      api.answerNext({ kind: 'menu', itemId: 'rename' });
      await header(wrapper, 'ssh+h1').trigger('contextmenu');
      await flushPromises();
      await group.get('[data-testid="host-name-input"]').setValue(name);
      outside.focus();
      await flushPromises();
    };
    await rename('staging');
    expect(api.renameHost).toHaveBeenLastCalledWith('h1', 'staging');
    expect(group.find('[data-testid="host-name-input"]').exists()).toBe(false);
    expect(group.get('[data-testid="project-group-name"]').text()).toBe('prod-1');
    await rename('billing-prod');
    expect(api.renameHost).toHaveBeenLastCalledWith('h1', 'billing-prod');
    expect(group.find('[data-testid="host-name-input"]').exists()).toBe(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('says in place that the name was not saved when main could not save it, keeping the field open for another try', async () => {
    const api = fakeShellApi([], {
      renameHost: vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('ipc')).mockResolvedValue({ ok: true as const, name: 'billing-prod' }),
    });
    const { wrapper } = mountSection({ api });
    api.answerNext({ kind: 'menu', itemId: 'rename' });
    await header(wrapper, 'ssh+h1').trigger('contextmenu');
    await flushPromises();
    const group = wrapper.get('[data-testid="project-group"][data-group="ssh+h1"]');
    const input = group.get<HTMLInputElement>('[data-testid="host-name-input"]');
    await input.setValue('billing-prod');
    for (let attempt = 0; attempt < 2; attempt++) {
      await input.trigger('keydown', { key: 'Enter' });
      await flushPromises();
      expect(group.get('[data-testid="host-name-error"]').text()).toBe('The name could not be saved. Try again.');
      expect(input.element.value).toBe('billing-prod');
    }
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.renameHost).toHaveBeenCalledTimes(3);
    expect(group.find('[data-testid="host-name-input"]').exists()).toBe(false);
  });

  it('opens the host card to rename from a project menu in flat view', async () => {
    const { wrapper, api } = mountSection({ view: 'flat' });
    api.answerNext({ kind: 'menu', itemId: 'rename' });
    await wrapper.get('[data-project-key="x"]').trigger('contextmenu');
    await flushPromises();
    expect(api.renameHostOnCard).toHaveBeenCalledWith('h1');
    expect(wrapper.find('[data-testid="host-name-input"]').exists()).toBe(false);
  });

  it('swaps a group header\'s name when the host is renamed', async () => {
    const { wrapper } = mountSection();
    await wrapper.setProps({ projects: PROJECTS.map((entry) => (entry.authority.key === 'ssh+h1' ? { ...entry, authority: { ...PROD, name: 'billing-prod' } } : entry)) });
    // the old name leaves before the new one enters
    expect(wrapper.get('[data-group="ssh+h1"] [data-testid="project-group-name"] .t-swap-leave-active').text()).toBe('prod-1');
  });
});

describe('a project added to the list', () => {
  it('drops into place, then plays the attention ring once', async () => {
    const { wrapper } = mountSection({ view: 'flat' });
    expect(wrapper.find('.d-row-drop').exists()).toBe(false);
    await wrapper.setProps({ projects: [...PROJECTS, project('api', PROD)] });
    const row = wrapper.get('[data-project-key="api"]');
    expect(row.classes()).toContain('d-row-drop');
    row.element.dispatchEvent(new AnimationEvent('animationend', { animationName: 'd-tuck-in' }));
    await flushPromises();
    expect(row.classes()).not.toContain('d-row-drop');
    expect(row.classes()).toContain('d-attention');
  });

  it('opens its collapsed group in grouped view', async () => {
    const { wrapper, api } = mountSection({ groups: { order: GROUPS.order, collapsed: ['ssh+h1'] } });
    await wrapper.setProps({ projects: [...PROJECTS, project('api', PROD)] });
    expect(api.setProjectGroupCollapsed).toHaveBeenCalledWith('ssh+h1', false);
  });
});
