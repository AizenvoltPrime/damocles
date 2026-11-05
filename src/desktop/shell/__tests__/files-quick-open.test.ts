// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ancestorsOf, autoRevealExcluded, flattenTree, type Listing } from '../files-tree';
import { highlightSegments, quickOpenModel, quickOpenPick } from '../overlay/quick-pick';
import { dropZoneAt } from '../overlay/drop-zones';
import { markdownPreviewHtml, previewLink } from '../editor/markdown-html';
import { quickOpenRowKey, type QuickOpenFolderResult, type QuickOpenPathResult, type QuickOpenProjectResult, type QuickOpenResponse } from '../../preload/overlay-channels';

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
  const result = (projectKey: string, relativePath: string, recent = false): QuickOpenProjectResult => {
    const slash = relativePath.lastIndexOf('/');
    return {
      kind: 'project', projectKey, projectName: projectKey.toUpperCase(), relativePath,
      label: relativePath.slice(slash + 1), description: slash < 0 ? '' : relativePath.slice(0, slash),
      labelMatches: [[0, 1]], descriptionMatches: [], recent,
    };
  };
  const labels = {
    recent: 'recently opened', current: (p: string) => `${p} · current`, other: (p: string) => p, goToLine: (n: number) => `line ${n}`,
    goToLineColumn: (n: number, c: number) => `line ${n} column ${c}`, mention: 'mention',
    truncated: (count: number) => `first ${count}`, stopped: 'stopped', noEntries: (name: string) => `none start with ${name}`, folderEmpty: 'no entries', denied: 'denied',
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
    expect(quickOpenModel({ ...response, line: 12, column: 4 }, false, labels).hint).toBe('line 12 column 4');
    expect(quickOpenModel({ ...response, mention: true }, false, labels).hint).toBe('mention');
  });

  it('gives each file row its project-relative path for its file icon, and no icon of its own', () => {
    const items = quickOpenModel(response, false, labels).rows.flatMap((row) => (row.kind === 'item' ? [row.item] : []));
    expect(items.map((item) => item.file)).toEqual(['src/x.ts', 'src/y.ts', 'z.ts']);
    expect(items.every((item) => item.icon === undefined)).toBe(true);
  });

  it('ids each file by project and path, so equal paths in two projects stay apart', () => {
    expect(quickOpenRowKey(result('a', 'x'))).not.toBe(quickOpenRowKey(result('b', 'x')));
  });

  const pathResult = (authority: string, path: string, host?: string): QuickOpenPathResult => {
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const label = path.slice(slash + 1);
    const description = path.slice(0, slash);
    return {
      kind: 'path', authority, path, label, description,
      labelMatches: [[0, label.length]], descriptionMatches: [[0, description.length]], recent: false, ...(host === undefined ? {} : { host }),
    };
  };

  it('renders a typed path as one row: its file icon, name, folder, and a host chip only on a host', () => {
    const local = quickOpenModel({ generation: 1, mention: false, line: 3, results: [pathResult('local', 'C:\\notes\\todo.md')] }, false, labels);
    expect(local.rows).toHaveLength(1);
    expect(local.rows[0]).toMatchObject({
      kind: 'item',
      item: { label: 'todo.md', description: 'C:\\notes', file: 'C:\\notes\\todo.md', labelMatches: [[0, 7]], descriptionMatches: [[0, 8]] },
    });
    const item = local.rows[0]!.kind === 'item' ? local.rows[0]!.item : undefined;
    expect(item?.badge).toBeUndefined();
    expect(item?.project).toBeUndefined();
    expect(item?.icon).toBeUndefined();
    expect(local.hint).toBe('line 3');

    const remote = quickOpenModel({ generation: 1, mention: false, results: [pathResult('ssh-remote+box', '/home/u/a.txt', 'box')] }, false, labels);
    expect(remote.rows[0]).toMatchObject({ kind: 'item', item: { label: 'a.txt', description: '/home/u', file: '/home/u/a.txt', badge: 'box' } });
  });

  it('puts no group label over a typed path, even for an empty query', () => {
    const model = quickOpenModel({ generation: 1, currentProjectKey: 'a', mention: false, results: [pathResult('local', '/tmp/a.txt')] }, true, labels);
    expect(model.rows.map((row) => row.kind)).toEqual(['item']);
  });

  it('ids a typed path apart from every project file, and by its authority', () => {
    const path = pathResult('local', '/x');
    expect(quickOpenRowKey(path)).not.toBe(quickOpenRowKey(result('local', '/x')));
    expect(quickOpenRowKey(path)).not.toBe(quickOpenRowKey(result('path', 'local')));
    expect(quickOpenRowKey(path)).not.toBe(quickOpenRowKey(pathResult('ssh-remote+box', '/x')));
  });

  it('picks a typed path with its authority, path, line and column, never as a mention', () => {
    const path = pathResult('ssh-remote+box', '/home/u/a.txt', 'box');
    const answer: QuickOpenResponse = { generation: 1, mention: true, line: 3, column: 5, results: [path] };
    expect(quickOpenPick(answer, quickOpenRowKey(path))).toEqual({ kind: 'path', authority: 'ssh-remote+box', path: '/home/u/a.txt', line: 3, column: 5, mention: false });
    expect(quickOpenPick({ generation: 1, mention: false, results: [path] }, quickOpenRowKey(path))).toEqual({ kind: 'path', authority: 'ssh-remote+box', path: '/home/u/a.txt', mention: false });
  });

  it('picks a project file with the line and column of the query, and nothing for an id the answer does not hold', () => {
    const answer: QuickOpenResponse = { ...response, line: 12, column: 4 };
    expect(quickOpenPick(answer, quickOpenRowKey(result('b', 'z.ts')))).toEqual({ kind: 'project', projectKey: 'b', relativePath: 'z.ts', line: 12, column: 4, mention: false });
    expect(quickOpenPick({ ...response, mention: true }, quickOpenRowKey(result('b', 'z.ts')))).toEqual({ kind: 'project', projectKey: 'b', relativePath: 'z.ts', mention: true });
    expect(quickOpenPick(answer, quickOpenRowKey(pathResult('local', 'z.ts')))).toBeUndefined();
  });

  const folderResult = (input: string, label: string, caret?: number, host?: string): QuickOpenFolderResult => ({
    kind: 'folder', authority: host === undefined ? 'local' : `ssh+${host}`, label, labelMatches: [[0, label.length]], input,
    ...(caret === undefined ? {} : { caret }), ...(host === undefined ? {} : { host }),
  });
  const listing = (extra: Partial<QuickOpenResponse> = {}): QuickOpenResponse => ({
    generation: 1, mention: false, ...extra,
    results: [
      folderResult('C:\\tmp\\', '..'),
      folderResult('C:\\tmp\\work\\src\\', 'src'),
      folderResult('"C:\\tmp\\work\\ space\\"', ' space', 22),
      { ...pathResult('local', 'C:\\tmp\\work\\a.txt'), complete: { input: 'C:\\tmp\\work\\a.txt' } },
      { ...pathResult('local', 'C:\\tmp\\work\\b (2).txt'), complete: { input: '"C:\\tmp\\work\\b (2).txt"', caret: 22 } },
    ],
  });
  const items = (response: QuickOpenResponse) => quickOpenModel(response, false, labels).rows.flatMap((row) => (row.kind === 'item' ? [row.item] : []));

  it('maps a folder row to the query it goes to and a file row to the query Tab completes, in main\'s order with no groups', () => {
    const model = quickOpenModel(listing(), true, labels);
    expect(model.rows.map((row) => row.kind)).toEqual(['item', 'item', 'item', 'item', 'item']);
    const [up, src, spaced, a, b] = items(listing());
    expect(up).toMatchObject({ label: '..', folder: true, file: '..', descend: 'C:\\tmp\\' });
    expect(src).toMatchObject({ label: 'src', folder: true, file: 'src', descend: 'C:\\tmp\\work\\src\\', labelMatches: [[0, 3]], descriptionMatches: [] });
    expect(src!.caret).toBeUndefined();
    expect(src!.complete).toBeUndefined();
    expect(spaced).toMatchObject({ descend: '"C:\\tmp\\work\\ space\\"', caret: 22 });
    expect(a).toMatchObject({ label: 'a.txt', complete: 'C:\\tmp\\work\\a.txt', file: 'C:\\tmp\\work\\a.txt' });
    expect(a!.folder).toBeUndefined();
    expect(a!.descend).toBeUndefined();
    expect(b).toMatchObject({ complete: '"C:\\tmp\\work\\b (2).txt"', caret: 22 });
  });

  it('gives a host\'s folder row the host chip, and a project file of a listing its completion', () => {
    const response: QuickOpenResponse = {
      generation: 1, mention: false,
      results: [folderResult('~/projects/', 'projects', undefined, 'box'), { ...result('a', 'src/x.ts'), complete: { input: '~/a/src/x.ts' } }],
    };
    const [folder, file] = items(response);
    expect(folder).toMatchObject({ badge: 'box', folder: true });
    expect(file).toMatchObject({ project: 'A', complete: '~/a/src/x.ts' });
  });

  it('ids every row by main\'s row key, a folder by its authority and input, and never picks a folder', () => {
    const response = listing();
    expect(items(response).map((item) => item.id)).toEqual(response.results.map(quickOpenRowKey));
    expect(new Set(items(response).map((item) => item.id)).size).toBe(response.results.length);
    expect(quickOpenRowKey(folderResult('/x/', 'x'))).not.toBe(quickOpenRowKey(folderResult('/x/', 'x', undefined, 'box')));
    expect(quickOpenPick({ ...response, line: 2 }, quickOpenRowKey(response.results[1]!))).toBeUndefined();
    expect(quickOpenPick({ ...response, line: 2, column: 4 }, quickOpenRowKey(response.results[3]!))).toEqual({ kind: 'path', authority: 'local', path: 'C:\\tmp\\work\\a.txt', line: 2, column: 4, mention: false });
  });

  it('gives the typed :line[:column] to the exact row alone when the answer has one', () => {
    const exact = { ...pathResult('local', 'C:\\tmp\\work\\ab.txt'), complete: { input: 'C:\\tmp\\work\\ab.txt' }, exact: true as const };
    const sibling = { ...pathResult('local', 'C:\\tmp\\work\\ab.txt.bak'), complete: { input: 'C:\\tmp\\work\\ab.txt.bak' } };
    const response: QuickOpenResponse = { generation: 1, mention: false, line: 2, column: 4, results: [exact, folderResult('C:\\tmp\\work\\ab\\', 'ab'), sibling] };
    expect(quickOpenPick(response, quickOpenRowKey(exact))).toEqual({ kind: 'path', authority: 'local', path: 'C:\\tmp\\work\\ab.txt', line: 2, column: 4, mention: false });
    expect(quickOpenPick(response, quickOpenRowKey(sibling))).toEqual({ kind: 'path', authority: 'local', path: 'C:\\tmp\\work\\ab.txt.bak', mention: false });
  });

  it('notes a listing cut at its bounds beside the line hint, counting the entries main says it listed', () => {
    expect(quickOpenModel(listing({ truncated: { listed: 4 } }), false, labels)).toMatchObject({ notice: 'first 4' });
    expect(quickOpenModel(listing({ truncated: { listed: 3 }, line: 2 }), false, labels)).toMatchObject({ hint: 'line 2', notice: 'first 3' });
    expect(quickOpenModel(listing(), false, labels).notice).toBeUndefined();
    // a listing the bounds cut before it kept an entry says so, beside .. or in place of rows
    const up = listing().results[0]!;
    expect(quickOpenModel({ generation: 1, mention: false, results: [up], truncated: { listed: 0 } }, false, labels)).toMatchObject({ notice: 'stopped' });
    expect(quickOpenModel({ generation: 1, mention: false, results: [], truncated: { listed: 0 } }, false, labels)).toEqual({ rows: [], empty: 'stopped' });
  });

  it('starts on the first entry after .., and on .. only when it is the folder\'s one row', () => {
    const response = listing();
    expect(quickOpenModel(response, false, labels).activeId).toBe(quickOpenRowKey(response.results[1]!));
    expect(quickOpenModel({ ...response, results: response.results.slice(0, 1) }, false, labels).activeId).toBeUndefined();
    expect(quickOpenModel({ ...response, results: response.results.slice(1) }, false, labels).activeId).toBeUndefined();
  });

  it('says why a typed folder has no rows: no entry starts with the typed name, it has none, or it cannot be read', () => {
    expect(quickOpenModel({ generation: 1, mention: false, results: [], emptyText: 'folderNoMatch', emptyName: 'zzz' }, false, labels)).toEqual({ rows: [], empty: 'none start with zzz' });
    expect(quickOpenModel({ generation: 1, mention: false, results: [], emptyText: 'folderEmpty' }, false, labels)).toEqual({ rows: [], empty: 'no entries' });
    expect(quickOpenModel({ generation: 1, mention: false, results: [], emptyText: 'folderDenied' }, false, labels)).toEqual({ rows: [], empty: 'denied' });
    expect(quickOpenModel({ generation: 1, mention: false, results: [] }, false, labels).empty).toBeUndefined();
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
