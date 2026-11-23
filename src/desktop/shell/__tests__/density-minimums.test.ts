// @vitest-environment happy-dom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { remPx, spacedRemPx } from '@/composables/useRemPx';
import { COLUMN_MIN_PX, ROW_MIN_PX } from '../layout/layout-model';
import { minimumScale } from '../../main/themes/arrangement';
import { DEFAULT_GRID_LAYOUT, MIN_SECTION_SIZE, MIN_SIDEBAR_WIDTH, type DamoclesShellApi, type ShellState } from '../../preload/shell-channels';
import { atRootScale, SECTION_HEADER_REM, storedMinimum } from '../layout';
import SidebarSection from '../components/SidebarSection.vue';
import LayoutGrid from '../layout/LayoutGrid.vue';
import Sash from '../layout/Sash.vue';
import Sidebar from '../components/Sidebar.vue';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, STATE, fakeShellApi } from './fakes';

// The layout minimums are px at the default font and density: the shell scales them by its root font and the theme's density
// (the spacing probe), main by minimumScale, and neither goes below the sidebar and section minimums main's layout file keeps.

const WITH_TERMINAL: ShellState = { ...STATE, layout: { ...STATE.layout, grid: { ...DEFAULT_GRID_LAYOUT, visible: { editor: true, terminal: true } } } };

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

// The probes useRemPx measures, each a hidden element of its own the observer reports; happy-dom keeps the root font probe's
// 1rem width but drops the spacing probe's calc(var()) one.
function probe(kind: 'root' | 'spacing'): FakeResizeObserver {
  const found = FakeResizeObserver.instances.find((observer) => {
    const element = observer.observed[0] as HTMLElement | undefined;
    return element?.style.visibility === 'hidden' && (element.style.width === '1rem') === (kind === 'root');
  });
  if (!found) throw new Error(`no ${kind} probe`);
  return found;
}

/** The window at a text size (px) and a theme density, as the root font and Tailwind's --spacing probes report them. */
async function scale(textSize: number, density: number): Promise<void> {
  spacedRemPx(1);
  remPx(1);
  const root = (textSize * 16) / 13;
  (probe('root').callback as (entries: unknown[]) => void)([{ contentRect: { width: root } }]);
  (probe('spacing').callback as (entries: unknown[]) => void)([{ contentRect: { width: root * density } }]);
  await flushPromises();
}

describe('the shell\'s layout minimums', () => {
  it.each([
    { density: 0.85, column: 255, row: 102, sidebar: MIN_SIDEBAR_WIDTH, section: MIN_SECTION_SIZE },
    { density: 1, column: 300, row: 120, sidebar: 220, section: 60 },
    { density: 1.15, column: 345, row: 138, sidebar: 253, section: 69 },
  ])('scale with density $density, the stored minimums never going below main\'s', async ({ density, column, row, sidebar, section }) => {
    await scale(13, density);
    expect(atRootScale(COLUMN_MIN_PX)).toBeCloseTo(column, 6);
    expect(atRootScale(ROW_MIN_PX)).toBeCloseTo(row, 6);
    expect(storedMinimum(MIN_SIDEBAR_WIDTH)).toBeCloseTo(sidebar, 6);
    expect(storedMinimum(MIN_SECTION_SIZE)).toBeCloseTo(section, 6);
  });

  it('follow the text size and density together, as main\'s minimumScale does', async () => {
    for (const [textSize, density] of [[11, 0.85], [20, 1.15], [16, 0.9]] as const) {
      await scale(textSize, density);
      expect(atRootScale(COLUMN_MIN_PX), `${textSize}px at ${density}`).toBeCloseTo(COLUMN_MIN_PX * minimumScale(textSize, density), 6);
      expect(atRootScale(ROW_MIN_PX), `${textSize}px at ${density}`).toBeCloseTo(ROW_MIN_PX * minimumScale(textSize, density), 6);
    }
  });

  it.each([
    { density: 0.85, column: 255, row: 102 },
    { density: 1.15, column: 345, row: 138 },
  ])('hold the grid\'s sashes at the column and row minimums at density $density', async ({ density, column, row }) => {
    await scale(13, density);
    const wrapper = mount(LayoutGrid, {
      props: { api: fakeShellApi(), state: WITH_TERMINAL, focusOverlay: false, sidebarSliding: false },
      global: { plugins: [shellI18n], stubs: { transition: true, TerminalPane: true, PaneGrip: true } },
    });
    mounted.push(wrapper);
    await flushPromises();
    const sash = (orientation: string) => wrapper.findAllComponents(Sash).find((candidate) => candidate.props('orientation') === orientation)!;
    expect(sash('vertical').props('min')).toBeCloseTo(column, 6);
    expect(sash('horizontal').props('min')).toBeCloseTo(row, 6);
  });

  it.each([
    { density: 0.85, sidebar: MIN_SIDEBAR_WIDTH, section: MIN_SECTION_SIZE },
    { density: 1.15, sidebar: 253, section: 69 },
  ])('report a sidebar and sections at their minimums that main\'s layout file keeps, at density $density', async ({ density, sidebar, section }) => {
    await scale(13, density);
    const api: DamoclesShellApi = fakeShellApi();
    const wrapper = mount(Sidebar, {
      props: { api, state: STATE },
      global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api), [SCM_STORE]: createScmStore(api.scm) } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    const sidebarSize = FakeResizeObserver.instances.filter((observer) => observer.observed[0]?.getAttribute('data-testid') === 'sidebar').at(-1)!;
    (sidebarSize.callback as (entries: unknown[]) => void)([{ contentBoxSize: [{ inlineSize: 300, blockSize: 800 }] }]);
    await flushPromises();

    await wrapper.get('[data-testid="sidebar-sash"]').trigger('keydown', { key: 'Home' });
    expect(vi.mocked(api.reportSidebarLayout).mock.lastCall![0].sidebarWidth).toBeCloseTo(sidebar, 6);
    await wrapper.get('[data-testid="section-sash"][data-between="projects chats"]').trigger('keydown', { key: 'Home' });
    expect(vi.mocked(api.reportSidebarLayout).mock.lastCall![0].sections.projects.size).toBeCloseTo(section, 6);
  });

  it.each([
    { density: 0.85, section: MIN_SECTION_SIZE },
    { density: 1.15, section: 69 },
  ])('give a section that fills the rest the same body minimum at density $density', async ({ density, section }) => {
    await scale(13, density);
    const wrapper = mount(SidebarSection, { props: { section: 'chats', collapsed: false }, global: { plugins: [shellI18n] } });
    mounted.push(wrapper);
    await flushPromises();
    const minHeight = (wrapper.get('.sidebar-section').element as HTMLElement).style.minHeight;
    expect(minHeight).toBe(`calc(${storedMinimum(MIN_SECTION_SIZE)}px + ${SECTION_HEADER_REM}rem)`);
    expect(storedMinimum(MIN_SECTION_SIZE)).toBeCloseTo(section, 6);
  });
});

// A compact theme gives every button a 1.5rem floor (--d-hit-min). A glyph button in a row whose height script fixes cannot
// take it, so it opts out by name, keeps its default size, and its row's menu offers the same command at full size.
describe('the hit-size floor\'s opt-out', () => {
  const SRC = path.resolve(__dirname, '..', '..', '..');
  const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return /\.(vue|ts)$/.test(entry.name) ? [full] : [];
  });

  it('is one class that lifts the floor, declared in the floor\'s own layer', () => {
    const base = /@layer base \{\s*:where\(button,[^}]*min-height: var\(--d-hit-min, auto\);[^}]*\}[^}]*\.d-hit-free \{\s*min-height: 0;\s*min-width: 0;\s*\}\s*\}/;
    expect(read('webview/style.css')).toMatch(base);
  });

  it('is used only by the fixed-row glyph buttons, each at its default size and with a menu item for the same command', () => {
    const users = [path.join(SRC, 'webview'), path.join(SRC, 'desktop', 'shell')].flatMap(sources)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('d-hit-free'))
      .map((file) => path.relative(SRC, file).replaceAll('\\', '/'));
    expect(users.sort()).toEqual(['desktop/shell/forge/JobLogView.vue', 'desktop/shell/search/SearchResultRow.vue']);
    for (const user of users) {
      const uses = read(user).split('\n').filter((line) => line.includes('d-hit-free') && line.includes('class='));
      expect(uses.length, user).toBeGreaterThan(0);
      for (const line of uses) expect(line, user).toContain('size-[1.25rem]');
    }
    const log = read('desktop/shell/forge/JobLogView.vue');
    expect(log).toMatch(/@contextmenu="item\.section && openSectionMenu\(/);
    expect(log).toContain('forge.log.foldSection');
    const search = read('desktop/shell/search/SearchSection.vue');
    expect(search).toMatch(/item\('replace', t\('search\.replaceOne'\)/);
    expect(search).toMatch(/item\('dismiss', t\('search\.dismiss'\)/);
  });
});
