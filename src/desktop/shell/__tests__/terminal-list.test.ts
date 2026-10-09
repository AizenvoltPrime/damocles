// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { shallowRef } from 'vue';
import type { TerminalGroupInfo, TerminalInfo } from '../../preload/terminal-channels';
import TerminalList from '../terminal/TerminalList.vue';
import { TERMINAL_STORE, type TerminalStore } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { fakeShellApi, type FakeShellApi } from './fakes';

const info = (id: string, title = id): TerminalInfo => ({
  id, title, name: null, profileId: 'cmd', icon: 'cmd', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: false,
});
const group = (id: string, paneIds: string[]): TerminalGroupInfo => ({ id, paneIds, activePaneId: paneIds[0]!, sizes: paneIds.map(() => 1 / paneIds.length) });

const terminals = [info('term-1', 'dev server'), info('term-2', 'tests'), info('term-3', 'logs'), info('term-4', 'shell'), info('term-5', 'build')];
const groups = [group('group-1', ['term-1', 'term-2', 'term-3']), group('group-2', ['term-4']), group('group-3', ['term-5'])];

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

function mountList(activeId = 'term-2'): { api: FakeShellApi; wrapper: VueWrapper } {
  const api = fakeShellApi();
  const store = { renaming: shallowRef(null), startRename: vi.fn(), state: shallowRef(null) } as unknown as TerminalStore;
  wrapper = mount(TerminalList, {
    props: { api, platform: 'win32', terminals, groups, activeId, splitShortcut: 'Ctrl+Shift+5', widthRem: 12, panelWidth: 1200 },
    global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, 'transition-group': false } },
  });
  return { api, wrapper };
}

const row = (w: VueWrapper, id: string) => w.get(`[data-testid="terminal-row"][data-terminal-id="${id}"]`);

describe('grouped terminal list', () => {
  it('lists one row per pane in group order', () => {
    const { wrapper: w } = mountList();
    expect(w.findAll('[data-testid="terminal-row"]').map((r) => r.attributes('data-terminal-id'))).toEqual(['term-1', 'term-2', 'term-3', 'term-4', 'term-5']);
  });

  // VS Code's ┌ ├ └ prefixes, drawn as lines; a single-pane group has none.
  it('draws the tree on the rows of a split group only', () => {
    const { wrapper: w } = mountList();
    expect(row(w, 'term-1').get('[data-testid="terminal-row-tree"]').attributes('data-tree')).toBe('first');
    expect(row(w, 'term-2').get('[data-testid="terminal-row-tree"]').attributes('data-tree')).toBe('middle');
    expect(row(w, 'term-3').get('[data-testid="terminal-row-tree"]').attributes('data-tree')).toBe('last');
    expect(row(w, 'term-4').find('[data-testid="terminal-row-tree"]').exists()).toBe(false);
    expect(row(w, 'term-1').get('[data-testid="terminal-row-tree"]').attributes('aria-hidden')).toBe('true');
  });

  // Accent stays the active row's bar alone; the shown group's tree is a step brighter than the others.
  it('draws the shown group\'s tree in the muted colour and other groups\' in the faint one', () => {
    const { wrapper: w } = mountList('term-2');
    expect(row(w, 'term-1').get('[data-testid="terminal-row-tree"]').classes()).toContain('text-(--d-muted)');
    wrapper!.unmount();
    const { wrapper: other } = mountList('term-4');
    expect(row(other, 'term-1').get('[data-testid="terminal-row-tree"]').classes()).toContain('text-(--d-faint)');
  });

  // VS Code's splitTerminalAriaLabel; aria-posinset on a tab would mean its place in the whole list.
  it('tells a screen reader where a pane sits in its group, and keeps tab semantics', () => {
    const { wrapper: w } = mountList();
    expect(row(w, 'term-2').get('[data-testid="terminal-row-split"]').text()).toBe('split 2 of 3');
    expect(row(w, 'term-4').find('[data-testid="terminal-row-split"]').exists()).toBe(false);
    expect(row(w, 'term-2').attributes('role')).toBe('tab');
    expect(row(w, 'term-2').attributes('aria-selected')).toBe('true');
    expect(row(w, 'term-2').attributes('aria-posinset')).toBeUndefined();
  });

  // role="tab" makes its children presentational, so without its own name a row would read its Split and Kill labels too.
  it('names each tab by its terminal alone and ties it to its panel', () => {
    const { wrapper: w } = mountList();
    expect(row(w, 'term-2').attributes('aria-label')).toBe('tests, split 2 of 3, Running');
    expect(row(w, 'term-4').attributes('aria-label')).toBe('shell, Running');
    expect(row(w, 'term-2').attributes('id')).toBe('terminal-row-term-2');
    expect(row(w, 'term-2').attributes('aria-controls')).toBe('terminal-panel-term-2');
  });

  it('selects the clicked pane and splits from the row\'s Split button', async () => {
    const { wrapper: w } = mountList();
    await row(w, 'term-3').trigger('click');
    expect(w.emitted('select')).toEqual([['term-3']]);
    await row(w, 'term-4').get('[data-testid="terminal-row-split-button"]').trigger('click');
    expect(w.emitted('split')).toEqual([['term-4']]);
    expect(w.emitted('select')).toHaveLength(1);
  });

  it('opens a row\'s menu under the row from Shift+F10 in keydown, which Blink turns into no contextmenu on macOS', async () => {
    const { api, wrapper: w } = mountList();
    api.answerNext({ kind: 'dismissed' });
    const event = new KeyboardEvent('keydown', { key: 'F10', code: 'F10', shiftKey: true, bubbles: true, cancelable: true });
    row(w, 'term-3').element.dispatchEvent(event);
    await vi.waitFor(() => expect(api.overlayRequests).toHaveLength(1));
    expect(event.defaultPrevented).toBe(true);
    expect(api.overlayRequests[0]).toMatchObject({ kind: 'menu' });
  });

  it('offers Unsplit in the row menu of a split pane and sends it for that pane', async () => {
    const { api, wrapper: w } = mountList();
    api.answerNext({ kind: 'menu', itemId: 'unsplit' });
    await row(w, 'term-2').trigger('contextmenu');
    await vi.waitFor(() => expect(api.terminal.unsplit).toHaveBeenCalledWith('term-2'));
    const request = api.overlayRequests.at(-1);
    expect(request?.kind === 'menu' && request.items.map((item) => (item.kind === 'item' ? item.id : '-')).slice(0, 2)).toEqual(['split', 'unsplit']);
  });
});
