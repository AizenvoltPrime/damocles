import { ref } from 'vue';

const rootFontPx = ref(16);
let probe: HTMLElement | null = null;
const spacingRemPx = ref(16);
let spacingProbe: HTMLElement | null = null;

// Tailwind's --spacing is 0.25rem times the theme's density (style.css), so 4 of it is one density-scaled rem.
function observeSpacing(): void {
  if (spacingProbe) return;
  spacingProbe = document.createElement('div');
  spacingProbe.setAttribute('aria-hidden', 'true');
  spacingProbe.style.cssText = 'position:absolute;width:calc(var(--spacing, 0.25rem) * 4);height:0;visibility:hidden;pointer-events:none';
  document.body.append(spacingProbe);
  spacingRemPx.value = spacingProbe.getBoundingClientRect().width || 16;
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(([entry]) => {
    if (entry && entry.contentRect.width > 0) spacingRemPx.value = entry.contentRect.width;
  }).observe(spacingProbe);
}

/** `rem` in px at the current root font size and the theme's density, as a Tailwind spacing utility of that size. Reactive. */
export function spacedRemPx(rem: number): number {
  observeSpacing();
  return rem * spacingRemPx.value;
}

// The root font size follows the host font (style.css) and changes live, and no event reports a computed-style
// change, so a 1rem-wide probe's resize is what tells the reactive value to follow.
function observeRootFont(): void {
  if (probe) return;
  probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;width:1rem;height:0;visibility:hidden;pointer-events:none';
  document.body.append(probe);
  rootFontPx.value = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(([entry]) => {
    if (entry && entry.contentRect.width > 0) rootFontPx.value = entry.contentRect.width;
  }).observe(probe);
}

/**
 * `rem` in px at the current root font size, for APIs that take px numbers (popper offsets). Reactive: a render or
 * computed that calls it runs again when the host font changes.
 */
export function remPx(rem: number): number {
  observeRootFont();
  return rem * rootFontPx.value;
}
