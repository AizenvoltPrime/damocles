import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { chatById, chatIdOf, expect, selectChatPage, test } from './support/fixtures';
import { expectNoAxeViolations } from './support/axe';
import { DESIGN_APP, DESIGN_SCHEME, designTabs, designViews, grounding, inShownDesignView, recordOpenExternal, startDesignChat } from './support/design';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { call, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { menuItem, overlayMenu, overlayViewState, readyOverlay } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { shellPage } from './support/shell';
import { awaitTurnEnd } from './support/ui';

// A screen the designer writes opens in a preview tab of the design chat, a sandboxed view laid over the tab's frame at
// the chosen width. Widths come from the fixture app (Tailwind's breakpoints, primary xl 1280).

test.describe.configure({ timeout: 300_000 });

const DESIGN_MD = ['---', 'app: Laravel 11, Inertia, Vue 3, Tailwind 4', 'viewports:', '  primary: xl', '  checked: [sm, xl]', '  journey: []', '---', '# Contacts', ''].join('\n');

// A static screen with two declared states and a link to another site; its inline script must never run.
const screen = (id: string, title: string): string => [
  '<!doctype html>',
  `<html lang="en" data-ds-screen="${id}" data-ds-states="default empty">`,
  `<head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="../tokens.css"></head>`,
  '<body><main>',
  `<h1>${title}</h1>`,
  '<button data-ds-component="Button" data-ds-decision="D1">Add contact</button>',
  '<table data-ds-component="Table" data-ds-state-only="default"><tr><td data-ds-bind="Contact.name">Ada Lovelace</td></tr></table>',
  '<p id="empty" data-ds-state-only="empty">No contacts yet</p>',
  '<a id="away" href="https://example.com/">Elsewhere</a>',
  '<script>document.title = "scripts ran";</script>',
  '</main></body></html>',
  '',
].join('\n');

/**
 * Starts a design chat on the fixture app and has the designer write `screens` (each `[id, title]`) as static mockups. The
 * first write of each screen opens its preview tab in the design chat, which this selects.
 */
async function designWithScreens(home: HermeticHome, stub: OpenAIStub, app: ElectronApplication, screens: ReadonlyArray<readonly [string, string]>): Promise<{ parent: Page; design: Page; folder: string }> {
  const parent = await openProjectChat(app, home.project);
  const { design, folder } = await startDesignChat(app, parent, stub, home, {
    fidelity: 'Static mockup',
    script: (designDir) => [
      ...grounding(designDir, DESIGN_MD),
      ...screens.map(([id, title]) => call('write', { path: path.join(designDir, 'screens', `${id}-${title.toLowerCase()}.html`), content: screen(id, title) })),
      { chunks: ['Drafted the screens.'] },
    ],
  });
  // The transcript is virtualized, so the run's end is read from the stub: every scripted reply was taken.
  await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(0);
  await awaitTurnEnd(design);
  await selectChatPage(app, design);
  return { parent, design, folder };
}

/** Every live design webContents, shown or not. */
async function designContentsCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }, scheme) => webContents.getAllWebContents().filter((c) => !c.isDestroyed() && c.getURL().startsWith(scheme)).length, DESIGN_SCHEME);
}

/** The frame's rectangle in window DIPs (the shell's CSS px at zoom 1). */
async function frameRect(shell: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return shell.getByTestId('design-preview-frame').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left);
    const y = Math.round(rect.top);
    return { x, y, width: Math.round(rect.right) - x, height: Math.round(rect.bottom) - y };
  });
}

/** Resolves once the shown design view covers the frame exactly and lays its page out at `width` CSS px. */
async function viewAt(app: ElectronApplication, shell: Page, width: number): Promise<void> {
  // Both sides are read on every try: the frame moves while the focus overlay or a preset glides.
  await expect.poll(async () => {
    const views = (await designViews(app)).filter((view) => view.visible);
    const frame = await frameRect(shell);
    return views.length === 1 && JSON.stringify(views[0]!.bounds) === JSON.stringify(frame) ? 'covered' : JSON.stringify({ views: views.map((view) => view.bounds), frame });
  }, { timeout: 30_000 }).toBe('covered');
  await expect.poll(() => inShownDesignView<number>(app, 'window.innerWidth'), { timeout: 30_000 }).toBe(width);
}

const readout = (shell: Page): Locator => shell.getByTestId('design-preview-readout');

// A 1 x 1 PNG, so an image load the guard let through would succeed.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

interface Witness {
  readonly origin: string;
  /** What reached the server: connections, HTTP requests and WebSocket upgrades. */
  seen(): { connections: number; requests: number; upgrades: number };
  close(): Promise<void>;
}

/** A loopback HTTP and WebSocket server the test owns, which answers anything that reaches it and counts it. */
async function startWitness(): Promise<Witness> {
  const seen = { connections: 0, requests: 0, upgrades: 0 };
  const server = http.createServer((_request, response) => {
    seen.requests++;
    response.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' });
    response.end(PIXEL);
  });
  server.on('connection', () => seen.connections++);
  server.on('upgrade', (_request, socket) => {
    seen.upgrades++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `127.0.0.1:${port}`,
    seen: () => ({ ...seen }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Probes `probe` every 100 ms for `window` ms and fails as soon as it differs from `expected`. */
async function expectToStay(probe: () => Promise<unknown>, expected: unknown, window: number): Promise<void> {
  const end = Date.now() + window;
  do {
    expect(await probe()).toEqual(expected);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < end);
}

test('a screen opens at its primary width; presets, typing, Fit, a drag and the keys set the width the view lays out at', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const opened = await recordOpenExternal(app);
    await designWithScreens(home, stub, app, [['S1', 'Contacts']]);
    const shell = await shellPage(app);

    // The tab: a monitor icon, the screen's id and title; it opens at the primary width with xl pressed and dotted.
    const tab = shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]');
    await expect(tab).toHaveCount(1);
    await expect(tab.getByTestId('editor-tab-title')).toHaveText('S1 · Contacts');
    await expect(shell.getByTestId('design-preview-path')).toHaveText('screens/S1-contacts.html');
    const xl = shell.locator('[data-testid="design-preview-preset"][data-preset="xl"]');
    await expect(xl).toHaveAttribute('aria-pressed', 'true');
    await expect(xl.getByTestId('design-preview-primary-dot')).toHaveCount(1);
    await expect(shell.locator('[data-testid="design-preview-preset"]')).toHaveText(['base', 'sm', 'md', 'lg', 'xl', '2xl']);
    await expect(readout(shell)).toHaveText(/^xl · 1280 px · \d+%$/);
    await viewAt(app, shell, 1280);
    // The static design's inline script never ran.
    expect(await inShownDesignView<string>(app, 'document.title')).toBe('Contacts');

    // Typing 900: md's band, outlined but not pressed, and the view lays out at 900.
    const field = shell.getByTestId('design-preview-width');
    await field.fill('900');
    await field.press('Enter');
    await expect(readout(shell)).toHaveText(/^md · 900 px · \d+%$/);
    await expect(shell.locator('[data-testid="design-preview-preset"][data-preset="md"]')).toHaveAttribute('data-band', 'true');
    await viewAt(app, shell, 900);

    // A preset glides there and the view follows to the end.
    await shell.locator('[data-testid="design-preview-preset"][data-preset="sm"]').click();
    await expect(readout(shell)).toHaveText(/^sm · 640 px · /);
    await viewAt(app, shell, 640);

    // Fit takes the room the pane has at 100%; twice that is 50%, where a 10 px edge drag adds 40 px.
    await shell.getByTestId('design-preview-fit').click();
    await expect(readout(shell)).toHaveText(/ · 100%$/);
    const room = Number(await field.inputValue());
    await field.fill(String(room * 2));
    await field.press('Enter');
    await expect(readout(shell)).toHaveText(new RegExp(` · ${room * 2} px · 50%$`));
    const handle = shell.getByTestId('design-preview-handle');
    const box = (await handle.boundingBox())!;
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2);
    await shell.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2);
    await shell.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', String(room * 2 + 40));

    // The handle's keys: 1 px, 10 px with Shift.
    await handle.focus();
    await handle.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(room * 2 + 39));
    await handle.press('Shift+ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(room * 2 + 29));
    await expect.poll(async () => (await designTabs(app))[0]?.designPreview.width).toBe(room * 2 + 29);

    // The Browser button opens the served URL from main, as the user's click.
    await shell.getByTestId('design-preview-browser').click();
    await expect.poll(opened).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/d\/[^/]+\/screens\/S1-contacts\.html$/)]);

    await expectNoAxeViolations(shell, '[data-testid="design-preview-tab"]');
  } finally {
    await stub.close();
  }
});

test('a static design switches states with scripts off, and the page reaches no network and opens nothing outside', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  const witness = await startWitness();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const opened = await recordOpenExternal(app);
    await designWithScreens(home, stub, app, [['S1', 'Contacts']]);
    const shell = await shellPage(app);
    await viewAt(app, shell, 1280);

    // Only the declared states, and switching hides the other state's blocks.
    const states = shell.getByTestId('design-preview-state');
    await expect(states).toHaveText(['default', 'empty']);
    const shown = (selector: string) => inShownDesignView<boolean>(app, `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).display !== 'none'`);
    expect(await shown('#empty')).toBe(false);
    await states.filter({ hasText: 'empty' }).click();
    await expect.poll(async () => (await designTabs(app))[0]?.designPreview.state).toBe('empty');
    await expect.poll(() => shown('#empty')).toBe(true);
    await expect.poll(() => shown('table')).toBe(false);
    await states.filter({ hasText: 'default' }).click();
    await expect.poll(() => shown('table')).toBe(true);

    // Provenance outlines the grounded elements.
    await shell.getByTestId('design-preview-provenance').click();
    await expect.poll(() => inShownDesignView<string>(app, `getComputedStyle(document.querySelector('[data-ds-component="Button"]')).outlineStyle`)).not.toBe('none');
    // Hovering a grounded element labels it with its data-ds attributes.
    await app.evaluate(async ({ BrowserWindow, WebContentsView }, scheme) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const view = win.contentView.children.find((child) => child instanceof WebContentsView && child.getVisible() && child.webContents.getURL().startsWith(scheme)) as Electron.WebContentsView;
      const contents = view.webContents;
      const center = await contents.executeJavaScript(`(() => { const r = document.querySelector('[data-ds-component="Button"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`) as [number, number];
      const zoom = contents.getZoomFactor();
      for (const [x, y] of [[1, 1], center]) contents.sendInputEvent({ type: 'mouseMove', x: Math.round(x! * zoom), y: Math.round(y! * zoom) });
    }, DESIGN_SCHEME);
    await expect.poll(() => inShownDesignView<boolean>(app, `[...document.querySelectorAll('div[aria-hidden="true"]')].some((label) => label.textContent.includes('component Button') && label.textContent.includes('decision D1'))`)).toBe(true);

    // Nothing reaches the network or the app: fetch, an http image and a WebSocket to a server that would answer them, the
    // app's own scheme and a local file all fail, and the server saw nothing.
    const localFile = pathToFileURL(path.join(home.project, 'resources', 'css', 'app.css')).href;
    const network = await inShownDesignView<Record<string, string>>(app, `(async () => {
      const load = (url) => fetch(url).then(() => 'loaded', () => 'failed');
      const image = await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve('loaded'); img.onerror = () => resolve('failed'); img.src = 'http://${witness.origin}/pixel.png'; });
      const socket = await new Promise((resolve) => { try { const ws = new WebSocket('ws://${witness.origin}/'); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('failed'); } catch { resolve('failed'); } });
      return { fetch: await load('http://${witness.origin}/data'), image, socket, app: await load('app://damocles/shell/index.html'), file: await load(${JSON.stringify(localFile)}) };
    })()`);
    expect(network).toEqual({ fetch: 'failed', image: 'failed', socket: 'failed', app: 'failed', file: 'failed' });
    expect(witness.seen()).toEqual({ connections: 0, requests: 0, upgrades: 0 });

    // window.open and a link to another site do nothing, here or outside.
    const url = await inShownDesignView<string>(app, 'location.href');
    expect(await inShownDesignView<boolean>(app, `window.open('https://example.com/') === null`)).toBe(true);
    await inShownDesignView(app, `document.getElementById('away').click()`);
    await expect.poll(() => inShownDesignView<string>(app, 'location.href')).toBe(url);
    // No event marks main's handling of the click, so nothing may open for a while after it.
    await expectToStay(opened, [], 2_000);

    // The session's request cancellation, below CSP: a load main itself starts in the view is refused before it leaves.
    const refused = await app.evaluate(async ({ BrowserWindow, WebContentsView }, scheme) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const view = win.contentView.children.find((child) => child instanceof WebContentsView && child.getVisible() && child.webContents.getURL().startsWith(scheme)) as Electron.WebContentsView;
      return view.webContents.loadURL('https://example.com/').then(() => 'loaded', (error: { errno?: number; code?: string }) => `${error.code ?? ''} ${error.errno ?? ''}`.trim());
    }, DESIGN_SCHEME);
    expect(refused).toBe('ERR_BLOCKED_BY_CLIENT -20');
  } finally {
    await witness.close();
    await stub.close();
  }
});

// The ICE gathering the probes run: host, server-reflexive and relay candidates any one of which would mean a socket left.
const ICE_PROBE = `(async () => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:9' }] });
  const types = [];
  pc.onicecandidate = (event) => { if (event.candidate) types.push(event.candidate.type); };
  pc.createDataChannel('probe');
  // Gathering ends at 'complete'; the 3 s cap bounds the probe where it never does.
  const gathered = new Promise((resolve) => { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); }; });
  await pc.setLocalDescription(await pc.createOffer());
  await Promise.race([gathered, new Promise((resolve) => setTimeout(resolve, 3000))]);
  pc.close();
  return types;
})()`;

test('WebRTC gathers no candidate in the preview, where the shell page beside it does', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    await designWithScreens(home, stub, app, [['S1', 'Contacts']]);
    const shell = await shellPage(app);
    await viewAt(app, shell, 1280);

    // The control: the same gathering in a page of the default session finds this computer's interfaces.
    const control = await shell.evaluate<string[]>(ICE_PROBE);
    expect(control).toContain('host');
    expect(await inShownDesignView<string[]>(app, ICE_PROBE)).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('expand floats the preview over the window with the view following, and its tab menu opens above the view', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    await designWithScreens(home, stub, app, [['S1', 'Contacts']]);
    const shell = await shellPage(app);
    await viewAt(app, shell, 1280);
    const before = await frameRect(shell);

    await shell.getByTestId('editor-focus-toggle').click();
    await expect(shell.getByTestId('editor-pane')).toHaveAttribute('data-focus-overlay', 'on');
    await expect.poll(async () => (await frameRect(shell)).width).toBeGreaterThan(before.width);
    await viewAt(app, shell, 1280);

    // The tab's menu: the overlay sits above the design view, which stays shown under it.
    await shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]').click({ button: 'right' });
    const overlay = await readyOverlay(app);
    await expect(overlayMenu(overlay)).toBeVisible();
    await expect(menuItem(overlay, 'openInBrowser')).toBeVisible();
    const items = await overlayMenu(overlay).locator('[data-menu-item]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-item-id')));
    expect(items).toEqual(['close', 'closeOthers', 'closeRight', 'closeAll', 'openInBrowser', 'focusOverlay', 'mention', 'copyPath']);
    const state = await overlayViewState(app);
    expect(state.topmost).toBe(true);
    expect((await designViews(app)).filter((view) => view.visible)).toHaveLength(1);
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toBeHidden();

    await shell.getByTestId('editor-focus-toggle').click();
    await expect(shell.getByTestId('editor-pane')).not.toHaveAttribute('data-focus-overlay', /.+/);
    await expect.poll(() => frameRect(shell)).toEqual(before);
    await viewAt(app, shell, 1280);
  } finally {
    await stub.close();
  }
});

test("a closed preview opens again from the design chat's header and from its screen's code tab, from the main chat too", async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const { parent, design } = await designWithScreens(home, stub, app, [['S1', 'Contacts']]);
    const shell = await shellPage(app);
    const previewTab = shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]');
    const closePreview = async (): Promise<void> => {
      await previewTab.click({ button: 'right' });
      const overlay = await readyOverlay(app);
      await menuItem(overlay, 'close').click();
      await expect(previewTab).toHaveCount(0);
    };
    await expect(previewTab).toHaveCount(1);
    await closePreview();

    // The header's Open preview lists the screens and opens the one picked.
    await design.getByTestId('design-header-open-preview').click();
    await design.locator('[data-testid="design-screen"]', { hasText: 'screens/S1-contacts.html' }).click();
    await expect(previewTab.getByTestId('editor-tab-title')).toHaveText('S1 · Contacts');
    await viewAt(app, shell, 1280);
    await closePreview();

    // The screen's code tab, outside every project, offers Open preview, which opens the design preview, not an HTML one.
    await design.getByTestId('design-header-folder').click();
    await design.locator('[data-testid="design-file"]', { hasText: 'screens/S1-contacts.html' }).click();
    const codeTab = shell.locator('[data-testid="editor-tab"][data-kind="code"]', { hasText: 'S1-contacts.html' });
    await expect(codeTab).toHaveCount(1);
    // From the main chat, the design chat is shown first.
    await selectChatPage(app, parent);
    await codeTab.click({ button: 'right' });
    const overlay = await readyOverlay(app);
    await menuItem(overlay, 'openPreview').click();
    await expect(previewTab.getByTestId('editor-tab-title')).toHaveText('S1 · Contacts');
    await viewAt(app, shell, 1280);
    await expect(shell.locator('[data-testid="editor-tab"][data-kind="htmlPreview"]')).toHaveCount(0);
  } finally {
    await stub.close();
  }
});

test("a link to another screen moves the tab there, Back and Forward walk the view's history by click and key, and a link to no page leaves the tab on its screen", async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    await designWithScreens(home, stub, app, [['S1', 'Contacts'], ['S2', 'Detail']]);
    const shell = await shellPage(app);
    const tabs = shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]');
    await tabs.filter({ hasText: 'S1 · Contacts' }).click();
    await viewAt(app, shell, 1280);
    const back = shell.getByTestId('design-preview-back');
    const forward = shell.getByTestId('design-preview-forward');
    await expect(back).toHaveAttribute('aria-disabled', 'true');
    await expect(forward).toHaveAttribute('aria-disabled', 'true');

    // The page follows a link to the other screen: the active tab, its path and the view all move to it.
    await inShownDesignView(app, `(() => { const link = document.createElement('a'); link.href = 'S2-detail.html'; document.body.append(link); link.click(); })()`);
    await expect(shell.locator('[data-testid="editor-tab"][aria-selected="true"] [data-testid="editor-tab-title"]')).toHaveText('S2 · Detail');
    await expect(shell.getByTestId('design-preview-path')).toHaveText('screens/S2-detail.html');
    await expect.poll(() => inShownDesignView<string>(app, 'document.title'), { timeout: 30_000 }).toBe('Detail');
    await expect(back).not.toHaveAttribute('aria-disabled');

    await back.click();
    await expect(shell.getByTestId('design-preview-path')).toHaveText('screens/S1-contacts.html');
    await expect.poll(() => inShownDesignView<string>(app, 'document.title'), { timeout: 30_000 }).toBe('Contacts');
    await expect(back).toHaveAttribute('aria-disabled', 'true');
    await expect(forward).not.toHaveAttribute('aria-disabled');

    // Forward from the keyboard while focus is in the page, as a browser takes it.
    await shell.getByTestId('design-preview-frame').click();
    await app.evaluate(({ BrowserWindow, WebContentsView }, scheme) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find((child) => child instanceof WebContentsView && child.getVisible() && child.webContents.getURL().startsWith(scheme)) as Electron.WebContentsView;
      const mac = process.platform === 'darwin';
      view.webContents.focus();
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: mac ? ']' : 'Right', modifiers: [mac ? 'meta' : 'alt'] });
    }, DESIGN_SCHEME);
    await expect(shell.getByTestId('design-preview-path')).toHaveText('screens/S2-detail.html');
    await expect.poll(() => inShownDesignView<string>(app, 'document.title'), { timeout: 30_000 }).toBe('Detail');

    // A link to a page the design does not have leaves the tab on its screen and says so; Back shows the screen again.
    await inShownDesignView(app, `(() => { const link = document.createElement('a'); link.href = '/'; document.body.append(link); link.click(); })()`);
    await expect(shell.getByTestId('design-preview-status')).toHaveAttribute('data-status', 'notFound');
    await expect(shell.locator('[data-testid="editor-tab"][aria-selected="true"] [data-testid="editor-tab-title"]')).toHaveText('S2 · Detail');
    await expect(shell.getByTestId('design-preview-path')).toHaveText('screens/S2-detail.html');
    await back.click();
    await expect(shell.getByTestId('design-preview-status')).toHaveCount(0);
    await expect.poll(() => inShownDesignView<string>(app, 'document.title'), { timeout: 30_000 }).toBe('Detail');
  } finally {
    await stub.close();
  }
});

test('preview tabs persist with their chat across a restart, keep four live views, rebuild a fifth, and close with the chat', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    let desktop = await launch();
    let app = desktop.app;
    const titles = ['Contacts', 'Detail', 'Edit', 'Import', 'Settings'] as const;
    const { design } = await designWithScreens(home, stub, app, titles.map((title, index) => [`S${index + 1}`, title] as const));
    let shell = await shellPage(app);
    const tabTitles = titles.map((title, index) => `S${index + 1} · ${title}`);
    const firstTitle = tabTitles[0]!;
    await expect(shell.locator('[data-testid="editor-tab"][data-kind="designPreview"] [data-testid="editor-tab-title"]')).toHaveText(tabTitles);

    // Show each tab once: no more than four design views stay live, and the least recently shown one rebuilds on return.
    for (const title of tabTitles) {
      await shell.locator('[data-testid="editor-tab"]', { hasText: title }).click();
      await expect(shell.getByTestId('design-preview-status')).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(() => designContentsCount(app)).toBeLessThanOrEqual(4);
    }
    await expect.poll(() => designContentsCount(app)).toBe(4);
    await shell.locator('[data-testid="editor-tab"]', { hasText: firstTitle }).click();
    await viewAt(app, shell, 1280);
    expect(await inShownDesignView<string>(app, 'document.title')).toBe('Contacts');
    expect(await designContentsCount(app)).toBe(4);

    // A chosen width survives the restart with the chat's tabs.
    const field = shell.getByTestId('design-preview-width');
    await field.fill('900');
    await field.press('Enter');
    await expect.poll(async () => (await designTabs(app)).find((tab) => tab.title === firstTitle)?.designPreview.width).toBe(900);
    const designId = await chatIdOf(app, design);
    await desktop.close();

    desktop = await launch();
    app = desktop.app;
    const designAgain = await chatById(app, designId);
    await selectChatPage(app, designAgain);
    shell = await shellPage(app);
    await expect(shell.locator('[data-testid="editor-tab"][data-kind="designPreview"] [data-testid="editor-tab-title"]')).toHaveText(tabTitles);
    await shell.locator('[data-testid="editor-tab"]', { hasText: firstTitle }).click();
    await expect(readout(shell)).toHaveText(/^md · 900 px · /);
    await viewAt(app, shell, 900);

    // Deleting the design chat closes its preview tabs and destroys their views.
    expect(await shell.evaluate((id) => window.damoclesShell!.deleteChat(id), designId)).toEqual({ ok: true });
    await expect.poll(() => designContentsCount(app)).toBe(0);
    await expect.poll(async () => (await designTabs(app)).length).toBe(0);
  } finally {
    await stub.close();
  }
});
