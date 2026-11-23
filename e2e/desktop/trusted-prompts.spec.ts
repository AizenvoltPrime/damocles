import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { hostMessage, openProjectChat } from './support/screenshots';
import { promptReady } from './support/ui';

// When a trusted card of the chat page takes an answer (docs/invariants.md "Theme CSS and trusted regions"): shown for its
// hold, and the whole card in view. The cards are raised with core's own messages, so no model turn is needed.

const READY = 'data-trusted-ready';
// The smallest window main allows (MIN_WINDOW_WIDTH and MIN_WINDOW_HEIGHT in main's window-layout-store.ts).
const SMALLEST = { width: 900, height: 600 };

const bash = (toolUseId: string, command: string): Record<string, unknown> => ({ type: 'requestPermission', toolUseId, toolName: 'Bash', toolInput: { command }, command, owner: { kind: 'main' } });
const elicitation = (elicitationId: string, message: string): Record<string, unknown> => ({ type: 'requestElicitation', elicitationId, serverName: 'notes', message, mode: 'url', url: 'https://example.test/' });
const permissionCard = (tab: Page): Locator => tab.getByTestId('permission-card');
const yes = (tab: Page): Locator => permissionCard(tab).getByRole('option', { name: 'Yes', exact: true });

/** Every message the chat page posts to main from now on, as JSON text. */
async function recordPosts(app: ElectronApplication, tab: Page): Promise<() => Promise<string[]>> {
  await app.evaluate(({ webContents }, url) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
    if (!target) throw new Error(`no chat page at ${url}`);
    const seen: string[] = [];
    (globalThis as { __e2ePosts?: string[] }).__e2ePosts = seen;
    target.ipc.on('damocles:panel:post', (_event, payload: unknown) => seen.push(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  }, tab.url());
  return () => app.evaluate(() => [...((globalThis as { __e2ePosts?: string[] }).__e2ePosts ?? [])]);
}

/** The card has mounted and settled: it is ready, or held with a part of it out of the page. */
async function promptReadyOrOutOfView(card: Locator): Promise<void> {
  await expect(card).toBeVisible();
  await expect.poll(() => card.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.getAttribute('data-trusted-ready') === 'true' || rect.top < 0 || rect.bottom > innerHeight;
  })).toBe(true);
}

const answered = async (posts: () => Promise<string[]>, id: string): Promise<boolean> => (await posts()).some((post) => post.includes(id));

/** Records every value the ready state of a card takes from now on, with the time of each. */
async function recordReady(tab: Page): Promise<() => Promise<Array<{ readonly card: string; readonly ready: string; readonly at: number }>>> {
  await tab.evaluate((attribute) => {
    const log: Array<{ card: string; ready: string; at: number }> = [];
    (window as { __e2eReady?: typeof log }).__e2eReady = log;
    new MutationObserver((records) => {
      for (const record of records) {
        const element = record.target as HTMLElement;
        const ready = element.getAttribute(attribute);
        if (ready !== null) log.push({ card: element.dataset.testid ?? '', ready, at: performance.now() });
      }
    }).observe(document.body, { attributes: true, attributeFilter: [attribute], subtree: true });
  }, READY);
  return () => tab.evaluate(() => [...((window as { __e2eReady?: Array<{ card: string; ready: string; at: number }> }).__e2eReady ?? [])]);
}

test('a request just shown is held for half a second, and so is the request that replaces an answered one', async ({ home, launch }) => {
  test.setTimeout(120_000);
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  const posts = await recordPosts(app, tab);
  const readyLog = await recordReady(tab);

  await hostMessage(app, tab, bash('e2e-hold-1', 'echo one'));
  await hostMessage(app, tab, bash('e2e-hold-2', 'echo two'));
  await expect(permissionCard(tab)).toContainText('echo one');
  await promptReady(permissionCard(tab));
  // the card said it was held before it said it was ready, for at least the hold
  const first = (await readyLog()).filter((entry) => entry.card === 'permission-card');
  expect(first[0]!.ready).toBe('false');
  expect(first.at(-1)!.ready).toBe('true');
  expect(first.find((entry) => entry.ready === 'true')!.at - first[0]!.at).toBeGreaterThanOrEqual(450);

  // A double-click on Yes, 150 ms apart, in the page's own time: the second click lands on whatever the page shows by then.
  const second = await tab.evaluate(async () => {
    const option = (): HTMLElement | null => document.querySelector('[data-testid="permission-card"] [data-testid="permission-option-yes"]');
    option()!.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    option()?.click();
    return document.querySelector('[data-testid="permission-card"]')?.getAttribute('data-trusted-ready') ?? null;
  });
  await expect.poll(() => answered(posts, 'e2e-hold-1')).toBe(true);
  await expect(permissionCard(tab)).toContainText('echo two');
  // the second click reached no card that takes an answer: the first was leaving or gone, the next one held
  expect(second === null || second === 'false').toBe(true);
  await promptReady(permissionCard(tab));
  expect(await answered(posts, 'e2e-hold-2')).toBe(false);

  await yes(tab).click();
  await expect.poll(() => answered(posts, 'e2e-hold-2')).toBe(true);
  await expect(permissionCard(tab)).toHaveCount(0);
});

test('a dock card answers only while the whole of it is in view, at every zoom, and a tall one fits the smallest window', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible())!;
    if (window.isMaximized()) window.unmaximize();
    window.setSize(size.width, size.height);
  }, SMALLEST);
  await expect.poll(() => tab.evaluate(() => innerHeight)).toBeLessThan(SMALLEST.height);
  const posts = await recordPosts(app, tab);

  // far more text than the window is tall, and three more cards under it, so the dock outgrows the page
  const long = Array.from({ length: 300 }, (_, line) => `Line ${line + 1} of what the server asks.`).join('\n');
  await hostMessage(app, tab, elicitation('e2e-tall', long));
  await hostMessage(app, tab, bash('e2e-under-1', 'echo under'));
  await hostMessage(app, tab, { type: 'requestSkillApproval', toolUseId: 'e2e-under-2', skillName: 'review-pr' });
  const tall = tab.getByTestId('elicitation-card');
  // every card is in the dock before anything is measured: one that mounts later moves the cards under it
  for (const card of [permissionCard(tab), tab.getByTestId('skill-card'), tall]) await promptReadyOrOutOfView(card);

  const page = tab.getByTestId('chat-dock').locator('xpath=..');
  const geometry = (): Promise<{ card: number; inner: number; scrolls: boolean }> => tall.evaluate((card) => {
    const scroller = document.querySelector('[data-testid="chat-dock"]')!.parentElement!;
    return { card: card.getBoundingClientRect().height, inner: innerHeight, scrolls: scroller.scrollHeight > scroller.clientHeight + 1 };
  });
  const decline = tall.getByRole('button', { name: 'Decline', exact: true });

  for (const zoom of [1, 0.9, 1.1]) {
    await app.evaluate(({ webContents }, [url, factor]) => {
      webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.setZoomFactor(factor as number);
    }, [tab.url(), zoom] as const);
    // one bounded card: 70% of the page however long its text is, on a page that scrolls
    await expect.poll(async () => {
      const measured = await geometry();
      return measured.scrolls && measured.card <= measured.inner * 0.7 + 1 && measured.card > measured.inner * 0.5;
    }, { message: `zoom ${zoom}` }).toBe(true);

    // brought whole into view, it takes an answer
    await page.evaluate((scroller) => {
      scroller.scrollTop = 0;
    });
    await tall.evaluate((card) => card.scrollIntoView({ block: 'center' }));
    await promptReady(tall);
    await expect(decline).not.toHaveAttribute('aria-disabled', 'true');

    // with its upper half scrolled out of the page, it is held, and says so on its controls
    await tall.evaluate((card) => {
      const scroller = document.querySelector('[data-testid="chat-dock"]')!.parentElement!;
      const rect = card.getBoundingClientRect();
      scroller.scrollTop += rect.top + rect.height / 2;
    });
    await expect(tall, `zoom ${zoom}`).toHaveAttribute(READY, 'false');
    await expect(decline).toHaveAttribute('aria-disabled', 'true');
    await decline.dispatchEvent('click');
    expect(await answered(posts, 'e2e-tall'), `zoom ${zoom}`).toBe(false);
  }

  await app.evaluate(({ webContents }, url) => {
    webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.setZoomFactor(1);
  }, tab.url());
  await page.evaluate((scroller) => {
    scroller.scrollTop = 0;
  });
  await tall.evaluate((card) => card.scrollIntoView({ block: 'center' }));
  await promptReady(tall);
  await decline.click();
  await expect.poll(() => answered(posts, 'e2e-tall')).toBe(true);

  // every card under it can be brought whole into view too, and then answers
  await permissionCard(tab).evaluate((card) => card.scrollIntoView({ block: 'nearest' }));
  await promptReady(permissionCard(tab));
  await yes(tab).click();
  await expect.poll(() => answered(posts, 'e2e-under-1')).toBe(true);
});

test('the attention ring never holds the card it plays on', async ({ home, launch }) => {
  test.setTimeout(120_000);
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  await hostMessage(app, tab, bash('e2e-attention', 'echo look'));
  await promptReady(permissionCard(tab));

  // every frame of the animation and of the visibility check's next reports after it
  const sampled = tab.evaluate(() => new Promise<{ played: boolean; states: string[] }>((resolve) => {
    const card = document.querySelector<HTMLElement>('[data-testid="permission-card"]')!;
    const states = new Set<string>();
    let played = false;
    let ended: number | undefined;
    const frame = (): void => {
      states.add(card.getAttribute('data-trusted-ready') ?? 'none');
      const playing = card.classList.contains('d-attention');
      played ||= playing;
      if (played && !playing) ended ??= performance.now();
      if (ended !== undefined && performance.now() - ended > 400) resolve({ played, states: [...states] });
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  await hostMessage(app, tab, { type: 'focusAttention', kind: 'approval' });
  expect(await sampled).toEqual({ played: true, states: ['true'] });
});
