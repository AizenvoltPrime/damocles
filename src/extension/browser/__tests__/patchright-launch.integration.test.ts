import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Env-gated Patchright launch smoke test (the harness later slices build the full integration matrix
 * on). It launches SYSTEM Chrome headless via the real launcher, drives open/navigate/screenshot
 * through the leak-free PageController, and asserts a base64 JPEG comes back.
 *
 * It is SKIPPED by default because it spawns a real browser and requires a Chrome channel. To run it
 * locally under PowerShell (Git Bash has a path-casing module-dup bug on this machine):
 *
 *   powershell -Command "$env:DAMOCLES_PATCHRIGHT_IT='1'; npx vitest run src/extension/browser/__tests__/patchright-launch.integration.test.ts"
 *
 * patchright must already be installed (npm install) and a branded Chrome/Edge available; NO Chromium
 * download is performed (channel:'chrome').
 */

const RUN_IT = process.env['DAMOCLES_PATCHRIGHT_IT'] === '1';

const FIXTURE_HTML = `<!doctype html><html><head><title>Damocles Fixture</title></head>
<body><h1 id="hdr">hello patchright</h1><a href="/next">next</a></body></html>`;

const NEXT_HTML = `<!doctype html><html><head><title>Next Page</title></head>
<body><h1 id="hdr2">second page</h1></body></html>`;

// Richer static fixture for the read/inspect tool paths (Slice 2). A tall body forces page scroll,
// there is an EMPTY text input (drives the empty-fields report), several interactive elements (drive
// refCount), a stable element to inspect (#inspect-me), and a MAIN-world global (window.__APP_STATE__)
// to prove browser_evaluate reads page globals the ISOLATED world cannot see.
const READ_FIXTURE_HTML = `<!doctype html><html><head><title>Read Fixture</title>
<style>#spacer { height: 3000px; } #inspect-me { width: 120px; height: 40px; color: rgb(10, 20, 30); background-color: rgb(200, 200, 200); display: block; }</style>
</head>
<body>
  <h1>read fixture heading</h1>
  <button id="btn">Click me</button>
  <a href="/next">a link</a>
  <input id="empty-input" type="text" placeholder="fill me" />
  <select id="sel"><option value="">choose</option><option value="a">Alpha</option></select>
  <div id="inspect-me" class="inspect-target" data-role="probe">inspect target</div>
  <div id="spacer"></div>
  <script>window.__APP_STATE__ = { user: 'ada', count: 42, nested: { ok: true } };</script>
</body></html>`;

// Slice-3 action fixture: exercises the locator-migrated action tools end-to-end. It includes a text
// input, a native <select>, a checkbox, a scrollable container, a drag source + drop target, an input
// whose oninput resets its value (drives the WARN branch of BrowserFill), a delayed-reveal element
// (proves locator auto-wait needs no manual sleep), and a CLOSED shadow-root host with a <button>
// (proves a normal page.locator pierces closed shadow roots).
const ACTIONS_FIXTURE_HTML = `<!doctype html><html><head><title>Actions Fixture</title>
<style>
  #scrollable { height: 100px; overflow: auto; border: 1px solid #000; }
  #scroll-inner { height: 1000px; }
  #drop { width: 120px; height: 40px; border: 1px dashed #333; }
  #drag { width: 80px; height: 30px; background: #ddd; }
  #delayed { display: none; }
</style>
</head>
<body>
  <h1>actions fixture</h1>
  <input id="text-input" type="text" placeholder="type here" />
  <select id="native-select"><option value="">choose</option><option value="a">Alpha</option><option value="b">Beta</option></select>
  <input id="checkbox" type="checkbox" />
  <button id="hover-btn">Hover me</button>
  <input id="resetting-input" type="text" oninput="this.value=''" />
  <div id="scrollable"><div id="scroll-inner">tall content</div></div>
  <div id="drag" draggable="true">drag</div>
  <div id="drop">drop here</div>
  <div id="shadow-host"></div>
  <div id="delayed">Now visible</div>
  <script>
    const host = document.getElementById('shadow-host');
    const root = host.attachShadow({ mode: 'closed' });
    const b = document.createElement('button');
    b.id = 'shadow-btn';
    b.textContent = 'shadow button';
    root.appendChild(b);
    const drop = document.getElementById('drop');
    drop.addEventListener('dragover', (e) => e.preventDefault());
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.textContent = 'dropped'; drop.setAttribute('data-dropped', '1'); });
  </script>
</body></html>`;

// Slice-5 fixture: a button that opens a SECOND tab via window.open (exercises the real context
// 'page' → handleNewPage popup path), an <input type=file> (BrowserUpload direct path), and a
// download link (<a download> served with Content-Disposition:attachment so Chrome treats it as a
// download rather than a navigation → the page.on('download') capture path fires).
const TABS_FIXTURE_HTML = `<!doctype html><html><head><title>Tabs Fixture</title></head>
<body>
  <h1 id="hdr">tabs fixture</h1>
  <button id="open-popup" onclick="window.open('/popup', '_blank')">open popup</button>
  <a id="anchor-popup" href="/popup" target="_blank" rel="noopener">open popup anchor</a>
  <input id="file-input" type="file" />
  <a id="dl" href="/download-file" download="hello.txt">download</a>
</body></html>`;

const POPUP_HTML = `<!doctype html><html><head><title>Popup Tab</title></head>
<body><h1 id="phdr">popup page</h1></body></html>`;

// Slice-6 intercept fixture: a page that loads an interceptable image (/tracker.png) and an
// unmatched script (/widget.js sets window.__WIDGET_LOADED__ when it runs), and offers a mockable API
// (/api/data returns {"real":true} unless a fulfill rule stubs it). Used to prove block/fulfill/
// unmatched behavior AND the stealth-observer regression (init scripts still inject with a route active).
const INTERCEPT_FIXTURE_HTML = `<!doctype html><html><head><title>Intercept Fixture</title></head>
<body>
  <h1 id="ihdr">intercept fixture</h1>
  <img id="tracker" src="/tracker.png" />
  <script src="/widget.js"></script>
</body></html>`;

// Slice-3 console/stealth fixture. Drives all three bridge sources on demand (a console.log, an
// uncaught error, and a rejected promise) via buttons rather than at load, so the test can install
// observers and be certain the binding is live before anything fires. `window.__APP_STATE__` is the
// MAIN-world-only global that acts as the positive control for the criterion-6 read.
const CONSOLE_FIXTURE_HTML = `<!doctype html><html><head><title>Console Fixture</title></head>
<body>
  <h1 id="chdr">console fixture</h1>
  <button id="do-log" onclick="console.log('hello from the page')">log</button>
  <button id="do-error" onclick="setTimeout(() => { throw new Error('uncaught boom'); }, 0)">error</button>
  <button id="do-reject" onclick="Promise.reject(new Error('rejected boom'))">reject</button>
  <script>window.__APP_STATE__ = { user: 'ada', count: 42, nested: { ok: true } };</script>
</body></html>`;

// Slice-4 settle fixture. The page's HTML arrives immediately but it references a SUBRESOURCE that the
// server stalls for SLOW_SUBRESOURCE_MS before completing. The DOM is therefore interactive long before
// the LOAD event fires, which is exactly the gap `settle` must respect: it has to return AFTER the load
// event, not merely after the document parses.
//
// Readiness is observed via `document.readyState` ('interactive' → 'complete'), which is document state
// visible from Patchright's ISOLATED world. A main-world `window.__LOAD_FIRED__` flag would read back as
// `undefined` through page.evaluate — the single/multi-world distinction Slice 3 documented.
const SLOW_SUBRESOURCE_MS = 1500;

const SLOW_LOAD_HTML = `<!doctype html><html><head><title>Slow Load Fixture</title></head>
<body><h1 id="slow-hdr">slow load fixture</h1><img id="slow-img" src="/slow-image.png" /></body></html>`;

// A page that is fully loaded by the time we settle on it: no subresources at all.
const FAST_LOAD_HTML = `<!doctype html><html><head><title>Fast Load Fixture</title></head>
<body><h1 id="fast-hdr">fast load fixture</h1></body></html>`;

// Slice-5 download-cap fixture: a link to a file just over the 100 MB per-file cap. The real handler
// must stat Playwright's temp file, delete() it, and record `rejected` — nothing reaches downloadsDir.
const OVERSIZED_BYTES = 100 * 1024 * 1024 + 1024;

const OVERSIZED_FIXTURE_HTML = `<!doctype html><html><head><title>Oversized Fixture</title></head>
<body><h1 id="ohdr">oversized fixture</h1>
<a id="dl-big" href="/oversized-file" download="oversized.bin">download big</a>
<a id="dl-small" href="/download-file" download="hello.txt">download small</a>
</body></html>`;

// 1x1 transparent PNG (bytes served for /tracker.png).
const TRACKER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe.runIf(RUN_IT)('Patchright launch smoke (env-gated)', () => {
  let server: Server;
  let baseUrl = '';
  let userDataDir = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/next') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(NEXT_HTML);
        return;
      }
      if (req.url === '/read') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(READ_FIXTURE_HTML);
        return;
      }
      if (req.url === '/actions') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(ACTIONS_FIXTURE_HTML);
        return;
      }
      if (req.url === '/tabs') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(TABS_FIXTURE_HTML);
        return;
      }
      if (req.url === '/popup') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(POPUP_HTML);
        return;
      }
      if (req.url === '/oversized') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(OVERSIZED_FIXTURE_HTML);
        return;
      }
      if (req.url === '/intercept') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(INTERCEPT_FIXTURE_HTML);
        return;
      }
      if (req.url === '/console') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(CONSOLE_FIXTURE_HTML);
        return;
      }
      if (req.url === '/tracker.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(TRACKER_PNG);
        return;
      }
      if (req.url === '/widget.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('window.__WIDGET_LOADED__ = true;');
        return;
      }
      if (req.url === '/api/data') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"real":true}');
        return;
      }
      if (req.url === '/slow-load') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(SLOW_LOAD_HTML);
        return;
      }
      if (req.url === '/fast-load') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(FAST_LOAD_HTML);
        return;
      }
      if (req.url === '/slow-image.png') {
        // Hold the response open so the page's LOAD event cannot fire yet, then complete normally.
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(TRACKER_PNG);
        }, SLOW_SUBRESOURCE_MS);
        return;
      }
      if (req.url === '/download-file') {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="hello.txt"',
        });
        res.end('hello from download');
        return;
      }
      if (req.url === '/oversized-file') {
        // Streams just over DOWNLOAD_MAX_BYTES (100 MB) so the real handler's stat-then-delete path
        // fires against real Chromium. Written in chunks rather than one Buffer to keep the server's
        // own memory bounded.
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="oversized.bin"',
          'content-length': String(OVERSIZED_BYTES),
        });
        const chunk = Buffer.alloc(1024 * 1024);
        let sent = 0;
        const pump = (): void => {
          while (sent < OVERSIZED_BYTES) {
            const size = Math.min(chunk.length, OVERSIZED_BYTES - sent);
            sent += size;
            if (!res.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        pump();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-it-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (userDataDir) await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('launches Chrome, navigates, and captures a JPEG screenshot with no Runtime.enable', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { PageController, CDP_ALLOWED_METHODS } = await import('../page-controller');

    expect(CDP_ALLOWED_METHODS).not.toContain('Runtime.enable');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const session = await context.newCDPSession(page);
      const controller = new PageController(page, session);

      // open
      await controller.navigate(baseUrl);
      await page.waitForLoadState('load');
      const title1 = await controller.evaluate('document.title');
      expect(title1.value).toBe('Damocles Fixture');

      // navigate
      await controller.navigate(`${baseUrl}/next`);
      await page.waitForLoadState('load');
      const title2 = await controller.evaluate('document.title');
      expect(title2.value).toBe('Next Page');

      // screenshot
      const shot = await controller.captureScreenshot({ format: 'jpeg', quality: 70 });
      expect(typeof shot).toBe('string');
      expect(shot.length).toBeGreaterThan(100);
      // JPEG magic bytes /9j/ at the start of a base64 stream.
      expect(shot.startsWith('/9j/')).toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);

  // Why there is no Page.bringToFront anywhere in the repo. Playwright/Patchright does not issue one
  // before Page.captureScreenshot either (see screenshotter `_screenshot` → `takeScreenshot`), and its
  // chromiumSwitches already pass --disable-backgrounding-occluded-windows, --disable-renderer-
  // backgrounding, --disable-background-timer-throttling and --enable-features=CDPScreenshotNewSurface.
  // Concurrent agents therefore capture their OWN background tabs correctly, and adding bringToFront
  // would make them fight over which tab is frontmost. This test is the executable proof.
  it('captures live, per-tab screenshots of BACKGROUND tabs without bringToFront', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { PageController } = await import('../page-controller');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 320, height: 240 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    try {
      const pageA = context.pages()[0] ?? (await context.newPage());
      const controllerA = new PageController(pageA, await context.newCDPSession(pageA));
      await controllerA.navigate(baseUrl);
      await pageA.waitForLoadState('load');

      // Opened last, so THIS is the frontmost tab for the rest of the test; pageA is backgrounded.
      const pageB = await context.newPage();
      const controllerB = new PageController(pageB, await context.newCDPSession(pageB));
      await controllerB.navigate(`${baseUrl}/next`);
      await pageB.waitForLoadState('load');

      const paint = async (controller: InstanceType<typeof PageController>, color: string): Promise<string> => {
        await controller.evaluate(`document.documentElement.style.background = '${color}'`);
        // One rAF settles the paint; a throttled background compositor would not produce a new frame.
        await new Promise((r) => setTimeout(r, 300));
        return controller.captureScreenshot({ format: 'jpeg', quality: 70 });
      };

      const backgroundRed = await paint(controllerA, 'red');
      const backgroundBlue = await paint(controllerA, 'blue');
      const foreground = await controllerB.captureScreenshot({ format: 'jpeg', quality: 70 });

      for (const shot of [backgroundRed, backgroundBlue, foreground]) {
        expect(shot.startsWith('/9j/')).toBe(true);
        expect(shot.length).toBeGreaterThan(500); // not a blank/degenerate frame
      }
      // The BACKGROUND tab re-rendered between captures — it is not serving a stale frame.
      expect(backgroundRed).not.toBe(backgroundBlue);
      // ...and each session captured its own page, not whichever tab happens to be frontmost.
      expect(foreground).not.toBe(backgroundBlue);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('drives the Slice-2 read/inspect paths against a real page with no Runtime.enable', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { PageController, CDP_ALLOWED_METHODS } = await import('../page-controller');
    const { buildSnapshotExpression } = await import('../../pi-session/tools/browser-tools');

    // (e) Structural guarantee: Runtime.enable is never permitted through the chokepoint.
    expect(CDP_ALLOWED_METHODS).not.toContain('Runtime.enable');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const session = await context.newCDPSession(page);
      const controller = new PageController(page, session);

      await controller.navigate(`${baseUrl}/read`);
      await page.waitForLoadState('load');
      // Page.navigate over CDP + waitForLoadState('load') can resolve off the initial about:blank
      // before <body> is parsed; wait for a fixture element so the DOM-read paths see a full document.
      await page.waitForSelector('#inspect-me');

      // (a) page.evaluate returns the snapshot object DIRECTLY (no {value} wrapper). The `(() => {})()`
      // string is evaluated as an EXPRESSION, exactly like the old raw Runtime.evaluate.
      const snap = await page.evaluate(buildSnapshotExpression()) as {
        snapshot: string; refCount: number; title: string; url: string;
        belowFold: number; scrollInfo: string[]; emptyFields: string[];
      };
      expect(snap).toBeTypeOf('object');
      expect(snap.title).toBe('Read Fixture');
      // button + link + input + select = ≥4 interactive elements tagged with refs.
      expect(snap.refCount).toBeGreaterThanOrEqual(4);
      // Tall body (#spacer 3000px) forces a page scrollbar → scrollInfo is populated.
      expect(Array.isArray(snap.scrollInfo)).toBe(true);
      expect(snap.scrollInfo.length).toBeGreaterThan(0);
      // The empty text input + unselected placeholder select are reported.
      expect(snap.emptyFields).toContain('empty-input');

      // (b) MAIN-world global round-trip: controller.evaluate targets the top frame's main world, which
      // sees window.__APP_STATE__. The ISOLATED world page.evaluate uses would NOT.
      const appState = await controller.evaluate('JSON.stringify(window.__APP_STATE__)');
      expect(typeof appState.value).toBe('string');
      expect(JSON.parse(appState.value as string)).toEqual({ user: 'ada', count: 42, nested: { ok: true } });

      // (c) BrowserElement chain: getDocument → querySelector → getOuterHTML/getBoxModel/computedStyle.
      const doc = await controller.getDocument();
      const nodeId = await controller.querySelector(doc.root.nodeId, '#inspect-me');
      expect(nodeId).toBeGreaterThan(0);
      const html = await controller.getOuterHTML(nodeId);
      expect(html).toContain('inspect target');
      const box = await controller.getBoxModel(nodeId);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      const computed = await controller.getComputedStyleForNode(nodeId);
      const display = computed.find((s) => s.name === 'display')?.value;
      expect(display).toBe('block');

      // (d) Accessibility tree via the leak-free CDPSession (Accessibility.getFullAXTree, no
      // Runtime.enable). page.accessibility.snapshot() is unavailable — Patchright removed the
      // deprecated Accessibility client API — so BrowserAccessibility sources from getFullAXTree.
      const tree = await controller.getFullAXTree() as { nodes?: unknown[] };
      expect(tree).not.toBeNull();
      expect(Array.isArray(tree.nodes)).toBe(true);
      expect(tree.nodes!.length).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('drives the Slice-3 action tools (locators) against a real page with no Runtime.enable', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { PageController, CDP_ALLOWED_METHODS } = await import('../page-controller');
    const { buildBrowserPiTools } = await import('../../pi-session/tools/browser-tools');

    // The action tools drive Playwright locators/mouse/keyboard (NOT the allow-list) and only touch the
    // isolated-world page.evaluate for custom-widget finders — Runtime.enable must never be permitted.
    expect(CDP_ALLOWED_METHODS).not.toContain('Runtime.enable');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const session = await context.newCDPSession(page);
      const controller = new PageController(page, session);

      // Drive the REAL tools: a lightweight `pi` stub whose defineTool returns the config verbatim, and a
      // scope stub resolving to the real PageController/Page over the launched context (the tools bind to
      // a BrowserAgentScope, never to the service).
      const pi = { defineTool: (cfg: unknown) => cfg };
      // Slice 3: `takeSnapshot` now drains the dialog ledger for its `[Dialogs]` header lines, so a
      // scope stub MUST provide these two or every snapshot-backed tool throws.
      const scope = {
        getController: () => controller,
        getCurrentPage: () => page,
        stageUpload: () => {},
        takeUnreportedDialogs: () => [],
        getDialogs: () => [],
      };
      type ToolLike = { name: string; execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> };
      const tools = buildBrowserPiTools({ pi, scope } as never) as unknown as ToolLike[];
      const byName = new Map(tools.map((t) => [t.name, t]));
      const call = (name: string, input: unknown, signal?: AbortSignal) => byName.get(name)!.execute('it', input, signal);
      const texts = (res: Awaited<ReturnType<ToolLike['execute']>>) => res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
      const image = (res: Awaited<ReturnType<ToolLike['execute']>>) => res.content.find((c) => c.type === 'image');

      await controller.navigate(`${baseUrl}/actions`);
      await page.waitForLoadState('load');
      await page.waitForSelector('#text-input');

      // Closed shadow root is reachable via a normal locator (Playwright pierces closed shadow DOM).
      expect(await page.locator('#shadow-btn').count()).toBe(1);

      // click → coordinate-free locator click, screenshot-after returns a base64 JPEG image block.
      const clickRes = await call('BrowserClick', { selector: '#hover-btn' });
      expect(texts(clickRes)[0]).toBe('Clicked: #hover-btn');
      const clickImg = image(clickRes);
      expect(clickImg?.mimeType).toBe('image/jpeg');
      expect((clickImg?.data ?? '').startsWith('/9j/')).toBe(true);

      // type (clear + pressSequentially through a locator).
      const typeRes = await call('BrowserType', { selector: '#text-input', text: 'hello', clear: true });
      expect(texts(typeRes)[0]).toBe('Typed "hello" into #text-input');
      expect(await page.evaluate(`document.querySelector('#text-input').value`)).toBe('hello');

      // hover.
      const hoverRes = await call('BrowserHover', { selector: '#hover-btn' });
      expect(texts(hoverRes)[0]).toBe('Hovered: #hover-btn');

      // native <select> via locator.selectOption.
      const selRes = await call('BrowserSelect', { selector: '#native-select', value: 'a' });
      expect(texts(selRes)[0]).toBe('Selected "a" in #native-select');
      expect(await page.evaluate(`document.querySelector('#native-select').value`)).toBe('a');

      // Closed shadow-root button reached through the real click tool (normal CSS selector).
      const shadowRes = await call('BrowserClick', { selector: '#shadow-btn' });
      expect(texts(shadowRes)[0]).toBe('Clicked: #shadow-btn');

      // fill: OK text + OK native check (setChecked) + WARN (value reset by oninput) + FAIL (non-checkbox).
      const fillRes = await call('BrowserFill', { fields: [
        { selector: '#text-input', value: 'filled', type: 'text' },
        { selector: '#checkbox', value: '', type: 'check' },
        { selector: '#resetting-input', value: 'wont-stick', type: 'text' },
        { selector: '#text-input', value: 'x', type: 'check' },
      ] });
      const fillText = texts(fillRes)[0];
      expect(fillText).toContain('OK text #text-input = "filled"');
      expect(fillText).toContain('OK check #checkbox');
      expect(fillText).toContain('WARN text #resetting-input');
      expect(fillText).toContain('FAIL check #text-input — Not a checkbox/switch element');
      expect(await page.evaluate(`document.querySelector('#checkbox').checked`)).toBe(true);

      // wait: auto-wait proves no manual sleep is needed — schedule a reveal, then wait for visibility.
      await page.evaluate(`setTimeout(() => { document.getElementById('delayed').style.display = 'block'; }, 600)`);
      const waitRes = await call('BrowserWait', { selector: '#delayed' });
      expect(texts(waitRes)[0]).toBe('Element appeared: #delayed');

      // scroll a specific overflow container.
      const scrollRes = await call('BrowserScroll', { selector: '#scrollable', y: 200 });
      expect(texts(scrollRes)[0]!.startsWith('Scrolled div#scrollable by (')).toBe(true);

      // drag via locator.dragTo (primary path).
      const dragRes = await call('BrowserDrag', { sourceSelector: '#drag', targetSelector: '#drop' });
      expect(texts(dragRes)[0]).toBe('Dragged #drag → #drop');

      // act: take a snapshot to assign [data-dq] refs, then batch click + key.
      const snapRes = await call('BrowserSnapshot', {});
      const snapText = texts(snapRes)[0]!;
      const m = snapText.match(/\[(\d+)\] button "Hover me"/);
      expect(m).not.toBeNull();
      const ref = Number((m as RegExpMatchArray)[1]);
      const actRes = await call('BrowserAct', { actions: [ { action: 'click', ref }, { action: 'key', text: 'Escape' } ] });
      const actText = texts(actRes)[0];
      expect(actText).toContain(`OK click [${ref}]`);
      expect(actText).toContain('OK key "Escape"');

      // Abort mid-action returns promptly via raceAbort (well under the 10s wait timeout).
      const ac = new AbortController();
      const start = Date.now();
      const pending = call('BrowserWait', { selector: '#never-appears', timeout: 10000 }, ac.signal);
      setTimeout(() => ac.abort(), 100);
      const abortRes = await pending;
      expect(texts(abortRes)[0]).toBe('BrowserWait aborted');
      expect(Date.now() - start).toBeLessThan(3000);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('drives the Slice-5 tabs/upload/download tools through the REAL BrowserService registry', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { BrowserService } = await import('../index');
    const { buildBrowserPiTools } = await import('../../pi-session/tools/browser-tools');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    // The vscode mock lacks createWebviewPanel, so we do NOT call BrowserService.open(). Instead we
    // instantiate the REAL service and drive its page registry directly (bypassing the panel):
    // setActivePage skips screencast when browserPanel is null, so no panel is needed.
    const service = new BrowserService();
    const downloadsDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-it-dl-'));
    const uploadPath = join(await fsp.mkdtemp(join(tmpdir(), 'damocles-it-up-')), 'upload.txt');
    await fsp.writeFile(uploadPath, 'upload payload');

    type Svc = {
      context: unknown;
      downloadManager: { downloadsDir: string };
      scopes: Map<string, { currentPage: unknown }>;
      registerPage: (p: unknown, ownerScopeId?: string) => Promise<unknown>;
      setActivePage: (p: unknown) => void;
      handleNewPage: (p: unknown) => Promise<void>;
    };
    const s = service as unknown as Svc;
    s.context = context;
    s.downloadManager.downloadsDir = downloadsDir;
    const PRIMARY = BrowserService.PRIMARY_SCOPE_ID;
    const scope = service.createAgentScope(PRIMARY);

    // Build the REAL tools over the REAL primary scope (the main agent + human surface).
    const pi = { defineTool: (cfg: unknown) => cfg };
    type ToolLike = { name: string; execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> };
    const tools = buildBrowserPiTools({ pi, scope } as never) as unknown as ToolLike[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    const call = (name: string, input: unknown) => byName.get(name)!.execute('it', input);
    const texts = (res: Awaited<ReturnType<ToolLike['execute']>>) => res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await s.registerPage(page, PRIMARY);
      s.scopes.get(PRIMARY)!.currentPage = page; // the primary scope's current tab (bypassing open())
      s.setActivePage(page);
      // Wire the real Slice-1 popup path so window.open registers the new tab (owned by the opener's scope).
      context.on('page', (p) => { void s.handleNewPage(p); });

      await page.goto(`${baseUrl}/tabs`);
      await page.waitForLoadState('load');
      await page.waitForSelector('#open-popup');
      expect(scope.getCurrentUrl()).toContain('/tabs');

      // Open a SECOND tab via window.open; the context 'page' event → handleNewPage registers it, owned
      // by the opener's (primary) scope but NOT auto-made the scope's current tab (decision #2).
      const popupPromise = context.waitForEvent('page');
      await page.click('#open-popup');
      const popup = await popupPromise;
      await popup.waitForLoadState('load');
      // Let handleNewPage (async registerPage + opener resolution) settle.
      await new Promise((r) => setTimeout(r, 300));

      // (1) list enumerates 2 tabs; the OPENER (/tabs) stays current — the popup is listed but not active
      // until the agent selects it.
      const listRes = await call('BrowserTabs', { action: 'list' });
      const listText = texts(listRes)[0]!;
      expect(listText).toContain('Open tabs (2)');
      const activeLine = listText.split('\n').find((l) => l.includes(' *'));
      expect(activeLine).toContain('/tabs');
      expect(listText).toContain('/popup');

      // (2) select index 0 keeps the current tab on /tabs (the opener) for the upload below.
      const selRes = await call('BrowserTabs', { action: 'select', index: 0 });
      expect(texts(selRes)[0]).toContain('Switched to tab 0');
      expect(scope.getCurrentUrl()).toContain('/tabs');
      expect(scope.getCurrentPage()).toBe(page);

      // (3) BrowserUpload sets files on the <input type=file> and the PAGE sees them.
      const upRes = await call('BrowserUpload', { selector: '#file-input', paths: [uploadPath] });
      expect(texts(upRes).join('\n')).toContain('Uploaded 1 file(s) to #file-input');
      const fileCount = await page.evaluate(`document.querySelector('#file-input').files.length`);
      expect(fileCount).toBe(1);
      const fileName = await page.evaluate(`document.querySelector('#file-input').files[0].name`);
      expect(fileName).toBe('upload.txt');

      // (4) Triggering a download saves the file under downloadsDir; BrowserDownloads reports the absolute path.
      await page.click('#dl');
      for (let i = 0; i < 50 && service.getDownloads().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const dls = service.getDownloads();
      expect(dls.length).toBeGreaterThanOrEqual(1);
      const saved = dls[0]!;
      expect(saved.savedPath.startsWith(downloadsDir)).toBe(true);
      expect(saved.state).toBe('completed');
      await expect(fsp.readFile(saved.savedPath, 'utf8')).resolves.toBe('hello from download');
      const dlRes = await call('BrowserDownloads', {});
      const dlText = texts(dlRes)[0];
      expect(dlText).toContain('Recent downloads');
      expect(dlText).toContain(saved.savedPath);

      // (5) close the current tab (index 0, /tabs) → the scope's current tab re-points to the most-recent
      // remaining tab it owns (popup).
      const closeRes = await call('BrowserTabs', { action: 'close', index: 0 });
      expect(texts(closeRes)[0]).toContain('Closed tab 0');
      await new Promise((r) => setTimeout(r, 200));
      const afterClose = scope.listTabs();
      expect(afterClose.length).toBe(1);
      expect(scope.getCurrentPage()).toBe(popup);
      expect(scope.getCurrentUrl()).toContain('/popup');

      // (6) last-tab guard: closing the only remaining tab is refused (value-safe error, session stays alive).
      const guardRes = await call('BrowserTabs', { action: 'close', index: 0 });
      expect(guardRes.isError).toBe(true);
      expect(texts(guardRes)[0]).toContain('Cannot close the last remaining tab');
      expect(scope.listTabs().length).toBe(1);
    } finally {
      await context.close();
      await fsp.rm(downloadsDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(uploadPath, { force: true }).catch(() => {});
    }
  }, 60_000);

  it('opens tabs deterministically (BrowserTabs new) and captures target=_blank popups', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { BrowserService } = await import('../index');
    const { buildBrowserPiTools } = await import('../../pi-session/tools/browser-tools');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    const service = new BrowserService();
    type Svc = {
      context: unknown;
      scopes: Map<string, { currentPage: unknown }>;
      registerPage: (p: unknown, ownerScopeId?: string) => Promise<unknown>;
      setActivePage: (p: unknown) => void;
      handleNewPage: (p: unknown) => Promise<void>;
    };
    const s = service as unknown as Svc;
    s.context = context;
    const PRIMARY = BrowserService.PRIMARY_SCOPE_ID;
    const scope = service.createAgentScope(PRIMARY);

    const pi = { defineTool: (cfg: unknown) => cfg };
    type ToolLike = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };
    const tools = buildBrowserPiTools({ pi, scope } as never) as unknown as ToolLike[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    const call = (name: string, input: unknown) => byName.get(name)!.execute('it', input);
    const texts = (res: Awaited<ReturnType<ToolLike['execute']>>) => res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await s.registerPage(page, PRIMARY);
      s.scopes.get(PRIMARY)!.currentPage = page;
      s.setActivePage(page);
      // Wire the context-level new-page path exactly as launchAndAdopt does (page.on('popup') is
      // wired inside registerPage automatically).
      context.on('page', (p) => { void s.handleNewPage(p); });

      await page.goto(`${baseUrl}/tabs`);
      await page.waitForSelector('#anchor-popup');
      expect(scope.listTabs().length).toBe(1);

      // (A) BrowserTabs new opens a tab deterministically (no dependence on a page spawning a popup)
      // and switches to it: the scope's tab list grows to 2 and the new tab is the current one.
      const newRes = await call('BrowserTabs', { action: 'new', url: `${baseUrl}/popup` });
      expect(texts(newRes)[0]).toContain('Opened new tab');
      await new Promise((r) => setTimeout(r, 300));
      const afterNew = scope.listTabs();
      expect(afterNew.length).toBe(2);
      expect(afterNew.find((t) => t.active)?.url).toContain('/popup');

      // Switch back to the fixture tab for the anchor-popup test.
      await call('BrowserTabs', { action: 'select', index: 0 });
      expect(scope.getCurrentPage()).toBe(page);

      // (B) A page-opened target=_blank popup (the case that failed live before this fix) is captured
      // via page.on('popup') and appears as a tracked tab (owned by the opener's scope) after a real
      // trusted click. Poll (fail-fast) rather than waitForEvent so a regression surfaces as an assertion.
      const before = scope.listTabs().length;
      await call('BrowserClick', { selector: '#anchor-popup' });
      for (let i = 0; i < 30 && scope.listTabs().length === before; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(scope.listTabs().length).toBe(before + 1);
      expect(scope.listTabs().some((t) => t.url.includes('/popup'))).toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('drives the Slice-6 BrowserIntercept tool: block + fulfill + unmatched + stealth-observer regression', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { BrowserService, installContextObservers } = await import('../index');
    const { buildBrowserPiTools } = await import('../../pi-session/tools/browser-tools');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    // Install the REAL context observers (the shared installer used by launchAndConnect) so the
    // stealth-observer regression asserts the ACTUAL init scripts fire, not duplicated text. We record
    // whether the title/cursor bindings fire at least once.
    let titleFired = false;
    let cursorFired = false;
    // Slice 3 made `onConsole` a REQUIRED third handler (contract §2).
    await installContextObservers(context, {
      onTitle: () => { titleFired = true; },
      onCursor: () => { cursorFired = true; },
      onConsole: () => {},
    });

    // Real service driven directly (vscode mock lacks createWebviewPanel, so no open()/panel).
    const service = new BrowserService();
    const s = service as unknown as {
      context: unknown;
      scopes: Map<string, { currentPage: unknown }>;
      registerPage: (p: unknown, ownerScopeId?: string) => Promise<unknown>;
      setActivePage: (p: unknown) => void;
    };
    s.context = context;
    const PRIMARY = BrowserService.PRIMARY_SCOPE_ID;
    const scope = service.createAgentScope(PRIMARY);

    const pi = { defineTool: (cfg: unknown) => cfg };
    type ToolLike = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };
    const tools = buildBrowserPiTools({ pi, scope } as never) as unknown as ToolLike[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    const call = (name: string, input: unknown) => byName.get(name)!.execute('it', input);
    const texts = (res: Awaited<ReturnType<ToolLike['execute']>>) => res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await s.registerPage(page, PRIMARY);
      s.scopes.get(PRIMARY)!.currentPage = page;
      s.setActivePage(page);
      // Main-world reads go through the PageController (raw CDP, no Runtime.enable): Patchright runs
      // page.evaluate in an ISOLATED world, which cannot see main-world globals like window.__WIDGET_LOADED__
      // or the page's real navigator.webdriver. DOM reads (naturalWidth, textContent) are shared across
      // worlds, so those stay on page.evaluate.
      const cdp = scope.getController()!;

      // Collect failed requests to prove the BLOCK rule aborts the matching request.
      const failedUrls: string[] = [];
      page.on('requestfailed', (req) => failedUrls.push(req.url()));

      // (a) BLOCK rule on the tracker image. Fire-and-forget route() settles quickly; wait a beat so
      // interception is enabled before navigation.
      const blockRes = await call('BrowserIntercept', { action: 'add', pattern: '**/tracker.png', type: 'block' });
      expect(texts(blockRes)[0]).toContain('Added intercept rule');
      expect(texts(blockRes)[0]).toContain('block');
      await new Promise((r) => setTimeout(r, 250));

      await page.goto(`${baseUrl}/intercept`);
      await page.waitForLoadState('load');
      await page.waitForSelector('#ihdr');
      // Give the (blocked) image + (unmatched) script a moment to resolve.
      await new Promise((r) => setTimeout(r, 500));

      // (a) The blocked image request failed.
      expect(failedUrls.some((u) => u.includes('/tracker.png'))).toBe(true);
      // The image element did not load any pixels.
      const imgWidth = await page.evaluate(`document.querySelector('#tracker').naturalWidth`);
      expect(imgWidth).toBe(0);

      // (c) UNMATCHED requests proceed: the page document loaded AND the unmatched script ran.
      const headingText = await page.evaluate(`document.querySelector('#ihdr')?.textContent`);
      expect(headingText).toBe('intercept fixture');
      const widgetLoaded = await cdp.evaluate('window.__WIDGET_LOADED__ === true');
      expect(widgetLoaded.value).toBe(true);

      // (d) STEALTH-OBSERVER REGRESSION: with a block route active, Patchright's route-based stealth
      // init scripts still run — assert navigator.webdriver === false in the MAIN world (what a
      // detector reads).
      const webdriver = await cdp.evaluate('navigator.webdriver');
      expect(webdriver.value).toBe(false);

      // And our context init-script observers still fire their exposeBinding — proving our narrow block
      // route did not clobber Patchright's HTML-request-level init-script injection. We exercise the
      // CURSOR observer: its mousemove listener is attached synchronously at document_start (unlike the
      // title observer's first report(), it does not touch the binding until an actual move), so it is
      // robust to Patchright installing the exposeBinding a beat after document_start. A real mouse move
      // over the page must drive __damoclesCursor → our onCursor callback, with the block rule active.
      cursorFired = false;
      for (let i = 0; i < 20 && !cursorFired; i++) {
        await page.mouse.move(40 + i * 3, 40 + i * 3);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(cursorFired).toBe(true);
      // The block rule is still active during the observer exercise (rules are context-level).
      expect(failedUrls.some((u) => u.includes('/tracker.png'))).toBe(true);

      // (b) FULFILL rule mocks the API. Without the rule the fixture serves {"real":true}; with it the
      // page fetch returns our stub body.
      const stubBody = '{"mock":true,"items":[1,2,3]}';
      const fulfillRes = await call('BrowserIntercept', {
        action: 'add',
        pattern: '**/api/data',
        type: 'fulfill',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: stubBody,
      });
      expect(texts(fulfillRes)[0]).toContain('Added intercept rule');
      await new Promise((r) => setTimeout(r, 250));
      const fetched = await page.evaluate(`fetch('/api/data').then((r) => r.text())`);
      expect(fetched).toBe(stubBody);

      // list shows both rules, REDACTED (bodyBytes, not the raw body).
      const listRes = await call('BrowserIntercept', { action: 'list' });
      const listText = texts(listRes)[0]!;
      expect(listText).toContain('Intercept rules (2)');
      expect(listText).toContain('bodyBytes=');
      expect(listText).not.toContain('mock');

      // clear removes both; a subsequent fetch hits the REAL endpoint again.
      const clearRes = await call('BrowserIntercept', { action: 'clear' });
      expect(texts(clearRes)[0]).toBe('Cleared 2 intercept rule(s).');
      expect(service.listInterceptRules()).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 250));
      const realAgain = await page.evaluate(`fetch('/api/data').then((r) => r.text())`);
      expect(realAgain).toBe('{"real":true}');

      // titleFired is best-effort here: on an INSTANT local fixture the first DOMContentLoaded can beat
      // Patchright's post-document_start binding install, so the title observer's first report() may
      // no-op (real sites reach DCL later, after the binding is live). The cursor observer above is the
      // deterministic regression signal — it proves our init scripts still install with a route active.
      void titleFired;
    } finally {
      await context.close();
    }
  }, 60_000);

  /**
   * Slice-3 acceptance criteria 3, 5 and 6 against REAL Chrome. This is the AUTHORITATIVE home for
   * criterion 6.
   *
   * The main-world read is the whole point. Patchright runs `page.evaluate` in an ISOLATED world,
   * where our bindings never existed at ALL — asserting the absence of a Damocles name there would
   * pass no matter what the implementation did, i.e. a guaranteed FALSE PASS. So the property list is
   * read through `controller.evaluate` (raw `Runtime.evaluate` over the leak-free CDPSession, top
   * frame's default context = the main world), and a main-world-only global proves it.
   */
  it('Slice 3: main world carries no Damocles-attributable global, observers still fire, console bridges', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { CDP_ALLOWED_METHODS } = await import('../page-controller');
    const { BrowserService, installContextObservers } = await import('../index');

    // The invariant this slice must not weaken: no new allow-list entry, and Runtime/Console.enable
    // are still absent. `Runtime.addBinding` is deliberately unused (re-arming it per context would
    // require Runtime.enable) — the bridge rides context.exposeBinding instead.
    expect(CDP_ALLOWED_METHODS).not.toContain('Runtime.enable');
    expect(CDP_ALLOWED_METHODS).not.toContain('Console.enable');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    // Drive the REAL service so the console payload lands in the REAL per-tab ConsoleCollector.
    const service = new BrowserService();
    const s = service as unknown as {
      context: unknown;
      scopes: Map<string, { currentPage: unknown }>;
      registerPage: (p: unknown, ownerScopeId?: string) => Promise<unknown>;
      setActivePage: (p: unknown) => void;
      onConsoleBinding: (p: unknown, payload: string) => void;
    };
    s.context = context;
    const PRIMARY = BrowserService.PRIMARY_SCOPE_ID;
    const scope = service.createAgentScope(PRIMARY);

    let titleFired = false;
    let cursorFired = false;
    // The REAL installer, with all three handlers. onConsole is routed into the service exactly as
    // launchAndAdopt wires it, so the collector is fed through production code.
    await installContextObservers(context, {
      onTitle: () => { titleFired = true; },
      onCursor: () => { cursorFired = true; },
      onConsole: (p, payloadJson) => { s.onConsoleBinding(p, payloadJson); },
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await s.registerPage(page, PRIMARY);
      s.scopes.get(PRIMARY)!.currentPage = page;
      s.setActivePage(page);

      // PRODUCTION-PATH ONLY. The controller under test is the one `doRegisterPage` built on the CDP
      // session IT attached (`index.ts:1032` → `:1055`); the harness never constructs a session or a
      // PageController of its own. Production's sequence is
      //   launchAndAdopt → installContextObservers → registerPage → doRegisterPage → newCDPSession →
      //   new PageController,
      // and `context.newCDPSession(page)` at `index.ts:1032` is the ONLY attach in the entire non-test
      // browser layer. Sourcing the controller from `getScopeController()` therefore makes the attach
      // ordering come from production code by construction, so no harness ordering can influence — or
      // fake — this result.
      const controller = service.getScopeController(PRIMARY)!;
      expect(controller).toBeTruthy();

      await page.goto(`${baseUrl}/console`);
      await page.waitForLoadState('load');
      await page.waitForSelector('#do-log');

      // ── Criterion 6 — MAIN-WORLD property enumeration ──────────────────────────────────────────
      const namesJson = await controller.evaluate('JSON.stringify(Object.getOwnPropertyNames(window))');
      expect(typeof namesJson.value).toBe('string');
      const names = JSON.parse(namesJson.value as string) as string[];

      // POSITIVE CONTROL: this read really is seeing the MAIN world. `__APP_STATE__` is set by an
      // inline page script and is invisible to Patchright's isolated world, so its presence here
      // proves the enumeration below is not a vacuous read of the wrong context (or of nothing).
      expect(names).toContain('__APP_STATE__');
      expect(names.length).toBeGreaterThan(50);

      // The criterion itself: nothing in the main world's own properties is attributable to us.
      const attributable = names.filter((n) => n.toLowerCase().includes('damocles') || /^__damocles/.test(n));
      expect(attributable).toEqual([]);

      // The old, fixed defect: these exact enumerable globals used to be present (T1).
      expect(names).not.toContain('__damoclesCursor');
      expect(names).not.toContain('__damoclesTitle');

      // The relocated bindings are also absent from Object.keys / for...in, which is what detection
      // scripts actually enumerate.
      const enumJson = await controller.evaluate(`JSON.stringify({
        keys: Object.keys(window).filter((k) => k.toLowerCase().includes('damocles')),
        forIn: (() => { const out = []; for (const k in window) { if (k.toLowerCase().includes('damocles')) out.push(k); } return out; })()
      })`);
      const enumerated = JSON.parse(enumJson.value as string) as { keys: string[]; forIn: string[] };
      expect(enumerated.keys).toEqual([]);
      expect(enumerated.forIn).toEqual([]);

      // ── Criterion 5 — the console wrapper is a Proxy over a native fn, and toString is unpatched ──
      // Authoritative against real Chrome (happy-dom models this faithfully too, but this is the
      // environment a detector actually runs in).
      const stealth = await controller.evaluate(`JSON.stringify({
        logToString: Function.prototype.toString.call(console.log),
        logName: console.log.name,
        toStringToString: Function.prototype.toString.call(Function.prototype.toString),
        toStringIsNative: Function.prototype.toString.toString().includes('[native code]')
      })`);
      const st = JSON.parse(stealth.value as string) as {
        logToString: string; logName: string; toStringToString: string; toStringIsNative: boolean;
      };
      expect(st.logToString).toContain('[native code]');
      expect(st.logName).toBe('log');
      // Function.prototype.toString itself is NOT patched — patching it is a classic tell in its own right.
      expect(st.toStringIsNative).toBe(true);
      expect(st.toStringToString).toContain('[native code]');

      // ── Criterion 3 — console.log, an uncaught error and a rejection reach THIS tab's collector ──
      await page.click('#do-log');
      await page.click('#do-error');
      await page.click('#do-reject');

      // The bridge batches on a 100ms window; poll (fail-fast) rather than sleeping blindly.
      const deadline = Date.now() + 10_000;
      let captured: Array<{ level: string; text: string }> = [];
      while (Date.now() < deadline) {
        captured = service.getConsoleMessages(PRIMARY);
        const haveAll = captured.some((m) => m.text.includes('hello from the page'))
          && captured.some((m) => m.text.includes('uncaught boom'))
          && captured.some((m) => m.text.includes('rejected boom'));
        if (haveAll) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // A plain console.log arrives, attributed to the tab that produced it.
      const logEntry = captured.find((m) => m.text.includes('hello from the page'));
      expect(logEntry).toBeDefined();
      expect(logEntry!.level).toBe('log');

      // An uncaught error arrives at error level, with its source location.
      const errEntry = captured.find((m) => m.text.includes('uncaught boom'));
      expect(errEntry).toBeDefined();
      expect(errEntry!.level).toBe('error');
      expect(errEntry!.text).toMatch(/:\d+:\d+/);

      // An unhandled rejection arrives with the contract's prefix.
      const rejEntry = captured.find((m) => m.text.includes('rejected boom'));
      expect(rejEntry).toBeDefined();
      expect(rejEntry!.level).toBe('error');
      expect(rejEntry!.text.startsWith('Unhandled promise rejection:')).toBe(true);

      // Same content through the AGENT's surface, which is what the criterion is really about.
      expect(scope.getConsole().some((m) => m.text.includes('hello from the page'))).toBe(true);

      // ── Criterion 6, second half — the observers STILL FIRE with the randomized names ───────────
      // The cursor observer is CHANGE-DRIVEN: it remembers the last cursor it reported and stays
      // silent while the value is unchanged. So the flag must NOT be reset here — by this point the
      // observer has already reported (the moves above settle on 'default'), and clearing the flag
      // then repeating same-cursor moves would wait forever for a report that is correctly suppressed.
      // We assert it fired at least once with the randomized binding name, which is the criterion.
      for (let i = 0; i < 20 && !cursorFired; i++) {
        await page.mouse.move(40 + i * 3, 40 + i * 3);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(cursorFired).toBe(true);

      // The title observer fires on a REAL title change (a mutation after the binding is live is not
      // subject to the DOMContentLoaded race that makes the first report() best-effort).
      titleFired = false;
      await page.evaluate(`document.title = 'Changed Title'`);
      for (let i = 0; i < 20 && !titleFired; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(titleFired).toBe(true);

      // ── THE REGRESSION THIS SUITE MISSED ───────────────────────────────────────────────────────
      // Everything above runs on the FIRST document. Playwright's exposeBinding function lives only
      // in the ISOLATED world, and the main world holds it only on the initial about:blank — so a
      // bridge that resolved it from the main world worked here and was dead on every real page.
      // These assertions navigate first, which is what every real user does.
      const consoleCountBefore = service.getConsoleMessages(PRIMARY).length;
      await page.goto(`${baseUrl}/console`);
      await page.waitForLoadState('load');
      await page.waitForSelector('#do-log');
      await page.click('#do-log');
      const navDeadline = Date.now() + 10_000;
      while (Date.now() < navDeadline && service.getConsoleMessages(PRIMARY).length === consoleCountBefore) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(service.getConsoleMessages(PRIMARY).length).toBeGreaterThan(consoleCountBefore);

      // A data: URL has an opaque origin and issues no HTTP request — the scheme real usage hit.
      // DOUBLE-INJECTION REGRESSION. Patchright executes every context init script TWICE per
      // document (two registration paths both fire), which installed two console wrappers with
      // separate closure state and reported every entry twice. Asserted against real Chrome because
      // the double execution is engine behaviour a single-world unit test cannot reproduce.
      const beforeDup = service.getConsoleMessages(PRIMARY).length;
      // MAIN world via the controller: `page.evaluate` targets the ISOLATED world, where the
      // main-world console wrapper does not exist, so it would log nothing and pass vacuously.
      await controller.evaluate(`console.log('exactly-once-probe')`);
      const dupDeadline = Date.now() + 5_000;
      while (
        Date.now() < dupDeadline
        && !service.getConsoleMessages(PRIMARY).some((m) => m.text.includes('exactly-once-probe'))
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // Settle past the 100ms batch window so a second copy would have landed by now.
      await new Promise((r) => setTimeout(r, 400));
      const probeHits = service.getConsoleMessages(PRIMARY).filter((m) => m.text.includes('exactly-once-probe'));
      expect(probeHits).toHaveLength(1);
      // POSITIVE CONTROL: the buffer really grew, so the count above is de-duplication and not a
      // bridge that stopped delivering.
      expect(service.getConsoleMessages(PRIMARY).length).toBeGreaterThan(beforeDup);

      const beforeData = service.getConsoleMessages(PRIMARY).length;
      const DATA_DOC = `<body><button id="d" onclick="console.log('log from data url')">d</button></body>`;
      await page.goto('data:text/html,' + encodeURIComponent(DATA_DOC));
      await page.waitForLoadState('load');
      await page.click('#d');
      const dataDeadline = Date.now() + 10_000;
      while (
        Date.now() < dataDeadline
        && !service.getConsoleMessages(PRIMARY).some((m) => m.text.includes('log from data url'))
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(service.getConsoleMessages(PRIMARY).some((m) => m.text.includes('log from data url'))).toBe(true);
      expect(service.getConsoleMessages(PRIMARY).length).toBeGreaterThan(beforeData);
    } finally {
      await context.close();
    }
  }, 90_000);

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // Slice 4 — settle timing and the known-viewport CDP send count, against REAL Chrome.
  //
  // These three cases exist because happy-dom cannot express them: it has no load event, no network,
  // no compositor and no rAF cadence, so the unit suite can only prove `settle` CALLS the right APIs,
  // never that the resulting timing is correct. That is the Slice-3 lesson applied — a criterion about
  // real browser behaviour is asserted against a real browser too.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════

  it('settle returns FAST on an already-loaded page — materially under the old 2000ms floor', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { settle } = await import('../../pi-session/tools/browser-tools');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`${baseUrl}/fast-load`, { waitUntil: 'load' });

      // Measure only `settle` itself, on a page that is already loaded — the BrowserOpen/Navigate
      // steady state. The old code paid a flat 2000ms/1500ms here regardless.
      const started = Date.now();
      await settle(page, 15_000);
      const elapsed = Date.now() - started;

      // Generous headroom for CI noise: the real cost is two animation frames (~32ms) plus one round
      // trip. Anything near the old floor means the sleep is still there.
      expect(elapsed).toBeLessThan(1000);

      // POSITIVE CONTROL: the timer is measuring something real. A settle that resolved instantly by
      // doing nothing would also be "fast" — so assert the page genuinely reached its load state and
      // that a double-rAF actually elapsed (two frames cannot complete in 0ms on a live compositor).
      expect(await page.evaluate('document.readyState')).toBe('complete');
      const frames = await page.evaluate(`new Promise(r => {
        const t0 = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t0)));
      })`) as number;
      expect(frames).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('settle on a page that DELAYS its load event returns only AFTER the load event', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { settle } = await import('../../pi-session/tools/browser-tools');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());

      // Start the navigation but do NOT await the load event — the fixture's <img> is stalled server
      // side for SLOW_SUBRESOURCE_MS, so the DOM is interactive well before `load` fires. This is the
      // exact race the old fixed sleeps got wrong in both directions.
      const navigation = page.goto(`${baseUrl}/slow-load`, { waitUntil: 'domcontentloaded' });
      await navigation;
      await page.waitForSelector('#slow-hdr');

      // Pre-condition: we are genuinely mid-load. If this were already 'complete' the fixture would
      // not be stalling and the assertion below would be vacuous.
      //
      // `document.readyState` — not the fixture's `window.__LOAD_FIRED__` — because page.evaluate runs
      // in Patchright's ISOLATED world, which cannot see a main-world global. readyState is document
      // state and is shared across worlds. (The first draft of this test used the global and failed
      // with `undefined`, which is the single/multi-world distinction Slice 3 documented.)
      expect(await page.evaluate('document.readyState')).toBe('interactive');

      const started = Date.now();
      await settle(page, 15_000);
      const elapsed = Date.now() - started;

      // THE CRITERION: settle waited for the load event rather than returning on a fixed clock.
      expect(await page.evaluate('document.readyState')).toBe('complete');
      // ...and it really waited — it did not return before the stalled subresource completed. The
      // bound is deliberately loose (half the stall) to absorb navigation start-up skew.
      expect(elapsed).toBeGreaterThan(SLOW_SUBRESOURCE_MS / 2);
      // ...but it is still bounded well under the 15s cap: it returned on the LOAD, not on the cap.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('a real-page captureScreenshot with a known viewport issues EXACTLY ONE CDP send', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { PageController } = await import('../page-controller');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const session = await context.newCDPSession(page);

      // Count real sends by wrapping the live CDPSession, so this measures the production ladder
      // against real Chrome rather than a hand-rolled fake.
      const sent: string[] = [];
      const realSend = session.send.bind(session);
      (session as unknown as { send: (m: string, p?: unknown) => Promise<unknown> }).send = (m, p) => {
        sent.push(m);
        return realSend(m as never, p as never);
      };

      const controller = new PageController(page, session);
      await page.goto(`${baseUrl}/fast-load`, { waitUntil: 'load' });

      controller.setKnownViewport({ width: 1024, height: 768, dpr: 1 }); // under the 1950 cap
      sent.length = 0;
      const shot = await controller.captureScreenshot({ format: 'jpeg', quality: 70 });

      // The criterion, against a real page: one round trip, and it is the capture.
      expect(sent).toEqual(['Page.captureScreenshot']);
      // The image is real, so the saved round trip did not cost correctness.
      expect(shot.startsWith('/9j/')).toBe(true);
      expect(shot.length).toBeGreaterThan(500);

      // POSITIVE CONTROL: a controller with NO cache probes first on the same real page, proving the
      // single-send assertion above is a property of the seeding and not of this Chrome build.
      const probeSession = await context.newCDPSession(page);
      const probeSent: string[] = [];
      const probeRealSend = probeSession.send.bind(probeSession);
      (probeSession as unknown as { send: (m: string, p?: unknown) => Promise<unknown> }).send = (m, p) => {
        probeSent.push(m);
        return probeRealSend(m as never, p as never);
      };
      const unseeded = new PageController(page, probeSession);
      const probeShot = await unseeded.captureScreenshot({ format: 'jpeg', quality: 70 });

      expect(probeSent).toEqual(['Runtime.evaluate', 'Page.captureScreenshot']);
      expect(probeShot.startsWith('/9j/')).toBe(true);

      // Runtime.enable was never sent on EITHER path — the invariant, re-asserted against real Chrome
      // on the new code path.
      for (const forbidden of ['Runtime.enable', 'Console.enable', 'Network.enable']) {
        expect(sent).not.toContain(forbidden);
        expect(probeSent).not.toContain(forbidden);
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  /**
   * Slice 5 / S4 against REAL routes. happy-dom cannot express this: the unit tests prove
   * `addInterceptRule` REFUSES `https://**`, but only real Chromium proves what that refusal buys —
   * that the page still loads — and that a narrow block genuinely aborts the request it names.
   */
  it('Slice 5: refuses an over-broad block against real routes while a narrow block still works', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { BrowserService } = await import('../index');
    const { buildBrowserPiTools } = await import('../../pi-session/tools/browser-tools');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    const service = new BrowserService();
    const s = service as unknown as {
      context: unknown;
      scopes: Map<string, { currentPage: unknown }>;
      registerPage: (p: unknown, ownerScopeId?: string) => Promise<unknown>;
      setActivePage: (p: unknown) => void;
    };
    s.context = context;
    const PRIMARY = BrowserService.PRIMARY_SCOPE_ID;
    const scope = service.createAgentScope(PRIMARY);

    type ToolLike = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };
    const tools = buildBrowserPiTools({ pi: { defineTool: (cfg: unknown) => cfg }, scope } as never) as unknown as ToolLike[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    const call = (name: string, input: unknown) => byName.get(name)!.execute('it', input);
    const texts = (res: Awaited<ReturnType<ToolLike['execute']>>) => res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await s.registerPage(page, PRIMARY);
      s.scopes.get(PRIMARY)!.currentPage = page;
      s.setActivePage(page);

      const failedUrls: string[] = [];
      page.on('requestfailed', (req) => failedUrls.push(req.url()));

      // (a) Every scheme-prefixed catch-all is REFUSED for block. Before Slice 5, `https://**` reduced
      // to the non-empty string "https" and registered — aborting every HTTPS request on the page.
      for (const pattern of ['https://**', '://**', '*://*/*', '**', '*']) {
        const refused = await call('BrowserIntercept', { action: 'add', pattern, type: 'block' });
        expect(refused.isError).toBe(true);
        expect(texts(refused)[0]).toMatch(/over-broad/i);
      }
      // A fulfill catch-all is refused on the same predicate.
      const refusedFulfill = await call('BrowserIntercept', { action: 'add', pattern: 'https://**', type: 'fulfill', status: 204 });
      expect(refusedFulfill.isError).toBe(true);
      expect(texts(refusedFulfill)[0]).toMatch(/over-broad/i);
      // Nothing was registered by any of the refusals.
      expect(service.listInterceptRules()).toHaveLength(0);

      // (b) POSITIVE CONTROL — a NARROW block on a real asset genuinely aborts that request, and the
      // page itself still loads. This is what the refusals above protect: had `https://**` registered,
      // the document request would have been aborted too and nothing below would load.
      const narrow = await call('BrowserIntercept', { action: 'add', pattern: '**/tracker.png', type: 'block' });
      expect(narrow.isError).toBeFalsy();
      await new Promise((r) => setTimeout(r, 250));

      await page.goto(`${baseUrl}/intercept`);
      await page.waitForLoadState('load');
      await page.waitForSelector('#ihdr');
      await new Promise((r) => setTimeout(r, 500));

      // The named asset was aborted...
      expect(failedUrls.some((u) => u.includes('/tracker.png'))).toBe(true);
      expect(await page.evaluate(`document.querySelector('#tracker').naturalWidth`)).toBe(0);
      // ...while the document and the unmatched script were NOT.
      expect(await page.evaluate(`document.querySelector('#ihdr')?.textContent`)).toBe('intercept fixture');
      expect(failedUrls.some((u) => u.endsWith('/intercept'))).toBe(false);
      expect(failedUrls.some((u) => u.includes('/widget.js'))).toBe(false);

      // (c) An allowed narrow pattern with a scheme also registers and matches real traffic.
      const scoped = await call('BrowserIntercept', {
        action: 'add', pattern: `${baseUrl}/api/data`, type: 'fulfill', status: 200,
        headers: { 'content-type': 'application/json' }, body: '{"stubbed":true}',
      });
      expect(scoped.isError).toBeFalsy();
      await new Promise((r) => setTimeout(r, 250));
      expect(await page.evaluate(`fetch('/api/data').then((r) => r.text())`)).toBe('{"stubbed":true}');

      // (d) The S5 header bounds hold against the real service too.
      const cookieRule = await call('BrowserIntercept', {
        action: 'add', pattern: '**/api/data', type: 'fulfill', status: 200, headers: { 'Set-Cookie': 'a=b' },
      });
      expect(cookieRule.isError).toBe(true);
      expect(texts(cookieRule)[0]).toMatch(/set-cookie/i);
      const hopRule = await call('BrowserIntercept', {
        action: 'add', pattern: '**/api/**', type: 'modify', headers: { Connection: 'close' },
      });
      expect(hopRule.isError).toBe(true);
      expect(texts(hopRule)[0]).toMatch(/connection/i);
      // The two refusals added nothing on top of the two live rules.
      expect(service.listInterceptRules()).toHaveLength(2);

      await call('BrowserIntercept', { action: 'clear' });
    } finally {
      await context.close();
    }
  }, 60_000);

  /**
   * Slice 5 / S3 against REAL Chromium. The unit tests drive the handler with a fake `Download`; only
   * this proves the cap holds against a genuine Chromium download stream — that the file is refused,
   * that NOTHING lands in the downloads directory, and that the agent is told it was rejected rather
   * than being handed a fabricated success.
   */
  it('Slice 5: refuses a real over-cap download and leaves the downloads directory empty', async () => {
    const { launchBrowserContext } = await import('../launcher');
    const { BrowserService } = await import('../index');
    const { buildBrowserPiTools } = await import('../../pi-session/tools/browser-tools');

    const context = await launchBrowserContext({
      userDataDir,
      headless: true,
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      devToolsPort: true,
    });

    const service = new BrowserService();
    const downloadsDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-it-dlcap-'));
    const s = service as unknown as {
      context: unknown;
      downloadManager: { downloadsDir: string };
      scopes: Map<string, { currentPage: unknown }>;
      registerPage: (p: unknown, ownerScopeId?: string) => Promise<unknown>;
      setActivePage: (p: unknown) => void;
    };
    s.context = context;
    s.downloadManager.downloadsDir = downloadsDir;
    const PRIMARY = BrowserService.PRIMARY_SCOPE_ID;
    const scope = service.createAgentScope(PRIMARY);

    type ToolLike = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };
    const tools = buildBrowserPiTools({ pi: { defineTool: (cfg: unknown) => cfg }, scope } as never) as unknown as ToolLike[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    const texts = (res: Awaited<ReturnType<ToolLike['execute']>>) => res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
    const waitForDownloads = async (count: number): Promise<void> => {
      for (let i = 0; i < 300 && service.getDownloads().length < count; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await s.registerPage(page, PRIMARY);
      s.scopes.get(PRIMARY)!.currentPage = page;
      s.setActivePage(page);

      await page.goto(`${baseUrl}/oversized`);
      await page.waitForLoadState('load');
      await page.waitForSelector('#dl-big');

      // A REAL Chromium download of just over 100 MB.
      await page.click('#dl-big');
      await waitForDownloads(1);

      const rejected = service.getDownloads()[0]!;
      expect(rejected.state).toBe('rejected');
      expect(rejected.savedPath).toBe('');
      // The size really was measured off Playwright's temp file before the delete().
      expect(rejected.sizeBytes).toBe(OVERSIZED_BYTES);
      // THE CRITERION: nothing reached the downloads directory.
      expect(await fsp.readdir(downloadsDir)).toEqual([]);

      // The agent is told it was refused, with a reason and NO path — never a fabricated success.
      const listing = texts(await byName.get('BrowserDownloads')!.execute('it', {}))[0]!;
      expect(listing).toContain('oversized.bin');
      expect(listing).toContain('[rejected]');
      expect(listing).toMatch(/REJECTED/);
      expect(listing).toMatch(/100\.0 MB/);
      expect(listing).not.toContain(downloadsDir);
      expect(listing).not.toContain('completed');

      // POSITIVE CONTROL — the very same handler still saves an under-cap download from the same page,
      // so the rejection above is the size cap acting, not downloads being broken outright.
      await page.click('#dl-small');
      await waitForDownloads(2);

      const saved = service.getDownloads()[1]!;
      expect(saved.state).toBe('completed');
      expect(saved.savedPath.startsWith(downloadsDir)).toBe(true);
      await expect(fsp.readFile(saved.savedPath, 'utf8')).resolves.toBe('hello from download');
      expect(await fsp.readdir(downloadsDir)).toEqual(['hello.txt']);

      const after = texts(await byName.get('BrowserDownloads')!.execute('it', {}))[0]!;
      expect(after).toContain(saved.savedPath);
      expect(after).toContain('[completed]');
    } finally {
      await context.close();
      await fsp.rm(downloadsDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
