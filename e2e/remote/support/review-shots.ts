import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { REPO_ROOT } from '../../desktop/support/hermetic';
import { setReducedMotion, showShellTheme, THEMES } from '../../desktop/support/screenshots';

// Review captures for a visual check, written only to a folder outside the repository, whose test-results/ is not ignored.
export const REMOTE_SHOTS: string | undefined = process.env['DAMOCLES_REMOTE_SHOTS'];

/** Whether folder lies outside the repository, as an absolute path. */
export function outsideRepository(folder: string): boolean {
  const relative = path.relative(REPO_ROOT, path.resolve(folder));
  return path.isAbsolute(folder) && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

/** Captures `name` in dark, in light, and in dark with reduced motion, when review captures are asked for. */
export async function shootThemes(app: ElectronApplication, page: Page, name: string, target?: Locator): Promise<void> {
  if (REMOTE_SHOTS === undefined) return;
  if (!outsideRepository(REMOTE_SHOTS)) throw new Error(`DAMOCLES_REMOTE_SHOTS must name an absolute folder outside the repository, not ${REMOTE_SHOTS}`);
  fs.mkdirSync(REMOTE_SHOTS, { recursive: true });
  const shoot = (variant: string): Promise<Buffer> => (target ?? page).screenshot({ path: path.join(REMOTE_SHOTS, `${name}-${variant}.png`), animations: 'disabled' });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await shoot(theme);
  }
  await showShellTheme(app, 'dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setReducedMotion(app, true);
  await shoot('reduced-motion');
  await page.emulateMedia({ reducedMotion: null });
  await setReducedMotion(app, false);
}
