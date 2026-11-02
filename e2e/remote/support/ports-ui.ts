import type { Locator, Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../desktop/support/axe';
import { expect } from './remote';

// The sidebar's Ports section of the selected remote project (en locale).

export const portsSection = (shell: Page): Locator => shell.getByTestId('ports-section');
export const portRows = (shell: Page): Locator => portsSection(shell).getByTestId('port-row');
/** The row of a forward or listener on `host:port` of the target, keyed as main keys it (a loopback port's row is `localhost`). */
export const portRow = (shell: Page, port: number, host = 'localhost'): Locator =>
  portsSection(shell).locator(`[data-testid="port-row"][data-key="${host.includes(':') ? `[${host}]` : host}:${port}"]`);
/** A row's "5173 → localhost:5174" line. */
export const portMapping = (row: Locator): Locator => row.getByTestId('port-mapping');

/**
 * Scans the Ports section with axe, which must report no violation: once at rest, and once with the first row focused, so
 * its action buttons are shown and scanned too.
 */
export async function expectPortsSectionAccessible(shell: Page): Promise<void> {
  await expect(portsSection(shell)).toBeVisible();
  await expectNoAxeViolations(shell, '[data-testid="ports-section"]');
  if ((await portRows(shell).count()) === 0) return;
  const first = portRows(shell).first();
  await first.focus();
  // the buttons fade in; scanning mid-fade would judge their contrast at partial opacity
  await expect(first.getByTestId('port-actions')).toHaveCSS('opacity', '1');
  await expectNoAxeViolations(shell, '[data-testid="ports-section"]');
}
