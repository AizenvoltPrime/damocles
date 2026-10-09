import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { compareScoredItems, parseQuickOpenQuery, prepareQuery, scoreItem, type FuzzyItem, type ItemScore } from '../../core/quick-open/fuzzy-match';
import { isRelativeFilePath } from '../../shared/relative-path';
import { MAX_QUICK_OPEN_RESULTS } from '../preload/overlay-channels';
import { WORKER_PROGRESS_INTERVAL_MS, type WorkerProject, type WorkerReply, type WorkerRequest, type WorkerResult } from './protocol';

// Before a query, the recent files, then this many files of the current project and of each other one.
const EMPTY_CURRENT_PROJECT_FILES = 8;
const EMPTY_OTHER_PROJECT_FILES = 4;
// Files scored between two turns of the event loop, VS Code's topAsync batch (rawSearchService.ts sortResults); a newer query's
// message is read between batches.
export const SCORE_BATCH = 10_000;

export interface FileListReader {
  write(data: Uint8Array): void;
  // the files in path order
  end(): string[];
}

/**
 * A project's file list from the ripgrep output main streams in, as '/' separated paths relative to root in path order, so
 * the list is the same whatever order ripgrep's parallel walk prints it in. progress runs for every file ripgrep prints.
 */
export function fileListReader(root: string, progress: () => void): FileListReader {
  const decoder = new StringDecoder('utf8');
  const files: string[] = [];
  let partial = '';
  const line = (raw: string): void => {
    const printed = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (printed === '') return;
    progress();
    const relative = path.relative(root, printed).split(path.sep).join('/');
    // ripgrep prints paths under the root it was given; anything else is dropped rather than trusted.
    if (isRelativeFilePath(relative)) files.push(relative);
  };
  return {
    write: (data) => {
      const lines = (partial + decoder.write(data)).split('\n');
      partial = lines.pop()!;
      for (const each of lines) line(each);
    },
    end: () => {
      line(partial);
      return files.sort();
    },
  };
}

/** A project's file list: main runs ripgrep and streams its output in. */
export type ListFiles = (project: WorkerProject, progress: () => void) => Promise<string[]>;

function itemOf(relativePath: string): FuzzyItem {
  const slash = relativePath.lastIndexOf('/');
  return { label: relativePath.slice(slash + 1), description: slash < 0 ? '' : relativePath.slice(0, slash), path: relativePath };
}

function resultOf(projectKey: string, relativePath: string, score: ItemScore | undefined, recent: boolean): WorkerResult {
  return { projectKey, relativePath, labelMatches: score?.labelMatches ?? [], descriptionMatches: score?.descriptionMatches ?? [], recent };
}

// The files a query matched, per project, from the lists of one version.
interface MatchedFiles {
  readonly version: number;
  readonly lists: ReadonlyArray<{ readonly projectKey: string; readonly files: readonly string[] }>;
}

// One open Quick Open's queries: its newest generation and the files each of its filters matched.
interface Search {
  latest: number;
  readonly cache: Map<string, MatchedFiles>;
}

// VS Code's getResultsFromCache (rawSearchService.ts): a filter that extends an earlier one matches only files the earlier one
// matched, so the longest such filter's files are scored instead of every file. A path separator the earlier filter lacked
// widens the match, as VS Code says, and so does a quoted piece, which matches only contiguously.
function cachedLists(search: Search, filter: string, version: number): MatchedFiles['lists'] | undefined {
  const separator = /[/\\]/;
  let best: string | undefined;
  for (const [previous, entry] of search.cache) {
    if (entry.version !== version || !filter.startsWith(previous) || previous.includes('"')) continue;
    if (separator.test(filter) && !separator.test(previous)) continue;
    if (best === undefined || previous.length > best.length) best = previous;
  }
  return best === undefined ? undefined : search.cache.get(best)!.lists;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Query = Extract<WorkerRequest, { kind: 'query' }>;

/**
 * The worker's side of Quick Open: per-project file lists, cached until main invalidates them, and the scoring of each query.
 * Returns the handler of main's requests; every reply goes through post.
 */
export function createQuickOpenFileSearch(post: (reply: WorkerReply) => void, listFiles?: ListFiles): (request: WorkerRequest) => void {
  const lists = new Map<string, Promise<string[]>>();
  const searches = new Map<number, Search>();
  // the listings main runs for this worker, by listing id
  const listings = new Map<number, { readonly reader: FileListReader; readonly resolve: (files: string[]) => void; readonly reject: (err: Error) => void }>();
  let nextListing = 0;
  const listFromMain: ListFiles = (project, onProgress) => new Promise((resolve, reject) => {
    const listing = nextListing++;
    listings.set(listing, { reader: fileListReader(project.fsPath, onProgress), resolve, reject });
    post({ kind: 'list', listing, projectKey: project.key });
  });
  const list = listFiles ?? listFromMain;
  // bumped by every invalidation and failed listing, so a search's cached matches never outlive the lists they came from
  let version = 0;
  const log = (line: string): void => post({ kind: 'log', line });
  let lastProgress = 0;
  const progress = (): void => {
    const now = Date.now();
    if (now - lastProgress < WORKER_PROGRESS_INTERVAL_MS) return;
    lastProgress = now;
    post({ kind: 'progress' });
  };

  function files(project: WorkerProject): Promise<string[]> {
    const cached = lists.get(project.key);
    if (cached) return cached;
    // A failed listing is not cached, and neither are the matches scored without it, so the next query tries again.
    const guarded: Promise<string[]> = list(project, progress).catch((err: unknown) => {
      if (lists.get(project.key) === guarded) lists.delete(project.key);
      version++;
      log(`[quick-open] listing ${project.fsPath} failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
    lists.set(project.key, guarded);
    return guarded;
  }

  // The query's results, or undefined once a newer query of its search arrived.
  async function answer(request: Query, search: Search): Promise<WorkerResult[] | undefined> {
    const current = (): boolean => searches.get(request.search) === search && search.latest === request.generation;
    const parsed = parseQuickOpenQuery(request.raw);
    const { context } = request;
    const { scope } = context;
    const projects = request.projects.filter((project) => scope === undefined || project.key === scope.projectKey);
    const keys = new Set(projects.map((project) => project.key));
    const listVersion = version;
    const listings = await Promise.all(projects.map(async (project) => ({ projectKey: project.key, files: await files(project) })));
    if (!current()) return undefined;
    const projectLists = listings.map(({ projectKey, files: all }) => ({ projectKey, files: scope === undefined ? all : all.filter((file) => file.startsWith(scope.folder)) }));
    const recent = scope === undefined ? context.recent.filter((ref) => keys.has(ref.projectKey)) : [];
    const recentKeys = new Set(recent.map((ref) => `${ref.projectKey}\n${ref.relativePath}`));
    const isRecent = (projectKey: string, relativePath: string): boolean => recentKeys.has(`${projectKey}\n${relativePath}`);
    const results: WorkerResult[] = [];
    if (parsed.filter === '' && scope !== undefined) {
      for (const { projectKey, files: listed } of projectLists) for (const file of listed.slice(0, MAX_QUICK_OPEN_RESULTS)) results.push(resultOf(projectKey, file, undefined, false));
    } else if (parsed.filter === '') {
      for (const ref of recent) results.push(resultOf(ref.projectKey, ref.relativePath, undefined, true));
      const ordered = [...projectLists].sort((a, b) => Number(b.projectKey === context.currentProjectKey) - Number(a.projectKey === context.currentProjectKey));
      for (const { projectKey, files: listed } of ordered) {
        const limit = projectKey === context.currentProjectKey ? EMPTY_CURRENT_PROJECT_FILES : EMPTY_OTHER_PROJECT_FILES;
        for (const file of listed.filter((candidate) => !isRecent(projectKey, candidate)).slice(0, limit)) results.push(resultOf(projectKey, file, undefined, false));
      }
    } else {
      const query = prepareQuery(parsed.filter);
      const scored: Array<{ projectKey: string; item: FuzzyItem; score: ItemScore; recent: boolean }> = [];
      const matched: Array<{ projectKey: string; files: string[] }> = [];
      let batch = 0;
      for (const { projectKey, files: listed } of cachedLists(search, parsed.filter, listVersion) ?? projectLists) {
        const kept: string[] = [];
        for (const file of listed) {
          if (++batch === SCORE_BATCH) {
            batch = 0;
            progress();
            await nextTurn();
            if (!current()) return undefined;
          }
          const item = itemOf(file);
          const score = scoreItem(item, query);
          if (score.score === 0) continue;
          kept.push(file);
          scored.push({ projectKey, item, score, recent: isRecent(projectKey, file) });
        }
        matched.push({ projectKey, files: kept });
      }
      search.cache.set(parsed.filter, { version: listVersion, lists: matched });
      scored.sort((a, b) => Number(b.recent) - Number(a.recent) || compareScoredItems(a.item, a.score, b.item, b.score, query));
      for (const entry of scored.slice(0, MAX_QUICK_OPEN_RESULTS)) results.push(resultOf(entry.projectKey, entry.item.path, entry.score, entry.recent));
    }
    return results;
  }

  return (request) => {
    if (request.kind === 'invalidate') {
      version++;
      if (request.projectKey === undefined) lists.clear();
      else lists.delete(request.projectKey);
      return;
    }
    if (request.kind === 'end') {
      searches.delete(request.search);
      return;
    }
    if (request.kind === 'listOutput') {
      listings.get(request.listing)?.reader.write(request.data);
      return;
    }
    if (request.kind === 'listEnd') {
      const listing = listings.get(request.listing);
      if (!listing) return;
      listings.delete(request.listing);
      if (request.error === undefined) listing.resolve(listing.reader.end());
      else listing.reject(new Error(request.error));
      return;
    }
    let search = searches.get(request.search);
    if (!search) {
      search = { latest: -1, cache: new Map() };
      searches.set(request.search, search);
    }
    search.latest = Math.max(search.latest, request.generation);
    answer(request, search).then(
      (results) => post(results === undefined ? { kind: 'superseded', id: request.id } : { kind: 'answer', id: request.id, results }),
      (err: unknown) => post({ kind: 'failed', id: request.id, message: err instanceof Error ? err.message : String(err) }),
    );
  };
}
