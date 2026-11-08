import { computed, shallowRef, type ComputedRef, type InjectionKey, type ShallowRef } from 'vue';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import type { TerminalData, TerminalInfo, TerminalMove, TerminalRunAction, TerminalScreen, TerminalState } from '../../preload/terminal-channels';

// A batch of output and the shell events main parsed out of it, or the screen a reloaded page shows before its output.
export type TerminalBatch = Pick<TerminalData, 'data' | 'events'> | { readonly screen: TerminalScreen };
export type TerminalSink = (batch: TerminalBatch) => void;

// Where focus goes when an inline rename ends: the terminal it renames, or the list row or tab it was started from.
export type RenameReturn = 'terminal' | 'tab';

export interface TerminalStore {
  readonly state: ShallowRef<TerminalState | null>;
  readonly active: ComputedRef<TerminalInfo | null>;
  // a terminal to focus once its view can take focus: main's focus after a user action, or a click or key in the pane
  readonly focusRequest: ShallowRef<{ readonly id: string; readonly seq: number } | null>;
  requestFocus(id: string): void;
  // the terminal whose list row or tab shows the rename field
  readonly renaming: ShallowRef<{ readonly id: string; readonly returnTo: RenameReturn } | null>;
  startRename(id: string, returnTo: RenameReturn): void;
  endRename(): void;
  // main's Edit menu Paste for a terminal, which its view answers with the terminal's bracketed paste mode
  readonly pasteRequest: ShallowRef<{ readonly id: string; readonly seq: number } | null>;
  // a palette command main asks the terminal's view to run on its buffer
  readonly actionRequest: ShallowRef<(TerminalRunAction & { readonly seq: number }) | null>;
  // the terminal of the user's last move, set once main's state shows it landed
  readonly moved: ShallowRef<{ readonly id: string; readonly seq: number } | null>;
  // main applies the move and publishes; the shell never reorders on its own, and sends no move that changes nothing
  move(move: TerminalMove): void;
  // the editor pane's host element of each terminal tab, which that terminal's view is teleported into
  readonly editorHosts: ShallowRef<ReadonlyMap<string, HTMLElement>>;
  // the editor terminal whose tab is active while the editor pane shows
  readonly editorShown: ShallowRef<string | null>;
  // the view's xterm takes the terminal's output; output that arrives before it mounts waits for it
  attach(id: string, sink: TerminalSink): () => void;
  // a screen waits for the terminal's view
  screenWaits(id: string): boolean;
  start(): Promise<void>;
  stop(): void;
}

export const TERMINAL_STORE: InjectionKey<TerminalStore> = Symbol('terminal-store');

/** The terminals in the panel, in list order; editor terminals follow them in `state.terminals`. */
export function panelTerminals(state: Pick<TerminalState, 'terminals'> | null): readonly TerminalInfo[] {
  return state?.terminals.filter((terminal) => terminal.placement === 'panel') ?? [];
}

/** How many panes share the group of terminal `id`. */
export function groupPanes(state: TerminalState | null, id: string): number {
  return state?.groups.find((group) => group.paneIds.includes(id))?.paneIds.length ?? 0;
}

const arrangementOf = (state: TerminalState | null): string => state?.groups.map((group) => group.paneIds.join(' ')).join('|') ?? '';
const rowOf = (state: TerminalState | null, id: string): number => state?.terminals.findIndex((terminal) => terminal.id === id) ?? -1;

/**
 * Whether `state` shows the terminal where `move` puts it, by the rules of main's TerminalService.move; a step compares the
 * terminal's row with `from`, its row before the move. A move that has landed before it is sent changes nothing.
 */
export function moveLanded(state: TerminalState | null, move: TerminalMove, from = rowOf(state, move.id)): boolean {
  const groups = state?.groups ?? [];
  const groupOf = (id: string) => groups.find((group) => group.paneIds.includes(id));
  switch (move.kind) {
    case 'toEditor':
      return state?.terminals.some((terminal) => terminal.id === move.id && terminal.placement === 'editor') === true;
    case 'detach':
      return groups.at(-1)?.paneIds.join(' ') === move.id;
    case 'step': {
      const row = rowOf(state, move.id);
      return row >= 0 && Math.sign(row - from) === move.delta;
    }
    case 'reorder':
    case 'join': {
      const own = groupOf(move.id);
      const target = groupOf(move.target);
      if (move.target === move.id) return true;
      if (!own || !target) return false;
      const offset = move.side === 'after' ? 1 : -1;
      if (own === target) return own.paneIds.indexOf(move.id) === own.paneIds.indexOf(move.target) + offset;
      return move.kind === 'reorder' && groups.indexOf(own) === groups.indexOf(target) + offset;
    }
  }
}

/** The window's terminals as main publishes them, and the routing of each terminal's output to its view. */
export function createTerminalStore(api: DamoclesShellApi): TerminalStore {
  const state = shallowRef<TerminalState | null>(null);
  const focusRequest = shallowRef<{ id: string; seq: number } | null>(null);
  const renaming = shallowRef<{ id: string; returnTo: RenameReturn } | null>(null);
  const pasteRequest = shallowRef<{ id: string; seq: number } | null>(null);
  const actionRequest = shallowRef<(TerminalRunAction & { seq: number }) | null>(null);
  const moved = shallowRef<{ id: string; seq: number } | null>(null);
  const editorHosts = shallowRef<ReadonlyMap<string, HTMLElement>>(new Map());
  const editorShown = shallowRef<string | null>(null);
  // The move sent, the arrangement and row it was sent against. Main publishes nothing for a move it refuses, and a state it
  // published before taking the move can still arrive after the send, so the first arrangement change settles it, reporting
  // it moved only if that state shows the move landed.
  let pendingMove: { readonly move: TerminalMove; readonly arrangement: string; readonly from: number } | null = null;
  const sinks = new Map<string, TerminalSink>();
  // Bounded by flow control: the host pauses a pty whose output no view acknowledges.
  const pending = new Map<string, TerminalBatch[]>();
  const stops: Array<() => void> = [];
  let seq = 0;

  const active = computed(() => {
    const current = state.value;
    return current?.terminals.find((terminal) => terminal.id === current.activeId) ?? null;
  });

  // Output waiting for a terminal that left the list is dropped; output may arrive before the state that lists it.
  function applyState(next: TerminalState): void {
    const ids = new Set(next.terminals.map((terminal) => terminal.id));
    for (const terminal of state.value?.terminals ?? []) if (!ids.has(terminal.id)) pending.delete(terminal.id);
    if (renaming.value && !ids.has(renaming.value.id)) renaming.value = null;
    state.value = next;
    if (pendingMove && arrangementOf(next) !== pendingMove.arrangement) {
      if (moveLanded(next, pendingMove.move, pendingMove.from)) moved.value = { id: pendingMove.move.id, seq: ++seq };
      pendingMove = null;
    }
  }

  function onData({ id, data, events }: TerminalData): void {
    route(id, events ? { data, events } : { data });
  }

  function route(id: string, batch: TerminalBatch): void {
    const sink = sinks.get(id);
    if (sink) sink(batch);
    else if (pending.has(id)) pending.get(id)!.push(batch);
    else pending.set(id, [batch]);
  }

  function requestFocus(id: string): void {
    focusRequest.value = { id, seq: ++seq };
  }

  function startRename(id: string, returnTo: RenameReturn): void {
    if (state.value?.terminals.some((terminal) => terminal.id === id)) renaming.value = { id, returnTo };
  }

  return {
    state,
    active,
    focusRequest,
    requestFocus,
    renaming,
    startRename,
    endRename() {
      renaming.value = null;
    },
    pasteRequest,
    actionRequest,
    moved,
    editorHosts,
    editorShown,
    move(request) {
      if (moveLanded(state.value, request)) return;
      pendingMove = { move: request, arrangement: arrangementOf(state.value), from: rowOf(state.value, request.id) };
      api.terminal.move(request);
    },
    screenWaits: (id) => (pending.get(id) ?? []).some((batch) => 'screen' in batch),
    attach(id, sink) {
      sinks.set(id, sink);
      for (const batch of pending.get(id) ?? []) sink(batch);
      pending.delete(id);
      return () => {
        if (sinks.get(id) === sink) sinks.delete(id);
      };
    },
    async start() {
      // Subscribed before the first read, so nothing between the two is lost.
      stops.push(api.terminal.onState(applyState));
      stops.push(api.terminal.onData(onData));
      stops.push(api.terminal.onScreen((screen) => route(screen.id, { screen })));
      stops.push(api.terminal.onFocus(requestFocus));
      stops.push(api.terminal.onStartRename((id) => startRename(id, 'terminal')));
      stops.push(api.terminal.onRequestPaste((id) => {
        pasteRequest.value = { id, seq: ++seq };
      }));
      stops.push(api.terminal.onRunAction((request) => {
        actionRequest.value = { ...request, seq: ++seq };
      }));
      applyState(await api.terminal.getState());
    },
    stop() {
      for (const stop of stops.splice(0)) stop();
    },
  };
}
