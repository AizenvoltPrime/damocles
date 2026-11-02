// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PortsSection from '../components/PortsSection.vue';
import { menuChoice, portDotShape, portMenu, remoteText } from '../components/ports-section';
import { shellI18n } from '../i18n';
import type { OverlayMenuItem, OverlayRequest } from '../../preload/overlay-channels';
import type { PortRow, PortsView } from '../../preload/ports-channels';
import { FakeResizeObserver, fakePortsApi, fakeShellApi, type FakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

const VITE: PortRow = { key: 'localhost:5173', remoteHost: 'localhost', remotePort: 5173, localPort: 5174, label: 'vite', processLabel: 'node (npm run dev)', state: 'forwarded', liveConnections: 2, origin: 'auto', onDetect: 'notify' };
const HTTP: PortRow = { key: 'localhost:8000', remoteHost: 'localhost', remotePort: 8000, localPort: 8000, processLabel: 'python3', state: 'forwarded', liveConnections: 0, origin: 'auto', onDetect: 'notify' };
const DB: PortRow = { key: 'db:5432', remoteHost: 'db', remotePort: 5432, state: 'detected', liveConnections: 0, origin: 'auto', onDetect: 'notify' };
const view = (rows: readonly PortRow[], patch: Partial<PortsView> = {}): PortsView => ({ hostId: 'h1', autoForwardMode: 'all', autoForward: true, connected: true, rows, ...patch });

async function mountPorts(first: PortsView | null, hostId = 'h1'): Promise<{ wrapper: VueWrapper<InstanceType<typeof PortsSection>>; api: FakeShellApi; ports: ReturnType<typeof fakePortsApi> }> {
  const ports = fakePortsApi(async () => first);
  const api = fakeShellApi([], { ports });
  const wrapper = mount(PortsSection, {
    props: { api, projectKey: 'ssh+h1/srv/app', hostId, hostName: 'prod-1', collapsed: false },
    global: { plugins: [shellI18n] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, api, ports };
}

const rowOf = (wrapper: VueWrapper, port: number) => wrapper.get(`[data-testid="port-row"][data-port="${port}"]`);

describe('Ports rows', () => {
  it('reads "5173 → localhost:5174" with the label and process under it, marking a local port that differs', async () => {
    const { wrapper } = await mountPorts(view([VITE, HTTP, DB]));
    const vite = rowOf(wrapper, 5173);
    expect(vite.get('[data-testid="port-mapping"]').text().replace(/\s+/g, ' ')).toBe('5173 → forwarded to localhost:5174');
    expect(vite.get('[data-testid="port-local"]').attributes('data-via')).toBe('true');
    expect(vite.get('[data-testid="port-detail"]').text()).toBe('vite · node (npm run dev)');
    expect(vite.attributes('title')).toBe('prod-1:5173 → localhost:5174 · node (npm run dev)');
    expect(rowOf(wrapper, 8000).get('[data-testid="port-local"]').attributes('data-via')).toBeUndefined();
    const db = rowOf(wrapper, 5432);
    expect(db.get('[data-testid="port-mapping"]').text().replace(/\s+/g, ' ')).toBe('db:5432 · not forwarded');
    expect(db.find('[data-testid="port-forward"]').exists()).toBe(true);
    expect(db.find('[data-testid="port-open-pane"]').exists()).toBe(false);
    expect(wrapper.get('[role="table"]').attributes('aria-label')).toBe('Ports on prod-1');
  });

  it('gives each state its own dot shape and name, green only while connections are live', async () => {
    const { wrapper } = await mountPorts(view([VITE, HTTP, DB, { ...DB, key: 'localhost:9', remoteHost: 'localhost', remotePort: 9, state: 'ignored' }, { ...DB, key: 'localhost:7', remoteHost: 'localhost', remotePort: 7, state: 'error', error: 'listenFailed' }]));
    const dot = (port: number) => rowOf(wrapper, port).get('[data-testid="port-dot"]');
    expect([5173, 8000, 5432, 9, 7].map((port) => dot(port).attributes('data-shape'))).toEqual(['live', 'idle', 'detected', 'ignored', 'error']);
    expect(dot(5173).attributes()).toMatchObject({ role: 'img', 'aria-label': 'Forwarding, 2 open connections' });
    expect(dot(5173).classes()).toContain('text-(--d-success)');
    expect(dot(8000).attributes('aria-label')).toBe('Forwarded, no open connections');
    expect(dot(8000).classes()).not.toContain('text-(--d-success)');
    expect(portDotShape({ ...HTTP, liveConnections: 1 })).toBe('live');
  });

  it('slides in only rows that arrive after the first list, and a newer push beats an older read', async () => {
    let answer!: (value: PortsView) => void;
    const ports = fakePortsApi(() => new Promise<PortsView>((resolve) => { answer = resolve; }));
    const api = fakeShellApi([], { ports });
    const wrapper = mount(PortsSection, { props: { api, projectKey: 'p', hostId: 'h1', hostName: 'prod-1', collapsed: false }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    ports.push(view([HTTP]));
    await flushPromises();
    answer(view([]));
    await flushPromises();
    expect(wrapper.findAll('[data-testid="port-row"]')).toHaveLength(1);
    expect(rowOf(wrapper, 8000).classes()).not.toContain('d-row-arrive');
    ports.push(view([VITE, HTTP]));
    ports.push({ ...view([]), hostId: 'other' });
    await flushPromises();
    expect(rowOf(wrapper, 5173).classes()).toContain('d-row-arrive');
    expect(rowOf(wrapper, 8000).classes()).not.toContain('d-row-arrive');
    await rowOf(wrapper, 5173).trigger('animationend');
    expect(rowOf(wrapper, 5173).classes()).not.toContain('d-row-arrive');
    await wrapper.setProps({ hostId: 'h2' });
    ports.push({ ...view([DB]), hostId: 'h2' });
    await flushPromises();
    expect(rowOf(wrapper, 5432).classes()).not.toContain('d-row-arrive');
  });

  it('hides the section for a host main forwards no ports for', async () => {
    const { wrapper } = await mountPorts(null);
    expect(wrapper.find('[data-testid="ports-section"]').exists()).toBe(false);
  });
});

describe('Ports keyboard and actions', () => {
  it('keeps one row in the tab order and moves it with the arrow keys, Home and End', async () => {
    const { wrapper } = await mountPorts(view([VITE, HTTP, DB]));
    const rows = () => wrapper.findAll('[data-testid="port-row"]');
    expect(rows().map((row) => row.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    (rows()[0]!.element as HTMLElement).focus();
    await rows()[0]!.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(document.activeElement).toBe(rows()[1]!.element);
    expect(rows().map((row) => row.attributes('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(rows()[1]!.get('[data-testid="port-open-pane"]').attributes('tabindex')).toBe('0');
    expect(rows()[0]!.get('[data-testid="port-open-pane"]').attributes('tabindex')).toBe('-1');
    await rows()[1]!.trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(document.activeElement).toBe(rows()[2]!.element);
    await rows()[2]!.trigger('keydown', { key: 'ArrowDown' });
    await rows()[2]!.trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(document.activeElement).toBe(rows()[0]!.element);
  });

  it('runs Enter, F2 and Delete as VS Code\'s Ports view does, for the row\'s own actions only', async () => {
    const { wrapper, ports } = await mountPorts(view([VITE, DB]));
    await rowOf(wrapper, 5173).trigger('keydown', { key: 'Enter' });
    await rowOf(wrapper, 5173).trigger('keydown', { key: 'F2' });
    await rowOf(wrapper, 5173).trigger('keydown', { key: 'Delete' });
    await rowOf(wrapper, 5432).trigger('keydown', { key: 'Enter' });
    await rowOf(wrapper, 5432).trigger('keydown', { key: 'Delete' });
    expect(ports.openInPane).toHaveBeenCalledWith('ssh+h1/srv/app', 'localhost:5173');
    expect(ports.setLabel).toHaveBeenCalledWith('ssh+h1/srv/app', 'localhost:5173');
    expect(ports.stop).toHaveBeenCalledTimes(1);
    expect(ports.stop).toHaveBeenCalledWith('ssh+h1/srv/app', 'localhost:5173');
    expect(ports.forwardDetected).toHaveBeenCalledWith('ssh+h1/srv/app', 'db:5432');
  });

  it('leaves keys on a row button to the button', async () => {
    const { wrapper, ports } = await mountPorts(view([VITE]));
    await rowOf(wrapper, 5173).get('[data-testid="port-open-browser"]').trigger('keydown', { key: 'Delete' });
    expect(ports.stop).not.toHaveBeenCalled();
    await rowOf(wrapper, 5173).get('[data-testid="port-open-browser"]').trigger('click');
    expect(ports.openInBrowser).toHaveBeenCalledWith('ssh+h1/srv/app', 'localhost:5173');
  });

  it('opens the row menu from Shift+F10, and its When detected choice sets the port\'s action', async () => {
    const { wrapper, api, ports } = await mountPorts(view([VITE]));
    api.answerNext({ kind: 'menu', itemId: 'onDetect:openPane' });
    await rowOf(wrapper, 5173).trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    const request = api.overlayRequests[0] as Extract<OverlayRequest, { kind: 'menu' }>;
    expect(request.label).toBe('Port 5173');
    expect(ports.setOnDetect).toHaveBeenCalledWith('ssh+h1/srv/app', 5173, 'openPane');
    api.answerNext({ kind: 'menu', itemId: 'copyAddress' });
    await rowOf(wrapper, 5173).get('[data-testid="port-more"]').trigger('click');
    await flushPromises();
    expect(ports.copyAddress).toHaveBeenCalledWith('ssh+h1/srv/app', 'localhost:5173');
    expect(wrapper.get('[data-testid="ports-announcement"]').text()).toBe('Copied http://localhost:5174');
  });

  it('shows a check on the row for a moment after Copy address, and announces every copy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { wrapper, api } = await mountPorts(view([VITE, HTTP]));
      const status = wrapper.get('[data-testid="ports-announcement"]').element;
      const said: string[] = [];
      new MutationObserver(() => said.push(status.textContent?.trim() ?? '')).observe(status, { childList: true, characterData: true, subtree: true });
      const copy = async (): Promise<void> => {
        api.answerNext({ kind: 'menu', itemId: 'copyAddress' });
        await rowOf(wrapper, 5173).get('[data-testid="port-more"]').trigger('click');
        await flushPromises();
      };
      await copy();
      expect(rowOf(wrapper, 5173).attributes('data-copied')).toBe('true');
      expect(rowOf(wrapper, 5173).find('[data-testid="port-copied"]').exists()).toBe(true);
      expect(rowOf(wrapper, 8000).find('[data-testid="port-copied"]').exists()).toBe(false);
      expect(rowOf(wrapper, 5173).get('[data-testid="port-actions"]').classes()).toContain('group-data-copied/port:opacity-100');
      vi.advanceTimersByTime(1000);
      await copy();
      // a second copy keeps the check its own full moment
      vi.advanceTimersByTime(1000);
      await flushPromises();
      expect(rowOf(wrapper, 5173).find('[data-testid="port-copied"]').exists()).toBe(true);
      vi.advanceTimersByTime(200);
      await flushPromises();
      expect(rowOf(wrapper, 5173).find('[data-testid="port-copied"]').exists()).toBe(false);
      expect(rowOf(wrapper, 5173).attributes('data-copied')).toBeUndefined();
      expect(said.filter((text) => text !== '')).toEqual(['Copied http://localhost:5174', 'Copied http://localhost:5174']);
      expect(said.at(-2)).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives focus to the row that takes a stopped row\'s place once main\'s list drops it', async () => {
    const { wrapper, ports } = await mountPorts(view([VITE, HTTP, DB]));
    (rowOf(wrapper, 8000).element as HTMLElement).focus();
    await rowOf(wrapper, 8000).trigger('keydown', { key: 'Delete' });
    expect(ports.stop).toHaveBeenCalledWith('ssh+h1/srv/app', 'localhost:8000');
    // a list that still holds it moves nothing
    ports.push(view([VITE, { ...HTTP, liveConnections: 1 }, DB]));
    await flushPromises();
    expect(document.activeElement).toBe(rowOf(wrapper, 8000).element);
    ports.push(view([VITE, DB]));
    await flushPromises();
    expect(document.activeElement).toBe(rowOf(wrapper, 5432).element);
    expect(rowOf(wrapper, 5432).attributes('tabindex')).toBe('0');
  });

  it('gives focus to the row above when the stopped row was last, and to the section header when none is left', async () => {
    const { wrapper, ports } = await mountPorts(view([VITE, HTTP]));
    const stop = rowOf(wrapper, 8000).get('[data-testid="port-stop"]');
    (stop.element as HTMLElement).focus();
    await stop.trigger('click');
    ports.push(view([VITE]));
    await flushPromises();
    expect(document.activeElement).toBe(rowOf(wrapper, 5173).element);
    await rowOf(wrapper, 5173).trigger('keydown', { key: 'Delete' });
    ports.push(view([]));
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="sidebar-section-header"] button').element);
  });

  it('leaves focus where the user moved it before the stopped row left', async () => {
    const { wrapper, ports } = await mountPorts(view([VITE, HTTP]));
    (rowOf(wrapper, 8000).element as HTMLElement).focus();
    await rowOf(wrapper, 8000).trigger('keydown', { key: 'Delete' });
    const forward = wrapper.get('[data-testid="ports-forward"]').element as HTMLElement;
    forward.focus();
    ports.push(view([VITE]));
    await flushPromises();
    expect(document.activeElement).toBe(forward);
  });

  it('runs Forward a port from the header and Undo from the output-only notice', async () => {
    const { wrapper, ports } = await mountPorts(view([HTTP], { autoForwardMode: 'outputOnly' }));
    await wrapper.get('[data-testid="ports-forward"]').trigger('click');
    expect(ports.forward).toHaveBeenCalledWith('ssh+h1/srv/app');
    await wrapper.get('[data-testid="ports-undo-fallback"]').trigger('click');
    expect(ports.undoFallback).toHaveBeenCalledWith('ssh+h1/srv/app');
  });

  it('shows a failed action under the rows, in English and Greek, until the next action clears it', async () => {
    const { wrapper, ports } = await mountPorts(view([HTTP, DB], { autoForwardMode: 'outputOnly' }));
    const failure = () => wrapper.find('[data-testid="ports-failure"]');
    vi.mocked(ports.stop).mockRejectedValueOnce(new Error('Error invoking remote method: ViaWslError'));
    await rowOf(wrapper, 8000).get('[data-testid="port-stop"]').trigger('click');
    await flushPromises();
    expect(failure().attributes('role')).toBe('alert');
    expect(failure().text()).toBe('Port 8000: that didn\'t work. Try again.');
    await rowOf(wrapper, 8000).get('[data-testid="port-open-pane"]').trigger('click');
    await flushPromises();
    expect(failure().exists()).toBe(false);
    vi.mocked(ports.forward).mockRejectedValueOnce(new Error('disconnected'));
    await wrapper.get('[data-testid="ports-forward"]').trigger('click');
    await flushPromises();
    expect(failure().text()).toBe('The port wasn\'t forwarded. Try again.');
    shellI18n.global.locale.value = 'el';
    vi.mocked(ports.undoFallback).mockRejectedValueOnce(new Error('disconnected'));
    await wrapper.get('[data-testid="ports-undo-fallback"]').trigger('click');
    await flushPromises();
    expect(failure().text()).toBe('Η προώθηση όλων των θυρών δεν ενεργοποιήθηκε ξανά. Δοκιμάστε ξανά.');
    vi.mocked(ports.forwardDetected).mockRejectedValueOnce(new Error('disconnected'));
    await rowOf(wrapper, 5432).get('[data-testid="port-forward"]').trigger('click');
    await flushPromises();
    expect(failure().text()).toBe('Θύρα db:5432: αυτό δεν λειτούργησε. Δοκιμάστε ξανά.');
  });

  it('dims a host that is not connected and offers only what needs no connection', async () => {
    const { wrapper, ports } = await mountPorts(view([VITE], { connected: false }));
    expect(wrapper.get('[data-testid="ports-body"]').attributes('data-away')).toBe('true');
    expect(wrapper.get('[data-testid="ports-forward"]').attributes('disabled')).toBeDefined();
    expect(rowOf(wrapper, 5173).get('[data-testid="port-open-pane"]').attributes('disabled')).toBeDefined();
    await rowOf(wrapper, 5173).trigger('keydown', { key: 'Enter' });
    expect(ports.openInPane).not.toHaveBeenCalled();
    await rowOf(wrapper, 5173).trigger('keydown', { key: 'F2' });
    expect(ports.setLabel).toHaveBeenCalled();
  });

  it('words the empty state by the automatic forwarding setting', async () => {
    const auto = await mountPorts(view([]));
    expect(auto.wrapper.get('[data-testid="ports-empty"]').text()).toContain('Ports that programs on prod-1 listen on show up here.');
    const manual = await mountPorts(view([], { autoForward: false }));
    expect(manual.wrapper.get('[data-testid="ports-empty"]').text()).toContain('Automatic forwarding is off.');
  });
});

describe('Ports row menu', () => {
  const labels = { action: (action: string) => action, whenDetected: 'When detected', onDetect: (value: string) => value };
  const ids = (items: readonly OverlayMenuItem[]) => items.map((item) => (item.kind === 'separator' ? '-' : item.id));

  it('lists every action for a forward, Stop last and set apart, with the effective When detected checked', () => {
    const items = portMenu({ ...VITE, onDetect: 'silent' }, labels, true);
    expect(ids(items)).toEqual(['openInPane', 'openInBrowser', 'copyAddress', '-', 'setLabel', 'changeLocalPort', 'whenDetected', '-', 'stop']);
    const submenu = items.find((item) => item.kind === 'submenu');
    expect(submenu?.kind === 'submenu' && submenu.items.map((item) => item.kind === 'item' && [item.id, item.checked, item.radio])).toEqual([
      ['onDetect:notify', false, true], ['onDetect:openPane', false, true], ['onDetect:openBrowser', false, true], ['onDetect:silent', true, true], ['onDetect:ignore', false, true],
    ]);
    expect(items.at(-1)).toMatchObject({ id: 'stop', danger: true });
  });

  it('offers Forward to a detected or ignored port and Forward or Stop to one that failed', () => {
    expect(ids(portMenu(DB, labels, true))).toEqual(['forward', '-', 'setLabel', 'whenDetected']);
    expect(ids(portMenu({ ...DB, state: 'ignored' }, labels, true))).toEqual(['forward', '-', 'setLabel', 'whenDetected']);
    expect(ids(portMenu({ ...DB, state: 'error', error: 'listenFailed' }, labels, true))).toEqual(['forward', '-', 'whenDetected', '-', 'stop']);
    const away = portMenu(VITE, labels, false).filter((item) => item.kind === 'item' && item.disabled).map((item) => item.kind === 'item' && item.id);
    expect(away).toEqual(['openInPane', 'openInBrowser', 'copyAddress', 'changeLocalPort']);
  });

  it('reads back only the ids it offered', () => {
    expect(menuChoice('onDetect:ignore')).toEqual({ onDetect: 'ignore' });
    expect(menuChoice('stop')).toEqual({ action: 'stop' });
    expect(menuChoice('onDetect:never')).toBeUndefined();
    expect(menuChoice('whenDetected')).toBeUndefined();
    expect(remoteText(DB)).toBe('db:5432');
    expect(remoteText(VITE)).toBe('5173');
  });
});
