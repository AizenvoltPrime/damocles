// Quick Open worker messages, shared by main and the worker thread; no electron import.

import { isRelativeFilePath } from '../../shared/relative-path';
import { MAX_QUICK_OPEN_RESULTS, type QuickOpenMatch } from '../preload/overlay-channels';
import type { FileRef } from '../preload/shell-channels';

// Characters of a log line or failure message main takes from the worker; the rest is cut.
export const MAX_WORKER_MESSAGE_CHARS = 1000;

// The worker posts progress at most this often; QUICK_OPEN_WORKER_SILENCE_MS in main must stay many times longer.
export const WORKER_PROGRESS_INTERVAL_MS = 1000;

export interface WorkerProject {
  readonly key: string;
  readonly fsPath: string;
}

export interface WorkerQueryContext {
  readonly currentProjectKey?: string;
  // most recent first
  readonly recent: readonly FileRef[];
  // only this project folder's files, in path order before a query, with no recent ones
  readonly scope?: { readonly projectKey: string; readonly folder: string };
}

/** ripgrep's argv for a project's file list: no config file, no link following, excludes as negated globs, the root after '--'. */
export function ripgrepFileArgs(root: string, ignoreArgs: readonly string[], excludes: readonly string[]): string[] {
  return ['--files', '--hidden', '--no-config', ...ignoreArgs, ...excludes.flatMap((glob) => ['-g', `!${glob}`]), '--', root];
}

/**
 * main → worker. query: one keystroke's query of the open request `search`; a newer `generation` of the same search makes
 * the worker stop the older one. The projects are main's current ones. invalidate: drop one project's list, or every list.
 * end: the open request closed, so its cache goes. listOutput and listEnd: ripgrep's output for a listing the worker asked
 * for, then its end, with the reason when it failed.
 */
export type WorkerRequest =
  | {
    readonly kind: 'query';
    readonly id: number;
    readonly search: number;
    readonly generation: number;
    readonly raw: string;
    readonly context: WorkerQueryContext;
    readonly projects: readonly WorkerProject[];
  }
  | { readonly kind: 'invalidate'; readonly projectKey?: string }
  | { readonly kind: 'end'; readonly search: number }
  | { readonly kind: 'listOutput'; readonly listing: number; readonly data: Uint8Array }
  | { readonly kind: 'listEnd'; readonly listing: number; readonly error?: string };

export interface WorkerResult {
  readonly projectKey: string;
  readonly relativePath: string;
  readonly labelMatches: readonly QuickOpenMatch[];
  readonly descriptionMatches: readonly QuickOpenMatch[];
  readonly recent: boolean;
}

/**
 * worker → main. superseded: a newer query of the same search arrived first. failed: the query threw. progress: a listing
 * printed a file or scoring finished a batch since the last one, which is how main tells a slow worker from a stuck one.
 * list: run ripgrep for a project's files, so main holds every ripgrep and kills them with the worker.
 */
export type WorkerReply =
  | { readonly kind: 'answer'; readonly id: number; readonly results: readonly WorkerResult[] }
  | { readonly kind: 'superseded'; readonly id: number }
  | { readonly kind: 'failed'; readonly id: number; readonly message: string }
  | { readonly kind: 'log'; readonly line: string }
  | { readonly kind: 'progress' }
  | { readonly kind: 'list'; readonly listing: number; readonly projectKey: string };

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isMessage = (value: unknown): value is string => typeof value === 'string';

// Non-empty [start, end) ranges within `length` characters, at most one per character.
function parseMatches(raw: unknown, length: number): QuickOpenMatch[] | undefined {
  if (!Array.isArray(raw) || raw.length > length) return undefined;
  const matches: QuickOpenMatch[] = [];
  for (const item of raw as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2) return undefined;
    const [start, end] = item as unknown[];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
    const from = start as number;
    const to = end as number;
    if (from < 0 || to <= from || to > length) return undefined;
    matches.push([from, to]);
  }
  return matches;
}

function parseResult(raw: unknown): WorkerResult | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const projectKey = own(value, 'projectKey');
  const relativePath = own(value, 'relativePath');
  const recent = own(value, 'recent');
  if (typeof projectKey !== 'string' || !isRelativeFilePath(relativePath) || typeof recent !== 'boolean') return undefined;
  const slash = relativePath.lastIndexOf('/');
  const labelMatches = parseMatches(own(value, 'labelMatches'), relativePath.length - slash - 1);
  // A path match may end on the separator after the folder (scoreItem's "description/label").
  const descriptionMatches = parseMatches(own(value, 'descriptionMatches'), slash + 1);
  if (!labelMatches || !descriptionMatches) return undefined;
  return { projectKey, relativePath, labelMatches, descriptionMatches, recent };
}

/** A reply from the worker, checked as untrusted data: anything outside the contract or its bounds is undefined. */
export function parseWorkerReply(raw: unknown): WorkerReply | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const kind = own(value, 'kind');
  if (kind === 'log') {
    const line = own(value, 'line');
    return isMessage(line) ? { kind, line: line.slice(0, MAX_WORKER_MESSAGE_CHARS) } : undefined;
  }
  if (kind === 'progress') return { kind };
  if (kind === 'list') {
    const listing = own(value, 'listing');
    const projectKey = own(value, 'projectKey');
    return isId(listing) && typeof projectKey === 'string' ? { kind, listing, projectKey } : undefined;
  }
  const id = own(value, 'id');
  if (!isId(id)) return undefined;
  if (kind === 'superseded') return { kind, id };
  if (kind === 'failed') {
    const message = own(value, 'message');
    return isMessage(message) ? { kind, id, message: message.slice(0, MAX_WORKER_MESSAGE_CHARS) } : undefined;
  }
  if (kind !== 'answer') return undefined;
  const rawResults = own(value, 'results');
  if (!Array.isArray(rawResults) || rawResults.length > MAX_QUICK_OPEN_RESULTS) return undefined;
  const results: WorkerResult[] = [];
  for (const item of rawResults as unknown[]) {
    const result = parseResult(item);
    if (!result) return undefined;
    results.push(result);
  }
  return { kind, id, results };
}
