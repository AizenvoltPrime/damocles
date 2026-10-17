// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { pickerPlacement, typeAheadMatch } from '../overlay/components/new-chat-menu';
import { branchLabels, placeChipFolds, placeOf, tabPlaces } from '../editor/editor-place';
import TabPlaceChip from '../editor/TabPlaceChip.vue';
import { toOverlayMenu, worktreeRowMenu } from '../scm/scm-menus';
import SidebarSection from '../components/SidebarSection.vue';
import Breadcrumbs from '../editor/Breadcrumbs.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver } from './fakes';

const mounted: VueWrapper[] = [];
beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

const px = (rem: number): number => rem * 16;

describe('the New menu picker placement', () => {
  it('opens under its trigger when a full list fits there', () => {
    const placed = pickerPlacement({ top: 100, bottom: 128 }, { top: 40, bottom: 400 }, 800, px);
    expect(placed).toEqual({ above: false, offset: 128 - 40 + 4, listHeight: 220 });
  });

  it('flips above its trigger when the room below is short and above is larger', () => {
    const placed = pickerPlacement({ top: 500, bottom: 528 }, { top: 300, bottom: 560 }, 600, px);
    expect(placed.above).toBe(true);
    expect(placed.offset).toBe(560 - 500 + 4);
    expect(placed.listHeight).toBe(220);
  });

  it('stays below with a shorter list when below still has more room', () => {
    const placed = pickerPlacement({ top: 60, bottom: 88 }, { top: 40, bottom: 300 }, 300, px);
    expect(placed.above).toBe(false);
    expect(placed.listHeight).toBe(300 - 88 - (33 + 4 + 8));
  });
});

describe('the New menu type-ahead', () => {
  const labels = ['New chat', 'Run in a new worktree', 'fix-login', 'feat-auth'];
  it('moves to the next row starting with the letter, cycling on repeats', () => {
    expect(typeAheadMatch(labels, 0, 'f')).toBe(2);
    expect(typeAheadMatch(labels, 2, 'f')).toBe(3);
    expect(typeAheadMatch(labels, 3, 'f')).toBe(2);
  });
  it('matches a longer prefix from the current row and reports no match', () => {
    expect(typeAheadMatch(labels, 2, 'fe')).toBe(3);
    expect(typeAheadMatch(labels, 0, 'zz')).toBe(-1);
  });
});

describe('editor tab places', () => {
  const tab = (patch: Partial<ShellEditorTab>): ShellEditorTab => ({ id: 't', kind: 'code', title: 'a.ts', displayPath: 'src/a.ts', ...patch } as ShellEditorTab);
  const worktreeTab = tab({ id: 'w', projectKey: 'p1\u0000a1b2c3d4', worktreeBranch: 'damocles/fix-login' });
  const projectTab = tab({ id: 'p', projectKey: 'p1' });
  const otherTab = tab({ id: 'o', projectKey: 'p2' });

  it('marks a project-folder tab only while its project has worktree tabs open', () => {
    const places = tabPlaces([worktreeTab, projectTab, otherTab]);
    expect([...places.worktreeProjects]).toEqual(['p1']);
    expect(placeOf(worktreeTab, places)).toEqual({ kind: 'worktree', branch: 'damocles/fix-login', label: 'fix-login' });
    expect(placeOf(projectTab, places)).toEqual({ kind: 'project' });
    expect(placeOf(otherTab, places)).toBeUndefined();
    expect(placeOf(projectTab, tabPlaces([projectTab]))).toBeUndefined();
  });

  it('keeps a worktree tab marked as a worktree while main cannot name its branch, so it never reads as the project folder\'s copy', () => {
    const closing = tab({ id: 'c', projectKey: 'p1\u0000a1b2c3d4' });
    const places = tabPlaces([closing, projectTab]);
    expect(placeOf(closing, places)).toEqual({ kind: 'worktree', branch: undefined, label: undefined });
    expect(placeOf(projectTab, places)).toEqual({ kind: 'project' });
    const chip = mount(TabPlaceChip, { props: { place: placeOf(closing, places)!, folded: false }, global: { plugins: [shellI18n] } });
    mounted.push(chip);
    expect(chip.attributes('data-testid')).toBe('editor-tab-worktree');
    expect(chip.get('[data-testid="editor-tab-place-label"]').text()).toBe('Worktree');
    expect(chip.attributes('aria-label')).toBe('Worktree');
    const crumbs = mount(Breadcrumbs, { props: { tab: { ...closing, relativePath: 'src/a.ts' }, projectName: 'acme', place: placeOf(closing, places) }, global: { plugins: [shellI18n] } });
    mounted.push(crumbs);
    expect(crumbs.get('[data-testid="editor-breadcrumb-place"]').attributes('data-place')).toBe('worktree');
    expect(crumbs.get('[data-testid="editor-breadcrumb-place"]').text()).toContain('Worktree');
  });

  it('tells two open worktree tabs with the same leaf apart by the shortest part of their branches that differs', () => {
    const login = tab({ id: 'a', projectKey: 'p1\u0000a1b2c3d4', worktreeBranch: 'damocles/fix-login' });
    const other = tab({ id: 'b', projectKey: 'p1\u0000b1b2c3d4', worktreeBranch: 'ax/fix-login' });
    const lone = tab({ id: 'c', projectKey: 'p1\u0000c1b2c3d4', worktreeBranch: 'damocles/add-tests' });
    const places = tabPlaces([login, other, lone]);
    expect(placeOf(login, places)).toMatchObject({ label: 'damocles/fix-login' });
    expect(placeOf(other, places)).toMatchObject({ label: 'ax/fix-login' });
    expect(placeOf(lone, places)).toMatchObject({ label: 'add-tests' });
    // with the other tab closed the leaf alone tells it apart again
    expect(placeOf(login, tabPlaces([login, lone]))).toMatchObject({ label: 'fix-login' });
    expect(branchLabels(['a/b/fix', 'c/b/fix', 'fix', 'd/fix'])).toEqual(new Map([['a/b/fix', 'a/b/fix'], ['c/b/fix', 'c/b/fix'], ['fix', 'fix'], ['d/fix', 'd/fix']]));
  });

  it('puts the place first in the breadcrumbs, the worktree as its leaf with the full branch for assistive technology', () => {
    const wrapper = mount(Breadcrumbs, { props: { tab: { ...worktreeTab, relativePath: 'src/a.ts' }, projectName: 'acme', place: { kind: 'worktree', branch: 'damocles/fix-login', label: 'fix-login' } }, global: { plugins: [shellI18n] } });
    mounted.push(wrapper);
    const place = wrapper.get('[data-testid="editor-breadcrumb-place"]');
    expect(place.attributes('data-place')).toBe('worktree');
    expect(place.text()).toContain('fix-login');
    expect(place.text()).toContain('Worktree damocles/fix-login');
    expect(wrapper.get('nav').text().indexOf('fix-login')).toBeLessThan(wrapper.get('nav').text().indexOf('acme'));
    const project = mount(Breadcrumbs, { props: { tab: { ...projectTab, relativePath: 'src/a.ts' }, projectName: 'acme', place: { kind: 'project' } }, global: { plugins: [shellI18n] } });
    mounted.push(project);
    expect(project.get('[data-testid="editor-breadcrumb-place"]').text()).toBe('Project folder');
  });
});

describe('an editor tab\'s place chip', () => {
  it('shows its whole label', () => {
    for (const place of [{ kind: 'project' } as const, { kind: 'worktree', branch: 'damocles/fix-the-login-redirect', label: 'fix-the-login-redirect' } as const]) {
      const wrapper = mount(TabPlaceChip, { props: { place, folded: false }, global: { plugins: [shellI18n] } });
      mounted.push(wrapper);
      expect(wrapper.get('[data-testid="editor-tab-place-label"]').text()).toBe(place.kind === 'project' ? 'Project folder' : 'fix-the-login-redirect');
    }
  });

  it('folds to its icon with its full name kept for the title and assistive technology', () => {
    const project = mount(TabPlaceChip, { props: { place: { kind: 'project' }, folded: true }, global: { plugins: [shellI18n] } });
    const worktree = mount(TabPlaceChip, { props: { place: { kind: 'worktree', branch: 'damocles/fix-login', label: 'fix-login' }, folded: true }, global: { plugins: [shellI18n] } });
    mounted.push(project, worktree);
    expect(project.find('[data-testid="editor-tab-place-label"]').exists()).toBe(false);
    expect(project.find('svg').exists()).toBe(true);
    expect(project.attributes()).toMatchObject({ role: 'img', 'aria-label': 'Project folder', title: 'Project folder', 'data-folded': 'true' });
    expect(worktree.attributes()).toMatchObject({ role: 'img', 'aria-label': 'Worktree damocles/fix-login', title: 'Worktree damocles/fix-login' });
  });

  it('folds only when the title beside it would be cut below its minimum', () => {
    // the title shows whole, or cut but still at its minimum: the label stays
    expect(placeChipFolds({ clientWidth: 22, scrollWidth: 22 }, 32)).toBe(false);
    expect(placeChipFolds({ clientWidth: 40, scrollWidth: 120 }, 32)).toBe(false);
    // a fractional box that fits reads a pixel short once rounded
    expect(placeChipFolds({ clientWidth: 31, scrollWidth: 120 }, 32)).toBe(false);
    // the title is cut below its minimum, or a short title below its own width
    expect(placeChipFolds({ clientWidth: 20, scrollWidth: 120 }, 32)).toBe(true);
    expect(placeChipFolds({ clientWidth: 14, scrollWidth: 22 }, 32)).toBe(true);
  });
});

describe('the Repositories worktree row', () => {
  it('offers New Chat in This Worktree first on a live chat worktree only', () => {
    const english = (key: string): string => shellI18n.global.t(`scm.${key}`);
    const live = toOverlayMenu(worktreeRowMenu({ main: false, current: false, branch: 'wt', commit: null, newChatIn: { projectKey: 'p1', worktreeId: 'a1b2c3d4' } }), english);
    expect(live[0]).toMatchObject({ kind: 'item', id: 'newChatInWorktree', label: 'New Chat in This Worktree', icon: 'plus' });
    const plain = toOverlayMenu(worktreeRowMenu({ main: false, current: false, branch: 'wt', commit: null }), english);
    expect(plain.some((item) => item.kind === 'item' && item.id === 'newChatInWorktree')).toBe(false);
  });
});

describe('a section header chip', () => {
  it('rises over the title actions while pointed at or focused', async () => {
    const wrapper = mount(SidebarSection, {
      props: { section: 'files', collapsed: false },
      slots: { chip: '<button data-testid="chip">fix-login</button>', actions: '<button>New file</button>' },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    const holder = wrapper.get('[data-testid="sidebar-section-chip"]');
    expect(holder.attributes('data-raised')).toBeUndefined();
    await holder.trigger('pointerenter');
    expect(holder.attributes('data-raised')).toBe('true');
    await holder.trigger('pointerleave');
    expect(holder.attributes('data-raised')).toBeUndefined();
    await wrapper.get('[data-testid="chip"]').trigger('focusin');
    await flushPromises();
    expect(holder.attributes('data-raised')).toBe('true');
  });
});
