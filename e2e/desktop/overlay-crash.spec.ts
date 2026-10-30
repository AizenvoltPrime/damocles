import { OVERLAY_CHANNELS, type OverlayRequest } from '../../src/desktop/preload/overlay-channels';
import { logBeforeQuit } from './support/app';
import { activeChat, expect, test } from './support/fixtures';
import { OVERLAY_URL } from './support/shell';
import { readyOverlay } from './support/overlay';
import { answerMessageBoxes, chatInput, messageBoxes } from './support/ui';

const QUESTION = 'Proceed with the held question?';

interface Recorded {
  // each load event of the overlay page, with what main can read of its renderer at that moment
  events: Array<{ name: string; crashed: boolean; pid: number }>;
  // the requests main sent the page, by the question's message, in order, and the load event each followed
  sent: Array<{ message: string; after: string | undefined }>;
  // render-process-gone's reason, which depends on the OS: forcefullyCrashRenderer reads "crashed" on Windows and Linux, "killed" on macOS
  goneReason?: string;
}

interface HookGlobals {
  __damoclesE2e: { notifications: { warn(message: { message: string }, actions: Array<{ message: string }>, options: { modal: boolean }): Promise<number | undefined> } };
  __e2eOverlayCrash?: Recorded;
  __e2eHeldAnswer?: Promise<number | undefined>;
}

// A request made while the overlay page navigates is held for the next page; a crash of the renderer during that
// navigation must leave it held for the crash's reload, never hand it to the dying page.
test('a question asked while the overlay reloads is held through a crash of its renderer and shows once, in the reloaded page', async ({ home, launch }) => {
  const desktop = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  const { app } = desktop;
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await readyOverlay(app);
  await answerMessageBoxes(app);

  // Asked from the reload's did-start-navigation, after OverlayHost's own listener, so the question is held; the renderer
  // then dies before the reloaded document can commit.
  await app.evaluate(({ webContents }, { url, requestChannel, question }) => {
    const g = globalThis as unknown as HookGlobals;
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    const recorded: Recorded = { events: [], sent: [] };
    g.__e2eOverlayCrash = recorded;
    for (const name of ['did-stop-loading', 'render-process-gone', 'did-navigate', 'did-finish-load'] as const) {
      // Ahead of OverlayHost's own listeners, so a request it sends on an event is recorded after that event.
      overlay.prependListener(name as 'did-stop-loading', () => {
        recorded.events.push({ name, crashed: overlay.isCrashed(), pid: overlay.getOSProcessId() });
      });
    }
    overlay.prependListener('render-process-gone', (_event, details) => {
      recorded.goneReason = details.reason;
    });
    const send = overlay.send.bind(overlay);
    overlay.send = (channel: string, ...args: unknown[]): void => {
      if (channel === requestChannel) {
        const { request } = args[0] as { request: OverlayRequest };
        if (request.kind === 'message') recorded.sent.push({ message: request.message, after: recorded.events.at(-1)?.name });
      }
      send(channel, ...args);
    };
    const crashDuringReload = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (!details.isMainFrame || details.isSameDocument) return;
      overlay.removeListener('did-start-navigation', crashDuringReload);
      g.__e2eHeldAnswer = g.__damoclesE2e.notifications.warn({ message: question }, [{ message: 'Proceed' }], { modal: true });
      overlay.forcefullyCrashRenderer();
    };
    overlay.on('did-start-navigation', crashDuringReload);
    overlay.reload();
  }, { url: OVERLAY_URL, requestChannel: OVERLAY_CHANNELS.request, question: QUESTION });

  // Playwright's page for the crashed renderer is gone; the reloaded document is read and answered from main.
  const dialogText = (): Promise<string> => app.evaluate(({ webContents }, url) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
    // OverlayHost's liveness check: executeJavaScript on the dying renderer, which reads pid 0 before isCrashed(), never settles.
    if (!overlay || overlay.isCrashed() || overlay.getOSProcessId() === 0 || overlay.isLoading()) return '';
    return overlay.executeJavaScript('document.querySelector(\'[role="alertdialog"]\')?.textContent ?? \'\'') as Promise<string>;
  }, OVERLAY_URL);
  await expect.poll(dialogText, { timeout: 15_000 }).toContain(QUESTION);
  await app.evaluate(({ webContents }, url) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    return overlay.executeJavaScript('[...document.querySelectorAll(\'[role="alertdialog"] button\')].find((button) => button.textContent.trim() === "Proceed").click()');
  }, OVERLAY_URL);
  // the host answers with the chosen action's index
  expect(await app.evaluate(() => (globalThis as unknown as HookGlobals).__e2eHeldAnswer)).toBe(0);

  const recorded = await app.evaluate(() => (globalThis as unknown as HookGlobals).__e2eOverlayCrash!);
  // Electron 44's order, which OverlayHost's liveness check relies on: the dying renderer stops loading first, while
  // isCrashed() is still false and its process id already reads 0.
  const stop = recorded.events.findIndex((event) => event.name === 'did-stop-loading');
  const gone = recorded.events.findIndex((event) => event.name === 'render-process-gone');
  expect(stop).toBeGreaterThanOrEqual(0);
  expect(stop).toBeLessThan(gone);
  expect(recorded.events[stop]).toMatchObject({ crashed: false, pid: 0 });
  expect(recorded.sent).toEqual([{ message: QUESTION, after: 'did-finish-load' }]);
  expect(recorded.events.slice(gone).map((event) => event.name)).toContain('did-finish-load');
  expect(await messageBoxes(app)).toEqual([]);
  // A clean exit is the one reason OverlayHost fails a held request instead of reloading.
  expect(recorded.goneReason).toBeDefined();
  expect(recorded.goneReason).not.toBe('clean-exit');

  await desktop.close();
  const log = logBeforeQuit(home);
  expect(log).toContain(`[overlay] renderer gone (${recorded.goneReason})`);
  expect(log).not.toMatch(/the overlay could not ask|The overlay page stopped/);
});
