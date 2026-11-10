import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, selectChatPage, test } from './support/fixtures';
import { expectNoAxeViolations } from './support/axe';
import { approveDesign, DESIGN_APP, grounding, startDesignChat } from './support/design';
import { seedStubModel, REPO_ROOT, type HermeticHome } from './support/hermetic';
import { call, lastToolResult, startOpenAIStub, type OpenAIStub, type StubReply } from './support/openai-stub';
import { openProjectChat, setPageSize } from './support/screenshots';
import { shellPage } from './support/shell';
import { awaitTurnEnd } from './support/ui';
import type { JourneyFile, PreviewJourneyArgs } from '../../src/shared/types/design';
import type { DesignReplayProgress } from '../../src/desktop/preload/shell-channels';

// An interactive design runs an 11-step journey at base and xl, which core saves as JSON and a Playwright spec;
// FinishDesign refuses while a screen with controls has no journey and passes once that screen has none (the waiver); the
// parent's card says the journeys passed with their untested remainder; and Replay in preview plays the journey in the live
// tab, step by step, or all at once under reduced motion.

test.describe.configure({ timeout: 300_000 });

const SCREENS = path.join(REPO_ROOT, 'e2e', 'fixtures', 'design-journey', 'screens');

const DESIGN_MD = ['---', 'app: Laravel 11, Inertia, Vue 3, Tailwind 4', 'viewports:', '  primary: xl', '  checked: [base, xl]', '  journey: [base, xl]', '---', '# Contacts', ''].join('\n');

// The Contacts journey's PreviewJourney arguments, which the static parity page and its committed Playwright spec are pinned to (journey-playwright.test.ts).
const JOURNEY = JSON.parse(fs.readFileSync(path.join(DESIGN_APP, 'static', 'contacts.preview-journey.json'), 'utf8')) as PreviewJourneyArgs;
const COMMITTED_SPEC = path.join(DESIGN_APP, 'static', 'contacts.journey.spec.ts');

const screenFile = (name: string): string => fs.readFileSync(path.join(SCREENS, name), 'utf8');

/** An interactive design chat on the fixture app whose designer grounds itself and then runs `script(folder)`. */
async function interactiveDesign(home: HermeticHome, stub: OpenAIStub, app: ElectronApplication, script: (folder: string) => StubReply[]): Promise<{ parent: Page; design: Page; folder: string }> {
  const parent = await openProjectChat(app, home.project);
  const { design, folder } = await startDesignChat(app, parent, stub, home, { fidelity: 'Interactive prototype', script: (designDir) => [...grounding(designDir, DESIGN_MD), ...script(designDir)] });
  return { parent, design, folder };
}

/** Records every replay progress message main posts to the shell from now on; the one listener stays registered across calls. */
async function recordReplay(shell: Page): Promise<void> {
  await shell.evaluate(() => {
    const target = window as unknown as { replayLog?: unknown[] };
    const listening = target.replayLog !== undefined;
    target.replayLog = [];
    if (!listening) window.damoclesShell!.onDesignReplay((progress) => target.replayLog!.push({ ...progress, at: performance.now() }));
  });
}

/** The zoom factor of the design preview view showing in the window. */
async function previewZoom(app: ElectronApplication): Promise<number | undefined> {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const view = win.contentView.children.find((child) => child instanceof WebContentsView && child.getVisible() && child.webContents.getURL().startsWith('damocles-design://')) as Electron.WebContentsView | undefined;
    return view?.webContents.getZoomFactor();
  });
}

async function replayLog(shell: Page): Promise<Array<DesignReplayProgress & { at: number }>> {
  return shell.evaluate(() => (window as unknown as { replayLog: Array<DesignReplayProgress & { at: number }> }).replayLog);
}

test('an 11-step journey passes at base and xl, gates FinishDesign per screen, and replays in the live preview tab', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl, ['text', 'image']);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const { parent, design, folder } = await interactiveDesign(home, stub, app, (designDir) => [
      call('write', { path: path.join(designDir, 'screens', 'S1-contacts.html'), content: screenFile('S1-contacts.html') }),
      // S2 has a control and no journey, so the first FinishDesign names it.
      call('write', { path: path.join(designDir, 'screens', 'S2-help.html'), content: screenFile('S2-help.html') }),
      call('PreviewJourney', { ...JOURNEY }),
      call('FinishDesign', { summary: 'The contacts list with its Add contact dialog.' }),
      // Without its button S2 has no interactive control, which DesignCheck verifies, so it passes through the waiver.
      call('write', { path: path.join(designDir, 'screens', 'S2-help.html'), content: screenFile('S2-help-static.html') }),
      call('FinishDesign', { summary: 'The contacts list with its Add contact dialog, and a help page.' }),
      { chunks: ['The journey is saved for the implementation to replay.'] },
    ]);
    // Tall enough that the virtualized transcript keeps every card of the run mounted.
    await setPageSize(design, 900, 6000);
    await approveDesign(design);
    await expect.poll(() => stub.replies.length, { timeout: 120_000 }).toBe(0);
    await awaitTurnEnd(design);

    // The card: every step passed at both widths, 11/11, with the untested remainder and the spec it wrote.
    const card = design.getByTestId('preview-journey-card');
    await expect(card).toHaveAttribute('data-passed', 'true');
    await expect(card.getByTestId('preview-journey-counter').locator('[aria-hidden="true"]')).toHaveText('11/11');
    const chips = card.getByTestId('preview-journey-width');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText('base · 390 px');
    await expect(chips.nth(1)).toContainText('xl · 1280 px');
    for (const chip of await chips.all()) {
      await expect(chip).toHaveAttribute('data-passed', 'true');
      await expect(chip).toContainText('11/11');
    }
    await expect(card.locator('[data-testid="preview-journey-step"][data-state="pass"]')).toHaveCount(11);
    await expect(card.getByTestId('preview-journey-step-text').first()).toHaveText('Type “Grace” into field with placeholder “Search contacts”');
    await expect(card.getByTestId('preview-journey-untested')).toContainText('Search with no results');
    await expect(card.getByTestId('preview-journey-files')).toContainText('screens/S1-contacts.journey.spec.ts');
    await expectNoAxeViolations(design, '[data-testid="preview-journey-card"]');

    // Core wrote the journey and its Playwright spec beside the screen.
    const journey = JSON.parse(fs.readFileSync(path.join(folder, 'screens', 'S1-contacts.journey.json'), 'utf8')) as JourneyFile;
    expect(journey.steps).toHaveLength(11);
    expect(journey.viewports.map((viewport) => viewport.width)).toEqual([390, 1280]);
    expect(journey.results.map((result) => [result.width, result.passed, result.steps.length])).toEqual([[390, true, 11], [1280, true, 11]]);
    expect(journey.untested).toEqual(JOURNEY.untested);
    // This run's inputs are the committed spec's: the same steps, screen S1, the default state and widths 390 and 1280.
    expect(fs.readFileSync(path.join(folder, 'screens', 'S1-contacts.journey.spec.ts'), 'utf8')).toBe(fs.readFileSync(COMMITTED_SPEC, 'utf8'));

    // The first FinishDesign names the screen that has controls and no journey; the second passes with S2 waived.
    const finishes = design.getByTestId('finish-design-card');
    const refused = finishes.filter({ hasText: 'Finish refused' });
    await expect(refused).toHaveCount(1);
    const missing = refused.getByTestId('design-check-issue').filter({ hasText: 'journey.required' });
    await expect(missing).toHaveCount(1);
    await expect(missing).toContainText('S2');
    await expect(finishes.filter({ hasText: 'Design v1 finished' })).toHaveCount(1);

    // The parent's card: the journeys passed, S1's untested remainder, and S2's waiver.
    await setPageSize(parent, 900, 6000);
    const result = parent.getByTestId('design-result-card');
    await expect(result).toHaveCount(1);
    await expect(result.getByTestId('design-result-subtitle')).toContainText('check passed · journeys passed');
    await expect(result.locator('[data-testid="design-result-journey"][data-screen="S1"]')).toHaveText('S1 untested: Saving a contact · Deleting a contact · Search with no results');
    await expect(result.locator('[data-testid="design-result-journey"][data-screen="S2"]')).toHaveText('S2 no interactive controls, so no journey needed');
    await expectNoAxeViolations(parent, '[data-testid="design-result-card"]');

    // Replay in preview: main drives the live S1 tab step by step, and the strip in its gutter follows each step.
    await selectChatPage(app, design);
    const shell = await shellPage(app);
    await shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]', { hasText: 'S1' }).last().click();
    await expect(shell.getByTestId('design-preview-status')).toHaveCount(0, { timeout: 30_000 });
    // The 1280 px tab shows zoomed out in the pane, so the replay's hit test and clicks run on a view whose zoom is below 1.
    await expect.poll(() => previewZoom(app)).toBeLessThan(1);
    await recordReplay(shell);
    const replay = card.getByTestId('preview-journey-replay');
    await expect(replay).toHaveText('Replay in preview');
    await replay.click();
    const strip = shell.getByTestId('design-preview-replay');
    await expect(strip).toHaveAttribute('data-outcome', 'running', { timeout: 30_000 });
    await expect(replay).toBeDisabled();
    await expect(strip.locator('[data-testid="design-preview-replay-dot"][data-state="active"]')).toHaveCount(1);
    await expectNoAxeViolations(shell, '[data-testid="design-preview-replay"]');
    await expect(strip).toHaveAttribute('data-outcome', 'passed', { timeout: 120_000 });
    await expect(shell.getByTestId('design-preview-replay-status')).toHaveText('Replay passed · 11/11');
    await expect(replay).toBeEnabled({ timeout: 30_000 });
    await expect(card.getByTestId('preview-journey-replay-refusal')).toHaveCount(0);
    const paced = await replayLog(shell);
    // Every step ran on its own beat: the active index walked 0..10, each result arriving after the one before it.
    expect(paced.every((progress) => !progress.reducedMotion)).toBe(true);
    expect([...new Set(paced.flatMap((progress) => (progress.active === null ? [] : [progress.active])))]).toEqual([...Array(11).keys()]);
    expect(paced.at(-1)).toMatchObject({ done: true, active: null });
    expect(paced.at(-1)!.results).toHaveLength(11);
    // The strip clears after the replay and the readout comes back.
    await expect(strip).toHaveCount(0, { timeout: 15_000 });
    await expect(shell.getByTestId('design-preview-readout')).toBeVisible();

    // Reduced motion: main paces nothing and the strip shows the results at once, with no entrance on its dots.
    await design.emulateMedia({ reducedMotion: 'reduce' });
    await shell.emulateMedia({ reducedMotion: 'reduce' });
    await recordReplay(shell);
    await replay.click();
    await expect(strip).toHaveAttribute('data-outcome', 'passed', { timeout: 60_000 });
    await expect(strip.locator('[data-testid="design-preview-replay-dot"][data-state="pass"]')).toHaveCount(11);
    expect(await strip.locator('[data-testid="design-preview-replay-dot"]').evaluateAll((dots) => dots.some((dot) => dot.className.includes('d-badge-pop')))).toBe(false);
    await expect(replay).toBeEnabled({ timeout: 30_000 });
    const instant = await replayLog(shell);
    expect(instant.length).toBeGreaterThan(0);
    expect(instant.every((progress) => progress.reducedMotion)).toBe(true);
    expect(instant.at(-1)).toMatchObject({ done: true });
    // With no pacing the whole replay takes less time than the paced one did.
    const span = (log: Array<{ at: number }>): number => log.at(-1)!.at - log[0]!.at;
    expect(span(instant)).toBeLessThan(span(paced));
  } finally {
    await stub.close();
  }
});

test('a journey matches a part of a name, presses Escape in a dialog that takes no focus, and scrolls a feed to its next batch', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl, ['text', 'image']);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const dialog = { role: 'dialog', name: 'Filters' };
    const steps = [
      { action: 'assert', target: { role: 'button', name: 'save', exact: false }, expect: { visible: true } },
      { action: 'click', target: { role: 'button', name: 'Open filters' } },
      { action: 'assert', target: dialog, expect: { visible: true } },
      { action: 'press', target: dialog, key: 'Escape' },
      { action: 'assert', target: dialog, expect: { visible: false } },
      { action: 'scroll', to: 'end' },
      { action: 'assert', target: { text: 'Item 21' }, expect: { visible: true } },
    ];
    const { design, folder } = await interactiveDesign(home, stub, app, (designDir) => [
      call('write', { path: path.join(designDir, 'screens', 'S3-feed.html'), content: screenFile('S3-feed.html') }),
      call('PreviewJourney', { screen: 'screens/S3-feed.html', steps, untested: ['Loading past the second batch'] }),
      { chunks: ['The feed journey passed.'] },
    ]);
    await setPageSize(design, 900, 6000);
    await expect.poll(() => stub.replies.length, { timeout: 120_000 }).toBe(0);
    await awaitTurnEnd(design);

    expect(lastToolResult(stub)).toContain('The journey of S3 passed at 390 px and 1280 px: 7/7 steps.');
    const card = design.getByTestId('preview-journey-card');
    await expect(card).toHaveAttribute('data-passed', 'true', { timeout: 30_000 });
    await expect(card.getByTestId('preview-journey-counter').locator('[aria-hidden="true"]')).toHaveText('7/7');
    await expect(card.getByTestId('preview-journey-step-text').nth(5)).toHaveText('Scroll the page to its end');
    const journey = JSON.parse(fs.readFileSync(path.join(folder, 'screens', 'S3-feed.journey.json'), 'utf8')) as JourneyFile;
    expect(journey.results.map((result) => [result.width, result.passed])).toEqual([[390, true], [1280, true]]);
    const spec = fs.readFileSync(path.join(folder, 'screens', 'S3-feed.journey.spec.ts'), 'utf8');
    expect(spec).toContain('page.getByRole("button", { name: "save", exact: false })');
    expect(spec).toContain('await page.mouse.wheel(0, 100000);');
  } finally {
    await stub.close();
  }
});
