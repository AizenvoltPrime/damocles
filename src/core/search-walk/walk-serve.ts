import * as path from 'node:path';
import { commandLineCost } from './command-line';
import { overrideRules } from './rg-ignore';
import { insideGitRepo, rootHosts, walkFiles, type Walk } from './walk';
import { MAX_WALK_ERRORS, MAX_WALK_MESSAGE_CHARS, WALK_BATCH_FILES, WALK_BATCH_UNITS, WALK_CREDIT, WALK_FLUSH_MS, type WalkReply, type WalkRequest } from './walk-protocol';

interface Running {
  readonly controller: AbortController;
  credit: number;
  // settles a walk waiting for credit
  wake: (() => void) | undefined;
  walk: Walk | undefined;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, MAX_WALK_MESSAGE_CHARS);
const boundedErrors = (errors: readonly string[]): string[] => errors.slice(0, MAX_WALK_ERRORS).map(messageOf);

// True when the walk was cancelled or ended with folders still being read ahead: its released follows once they settle.
async function run(request: Extract<WalkRequest, { kind: 'walk' }>, running: Running, post: (reply: WalkReply) => void): Promise<boolean> {
  const { id, lineBudget, maxFiles } = request;
  const { signal } = running.controller;
  let walk: Walk | undefined;
  let batch: string[] = [];
  let size = 0;
  let units = 0;
  let firstAt = 0;
  let listed = 0;
  const send = async (): Promise<void> => {
    while (running.credit === 0 && !signal.aborted) await new Promise<void>((resolve) => (running.wake = resolve));
    if (signal.aborted) throw new Error('Operation aborted');
    running.credit--;
    post({ kind: 'files', id, files: batch });
    batch = [];
    size = 0;
    units = 0;
  };
  try {
    const requireGit = request.requireGit === 'insideRepo' ? await insideGitRepo(request.root) : request.requireGit;
    const allowed = request.allowedHosts;
    // without the caller's hosts, the walk's own: a root on a share reads that share and no other host
    const allowedHosts = allowed === undefined ? rootHosts(request.root) : () => Promise.resolve(new Set(allowed));
    if (signal.aborted) throw new Error('Operation aborted');
    walk = running.walk = walkFiles({ root: request.root, requireGit, ignore: request.ignore, gitFolders: request.gitFolders, overrides: overrideRules(request.overrides), allowedHosts, signal });
    // a folder's files are found at once, so a batch's wait is read as each folder is listed
    walking: for await (const folder of walk.files) {
      if (batch.length > 0 && Date.now() - firstAt >= WALK_FLUSH_MS) await send();
      for (const found of folder) {
        const file = path.sep === '/' ? found : found.replaceAll(path.sep, '/');
        const cost = lineBudget === undefined ? 1 : commandLineCost(file);
        if (batch.length > 0 && (size + cost > (lineBudget ?? WALK_BATCH_FILES) || units + file.length > WALK_BATCH_UNITS)) await send();
        batch.push(file);
        size += cost;
        units += file.length;
        if (batch.length === 1) firstAt = Date.now();
        listed++;
        if (maxFiles !== undefined && listed >= maxFiles) break walking;
      }
    }
    if (batch.length > 0) await send();
    // a cancel that came after the last batch: nothing more is sent
    if (signal.aborted) return true;
    const reading = walk.readsAhead() > 0;
    post({ kind: 'end', id, errors: boundedErrors(walk.errors), ...(reading ? { reading } : {}) });
    return reading;
  } catch (err) {
    if (signal.aborted) return true;
    const reading = (walk?.readsAhead() ?? 0) > 0;
    post({ kind: 'end', id, errors: boundedErrors(walk?.errors ?? []), error: messageOf(err), ...(reading ? { reading } : {}) });
    return reading;
  }
}

/** The walk process's end of its channel to the host, whatever carries it (walk-channels.ts). */
export interface WalkChannel {
  send(reply: WalkReply): void;
  onRequest(listener: (request: WalkRequest) => void): void;
}

/** The walk process's whole body: each request the channel brings runs or steers a walk, whose replies go back over it. */
export function serveWalks(channel: WalkChannel): void {
  const walks = new Map<number, Running>();
  const post = (reply: WalkReply): void => channel.send(reply);
  // Its host builds every request.
  channel.onRequest((request) => {
    if (request.kind === 'walk') {
      const running: Running = { controller: new AbortController(), credit: WALK_CREDIT, wake: undefined, walk: undefined };
      walks.set(request.id, running);
      void run(request, running, post)
        .then(async (release) => {
          if (!release) return;
          // a read of a share that stopped answering holds a pool thread until it returns, which the host counts as load
          await running.walk?.readsSettled();
          post({ kind: 'released', id: request.id });
        })
        .finally(() => {
          if (walks.get(request.id) === running) walks.delete(request.id);
        });
      return;
    }
    const running = walks.get(request.id);
    if (!running) return;
    if (request.kind === 'ack') running.credit++;
    else {
      walks.delete(request.id);
      running.controller.abort();
    }
    running.wake?.();
    running.wake = undefined;
  });
}
