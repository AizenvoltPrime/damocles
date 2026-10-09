import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { activeChat, nextChat } from './fixtures';
import { captureWindow, pageFramesShown } from './browser';
import { REPO_ROOT } from './hermetic';
import { shellState } from './shell';
import { addProject, chatInput, setThemeSource } from './ui';

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

// CSS px of the chat page in the captures `shoot` and `shootReferences` take.
const CAPTURE_WIDTHS = [900, 480] as const;
const CAPTURE_HEIGHT = 820;
// Untracked; the proto-* captures need it, and the network for the React and icons it loads.
const REFERENCE_DIR = path.join(REPO_ROOT, 'Damocles desktop UI revamp', 'export', 'damocles-revamp');

// DAMOCLES_SCREENSHOT_DIR, which Playwright never wipes, else the test's own output folder.
function screenshotFile(testInfo: TestInfo, name: string): string {
  const dir = process.env.DAMOCLES_SCREENSHOT_DIR;
  const file = dir ? path.join(dir, `${name}.png`) : testInfo.outputPath(`${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** Saves a PNG of the page or an element for visual review and attaches it to the report. */
export async function saveScreenshot(page: Page, testInfo: TestInfo, name: string, element?: Locator): Promise<string> {
  const file = screenshotFile(testInfo, name);
  await (element ?? page).screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
  return file;
}

/** Saves a PNG of the whole window with its native views (captureWindow) and attaches it to the report. */
export async function saveWindowScreenshot(app: ElectronApplication, testInfo: TestInfo, name: string): Promise<string> {
  const file = screenshotFile(testInfo, name);
  await captureWindow(app, file);
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
  return file;
}

/** Resolves once `page` has its fonts, has painted twice, and every finite animation and transition on it has finished. */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await document.fonts.ready;
    await frame();
    await frame();
    // A spinner or a pulse runs forever, so only animations with an end are awaited; a toast's life bar is a countdown
    // that ends with the toast, not an entrance.
    const finite = document.getAnimations().filter((animation) => animation.playState === 'running'
      && animation.effect?.getComputedTiming().endTime !== Infinity
      && !(animation instanceof CSSAnimation && animation.animationName === 'nt-life'));
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    await frame();
  });
}

/** Switches the app to `theme` and waits until `page` shows it. */
export async function showTheme(app: ElectronApplication, page: Page, theme: Theme): Promise<void> {
  await setThemeSource(app, theme);
  await expect(page.locator('body')).toHaveAttribute('data-vscode-theme-kind', `vscode-${theme}`);
  await settled(page);
}

/**
 * Resolves once every visible Damocles page (shell, overlay, chat views) shows `theme` when given and has settled, and
 * every visible browser page view shows a screencast frame. A hidden page is skipped: it paints no frames to wait for.
 */
export async function windowSettled(app: ElectronApplication, theme?: Theme): Promise<void> {
  for (const page of app.windows()) {
    if (!page.url().startsWith('app://') || await page.evaluate(() => document.visibilityState) !== 'visible') continue;
    if (theme) await expect(page.locator('body')).toHaveAttribute('data-vscode-theme-kind', `vscode-${theme}`);
    await settled(page);
  }
  await pageFramesShown(app);
}

/** Captures the whole window to `<dir>/<name>-<theme>.png` in each theme, once every visible page has settled in it. */
export async function captureThemes(app: ElectronApplication, dir: string, name: string): Promise<void> {
  for (const theme of THEMES) {
    await setThemeSource(app, theme);
    await windowSettled(app, theme);
    await captureWindow(app, path.join(dir, `${name}-${theme}.png`));
  }
}

/** Emulates a `width`×`height` CSS px viewport on `page` and waits until it has laid out at that size. */
export async function setPageSize(page: Page, width: number, height: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [width, height] as const);
  await settled(page);
}

/**
 * Adds `dir` as a trusted project and returns the new chat it opens, whose files the overlays list. The launch's empty
 * chat can be selected for a moment before main unloads it, so only another chat counts.
 */
export async function openProjectChat(app: ElectronApplication, dir: string): Promise<Page> {
  const first = await activeChat(app);
  await expect(chatInput(first)).toBeVisible();
  const opened = nextChat(app, [first]);
  await addProject(app, dir, true);
  const tab = await opened;
  await expect.poll(async () => {
    const state = await shellState(app);
    return state.projects.find((project) => project.fsPath === dir)?.key === state.selected.projectKey;
  }).toBe(true);
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

/** Delivers one host message to the chat page the way core does, for states the stub model cannot reach on its own. */
export async function hostMessage(app: ElectronApplication, tab: Page, message: Record<string, unknown>): Promise<void> {
  const url = tab.url();
  await app.evaluate(({ webContents }, [pageUrl, payload]) => {
    const target = webContents.getAllWebContents().find((wc) => wc.getURL() === pageUrl);
    if (!target) throw new Error(`no chat page at ${pageUrl}`);
    target.send('damocles:panel:message', payload);
  }, [url, message] as const);
}

/** Captures the chat page as `<name>-<theme>-<width>` in both themes at both widths; `prepare` runs after each resize. */
export async function shoot(app: ElectronApplication, tab: Page, testInfo: TestInfo, name: string, prepare?: () => Promise<void>): Promise<void> {
  for (const theme of THEMES) {
    await showTheme(app, tab, theme);
    for (const width of CAPTURE_WIDTHS) {
      await setPageSize(tab, width, CAPTURE_HEIGHT);
      await prepare?.();
      await settled(tab);
      await saveScreenshot(tab, testInfo, `${name}-${theme}-${width}`);
    }
  }
  await showTheme(app, tab, 'dark');
  await setPageSize(tab, CAPTURE_WIDTHS[0], CAPTURE_HEIGHT);
}

export interface ReferenceCapture {
  readonly name: string;
  // a function body run over the template's `logic` instance
  readonly setup: string;
  // runs on the reference page before each capture
  readonly focus?: (page: Page) => Promise<void>;
}

/**
 * Captures each reference state as `proto-<name>-<theme>-<width>`, in both themes at both widths, every run. Without the
 * reference folder the captures are skipped and the test says so in an annotation.
 */
export async function shootReferences(app: ElectronApplication, testInfo: TestInfo, captures: readonly ReferenceCapture[]): Promise<void> {
  if (!fs.existsSync(REFERENCE_DIR)) {
    testInfo.annotations.push({ type: 'reference', description: `${REFERENCE_DIR} is absent; skipped ${captures.map((c) => `proto-${c.name}`).join(', ')}` });
    return;
  }
  const reference = await openReference(app);
  try {
    for (const capture of captures) {
      for (const theme of THEMES) {
        for (const width of CAPTURE_WIDTHS) {
          await setPageSize(reference.page, width, CAPTURE_HEIGHT);
          await reference.show(theme, capture.setup);
          await capture.focus?.(reference.page);
          await settled(reference.page);
          await saveScreenshot(reference.page, testInfo, `proto-${capture.name}-${theme}-${width}`);
        }
      }
    }
  } finally {
    await reference.close();
  }
}

/** The light palette of the reference's desktop template, applied to the chat panel template, which ships only dark. */
function referenceLightPalette(): string {
  const desktop = fs.readFileSync(path.join(REFERENCE_DIR, 'Damocles Desktop.dc.html'), 'utf8');
  const match = /\[data-theme="light"\]\{([^}]*)\}/.exec(desktop);
  if (!match) throw new Error('the reference desktop template has no light palette');
  return `:root{${match[1]}}`;
}

// The template's root is height:100% of an auto-height host, so without this the page grows past the viewport.
const FIT_VIEWPORT = 'html,body{margin:0;overflow:hidden}[data-screen-label="Chat panel"]{height:100vh!important}';
const REFERENCE_HEADER = '[title="Prompt navigator (Ctrl+K)"]';

interface Reference {
  page: Page;
  /** Re-renders the template in `theme`, then runs `setup` (a function body over the template's `logic` instance). */
  show(theme: Theme, setup: string): Promise<void>;
  close(): Promise<void>;
}

/** Serves the reference folder and loads `Chat Panel.dc.html` in its own window and session. */
async function openReference(app: ElectronApplication): Promise<Reference> {
  const server = http.createServer((req, res) => {
    const file = path.join(REFERENCE_DIR, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    if (!file.startsWith(REFERENCE_DIR) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/javascript' }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/Chat%20Panel.dc.html`;
  const opened = app.waitForEvent('window', (page) => page.url().startsWith(url));
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = new BrowserWindow({ width: 900, height: 820, show: true, webPreferences: { partition: 'reference-capture' } });
    void win.loadURL(target);
  }, url);
  const page = await opened;
  const light = referenceLightPalette();
  return {
    page,
    async show(theme, setup) {
      await page.reload();
      await expect(page.locator(REFERENCE_HEADER)).toBeAttached({ timeout: 60_000 });
      await page.evaluate(([css, body, header]) => {
        document.getElementById('capture-theme')?.remove();
        const style = document.createElement('style');
        style.id = 'capture-theme';
        style.textContent = css;
        document.head.append(style);
        // The dc runtime's React wrapper holds the template's logic instance.
        type Fiber = { stateNode?: { logic?: { openOv?: unknown } } | null; return: Fiber | null };
        const host = document.querySelector(header);
        if (!host) throw new Error('no reference header');
        const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
        let fiber = key ? (host as unknown as Record<string, Fiber>)[key] ?? null : null;
        while (fiber && typeof fiber.stateNode?.logic?.openOv !== 'function') fiber = fiber.return;
        const logic = fiber?.stateNode?.logic;
        if (!logic) throw new Error('no reference component instance');
        new Function('logic', body)(logic);
      }, [`${FIT_VIEWPORT}${theme === 'light' ? light : ''}`, setup, REFERENCE_HEADER] as const);
      await settled(page);
    },
    async close() {
      // Closing this page through Playwright also closed the app's main window, so main destroys it instead.
      await app.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith(target))?.destroy();
      }, url);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
