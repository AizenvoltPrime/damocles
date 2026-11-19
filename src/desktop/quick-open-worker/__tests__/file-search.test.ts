import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fuzzy from '../../../core/quick-open/fuzzy-match';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { ALL_IGNORE_FILES, type WalkIgnore } from '../../../core/search-walk';
import { createWalkHost } from '../../../core/search-walk';
import { InThreadWalkChild } from '../../../__mocks__/in-thread-walk-child';
import { createQuickOpenListing } from '../../workspace/quick-open-listing';
import { createQuickOpenFileSearch, fileListBuilder, SCORE_BATCH } from '../file-search';
import { WORKER_PROGRESS_INTERVAL_MS, type WorkerProject, type WorkerQueryContext, type WorkerReply, type WorkerRequest, type WorkerResult } from '../protocol';

vi.mock('../../../core/quick-open/fuzzy-match', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../core/quick-open/fuzzy-match')>();
  return { ...original, scoreItem: vi.fn(original.scoreItem) };
});

let root: string;
let alpha: WorkerProject;
let beta: WorkerProject;

function project(name: string): WorkerProject {
  const fsPath = path.join(root, name);
  fs.mkdirSync(fsPath, { recursive: true });
  return { key: folderKey(fsPath), fsPath };
}

function touch(owner: WorkerProject, relativePath: string): void {
  const file = path.join(owner.fsPath, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

// Quick Open's listing as a workspace runs it, its walks on this thread.
const listing = createQuickOpenListing({ walks: createWalkHost(() => new InThreadWalkChild(), () => undefined), log: () => undefined });

/** Main's side of a listing, as QuickOpenIndex runs it: the walk's batches relayed to the worker, then the listing's end. */
function serveListing(receive: (request: WorkerRequest) => void, listingId: number, projectKey: string): void {
  const project = [alpha, beta].find((candidate) => candidate.key === projectKey)!;
  listing.list(project.fsPath, ALL_IGNORE_FILES, ['**/.git'], {
    files: (files) => receive({ kind: 'listFiles', listing: listingId, files }),
    end: (error) => receive(error === undefined ? { kind: 'listEnd', listing: listingId } : { kind: 'listEnd', listing: listingId, error }),
  });
}

/** The listing of root, read as the worker reads what main relays. */
function listed(root: string, excludes: readonly string[], progress: () => void = () => undefined, ignore: WalkIgnore = ALL_IGNORE_FILES): Promise<string[]> {
  const builder = fileListBuilder(progress);
  return new Promise((resolve, reject) => {
    listing.list(root, ignore, excludes, { files: (files) => builder.add(files), end: (error) => (error === undefined ? resolve(builder.end()) : reject(new Error(error))) });
  });
}

/** The worker's side driven in process: each query resolves with its reply, and main's listings run the real walk. */
function fileSearch(list?: (root: string) => string[]): {
  query: (raw: string, context: WorkerQueryContext, search?: { id: number; generation: number }) => Promise<WorkerReply>;
  receive: ReturnType<typeof createQuickOpenFileSearch>;
  logs: string[];
} {
  const waiting = new Map<number, (reply: WorkerReply) => void>();
  const logs: string[] = [];
  const receive = createQuickOpenFileSearch((reply) => {
    if (reply.kind === 'log') logs.push(reply.line);
    else if (reply.kind === 'list') serveListing(receive, reply.listing, reply.projectKey);
    else if (reply.kind !== 'progress') waiting.get(reply.id)?.(reply);
  }, list ? async (project) => list(project.fsPath) : undefined);
  let nextId = 0;
  const query = (raw: string, context: WorkerQueryContext, search = { id: 0, generation: nextId }): Promise<WorkerReply> => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    receive({ kind: 'query', id, search: search.id, generation: search.generation, raw, context, projects: [alpha, beta] });
  });
  return { query, receive, logs };
}

function results(reply: WorkerReply): WorkerResult[] {
  if (reply.kind !== 'answer') throw new Error(`expected an answer, got ${reply.kind}`);
  return [...reply.results];
}

const named = (reply: WorkerReply): string[] => results(reply).map((result) => `${result.projectKey === alpha.key ? 'alpha' : 'beta'}/${result.relativePath}${result.recent ? '*' : ''}`);

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-quick-')));
  alpha = project('alpha');
  beta = project('beta');
  vi.mocked(fuzzy.scoreItem).mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the walked file list', () => {
  it('lists every file as a relative path in path order, honouring .gitignore and the excludes', async () => {
    touch(alpha, 'src/a.ts');
    touch(alpha, 'src/b.ts');
    touch(alpha, '.git/HEAD');
    touch(alpha, 'ignored.log');
    fs.writeFileSync(path.join(alpha.fsPath, '.gitignore'), '*.log\n');
    expect(await listed(alpha.fsPath, ['**/.git'])).toEqual(['.gitignore', 'src/a.ts', 'src/b.ts']);
    const names = Array.from({ length: 40 }, (_, index) => `d${index % 7}/f${index}.ts`);
    for (const name of names) touch(alpha, name);
    const all = [...names, '.gitignore', 'src/a.ts', 'src/b.ts'].sort();
    for (let run = 0; run < 3; run++) {
      expect(await listed(alpha.fsPath, ['**/.git'])).toEqual(all);
    }
  });

  it('lists .git and ignored files only when the excludes and the ignore switches let them through', async () => {
    touch(alpha, 'a.ts');
    touch(alpha, '.git/HEAD');
    touch(alpha, 'ignored.log');
    fs.writeFileSync(path.join(alpha.fsPath, '.gitignore'), '*.log\n');
    expect(await listed(alpha.fsPath, [])).toEqual(['.git/HEAD', '.gitignore', 'a.ts']);
    expect(await listed(alpha.fsPath, ['**/.git'], undefined, { files: false, global: true, parents: true })).toEqual(['.gitignore', 'a.ts', 'ignored.log']);
  });

  it('reports progress for every batch, so main sees a slow listing still moving', async () => {
    for (const name of ['a.ts', 'b.ts', 'c/d.ts']) touch(alpha, name);
    const progress = vi.fn();
    await listed(alpha.fsPath, [], progress);
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('never follows a junction out of the project, nor lists the junction', async () => {
    touch(beta, 'secret.ts');
    fs.symlinkSync(beta.fsPath, path.join(alpha.fsPath, 'link'), 'junction');
    touch(alpha, 'mine.ts');
    expect(await listed(alpha.fsPath, [])).toEqual(['mine.ts']);
  });

  it('never reads a .gitignore that is a link, which ripgrep follows', async (context) => {
    fs.writeFileSync(path.join(beta.fsPath, 'rules'), 'hidden.ts\n');
    touch(alpha, 'hidden.ts');
    touch(alpha, 'shown.ts');
    fs.mkdirSync(path.join(alpha.fsPath, '.git'));
    try {
      fs.symlinkSync(path.join(beta.fsPath, 'rules'), path.join(alpha.fsPath, '.gitignore'), 'file');
    } catch (err) {
      // creating a file symlink on Windows needs Developer Mode or an elevated process
      if ((err as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw err;
    }
    expect(await listed(alpha.fsPath, ['**/.git'])).toEqual(['hidden.ts', 'shown.ts']);
  });

  it.runIf(process.platform !== 'win32')('lists a name holding a newline as one file, which a line of ripgrep output split', async () => {
    touch(alpha, 'two\nlines.ts');
    expect(await listed(alpha.fsPath, [])).toEqual(['two\nlines.ts']);
  });

  it('drops a path outside the root from a batch and sorts the list at its end', () => {
    const progress = vi.fn();
    const builder = fileListBuilder(progress);
    builder.add(['z/é.ts', '../x.ts', path.join(beta.fsPath, 'x.ts')]);
    builder.add(['a.ts', 'b/./c.ts', 'C:/x.ts']);
    expect(builder.end()).toEqual(['a.ts', 'z/é.ts']);
    expect(progress).toHaveBeenCalledTimes(2);
  });
});

describe('Quick Open queries in the worker', () => {
  it('shows recent files first, then files of the current project and of each other one', async () => {
    for (let i = 0; i < 10; i++) touch(alpha, `a${i}.ts`);
    for (let i = 0; i < 6; i++) touch(beta, `b${i}.ts`);
    const reply = await fileSearch().query('', { currentProjectKey: alpha.key, recent: [{ projectKey: beta.key, relativePath: 'b5.ts' }, { projectKey: 'gone', relativePath: 'x.ts' }] });
    expect(named(reply)).toEqual([
      'beta/b5.ts*',
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `alpha/a${i}.ts`),
      ...[0, 1, 2, 3].map((i) => `beta/b${i}.ts`),
    ]);
  });

  it('scores every project with highlights and caches each list until invalidated', async () => {
    touch(alpha, 'src/editor-pane.ts');
    touch(beta, 'docs/editor.md');
    touch(beta, 'other.ts');
    const worker = fileSearch();
    const context = { currentProjectKey: alpha.key, recent: [] };
    const first = results(await worker.query('@edpane:42', context));
    expect(first[0]).toEqual({ projectKey: alpha.key, relativePath: 'src/editor-pane.ts', labelMatches: [[0, 2], [7, 11]], descriptionMatches: [], recent: false });
    expect(first.map((result) => result.relativePath)).not.toContain('other.ts');
    touch(alpha, 'src/editor-new.ts');
    expect(named(await worker.query('editor', context))).not.toContain('alpha/src/editor-new.ts');
    worker.receive({ kind: 'invalidate', projectKey: alpha.key });
    expect(named(await worker.query('editor', context))).toContain('alpha/src/editor-new.ts');
  });

  it('scores every file of a large project, with no cap', async () => {
    const count = 3 * SCORE_BATCH + 5;
    const names = Array.from({ length: count }, (_, index) => `f${String(index).padStart(6, '0')}.txt`);
    const reply = await fileSearch((fsPath) => (fsPath === alpha.fsPath ? names : [])).query(names.at(-1)!, { currentProjectKey: alpha.key, recent: [] });
    expect(results(reply)[0]?.relativePath).toBe(names.at(-1));
    expect(vi.mocked(fuzzy.scoreItem)).toHaveBeenCalledTimes(count);
  });

  it('scores only the files that matched a query the new one extends, as VS Code\'s file search cache does', async () => {
    for (const file of ['src/editor-pane.ts', 'docs/editor.md', 'other.ts', 'zzz.ts', 'abc.ts']) touch(alpha, file);
    touch(beta, 'docs/editor.md');
    touch(beta, 'lib/pane.ts');
    const worker = fileSearch();
    const context = { currentProjectKey: alpha.key, recent: [] };
    const first = results(await worker.query('ed', context));
    expect(vi.mocked(fuzzy.scoreItem)).toHaveBeenCalledTimes(7);
    vi.mocked(fuzzy.scoreItem).mockClear();
    const narrowed = await worker.query('edi', context);
    expect(vi.mocked(fuzzy.scoreItem)).toHaveBeenCalledTimes(first.length);
    // A new search has no cache: the same answer from every file.
    expect(results(narrowed)).toEqual(results(await worker.query('edi', context, { id: 1, generation: 0 })));
    vi.mocked(fuzzy.scoreItem).mockClear();
    await worker.query('ed/', context);
    expect(vi.mocked(fuzzy.scoreItem)).toHaveBeenCalledTimes(7);
    vi.mocked(fuzzy.scoreItem).mockClear();
    await worker.query('"ed"', context);
    await worker.query('"ed"i', context);
    expect(vi.mocked(fuzzy.scoreItem)).toHaveBeenCalledTimes(14);
    worker.receive({ kind: 'invalidate', projectKey: alpha.key });
    vi.mocked(fuzzy.scoreItem).mockClear();
    await worker.query('edit', context);
    expect(vi.mocked(fuzzy.scoreItem)).toHaveBeenCalledTimes(7);
  });

  it('stops a query once a newer one of the same search arrives, and only then', async () => {
    for (let i = 0; i < 5; i++) touch(alpha, `a${i}.ts`);
    const worker = fileSearch();
    const context = { currentProjectKey: alpha.key, recent: [] };
    const [older, newer, otherSearch] = await Promise.all([
      worker.query('a1', context, { id: 3, generation: 4 }),
      worker.query('a', context, { id: 3, generation: 5 }),
      worker.query('a2', context, { id: 4, generation: 0 }),
    ]);
    expect(older).toEqual({ kind: 'superseded', id: 0 });
    expect(results(newer)).toHaveLength(5);
    expect(named(otherSearch)).toEqual(['alpha/a2.ts']);
    expect(vi.mocked(fuzzy.scoreItem)).toHaveBeenCalledTimes(10);
  });

  it('posts progress while a listing reports it and between scoring batches, at most once an interval', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const names = Array.from({ length: 3 * SCORE_BATCH }, (_, index) => `f${index}.txt`);
      const posted: WorkerReply[] = [];
      let answered!: () => void;
      const done = new Promise<void>((resolve) => (answered = resolve));
      const receive = createQuickOpenFileSearch((reply) => {
        posted.push(reply);
        if (reply.kind === 'answer') answered();
      }, async ({ fsPath }, progress) => {
        progress();
        progress();
        now += WORKER_PROGRESS_INTERVAL_MS - 1;
        progress();
        now += 1;
        progress();
        return fsPath === alpha.fsPath ? names : [];
      });
      const query = (id: number, raw: string): void => receive({ kind: 'query', id, search: 0, generation: id, raw, context: { recent: [] }, projects: [alpha] });

      query(0, '');
      await done;
      expect(posted.filter((reply) => reply.kind === 'progress')).toHaveLength(2);

      posted.length = 0;
      const scored = new Promise<void>((resolve) => (answered = resolve));
      vi.mocked(Date.now).mockImplementation(() => (now += WORKER_PROGRESS_INTERVAL_MS));
      query(1, 'f1');
      await scored;
      // The cached list reports nothing; each of the three batch boundaries does.
      expect(posted.filter((reply) => reply.kind === 'progress')).toHaveLength(3);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it('stops scoring between batches when a newer query arrives meanwhile', async () => {
    const names = Array.from({ length: 2 * SCORE_BATCH }, (_, index) => `f${index}.txt`);
    const worker = fileSearch((fsPath) => (fsPath === alpha.fsPath ? names : []));
    const context = { currentProjectKey: alpha.key, recent: [] };
    await worker.query('', context, { id: 0, generation: 0 });
    vi.mocked(fuzzy.scoreItem).mockClear();
    const older = worker.query('f1', context, { id: 0, generation: 1 });
    // The newer query arrives while the older one waits between its batches.
    await new Promise((resolve) => setImmediate(resolve));
    const newer = worker.query('f2', context, { id: 0, generation: 2 });
    expect(await older).toMatchObject({ kind: 'superseded' });
    expect((await newer).kind).toBe('answer');
    // The older query stopped at its first batch boundary; the newer one scored every file.
    expect(vi.mocked(fuzzy.scoreItem)).toHaveBeenCalledTimes(SCORE_BATCH - 1 + 2 * SCORE_BATCH);
  });

  it('answers an ended search\'s query as superseded and logs a listing that fails, trying again next time', async () => {
    touch(alpha, 'a.ts');
    const worker = fileSearch();
    const context = { currentProjectKey: alpha.key, recent: [] };
    const pending = worker.query('a', context, { id: 2, generation: 0 });
    worker.receive({ kind: 'end', search: 2 });
    expect(await pending).toMatchObject({ kind: 'superseded' });
    fs.rmSync(alpha.fsPath, { recursive: true });
    worker.receive({ kind: 'invalidate' });
    expect(results(await worker.query('a', context, { id: 3, generation: 0 }))).toEqual([]);
    expect(worker.logs.some((line) => line.includes('ENOENT'))).toBe(true);
    touch(alpha, 'a.ts');
    expect(named(await worker.query('a', context, { id: 3, generation: 1 }))).toEqual(['alpha/a.ts']);
  });

  it('asks main to list each project once, and again only after an invalidation or a failed listing', async () => {
    touch(alpha, 'a.ts');
    const asked: string[] = [];
    let fail = false;
    const answers = new Map<number, (reply: WorkerReply) => void>();
    const logs: string[] = [];
    const receive = createQuickOpenFileSearch((reply) => {
      if (reply.kind === 'log') logs.push(reply.line);
      else if (reply.kind === 'list') {
        asked.push(reply.projectKey === alpha.key ? 'alpha' : 'beta');
        if (fail && reply.projectKey === alpha.key) setImmediate(() => receive({ kind: 'listEnd', listing: reply.listing, error: 'EACCES: permission denied' }));
        else serveListing(receive, reply.listing, reply.projectKey);
      } else if (reply.kind !== 'progress') answers.get(reply.id)?.(reply);
    });
    const query = (id: number): Promise<WorkerReply> => new Promise((resolve) => {
      answers.set(id, resolve);
      receive({ kind: 'query', id, search: 0, generation: id, raw: 'a', context: { recent: [] }, projects: [alpha, beta] });
    });
    expect(named(await query(0))).toEqual(['alpha/a.ts']);
    expect(named(await query(1))).toEqual(['alpha/a.ts']);
    expect(asked).toEqual(['alpha', 'beta']);
    fail = true;
    receive({ kind: 'invalidate', projectKey: alpha.key });
    expect(results(await query(2))).toEqual([]);
    expect(logs).toEqual([`[quick-open] listing ${alpha.fsPath} failed: EACCES: permission denied`]);
    fail = false;
    expect(named(await query(3))).toEqual(['alpha/a.ts']);
    expect(asked).toEqual(['alpha', 'beta', 'alpha', 'alpha']);
  });

  it('keeps a project\'s list as it was when output arrives for its listing after the listing ended', async () => {
    const receive = createQuickOpenFileSearch((reply) => {
      if (reply.kind === 'list') {
        receive({ kind: 'listFiles', listing: reply.listing, files: ['a.ts'] });
        receive({ kind: 'listEnd', listing: reply.listing });
        receive({ kind: 'listFiles', listing: reply.listing, files: ['stray.ts'] });
      } else if (reply.kind === 'answer') answers.get(reply.id)?.(reply);
    });
    const answers = new Map<number, (reply: WorkerReply) => void>();
    const query = (id: number): Promise<WorkerReply> => new Promise((resolve) => {
      answers.set(id, resolve);
      receive({ kind: 'query', id, search: 0, generation: id, raw: '', context: { recent: [] }, projects: [alpha] });
    });
    expect(named(await query(0))).toEqual(['alpha/a.ts']);
    expect(named(await query(1))).toEqual(['alpha/a.ts']);
  });

  it('limits a scoped query to that project folder\'s files, in path order before a query, with no recent ones', async () => {
    touch(alpha, 'src/routes/users.ts');
    touch(alpha, 'src/routes/admin/audit.ts');
    touch(alpha, 'src/routes.ts');
    touch(alpha, 'src/app.ts');
    touch(beta, 'src/routes/users.ts');
    const worker = fileSearch();
    const context = { currentProjectKey: beta.key, recent: [{ projectKey: alpha.key, relativePath: 'src/app.ts' }], scope: { projectKey: alpha.key, folder: 'src/routes/' } };
    expect(named(await worker.query('', context))).toEqual(['alpha/src/routes/admin/audit.ts', 'alpha/src/routes/users.ts']);
    expect(named(await worker.query('users', context))).toEqual(['alpha/src/routes/users.ts']);
  });
});
