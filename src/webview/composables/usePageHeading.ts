import { inject, provide, type InjectionKey } from 'vue';

/** The page's heading, focusable with `tabindex="-1"`, that a strip hands focus to when its last focused control goes away. */
export type PageHeading = () => HTMLElement | null | undefined;

export const PAGE_HEADING_KEY: InjectionKey<PageHeading> = Symbol('pageHeading');

// Every page that shows the update strip provides its heading; a missing provider is a Vue warning, never a silent no-op.
export function providePageHeading(heading: PageHeading): void {
  provide(PAGE_HEADING_KEY, heading);
}

export function injectPageHeading(): PageHeading | undefined {
  return inject(PAGE_HEADING_KEY);
}
