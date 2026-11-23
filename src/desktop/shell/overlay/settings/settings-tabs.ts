// The look of a row of tabs inside Settings (the scope tabs, the gallery's Installed and Browse): muted text, the selected tab
// in full text, and an indicator under it that slides with the selection.
export const SETTINGS_TAB = 'relative h-8 min-w-0 flex-none gap-1.5 rounded-none border-0 bg-transparent px-3 text-xs font-medium text-(--d-muted) shadow-none transition-colors duration-150 hover:text-(--d-text) data-[state=active]:bg-transparent data-[state=active]:text-(--d-text) data-[state=active]:shadow-none [&_svg]:size-3';
export const SETTINGS_TAB_INDICATOR = '-bottom-px h-0.5 rounded-full bg-(--d-accent-fill) transition-transform duration-200 ease-out';
