// The design header's file list and the screens menu: the header menus' box, with rows sized for file paths. A status row
// (loading, failed, empty) is a disabled item that keeps its own color, so its text keeps its token's contrast.
export { MENU_CONTENT as DESIGN_MENU_CONTENT } from '../chat-header/menuStyles';
export const DESIGN_MENU_LABEL = 'px-2 pt-1 pb-1.5 text-10.5 font-normal text-(--d-faint-text)';
export const DESIGN_MENU_ITEM = 'gap-2 rounded-7 px-2 py-1 text-xs text-(--d-text) focus:bg-(--d-hover) focus:text-(--d-text) [&>svg]:size-3';
export const DESIGN_MENU_STATUS = 'rounded-7 px-2 py-1.5 text-xs text-(--d-muted) data-disabled:opacity-100';
