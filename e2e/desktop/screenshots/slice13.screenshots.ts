import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test';
import { expect, IPC_HANDLER_ERROR_ANNOTATION, test } from '../support/fixtures';
import { SCM_CHANNELS } from '../../../src/desktop/preload/scm-channels';
import { git, initRepo, type GitHome } from '../support/git';
import { menuItem, overlayMenu } from '../support/overlay';
import { bareRepo, setSection } from '../support/scm';
import { dismiss, openProjectChat, saveScreenshot, setFont, setReducedMotion, settled, shot, showShellTheme, showTheme, THEMES, windowShot, type Theme } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { overlayPage, shellPage } from '../support/shell';
import { clickSectionAction } from '../support/shell-ui';
import { addProject, chatInput } from '../support/ui';

// Review captures of the Graph (slice 13): Dark and Light, the 13px default and a 16px host font, narrow and wide sidebars,
// 125% and 150% zoom of the lanes, and a reduced-motion pass. Names are listed in the frontend scratchpad section.
const WIDTH = 1440;
const HEIGHT = 900;
const FONTS = [13, 16] as const;
const MINUTE = 60_000;
const HOOKS = { DAMOCLES_E2E_HOOKS: '1' };

interface HistoryHold {
  release(): void;
  fail(): void;
}
type HookGlobals = typeof globalThis & { __damoclesE2e?: { scm: { holdHistory(): HistoryHold } }; __e2eHistoryHold?: HistoryHold };

/** Holds every Graph history answer in main from now until releaseHistory or failHistory. */
async function holdHistory(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const globals = globalThis as HookGlobals;
    globals.__e2eHistoryHold = globals.__damoclesE2e!.scm.holdHistory();
  });
}

const releaseHistory = (app: ElectronApplication): Promise<void> => app.evaluate(() => (globalThis as HookGlobals).__e2eHistoryHold!.release());
/** Rejects the held answers, which main logs as a handler error; the test names the channel so the fixture expects it. */
async function failHistory(app: ElectronApplication): Promise<void> {
  test.info().annotations.push({ type: IPC_HANDLER_ERROR_ANNOTATION, description: SCM_CHANNELS.history });
  await app.evaluate(() => (globalThis as HookGlobals).__e2eHistoryHold!.fail());
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(1_200_000);

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
const graph = (shell: Page): Locator => shell.getByTestId('graph-section');
const tree = (shell: Page): Locator => graph(shell).getByTestId('graph-tree');
const row = (shell: Page, subject: string): Locator => graph(shell).getByTestId('graph-row').filter({ has: shell.getByTestId('graph-subject').getByText(subject, { exact: true }) });
const header = (shell: Page): Locator => graph(shell).getByTestId('sidebar-section-header');

async function commitAt(h: GitHome, dir: string, file: string, message: string, ago: number, author = ADA): Promise<void> {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `${message}\n${Math.random()}\n`);
  await git(h, dir, 'add', '-A');
  const date = new Date(Date.now() - ago).toISOString();
  await git(h, dir, { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email } }, 'commit', '--quiet', '-m', message);
}

/**
 * acme: origin/main with a merged feature and a tag; HEAD on feat/rate-limit, created from origin/main without tracking it (its
 * base) and published (its upstream), one commit ahead of its upstream, which has two more of its own.
 */
async function seed(h: GitHome): Promise<{ project: string; bare: string }> {
  const bare = await bareRepo(h, path.join(h.root, 'served'), 'acme');
  const project = path.join(h.root, 'acme');
  await git(h, h.root, 'clone', '--quiet', bare, project);
  for (const [key, value] of [['user.name', ADA.name], ['user.email', ADA.email]]) await git(h, project, 'config', key!, value!);
  const KOSTAS = { name: 'Kostas Papadopoulos', email: 'kostas@example.com' };
  const MARIA = { name: 'Maria', email: 'maria@example.com' };
  await commitAt(h, project, 'src/health.ts', 'Health check endpoint', 5 * 24 * 60 * MINUTE, KOSTAS);
  await git(h, project, 'tag', 'v1.2.0');
  await commitAt(h, project, 'src/express.ts', 'Express 5 compatibility shims', 3 * 24 * 60 * MINUTE, KOSTAS);
  await git(h, project, 'switch', '--quiet', '-c', 'feat/users-docs');
  await commitAt(h, project, 'docs/users.md', 'Document the /users endpoints', 2 * 24 * 60 * MINUTE, MARIA);
  await commitAt(h, project, 'package.json', 'Bump zod to 3.23', 30 * 60 * MINUTE, MARIA);
  await git(h, project, 'switch', '--quiet', 'main');
  await commitAt(h, project, 'src/orders.ts', 'Fix N+1 in orders query', 26 * 60 * MINUTE, KOSTAS);
  const date = new Date(Date.now() - 5 * 60 * MINUTE).toISOString();
  await git(h, project, { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }, 'merge', '--quiet', '--no-ff', '-m', "Merge branch 'feat/users-docs'", 'feat/users-docs');
  await git(h, project, 'push', '--quiet', 'origin', 'main', 'feat/users-docs', 'v1.2.0');
  await git(h, project, 'switch', '--quiet', '--no-track', '-c', 'feat/rate-limit', 'origin/main');
  await commitAt(h, project, 'src/limits.ts', 'Add rate limiting to POST /login', 3 * 60 * MINUTE);
  await git(h, project, 'push', '--quiet', '-u', 'origin', 'feat/rate-limit');
  // two commits a teammate pushed to feat/rate-limit, and one of ours not pushed yet
  const other = path.join(h.root, 'other');
  await git(h, h.root, 'clone', '--quiet', bare, other);
  await git(h, other, 'switch', '--quiet', 'feat/rate-limit');
  await commitAt(h, other, 'src/limits.test.ts', 'Cover the 429 response', 90 * MINUTE, KOSTAS);
  await commitAt(h, other, 'src/limits.ts', 'Use draft-7 rate limit headers', 60 * MINUTE, KOSTAS);
  await git(h, other, 'push', '--quiet', 'origin', 'feat/rate-limit');
  await commitAt(h, project, 'src/app.ts', 'Add request id to logger', 20 * MINUTE);
  await git(h, project, 'fetch', '--quiet', 'origin');
  await git(h, project, 'commit', '--quiet', '--allow-empty', '-m', 'Return 401 for an empty session cookie and log the request id with every rejected login attempt so support can trace it');
  return { project, bare };
}

/** The shell page's zoom, as Ctrl+= sets it. */
async function zoom(app: ElectronApplication, factor: number): Promise<void> {
  await app.evaluate(({ webContents }, value) => {
    for (const contents of webContents.getAllWebContents()) if (contents.getURL().includes('/shell/')) contents.setZoomFactor(value);
  }, factor);
}

/** Holds every running `name` animation `at` ms in, so a capture shows that frame. */
async function freeze(page: Page, name: string, at: number): Promise<number> {
  return page.evaluate(([animation, time]) => {
    const found = document.getAnimations().filter((each) => each instanceof CSSAnimation && each.animationName === animation);
    for (const each of found) {
      each.pause();
      each.currentTime = time;
    }
    return found.length;
  }, [name, at] as const);
}

/**
 * Saves `target` while the shell is zoomed by `factor`: Playwright places an element by the unzoomed page, so the clip is the
 * element's zoomed rect scaled back by the factor.
 */
async function zoomedShot(page: Page, testInfo: TestInfo, name: string, target: Locator, factor: number): Promise<void> {
  await settled(page);
  const box = await target.evaluate((element) => {
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    const top = Math.max(0, rect.top);
    return { x: Math.max(0, rect.left), y: top, width: Math.min(rect.right, innerWidth) - Math.max(0, rect.left), height: Math.min(rect.bottom, innerHeight) - top };
  });
  const file = path.join(process.env['DAMOCLES_SCREENSHOT_DIR'] ?? testInfo.outputDir, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: box.x * factor, y: box.y * factor, width: box.width * factor, height: box.height * factor } });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

async function settle(app: ElectronApplication): Promise<void> {
  await settled(await shellPage(app));
  await settled(await overlayPage(app));
}

/** Moves the sidebar's edge to `px` CSS px from the window's left. */
async function sidebarTo(shell: Page, px: number): Promise<void> {
  const sash = (await shell.getByTestId('sidebar-sash').boundingBox())!;
  await shell.mouse.move(sash.x + sash.width / 2, sash.y + 40);
  await shell.mouse.down();
  await shell.mouse.move(px, sash.y + 40, { steps: 6 });
  await shell.mouse.up();
  await settled(shell);
}

test('slice 13 chat captures: the commit menu\'s chat group, and the composer with commit chips and the Explain prompt', async ({ foreground: _foreground, home, launch }, testInfo) => {
  const { project } = await seed(home);
  const { app } = await launch();
  await setContentSize(app, WIDTH, HEIGHT);
  const tab = await openProjectChat(app, project);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  for (const id of ['sidebar-projects', 'sidebar-chats', 'files-section', 'scm-section']) await setSection(shell, id, false);
  await setSection(shell, 'graph-section', true);
  await expect(tree(shell)).toBeVisible({ timeout: 30_000 });
  await sidebarTo(shell, 320);
  const LONG = 'Return 401 for an empty session cookie and log the request id with every rejected login attempt so support can trace it';
  const pick = async (subject: string, item: string): Promise<void> => {
    await row(shell, subject).getByTestId('graph-subject').click({ button: 'right' });
    await expect(overlayMenu(overlay)).toBeVisible();
    await menuItem(overlay, item).click();
    await expect(overlayMenu(overlay)).toHaveCount(0);
  };

  for (const theme of THEMES) {
    await showTheme(app, tab, theme);
    await showShellTheme(app, theme);
    await shell.mouse.move(1, 1);
    await row(shell, 'Fix N+1 in orders query').getByTestId('graph-subject').click({ button: 'right' });
    await expect(overlayMenu(overlay)).toBeVisible();
    await windowShot(app, testInfo, `graph-chat-menu-${theme}`);
    await saveScreenshot(overlay, testInfo, `graph-chat-menu-panel-${theme}`, overlayMenu(overlay));
    await dismiss(app, overlay, overlayMenu(overlay));
  }

  await pick(LONG, 'addCommitToChat');
  await expect(tab.getByTestId('composer').getByTestId('commit-attachment-chip')).toHaveCount(1);
  await chatInput(tab).fill('Also check the query plan.');
  await pick('Fix N+1 in orders query', 'explainCommit');
  await expect(tab.getByTestId('composer').getByTestId('commit-attachment-chip')).toHaveCount(2);
  await expect(chatInput(tab)).toHaveValue('Also check the query plan.\nExplain the changes in this commit.');
  for (const theme of THEMES) {
    await showTheme(app, tab, theme);
    await showShellTheme(app, theme);
    await shot(tab, testInfo, `graph-chat-composer-${theme}`, tab.getByTestId('composer'));
    await windowShot(app, testInfo, `graph-chat-window-${theme}`);
  }
});

test('slice 13 captures', async ({ foreground: _foreground, home, launch }, testInfo) => {
  const { project } = await seed(home);
  const empty = path.join(home.root, 'fresh');
  fs.mkdirSync(empty, { recursive: true });
  await git(home, empty, 'init', '-b', 'main');
  const untrusted = path.join(home.root, 'stranger');
  await initRepo(home, untrusted);

  const { app } = await launch({ env: HOOKS });
  await setContentSize(app, WIDTH, HEIGHT);
  await openProjectChat(app, project);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  for (const id of ['sidebar-projects', 'sidebar-chats', 'files-section', 'scm-section']) await setSection(shell, id, false);
  await setSection(shell, 'graph-section', true);
  await expect(tree(shell)).toBeVisible({ timeout: 30_000 });
  await sidebarTo(shell, 320);

  const pass = async (theme: Theme, font: number): Promise<void> => {
    await showShellTheme(app, theme);
    await setFont(app, font);
    const t = (name: string): string => `graph-${name}-${theme}-${font}`;
    await tree(shell).evaluate((element) => element.scrollTo({ top: 0 }));
    // no pointer over a row and no row focused, so the resting rows show
    await shell.mouse.move(1, 1);
    await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await shot(shell, testInfo, t('rows'), graph(shell));
    await shot(shell, testInfo, t('header'), header(shell));

    // hover: the side branch's commit lights its lane
    await row(shell, 'Bump zod to 3.23').hover();
    await shot(shell, testInfo, t('hover'), graph(shell));
    await shell.mouse.move(1, 1);

    // the commit menu and the badge menu
    const head = graph(shell).locator('[data-testid="graph-row"][data-kind="head"]');
    await row(shell, 'Fix N+1 in orders query').getByTestId('graph-subject').click({ button: 'right' });
    await expect(overlayMenu(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('context-menu'));
    await dismiss(app, overlay, overlayMenu(overlay));
    await head.locator('[data-testid="graph-badge"]').first().click({ button: 'right' });
    await expect(overlayMenu(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('badge-menu'));
    await dismiss(app, overlay, overlayMenu(overlay));

    // keyboard focus on a row, then on HEAD's filled badge
    await head.focus();
    await shell.keyboard.press('ArrowDown');
    await shot(shell, testInfo, t('focus-row'), graph(shell));
    await head.focus();
    await shell.keyboard.press('Tab');
    await shot(shell, testInfo, t('focus-badge'), graph(shell));
    await shell.mouse.move(1, 1);

    // expanded: the long one-line message, its meta, stat and files
    const LONG = 'Return 401 for an empty session cookie and log the request id with every rejected login attempt so support can trace it';
    await row(shell, LONG).getByTestId('graph-subject').click();
    await row(shell, "Merge branch 'feat/users-docs'").getByTestId('graph-subject').click();
    await expect(graph(shell).locator('[data-testid="graph-detail"][data-kind="file"]').first()).toBeVisible();
    await expect(graph(shell).locator('[data-testid="graph-detail"][data-kind="message"]')).toHaveCount(2);
    await shell.mouse.move(1, 1);
    await shot(shell, testInfo, t('expanded'), graph(shell));
    for (const subject of [LONG, "Merge branch 'feat/users-docs'"]) await row(shell, subject).getByTestId('graph-subject').click();

    // the ref picker with a filter typed and two refs checked
    await graph(shell).getByTestId('graph-ref-chip').click();
    const picker = overlay.getByTestId('graph-ref-picker');
    await expect(picker).toBeVisible();
    await picker.locator('[data-item="refs/heads/main"]').click();
    await picker.locator('[data-item="refs/heads/feat/users-docs"]').click();
    await picker.getByTestId('graph-ref-filter').fill('feat');
    await settle(app);
    await windowShot(app, testInfo, t('refpicker'));
    await saveScreenshot(overlay, testInfo, t('refpicker-panel'), picker);
    await dismiss(app, overlay, picker);
  };

  for (const theme of THEMES) for (const font of FONTS) await pass(theme, font);
  await showShellTheme(app, 'dark');
  await setFont(app, 13);

  // the chip's four states
  const choose = async (items: readonly string[]): Promise<void> => {
    await graph(shell).getByTestId('graph-ref-chip').click();
    const picker = overlay.getByTestId('graph-ref-picker');
    await expect(picker).toBeVisible();
    for (const item of items) await picker.locator(`[data-item="${item}"]`).click();
    await picker.getByTestId('graph-ref-ok').click();
    await expect(picker).toHaveCount(0);
    await settled(shell);
  };
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await shot(shell, testInfo, `graph-chip-auto-${theme}`, header(shell));
    await choose(['all']);
    await shot(shell, testInfo, `graph-chip-all-${theme}`, header(shell));
    await shot(shell, testInfo, `graph-all-${theme}`, graph(shell));
    await choose(['refs/heads/main']);
    await shot(shell, testInfo, `graph-chip-one-${theme}`, header(shell));
    await choose(['refs/heads/feat/rate-limit', 'refs/remotes/origin/feat/rate-limit']);
    await shot(shell, testInfo, `graph-chip-refs-${theme}`, header(shell));
    await choose(['auto']);
  }
  await showShellTheme(app, 'dark');

  // 125% and 150%: the whole section with an expanded merge, the lanes on whole device pixels
  const merge = row(shell, "Merge branch 'feat/users-docs'");
  await merge.getByTestId('graph-subject').click();
  for (const factor of [1.25, 1.5]) {
    await zoom(app, factor);
    await settled(shell);
    await shell.mouse.move(1, 1);
    await zoomedShot(shell, testInfo, `graph-scale-${Math.round(factor * 100)}-dark`, graph(shell), factor);
  }
  await zoom(app, 1);
  await merge.getByTestId('graph-subject').click();

  // incoming and outgoing rows, then the Outdated badge after a background change while scrolled down
  await shot(shell, testInfo, 'graph-incoming-outgoing-dark-13', graph(shell));
  await showShellTheme(app, 'light');
  await shot(shell, testInfo, 'graph-incoming-outgoing-light-13', graph(shell));
  await showShellTheme(app, 'dark');
  await commitAt(home, project, 'many/a.txt', 'Filler', MINUTE);
  for (let i = 0; i < 30; i++) await git(home, project, 'commit', '--quiet', '--allow-empty', '-m', `Filler ${i}`);
  await clickSectionAction(shell, 'graph-refresh');
  await expect(row(shell, 'Filler 29')).toBeVisible();
  // every reload the outside commits caused has landed (each shows the top again) before the list scrolls
  await expect(graph(shell).getByTestId('graph-tree')).not.toHaveAttribute('aria-busy', 'true');
  await settled(shell);
  await tree(shell).hover();
  await shell.mouse.wheel(0, 400);
  await expect.poll(() => tree(shell).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await git(home, project, 'tag', 'outside-change');
  await expect(graph(shell).getByTestId('graph-outdated')).toBeVisible({ timeout: 30_000 });
  await shot(shell, testInfo, 'graph-outdated-dark-13', header(shell));
  await showShellTheme(app, 'light');
  await shot(shell, testInfo, 'graph-outdated-light-13', header(shell));
  await showShellTheme(app, 'dark');
  await tree(shell).hover();
  await shell.mouse.wheel(0, -4000);
  await expect(graph(shell).getByTestId('graph-outdated')).toHaveCount(0);

  // narrow (the sidebar's minimum) and wide sidebars
  for (const [name, px] of [['narrow', 0], ['wide', 520]] as const) {
    await sidebarTo(shell, px);
    for (const theme of THEMES) {
      await showShellTheme(app, theme);
      await shot(shell, testInfo, `graph-${name}-${theme}`, graph(shell));
    }
  }
  await sidebarTo(shell, 320);
  await showShellTheme(app, 'dark');

  // reduced motion: right after an expand, and right after a refresh that brings a new commit
  await commitAt(home, project, 'src/reduced.ts', 'Expand under reduced motion', 0);
  await clickSectionAction(shell, 'graph-refresh');
  await expect(row(shell, 'Expand under reduced motion')).toBeVisible();
  await expect(graph(shell).getByTestId('graph-tree')).not.toHaveAttribute('aria-busy', 'true');
  await settled(shell);
  await setReducedMotion(app, true);
  await row(shell, 'Expand under reduced motion').getByTestId('graph-subject').click();
  await expect(graph(shell).locator('[data-testid="graph-detail"][data-kind="file"]')).toBeVisible();
  await saveScreenshot(shell, testInfo, 'graph-reduced-expand-dark', graph(shell));
  await row(shell, 'Expand under reduced motion').getByTestId('graph-subject').click();
  await git(home, project, 'commit', '--quiet', '--allow-empty', '-m', 'Arrives after a refresh');
  await clickSectionAction(shell, 'graph-refresh');
  await expect(row(shell, 'Arrives after a refresh')).toBeVisible();
  await saveScreenshot(shell, testInfo, 'graph-reduced-arrival-dark', graph(shell));
  await setReducedMotion(app, false);

  // a live arrival held mid-animation, with motion
  await git(home, project, 'commit', '--quiet', '--allow-empty', '-m', 'Arrives with motion');
  await clickSectionAction(shell, 'graph-refresh');
  await expect(row(shell, 'Arrives with motion')).toBeVisible();
  await freeze(shell, 'o-up', 120);
  await saveScreenshot(shell, testInfo, 'graph-arrival-midway-dark', graph(shell));
  await settled(shell);

  // HEAD moved: its node's halo held 250ms in, centred on the node
  await settled(shell);
  await git(home, project, 'commit', '--quiet', '--allow-empty', '-m', 'Moves HEAD');
  await expect(row(shell, 'Moves HEAD')).toBeVisible();
  await expect(graph(shell).getByTestId('graph-halo')).toHaveCount(1);
  expect(await freeze(shell, 'd-ring', 250)).toBe(1);
  await saveScreenshot(shell, testInfo, 'graph-halo-midway-dark', row(shell, 'Moves HEAD'));
  await settled(shell);

  // the Go to Current flash held mid-way
  await clickSectionAction(shell, 'graph-go-to-current');
  await freeze(shell, 'd-flash', 300);
  await saveScreenshot(shell, testInfo, 'graph-flash-midway-dark', graph(shell));
  await settled(shell);

  // a page read that failed: the list ends in a row that reads it again
  for (let i = 0; i < 60; i++) await git(home, project, 'commit', '--quiet', '--allow-empty', '-m', `Page filler ${i}`);
  await clickSectionAction(shell, 'graph-refresh');
  await expect(row(shell, 'Page filler 59')).toBeVisible();
  await expect(graph(shell).getByTestId('graph-tree')).not.toHaveAttribute('aria-busy', 'true');
  await holdHistory(app);
  await tree(shell).evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(graph(shell).locator('[data-testid="graph-more"][data-state="loading"]')).toBeVisible();
  await failHistory(app);
  const failedRow = graph(shell).locator('[data-testid="graph-more"][data-state="failed"]');
  await expect(failedRow).toBeVisible();
  await tree(shell).evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await shell.mouse.move(1, 1);
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await settled(shell);
    await saveScreenshot(shell, testInfo, `graph-more-failed-${theme}`, graph(shell));
  }
  // reached from the rows with End, as the keyboard reaches it
  await graph(shell).getByTestId('graph-row').last().focus();
  await shell.keyboard.press('End');
  await expect(failedRow).toBeFocused();
  await saveScreenshot(shell, testInfo, 'graph-more-failed-focus-light', graph(shell));
  await showShellTheme(app, 'dark');
  await holdHistory(app);
  await releaseHistory(app);
  await failedRow.getByTestId('graph-more-retry').click();
  await expect(failedRow).toHaveCount(0);
  await tree(shell).evaluate((element) => element.scrollTo({ top: 0 }));

  // the ref picker's notes, which the shell adds when a group of refs failed to load and when refs were left out
  await shell.evaluate(() => {
    void window.damoclesShell!.requestOverlay({
      kind: 'refPicker',
      anchor: { x: 60, y: 40, width: 60, height: 20 },
      refs: [{ id: 'refs/heads/main', name: 'main' }, { id: 'refs/heads/feat/rate-limit', name: 'feat/rate-limit' }, { id: 'refs/tags/v1.2.0', name: 'v1.2.0' }],
      selected: 'auto',
      failed: true,
      omitted: 1234,
    });
  });
  const notesPicker = overlay.getByTestId('graph-ref-picker');
  await expect(notesPicker.getByTestId('graph-ref-omitted')).toBeVisible();
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await settle(app);
    await saveScreenshot(overlay, testInfo, `graph-refpicker-notes-${theme}`, notesPicker);
  }
  await dismiss(app, overlay, notesPicker);
  await showShellTheme(app, 'dark');

  // the skeleton: main's first page held, on a project not loaded yet, until both captures are taken
  await holdHistory(app);
  const second = path.join(home.root, 'second');
  await initRepo(home, second);
  await openProjectChat(app, second);
  for (const id of ['sidebar-projects', 'sidebar-chats', 'files-section', 'scm-section']) await setSection(shell, id, false);
  await setSection(shell, 'graph-section', true);
  await expect(graph(shell).getByTestId('graph-skeleton')).toBeVisible();
  await settled(shell);
  await saveScreenshot(shell, testInfo, 'graph-skeleton-dark', graph(shell));
  await showShellTheme(app, 'light');
  await saveScreenshot(shell, testInfo, 'graph-skeleton-light', graph(shell));
  await showShellTheme(app, 'dark');
  await releaseHistory(app);
  await expect(tree(shell)).toBeVisible({ timeout: 30_000 });

  // the empty and untrusted states
  await openProjectChat(app, empty);
  await expect(graph(shell).getByTestId('graph-state')).toBeVisible({ timeout: 30_000 });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await shot(shell, testInfo, `graph-empty-${theme}`, graph(shell));
  }
  await addProject(app, untrusted, false);
  await expect(graph(shell).getByTestId('scm-state')).toBeVisible({ timeout: 30_000 });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await shot(shell, testInfo, `graph-untrusted-${theme}`, graph(shell));
  }
});
