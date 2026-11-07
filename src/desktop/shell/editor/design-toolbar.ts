// A ghost button of the preview tab's toolbars. A button whose request is in flight is aria-disabled, never disabled, so it
// keeps focus; its handler refuses the click.
export const TOOLBAR_BUTTON = 'd-press h-6.5 gap-1.5 rounded-7 px-2 text-12 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 aria-disabled:cursor-default aria-disabled:opacity-(--d-opacity-disabled) aria-disabled:hover:bg-transparent aria-disabled:hover:text-(--d-muted) [&_svg]:size-3.5';
