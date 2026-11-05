// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ShellEditorTab } from '../../preload/shell-channels';
import Breadcrumbs from '../editor/Breadcrumbs.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver } from './fakes';

const mounted: VueWrapper[] = [];
beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountTab(tab: Partial<ShellEditorTab>, projectName?: string): VueWrapper {
  const full: ShellEditorTab = { id: 't1', kind: 'code', title: 'x', displayPath: '', dirty: false, readOnly: false, conflict: false, ...tab };
  const wrapper = mount(Breadcrumbs, { props: { tab: full, projectName }, global: { plugins: [shellI18n] } });
  mounted.push(wrapper);
  return wrapper;
}

function crumbsOf(tab: Partial<ShellEditorTab>, projectName?: string): { texts: string[]; current: string | undefined } {
  const crumbs = mountTab(tab, projectName).findAll('[data-crumb]');
  return { texts: crumbs.map((crumb) => crumb.text()), current: crumbs.find((crumb) => crumb.attributes('aria-current') === 'location')?.text() };
}

describe('editor breadcrumbs', () => {
  it('shows a project file as the project, each folder and the file', () => {
    expect(crumbsOf({ displayPath: 'C:\\p\\src\\a.ts', projectKey: 'p1', relativePath: 'src/a.ts' }, 'alpha')).toEqual({ texts: ['alpha', 'src', 'a.ts'], current: 'a.ts' });
  });

  it('shows a file outside every project as each folder of its path and the file, so the file name stays its own crumb', () => {
    expect(crumbsOf({ displayPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\damocles-system-prompt.md' })).toEqual({
      texts: ['C:', 'Users', 'me', 'AppData', 'Local', 'Temp', 'damocles-system-prompt.md'],
      current: 'damocles-system-prompt.md',
    });
    expect(crumbsOf({ displayPath: '/tmp/notes/plan.md' }).texts).toEqual(['tmp', 'notes', 'plan.md']);
  });

  it('names the host first for another host\'s file outside every project', () => {
    const wrapper = mount(Breadcrumbs, {
      props: { tab: { id: 't1', kind: 'code', title: 'x.jsonl', displayPath: '/home/me/x.jsonl', host: 'ssh+h1', dirty: false, readOnly: false, conflict: false }, hostName: 'prod-1' },
      global: { plugins: [shellI18n] },
    });
    mounted.push(wrapper);
    expect(wrapper.findAll('[data-crumb]').map((crumb) => crumb.text())).toEqual(['prod-1', 'home', 'me', 'x.jsonl']);
  });

  it('shows control and bidi characters in a project file\'s folders and name as escapes', () => {
    expect(crumbsOf({ displayPath: 'C:\\p\\s\u202Erc\\a\u2066b.ts', projectKey: 'p1', relativePath: 's\u202Erc/a\u2066b.ts' }, 'al\u0007pha').texts)
      .toEqual(['al\\u{7}pha', 's\\u{202E}rc', 'a\\u{2066}b.ts']);
  });

  it('splits a file outside every project at its separators before escaping, so an escape never reads as a folder', () => {
    expect(crumbsOf({ displayPath: 'C:\\x\\a\u202Eb.ts' })).toEqual({ texts: ['C:', 'x', 'a\\u{202E}b.ts'], current: 'a\\u{202E}b.ts' });
  });

  it('keeps a name with no path as one crumb', () => {
    expect(crumbsOf({ displayPath: 'Untitled-1', kind: 'untitled' })).toEqual({ texts: ['Untitled-1'], current: 'Untitled-1' });
  });

  it('shows a diff\'s line counts only once its editor counted them', () => {
    const diff: ShellEditorTab = { id: 'd', kind: 'diff', title: 'a.ts', displayPath: 'a.ts', dirty: false, readOnly: false, conflict: false, diff: { originalId: 'o', modifiedId: 'm' } };
    const counted = mount(Breadcrumbs, { props: { tab: diff, diffStats: { added: 3, removed: 1 } }, global: { plugins: [shellI18n] } });
    const pending = mount(Breadcrumbs, { props: { tab: diff }, global: { plugins: [shellI18n] } });
    mounted.push(counted, pending);
    expect(counted.get('[data-testid="editor-diff-stats"]').findAll('span').map((span) => span.text())).toEqual(['+3', '−1']);
    expect(counted.get('[data-testid="editor-diff-stats"]').attributes('aria-label')).toBe('3 lines added, 1 removed');
    expect(pending.find('[data-testid="editor-diff-stats"]').exists()).toBe(false);
  });

  it('gives way by weight past the fold: the place first, the first crumb down to its floor, the file last', () => {
    const tab: ShellEditorTab = { id: 't1', kind: 'code', title: 'a.ts', displayPath: 'C:\\p\\a.ts', projectKey: 'p1', relativePath: 'a.ts', dirty: false, readOnly: false, conflict: false };
    const wrapper = mount(Breadcrumbs, { props: { tab, projectName: 'alpha', place: { kind: 'project' } }, global: { plugins: [shellI18n] } });
    mounted.push(wrapper);
    const items = wrapper.findAll('nav > ol > li');
    const [place, first, file] = items.filter((item) => item.attributes('role') !== 'presentation');
    expect(place!.classes()).toContain('shrink-1000000');
    expect(first!.classes()).toContain('shrink-10000');
    expect(file!.classes().some((name) => name.startsWith('shrink'))).toBe(false);
    expect(items.filter((item) => item.attributes('role') === 'presentation').every((item) => item.classes('shrink-0'))).toBe(true);
    expect(file!.get('[data-crumb]').classes()).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
  });
});

// A fake row: the list's items sit in order, GAP apart, each crumb 6 per character wide.
const GAP = 4;
let rowWidth = 1000;
function itemWidth(item: Element): number {
  if (item.matches('[data-testid="editor-breadcrumb-place"]')) return 40;
  if (item.matches('[data-crumb-ellipsis]')) return 12;
  if (item.getAttribute('role') === 'presentation') return 8;
  return (item.textContent ?? '').length * 6;
}
function fakeRect(element: Element): DOMRect {
  const list = element.closest('nav > ol');
  const item = list ? [...list.children].find((child) => child.contains(element)) : undefined;
  let left = 0;
  let width = list === element ? rowWidth : 0;
  if (list && item) {
    for (const child of list.children) {
      if (child === item) break;
      left += itemWidth(child) + GAP;
    }
    width = itemWidth(item);
  }
  return { x: left, y: 0, left, right: left + width, width, top: 0, bottom: 16, height: 16, toJSON: () => ({}) };
}

describe('editor breadcrumbs overflow', () => {
  // home, user, .damocles, pi, agent, sessions, the session folder and the file: 540 wide whole, 16 between two crumbs
  const SESSION = '/home/user/.damocles/pi/agent/sessions/--home-user-projects-x--/2026-11-04T14-59-52-939Z_abc.jsonl';

  async function resize(wrapper: VueWrapper, width: number): Promise<void> {
    rowWidth = width;
    // the observer watches the list from the first flush after mount
    await flushPromises();
    const observer = FakeResizeObserver.instances.find((instance) => instance.observed.includes(wrapper.get('nav > ol').element));
    (observer!.callback as (entries: { contentRect: { width: number; height: number } }[]) => void)([{ contentRect: { width, height: 16 } }]);
    await flushPromises();
  }

  function rowOf(wrapper: VueWrapper): string[] {
    return wrapper.findAll('nav > ol > li:not([role="presentation"])').map((item) => (item.attributes('data-crumb-ellipsis') === undefined ? item.text() : '…'));
  }

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return fakeRect(this);
    });
  });

  it('shows every crumb whole while they fit', async () => {
    const wrapper = mountTab({ displayPath: SESSION });
    await resize(wrapper, 652);
    expect(rowOf(wrapper)).toEqual(['home', 'user', '.damocles', 'pi', 'agent', 'sessions', '--home-user-projects-x--', '2026-11-04T14-59-52-939Z_abc.jsonl']);
  });

  it('folds the leading folders after the first crumb and keeps the trailing folders that fit, refolding on resize', async () => {
    const wrapper = mountTab({ displayPath: SESSION });
    await resize(wrapper, 651);
    expect(rowOf(wrapper)).toEqual(['home', '…', '.damocles', 'pi', 'agent', 'sessions', '--home-user-projects-x--', '2026-11-04T14-59-52-939Z_abc.jsonl']);
    await resize(wrapper, 500);
    expect(rowOf(wrapper)).toEqual(['home', '…', 'sessions', '--home-user-projects-x--', '2026-11-04T14-59-52-939Z_abc.jsonl']);
    await resize(wrapper, 280);
    expect(rowOf(wrapper)).toEqual(['home', '…', '2026-11-04T14-59-52-939Z_abc.jsonl']);
    expect(wrapper.get('[data-crumb][aria-current="location"]').text()).toBe('2026-11-04T14-59-52-939Z_abc.jsonl');
    await resize(wrapper, 1000);
    expect(rowOf(wrapper)).toHaveLength(8);
  });

  it('refolds when the crumbs change', async () => {
    const wrapper = mountTab({ displayPath: SESSION });
    await resize(wrapper, 280);
    await wrapper.setProps({ tab: { id: 't1', kind: 'code', title: 'a.md', displayPath: '/tmp/x/a.md', dirty: false, readOnly: false, conflict: false } });
    await flushPromises();
    expect(rowOf(wrapper)).toEqual(['tmp', 'x', 'a.md']);
  });

  it('takes the place crumb out of the room the folders have', async () => {
    const wrapper = mountTab({ displayPath: 'C:\\p\\src\\lib\\a.ts', projectKey: 'p1', relativePath: 'src/lib/a.ts' }, 'alpha');
    await wrapper.setProps({ place: { kind: 'project' } });
    // alpha, src, lib, a.ts: 30 + 18 + 18 + 24 and three separators of 16, after the place's 40 and a separator
    await resize(wrapper, 56 + 138);
    expect(rowOf(wrapper)).toEqual(['Project folder', 'alpha', 'src', 'lib', 'a.ts']);
    await resize(wrapper, 56 + 137);
    expect(rowOf(wrapper)).toEqual(['Project folder', 'alpha', '…', 'lib', 'a.ts']);
  });

  it('names the ellipsis and lists the hidden folders in its tooltip on focus', async () => {
    const wrapper = mount(Breadcrumbs, {
      props: { tab: { id: 't1', kind: 'code', title: 'x', displayPath: SESSION, dirty: false, readOnly: false, conflict: false } },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await resize(wrapper, 500);
    const trigger = wrapper.get('[data-crumb-ellipsis] button');
    expect(trigger.attributes('aria-label')).toBe('Hidden folders');
    expect(trigger.element.tagName).toBe('BUTTON');
    await trigger.trigger('focus');
    await flushPromises();
    const folders = document.body.querySelector('[data-reka-popper-content-wrapper] ol');
    expect([...folders?.children ?? []].map((item) => item.textContent)).toEqual(['user', '.damocles', 'pi', 'agent']);
  });

  it('keeps the first crumb at least its own width up to 2rem', async () => {
    const wrapper = mountTab({ displayPath: SESSION });
    await resize(wrapper, 280);
    expect((wrapper.findAll('nav > ol > li')[0]!.element as HTMLElement).style.minWidth).toBe('1.5rem');
  });
});
