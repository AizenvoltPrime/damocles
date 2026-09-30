import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test';
import { attachDiagnostics, launchDesktop, type DesktopApp, type LaunchOptions } from './app';
import { createHermeticHome, type HermeticHome } from './hermetic';
import { shellState } from './shell';

export interface DesktopFixtures {
  home: HermeticHome;
  /** Launches the app on `home`; every launch is closed and its logs attached after the test. */
  launch: (options?: LaunchOptions) => Promise<DesktopApp>;
}

export const test = base.extend<DesktopFixtures>({
  // eslint-disable-next-line no-empty-pattern
  home: async ({}, use) => {
    const home = createHermeticHome();
    await use(home);
    home.dispose();
  },
  launch: async ({ home }, use, testInfo) => {
    const launched: DesktopApp[] = [];
    await use(async (options) => {
      const desktop = await launchDesktop(home, options);
      launched.push(desktop);
      await desktop.startTracing();
      return desktop;
    });
    const failed = testInfo.status !== testInfo.expectedStatus;
    // Every launch is closed even when an earlier step throws; home.dispose() cannot remove files a live app holds open.
    let firstError: { error: unknown } | undefined;
    const record = (error: unknown): void => {
      firstError ??= { error };
    };
    for (const [i, desktop] of launched.entries()) {
      await desktop.stopTracing(failed ? testInfo.outputPath(`trace-${i}.zip`) : undefined).catch(record);
      await desktop.close().catch(record);
      // After close, so the attached log also covers the shutdown.
      await attachDiagnostics(testInfo, `launch-${i}`, desktop, home).catch(record);
    }
    if (firstError) throw firstError.error;
  },
});

export { expect };

/** The first chat tab page (app://damocles/panel/<panelId>/index.html). */
export async function chatTab(app: ElectronApplication): Promise<Page> {
  const isTab = (p: Page): boolean => p.url().includes('/panel/');
  const existing = app.windows().find(isTab);
  if (existing) return existing;
  return app.waitForEvent('window', { predicate: isTab });
}

/** The panelId in a tab page URL. */
export function panelIdOf(page: Page): string {
  const match = /\/panel\/([^/]+)\//.exec(page.url());
  if (!match) throw new Error(`not a panel page: ${page.url()}`);
  return match[1]!;
}

/**
 * Resolves with the next chat tab that is not one of `known`. A browser page view loads the same /panel/<id>/ URL as a
 * chat tab, so the shell's tab list decides which new page is a tab.
 */
export async function nextTab(app: ElectronApplication, known: Page[]): Promise<Page> {
  const knownIds = new Set(known.flatMap((p) => /\/panel\/([^/]+)\//.exec(p.url())?.[1] ?? []));
  let opened: string | undefined;
  await expect.poll(async () => (opened = (await shellState(app)).tabs.map((t) => t.id).find((id) => !knownIds.has(id)))).toBeDefined();
  return tabById(app, opened!);
}

/** The chat tab for `panelId`, waiting for it to load if a relaunch has not restored it yet. */
export async function tabById(app: ElectronApplication, panelId: string): Promise<Page> {
  const matches = (p: Page): boolean => p.url().includes(`/panel/${panelId}/`);
  return app.windows().find(matches) ?? app.waitForEvent('window', { predicate: matches });
}
