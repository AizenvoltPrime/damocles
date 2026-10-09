// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ancestorsOf, autoRevealExcluded, flattenTree, type Listing } from '../files-tree';
import { highlightSegments, quickOpenItemId, quickOpenModel } from '../overlay/quick-pick';
import { dropZoneAt } from '../overlay/drop-zones';
import { markdownPreviewHtml, previewLink } from '../editor/markdown-html';
import type { QuickOpenResponse, QuickOpenResult } from '../../preload/overlay-channels';

const loaded = (...entries: Array<[string, 'file' | 'dir']>): Listing => ({ state: 'loaded', entries: entries.map(([name, kind]) => ({ name, kind })) });

describe('Files tree rows', () => {
  const listings = new Map<string, Listing>([
    ['', loaded(['src', 'dir'], ['test', 'dir'], ['README.md', 'file'])],
    ['src', loaded(['lib', 'dir'], ['a.ts', 'file'])],
    ['src/lib', { state: 'loading' }],
  ]);

  it('flattens only expanded folders, children after their folder, one level deeper', () => {
    const rows = flattenTree(listings, new Set(['src']), null);
    expect(rows.map((row) => (row.kind === 'entry' ? `${row.depth}:${row.path}` : 'input'))).toEqual(['0:src', '1:src/lib', '1:src/a.ts', '0:test', '0:README.md']);
    expect(rows[0]).toMatchObject({ directory: true, expanded: true });
    expect(rows[3]).toMatchObject({ directory: true, expanded: false, position: 2, setSize: 3 });
    expect(rows[2]).toMatchObject({ position: 2, setSize: 2 });
  });

  it('marks an expanded folder whose listing is on its way as loading', () => {
    const rows = flattenTree(listings, new Set(['src', 'src/lib']), null);
    expect(rows.find((row) => row.kind === 'entry' && row.path === 'src/lib')).toMatchObject({ loading: true, expanded: true });
  });

  it('opens a new entry input at the top of its folder and a rename input in place of its row', () => {
    const create = flattenTree(listings, new Set(['src']), { mode: 'newFile', parentDir: 'src' });
    expect(create[1]).toMatchObject({ kind: 'input', depth: 1, directory: false });
    const rename = flattenTree(listings, new Set(['src']), { mode: 'rename', path: 'src/a.ts' });
    expect(rename[2]).toMatchObject({ kind: 'input', name: 'a.ts', depth: 1 });
    expect(rename.some((row) => row.kind === 'entry' && row.path === 'src/a.ts')).toBe(false);
  });

  it('lists the folders above a file outermost first, for Reveal in Files', () => {
    expect(ancestorsOf('src/lib/deep/x.ts')).toEqual(['src', 'src/lib', 'src/lib/deep']);
    expect(ancestorsOf('x.ts')).toEqual([]);
  });

  it('leaves the tree alone for a file under node_modules or bower_components, at any depth', () => {
    expect(autoRevealExcluded('node_modules/vue/index.js')).toBe(true);
    expect(autoRevealExcluded('packages/app/node_modules/vue/index.js')).toBe(true);
    expect(autoRevealExcluded('web/bower_components/x.js')).toBe(true);
    expect(autoRevealExcluded('src/node_modules.ts')).toBe(false);
    expect(autoRevealExcluded('src/a.ts')).toBe(false);
  });
});

describe('Quick Open rows', () => {
  const result = (projectKey: string, relativePath: string, recent = false): QuickOpenResult => {
    const slash = relativePath.lastIndexOf('/');
    return {
      projectKey, projectName: projectKey.toUpperCase(), relativePath,
      label: relativePath.slice(slash + 1), description: slash < 0 ? '' : relativePath.slice(0, slash),
      labelMatches: [[0, 1]], descriptionMatches: [], recent,
    };
  };
  const labels = {
    recent: 'recently opened', current: (p: string) => `${p} · current`, other: (p: string) => p, goToLine: (n: number) => `line ${n}`, mention: 'mention',
  };
  const response: QuickOpenResponse = {
    generation: 1, currentProjectKey: 'a', mention: false,
    results: [result('a', 'src/x.ts', true), result('a', 'src/y.ts'), result('b', 'z.ts')],
  };

  it('groups an empty query: recent files, then the current project, then each other project', () => {
    const model = quickOpenModel(response, true, labels);
    expect(model.rows.map((row) => (row.kind === 'separator' ? `# ${row.label}` : row.item.label))).toEqual(['# recently opened', 'x.ts', '# A · current', 'y.ts', '# B', 'z.ts']);
  });

  it('lists a typed query by score with no groups, and says what Enter does with :line or @', () => {
    const model = quickOpenModel({ ...response, line: 12 }, false, labels);
    expect(model.rows.every((row) => row.kind === 'item')).toBe(true);
    expect(model.hint).toBe('line 12');
    expect(quickOpenModel({ ...response, mention: true }, false, labels).hint).toBe('mention');
  });

  it('ids each file by project and path, so equal paths in two projects stay apart', () => {
    expect(quickOpenItemId({ projectKey: 'a', relativePath: 'x' })).not.toBe(quickOpenItemId({ projectKey: 'b', relativePath: 'x' }));
  });

  it('cuts text at its match ranges, clamping ranges outside the text', () => {
    expect(highlightSegments('editor.ts', [[0, 2], [7, 9]])).toEqual([
      { text: 'ed', match: true }, { text: 'itor.', match: false }, { text: 'ts', match: true },
    ]);
    expect(highlightSegments('ab', [[1, 40]])).toEqual([{ text: 'a', match: false }, { text: 'b', match: true }]);
  });
});

describe('pane drop zones', () => {
  const grid = { x: 100, y: 50, width: 1000, height: 500 };
  it('hit-tests the reference zones: main 62%x64%, side 38%x64%, bottom 100%x36%', () => {
    expect(dropZoneAt(grid, { x: 100, y: 50 })).toBe('main');
    expect(dropZoneAt(grid, { x: 719, y: 369 })).toBe('main');
    expect(dropZoneAt(grid, { x: 720, y: 60 })).toBe('side');
    expect(dropZoneAt(grid, { x: 300, y: 370 })).toBe('bottom');
    expect(dropZoneAt(grid, { x: 1099, y: 549 })).toBe('bottom');
    expect(dropZoneAt(grid, { x: 50, y: 60 })).toBeNull();
    expect(dropZoneAt(grid, { x: 300, y: 560 })).toBeNull();
  });
});

describe('markdown preview', () => {
  const render = (source: string): HTMLElement => {
    const holder = document.createElement('div');
    holder.innerHTML = markdownPreviewHtml(source);
    return holder;
  };

  // One vector per case: happy-dom's NodeIterator stops after DOMPurify removes a node (see release-notes.test.ts).
  it.each([
    ['a script', '<p>text</p><script>alert(1)</script>'],
    ['an image with onerror', 'text\n\n<img src="x" onerror="alert(1)">'],
    ['an iframe', '<iframe src="https://evil.example"></iframe>'],
    ['an svg', '<svg><script>alert(1)</script></svg>'],
  ])('drops %s written as raw HTML', (_name, source) => {
    expect(render(source).querySelector('script, img, iframe, svg, [onerror]')).toBeNull();
  });

  it('keeps no class but its own and turns any input into a disabled checkbox', () => {
    const notes = render('<p class="fixed inset-0 z-50">x</p>');
    expect(notes.querySelector('[class]')).toBeNull();
    const input = render('<input type="text" value="x">').querySelector('input');
    expect(input?.getAttribute('type')).toBe('checkbox');
    expect(input?.hasAttribute('disabled')).toBe(true);
    const task = render('- [x] done').querySelector('input');
    expect(task?.getAttribute('type')).toBe('checkbox');
    expect(render(['```ts', 'x', '```'].join(String.fromCharCode(10))).querySelector('code')?.className).toBe('language-ts');
  });

  it('shows a markdown image as its alt text, loading nothing', () => {
    const notes = render('![logo](https://e.example/a.png)');
    expect(notes.querySelector('img')).toBeNull();
    expect(notes.querySelector('.md-preview-image')?.textContent).toBe('logo');
  });

  it('keeps only http(s), anchor and relative links', () => {
    const notes = render('[a](javascript:alert(1)) [b](https://x.example) [c](./other.md) [d](#t)');
    expect([...notes.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).toEqual([null, 'https://x.example', './other.md', '#t']);
  });

  it('resolves a relative link against the previewed file, never outside the project', () => {
    expect(previewLink('./b.md', 'docs/a.md')).toEqual({ kind: 'file', relativePath: 'docs/b.md' });
    expect(previewLink('../README.md#x', 'docs/a.md')).toEqual({ kind: 'file', relativePath: 'README.md' });
    expect(previewLink('../../etc/passwd', 'docs/a.md')).toBeUndefined();
    expect(previewLink('/abs', 'docs/a.md')).toBeUndefined();
    expect(previewLink('https://x.example', 'docs/a.md')).toEqual({ kind: 'external' });
    expect(previewLink('#Title', 'a.md')).toEqual({ kind: 'anchor', id: 'Title' });
    expect(previewLink('./%E0%A4%A.md', 'a.md')).toBeUndefined();
    expect(previewLink('#%', 'a.md')).toBeUndefined();
  });
});
