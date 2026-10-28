import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { settled } from './screenshots';

/** An axe scan of `selector` on `page`, which must report no violation. */
export async function expectNoAxeViolations(page: Page, selector: string): Promise<void> {
  // contrast is measured on what is painted, so an entrance still fading in would read as low contrast
  await settled(page);
  // Electron has no context().newPage(), which axe's default frame aggregation opens; legacy mode scans in the page itself.
  const results = await new AxeBuilder({ page }).setLegacyMode().include(selector).analyze();
  expect(results.violations.map((violation) => ({ id: violation.id, help: violation.help, nodes: violation.nodes.map((node) => node.target.join(' ')) }))).toEqual([]);
}
