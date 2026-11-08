import type { DamoclesShellApi } from '../../preload/shell-channels';

/**
 * Moves keyboard focus into a page tab's native view (an HTML preview, a design preview, a browser page). Main answers false,
 * and focus stays where it is, while that view does not show. F6 and Shift+F6 in the page leave it through main's part order.
 */
export async function enterPage(api: Pick<DamoclesShellApi, 'focusPage'>, tabId: string): Promise<boolean> {
  const entered = await api.focusPage({ tabId });
  // The shell page refocuses its active element when main gives it focus back; a page stand-in would enter the page again.
  if (entered && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  return entered;
}

/** An editor tab's own tab in the strip. */
export function editorTabElement(tabId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-editor-tab][data-tab-id="${CSS.escape(tabId)}"]`);
}
