// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { ShellEditorTab } from '../../preload/shell-channels';
import Breadcrumbs from '../editor/Breadcrumbs.vue';
import { shellI18n } from '../i18n';

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
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

  it('gives way by weight: the folders first, the place next, and the file crumb truncates last', () => {
    const crumbs = mountTab({ displayPath: 'C:\\a\\b.ts', readOnly: true }).findAll('[data-crumb]');
    const folders = crumbs[0]!.element.parentElement!;
    expect([...folders.classList]).toEqual(expect.arrayContaining(['min-w-0', 'overflow-hidden', 'shrink-100000000']));
    expect(folders.contains(crumbs.at(-1)!.element)).toBe(false);
    expect(crumbs.at(-1)!.classes()).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    expect(crumbs.at(-1)!.classes()).not.toContain('shrink-0');
  });
});
