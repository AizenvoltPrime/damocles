import type { InjectionKey, Ref } from 'vue';
import type { GridPane } from '../../preload/shell-channels';

// What a pane's grip reaches in the grid that holds it: the pointer drag onto the drop zones, and the keyboard "Move to" menu.
export interface GridContext {
  // the pane being dragged onto the drop zones, null otherwise
  readonly dragging: Readonly<Ref<GridPane | null>>;
  // a primary-button press on the grip; the drag starts once the pointer passes the threshold
  press(pane: GridPane, event: PointerEvent): void;
  // whether the click that follows a press should open the menu, false after a drag
  takeClick(): boolean;
  openMoveMenu(pane: GridPane, anchor: HTMLElement): Promise<void>;
}

export const GRID_CONTEXT: InjectionKey<GridContext> = Symbol('grid-context');
