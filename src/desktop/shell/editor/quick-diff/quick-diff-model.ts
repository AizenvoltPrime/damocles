import { shallowRef, type ShallowRef } from 'vue';
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import type { LineChange } from '@shared/scm/apply-line-changes';
import type { DamoclesScmApi, ScmResource } from '../../../preload/scm-channels';
import QuickDiffWorker from './quick-diff.worker?worker';
import type { QuickDiffReply, QuickDiffRequest } from './quick-diff-compute';

// ms after the last keystroke before the diff runs again (VS Code's dirty diff delayer); a base read waits the same after a
// status lands, since one index write lands several statuses
export const QUICK_DIFF_EDIT_DELAY_MS = 200;
export const QUICK_DIFF_BASE_DELAY_MS = 200;

export interface QuickDiffState {
  // the model version the changes belong to
  readonly versionId: number;
  readonly indexText: string;
  readonly headText: string | null;
  readonly indexOid: string;
  // HEAD's blob at the file's HEAD path, which an unstage names; null with no staged changes or when HEAD lacks the file
  readonly headOid: string | null;
  // index → buffer
  readonly primary: readonly LineChange[];
  // HEAD → buffer, shown where no primary change touches it
  readonly secondary: readonly LineChange[];
  // HEAD → index
  readonly staged: readonly LineChange[];
  // HEAD → buffer, every change
  readonly head: readonly LineChange[];
}

// reading: the base read has not answered; none: no marks will come for this base (refused, failed, gave up); ready: marks shown
export type QuickDiffStatus = 'reading' | 'none' | 'ready';

interface WorkerClient {
  reply(reply: QuickDiffReply): void;
  // the worker failed, so no reply comes
  fail(): void;
}

let worker: Worker | undefined;
// grows with each worker started, so a model knows to post its base again to a new one
let generation = 0;
let nextId = 0;
const clients = new Map<string, WorkerClient>();

// One worker serves every editor; each model posts under its own key and gets only its own latest reply. A worker that fails
// to load or throws answers nothing more, so every model drops its marks and the next diff starts a new worker.
function post(request: QuickDiffRequest): void {
  if (!worker) {
    const started = new QuickDiffWorker();
    const failed = (): void => {
      if (worker !== started) return;
      started.terminate();
      worker = undefined;
      for (const client of [...clients.values()]) client.fail();
    };
    started.addEventListener('message', (event: MessageEvent<QuickDiffReply>) => clients.get(event.data.key)?.reply(event.data));
    started.addEventListener('error', failed);
    started.addEventListener('messageerror', failed);
    worker = started;
    generation++;
  }
  worker.postMessage(request);
}

export interface QuickDiffModel {
  // null: no marks (refused, gave up, not computed yet)
  readonly state: ShallowRef<QuickDiffState | null>;
  readonly status: ShallowRef<QuickDiffStatus>;
  /** Reads the base again now, then diffs: after a stage or unstage this editor ran. */
  refresh(): Promise<void>;
  /** The state for the model's current text against the latest base, waiting for a pending base read or edit's diff. */
  current(): Promise<QuickDiffState | null>;
  dispose(): void;
}

/**
 * The quick diff of one editor model against its file's index and HEAD (B25): the base comes from main, the diffs from the
 * worker. It recomputes on edits after QUICK_DIFF_EDIT_DELAY_MS and when the repository's status revision moves.
 */
export function createQuickDiffModel(api: DamoclesScmApi, model: MonacoEditor.ITextModel, target: ScmResource, onRevision: (listener: () => void) => () => void): QuickDiffModel {
  const key = `${model.id}:${target.repoId}:${target.path}`;
  const state = shallowRef<QuickDiffState | null>(null);
  const status = shallowRef<QuickDiffStatus>('reading');
  let base: { indexText: string; headText: string | null; indexOid: string; headOid: string | null } | null = null;
  // the worker generation that holds this model's base
  let posted = 0;
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  let baseTimer: ReturnType<typeof setTimeout> | undefined;
  let baseRead = 0;
  // a base read has not landed: the base held may be an index before it, so nothing diffs or answers from it
  let baseInFlight = false;
  let requested: { id: number; versionId: number } | undefined;
  let waiters: Array<() => void> = [];
  let disposed = false;

  const release = (): void => {
    for (const done of waiters.splice(0)) done();
  };

  clients.set(key, {
    reply(reply) {
      if (disposed || reply.id !== requested?.id || base === null) return;
      const versionId = requested.versionId;
      requested = undefined;
      // A reply for an older version is dropped; the edit that moved the version scheduled the next diff.
      if (model.getVersionId() !== versionId) return;
      const result = reply.result;
      state.value = result === null || result.primary === null ? null : { versionId, ...base, primary: result.primary, secondary: result.secondary, staged: result.staged, head: result.head };
      status.value = state.value === null ? 'none' : 'ready';
      release();
    },
    fail() {
      requested = undefined;
      state.value = null;
      status.value = 'none';
      release();
    },
  });

  // a worker that holds no base for the key need not start to forget it
  function dropBase(): void {
    worker?.postMessage({ kind: 'drop', key } satisfies QuickDiffRequest);
  }

  function diffNow(): void {
    clearTimeout(editTimer);
    editTimer = undefined;
    if (disposed || base === null || baseInFlight) return;
    if (worker === undefined || posted !== generation) {
      post({ kind: 'base', key, base: { indexText: base.indexText, headText: base.headText } });
      posted = generation;
    }
    const id = ++nextId;
    requested = { id, versionId: model.getVersionId() };
    post({ kind: 'diff', key, id, buffer: model.getValue() });
  }

  async function readBase(): Promise<void> {
    clearTimeout(baseTimer);
    baseTimer = undefined;
    const read = ++baseRead;
    baseInFlight = true;
    requested = undefined;
    // a read main could not answer leaves the file without marks, as a refused one does
    const result = await api.quickDiffBase(target).catch(() => null);
    if (disposed || read !== baseRead) return;
    baseInFlight = false;
    if (result === null || !result.ok) {
      base = null;
      requested = undefined;
      state.value = null;
      status.value = 'none';
      dropBase();
      release();
      return;
    }
    base = { indexText: result.indexText, headText: result.hasStaged ? result.headText : null, indexOid: result.indexOid, headOid: result.hasStaged ? result.headOid : null };
    // a new base goes to the worker before the diff that needs it
    posted = 0;
    diffNow();
  }

  const disposables: IDisposable[] = [
    model.onDidChangeContent(() => {
      clearTimeout(editTimer);
      editTimer = setTimeout(diffNow, QUICK_DIFF_EDIT_DELAY_MS);
    }),
  ];
  const stopRevision = onRevision(() => {
    clearTimeout(baseTimer);
    baseTimer = setTimeout(() => void readBase(), QUICK_DIFF_BASE_DELAY_MS);
  });
  void readBase();

  return {
    state,
    status,
    refresh: readBase,
    async current() {
      // the revision moved since the base was read: the action waits for the base read that follows it
      if (baseTimer !== undefined) void readBase();
      if (!baseInFlight && base === null) return null;
      if (!baseInFlight && state.value?.versionId === model.getVersionId() && editTimer === undefined && requested === undefined) return state.value;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (requested === undefined || requested.versionId !== model.getVersionId()) diffNow();
      });
      return state.value?.versionId === model.getVersionId() ? state.value : null;
    },
    dispose() {
      disposed = true;
      clearTimeout(editTimer);
      clearTimeout(baseTimer);
      stopRevision();
      for (const disposable of disposables) disposable.dispose();
      clients.delete(key);
      dropBase();
      release();
      waiters = [];
    },
  };
}
