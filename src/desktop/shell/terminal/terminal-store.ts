import { computed, shallowRef, type ComputedRef, type InjectionKey, type ShallowRef } from 'vue';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import type { TerminalData, TerminalInfo, TerminalRunAction, TerminalState } from '../../preload/terminal-channels';

// A batch of output and the shell events main parsed out of it.
export type TerminalSink = (batch: Pick<TerminalData, 'data' | 'events'>) => void;

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
  // the view's xterm takes the terminal's output; output that arrives before it mounts waits for it
  attach(id: string, sink: TerminalSink): () => void;
  start(): Promise<void>;
  stop(): void;
}

export const TERMINAL_STORE: InjectionKey<TerminalStore> = Symbol('terminal-store');

/** How many panes share the group of terminal `id`. */
export function groupPanes(state: TerminalState | null, id: string): number {
  return state?.groups.find((group) => group.paneIds.includes(id))?.paneIds.length ?? 0;
}

/** The window's terminals as main publishes them, and the routing of each terminal's output to its view. */
export function createTerminalStore(api: DamoclesShellApi): TerminalStore {
  const state = shallowRef<TerminalState | null>(null);
  const focusRequest = shallowRef<{ id: string; seq: number } | null>(null);
  const renaming = shallowRef<{ id: string; returnTo: RenameReturn } | null>(null);
  const pasteRequest = shallowRef<{ id: string; seq: number } | null>(null);
  const actionRequest = shallowRef<(TerminalRunAction & { seq: number }) | null>(null);
  const sinks = new Map<string, TerminalSink>();
  // Bounded by flow control: the host pauses a pty whose output no view acknowledges.
  const pending = new Map<string, Array<Pick<TerminalData, 'data' | 'events'>>>();
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
  }

  function onData({ id, data, events }: TerminalData): void {
    const batch = events ? { data, events } : { data };
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
