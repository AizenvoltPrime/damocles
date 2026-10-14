import type { InjectionKey, Ref } from 'vue';
import type { SidebarSectionId } from '../../preload/shell-channels';
import type { DropEdge } from '../layout/section-order';

/** damocles.desktop.sidebar.alwaysShowHeaderActions (VS Code's workbench.view.alwaysShowHeaderActions), provided by the sidebar. */
export const ALWAYS_SHOW_SECTION_ACTIONS: InjectionKey<Readonly<Ref<boolean>>> = Symbol('always-show-section-actions');

/** Each section's title, the locale key its header, its menu, its sashes' labels and the move announcements all read. */
export const SECTION_TITLES: Readonly<Record<SidebarSectionId, string>> = {
  projects: 'projects.heading',
  chats: 'chats.heading',
  files: 'files.heading',
  search: 'search.heading',
  repos: 'repositories.heading',
  scm: 'scm.heading',
};

// The data type a section header drag carries, so a section ignores file drags and drags from other windows.
export const SECTION_DRAG_MIME = 'application/x-damocles-sidebar-section';

/** Reordering the sidebar's sections, provided by the sidebar; a section mounted outside it cannot be moved. */
export interface SectionOrderController {
  // the section whose header is being dragged in this window
  readonly dragged: Ref<SidebarSectionId | null>;
  // CSS `order` of the section, so moving one never moves its DOM node (and its scroll, focus and list state)
  orderOf(name: SidebarSectionId): number;
  drop(moved: SidebarSectionId, target: SidebarSectionId, edge: DropEdge): void;
  openMenu(name: SidebarSectionId, anchor: { x: number; y: number; width: number; height: number }): Promise<void>;
}

export const SECTION_ORDER: InjectionKey<SectionOrderController> = Symbol('section-order');
