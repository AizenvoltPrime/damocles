import { shallowRef, type ShallowRef } from 'vue';
import type { TerminalDropSide, TerminalState } from '../../preload/terminal-channels';
import { moveLanded, type TerminalStore } from './terminal-store';

// A terminal dragged within the shell page: a list row, the single-terminal tab or a terminal's editor tab. The payload is the
// terminal id alone.
export const TERMINAL_DRAG_MIME = 'application/x-damocles-terminal';

// The terminal this page is dragging; dragover cannot read the payload, only its type.
export const draggedTerminal: ShallowRef<string | null> = shallowRef(null);

// The part of the panel's end drop target (VS Code's terminal tabs container) the drag is over; every part highlights together.
// A part clears it only while it names that part, since the next part's dragenter comes before the last part's dragleave.
export type PanelEndPart = 'header' | 'list' | 'empty';
export const panelEndDrop: ShallowRef<PanelEndPart | null> = shallowRef(null);

export function leavePanelEnd(part: PanelEndPart): void {
  if (panelEndDrop.value === part) panelEndDrop.value = null;
}

export function startTerminalDrag(event: DragEvent, id: string): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(TERMINAL_DRAG_MIME, id);
  event.dataTransfer.effectAllowed = 'move';
  draggedTerminal.value = id;
}

export function endTerminalDrag(): void {
  draggedTerminal.value = null;
  panelEndDrop.value = null;
}

/** The terminal a dragenter or dragover carries, or null for any other drag (files, a sidebar section, another page's). */
export function terminalDragOf(event: DragEvent): string | null {
  return event.dataTransfer?.types.includes(TERMINAL_DRAG_MIME) === true ? draggedTerminal.value : null;
}

/** The terminal a drop carries, read from its payload. */
export function terminalDropOf(event: DragEvent): string | null {
  return event.dataTransfer?.getData(TERMINAL_DRAG_MIME) || null;
}

/** The terminal a drag over the panel's end target would move, or null for any other drag and one already alone at the end. */
export function panelEndDragOf(event: DragEvent, state: TerminalState | null): string | null {
  const id = terminalDragOf(event);
  return id === null || moveLanded(state, { kind: 'detach', id }) ? null : id;
}

/** Drag handlers that make `part` a part of the panel's end target, where a dropped terminal becomes a group of its own at the end. */
export function panelEndTarget(part: PanelEndPart, store: Pick<TerminalStore, 'state' | 'move'>): { over(event: DragEvent): void; leave(event: DragEvent): void; drop(event: DragEvent): void } {
  return {
    over(event) {
      if (panelEndDragOf(event, store.state.value) === null) {
        leavePanelEnd(part);
        return;
      }
      event.preventDefault();
      event.dataTransfer!.dropEffect = 'move';
      panelEndDrop.value = part;
    },
    leave(event) {
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) leavePanelEnd(part);
    },
    drop(event) {
      const id = terminalDropOf(event);
      if (id === null) return;
      event.preventDefault();
      endTerminalDrag();
      store.move({ kind: 'detach', id });
    },
  };
}

/** A pane's left half is before its terminal, the right half after (VS Code's horizontal panel). */
export function paneDropSide(rect: { readonly left: number; readonly width: number }, clientX: number): TerminalDropSide {
  return clientX - rect.left < rect.width / 2 ? 'before' : 'after';
}

/** A row's upper half is before its terminal, the lower half after. */
export function rowDropSide(rect: { readonly top: number; readonly height: number }, clientY: number): TerminalDropSide {
  return clientY - rect.top < rect.height / 2 ? 'before' : 'after';
}
