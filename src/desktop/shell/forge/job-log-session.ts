import { markRaw, ref, shallowRef, toRaw, type Ref, type ShallowRef } from 'vue';
import { CiLogParser, type CiLogRow } from '@shared/forge/ci-log';
import type { JobLogView } from '@shared/forge/ci';
import type { DamoclesShellApi } from '../../preload/shell-channels';

type ReadyView = Extract<JobLogView, { status: 'ready' }>;

/** One view applied: what the tab showed before it, and the first row the view appended, when it appended any. */
export interface JobLogApplied {
  readonly before: JobLogView;
  readonly next: JobLogView;
  readonly arrivedFrom: number | undefined;
}

/**
 * A job log tab's log in shell memory while the tab is open, so showing the tab again neither reads nor parses the log again:
 * its parser takes every update main pushes, shown or not, and a reset starts a new one.
 */
export interface JobLogSession {
  // the newest view main sent
  readonly view: ShallowRef<JobLogView>;
  // the log the tab holds: the newest ready view, kept under a later read's failure
  readonly log: ShallowRef<ReadyView | undefined>;
  readonly parser: ShallowRef<CiLogParser | null>;
  // the parser's held lines (peekHeld), shown after its rows until they become rows
  readonly provisional: ShallowRef<readonly CiLogRow[]>;
  // bumped after every push into the parser
  readonly revision: Ref<number>;
  // bumped by a new parser, whose log the view shows afresh
  readonly generation: Ref<number>;
  /** Asks main for the whole log so far, showing it loading unless a log is held. */
  load(): Promise<void>;
  /** Called after each view is applied; the returned function stops it. */
  onApplied(listener: (applied: JobLogApplied) => void): () => void;
  release(): void;
}

// by the raw api, so a reactive proxy of it finds the same sessions
const sessions = new WeakMap<DamoclesShellApi, Map<string, JobLogSession>>();

/** The tab's session, made and loaded on its first call; readFailed is the error shown when main refuses a read. */
export function jobLogSession(api: DamoclesShellApi, tabId: string, readFailed: () => string): { readonly session: JobLogSession; readonly created: boolean } {
  let byTab = sessions.get(toRaw(api));
  if (!byTab) {
    byTab = new Map();
    sessions.set(toRaw(api), byTab);
  }
  const held = byTab.get(tabId);
  if (held) return { session: held, created: false };
  const session = createSession(api, tabId, readFailed);
  byTab.set(tabId, session);
  void session.load();
  return { session, created: true };
}

/** Drops the sessions of tabs no longer open. */
export function releaseJobLogSessions(api: DamoclesShellApi, open: ReadonlySet<string>): void {
  const byTab = sessions.get(toRaw(api));
  if (!byTab) return;
  for (const [tabId, session] of byTab) {
    if (open.has(tabId)) continue;
    session.release();
    byTab.delete(tabId);
  }
}

function createSession(api: DamoclesShellApi, tabId: string, readFailed: () => string): JobLogSession {
  const view = shallowRef<JobLogView>({ status: 'loading' });
  const log = shallowRef<ReadyView | undefined>(undefined);
  const parser = shallowRef<CiLogParser | null>(null);
  const provisional = shallowRef<readonly CiLogRow[]>([]);
  const revision = ref(0);
  const generation = ref(0);
  const listeners = new Set<(applied: JobLogApplied) => void>();
  let ended = false;

  async function load(): Promise<void> {
    if (!log.value) view.value = { status: 'loading' };
    let next: JobLogView;
    try {
      next = await api.forge.jobLog(tabId);
    } catch (error) {
      console.error('[ci] main refused the job log', error);
      next = { status: 'error', message: readFailed() };
    }
    apply(next.status === 'ready' ? { ...next, reset: true } : next);
  }

  function apply(received: JobLogView): void {
    // an ended parser takes no more text: an append after the finish reads the whole log again
    if (received.status === 'ready' && !received.reset && ended && received.text !== '') {
      void load();
      return;
    }
    const before = view.value;
    let arrivedFrom: number | undefined;
    let next = received;
    if (received.status === 'ready') {
      let current = parser.value;
      if (received.reset || !current) {
        current = markRaw(new CiLogParser(received.kind));
        parser.value = current;
        ended = false;
        generation.value++;
      } else if (received.text !== '') arrivedFrom = current.rows.length;
      if (received.text !== '') current.push(received.text);
      if (!received.live && !ended) {
        current.end();
        ended = true;
      }
      provisional.value = current.peekHeld();
      revision.value++;
      // the parser holds the text, so the view keeps none of it
      const kept: ReadyView = { ...received, text: '' };
      log.value = kept;
      next = kept;
    } else if (received.status !== 'error') {
      log.value = undefined;
    }
    view.value = next;
    for (const listener of listeners) listener({ before, next, arrivedFrom });
  }

  // subscribed before the first read; an update before it lands applies in order, and the read replaces the log
  const stop = api.forge.onJobLog((update) => {
    if (update.tabId === tabId) apply(update.view);
  });

  return {
    view,
    log,
    parser,
    provisional,
    revision,
    generation,
    load,
    onApplied: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release: () => {
      stop();
      listeners.clear();
    },
  };
}
