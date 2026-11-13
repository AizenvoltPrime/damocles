import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn } from './support/forge';
import { CI_UI_FIXTURES, LOG_TICK_MS, type ForgeStub } from './support/forge-stub';
import { expect, test } from './support/fixtures';
import type { LaunchOptions, DesktopApp } from './support/app';
import type { HermeticHome } from './support/hermetic';
import { git, initRepo } from './support/git';
import { overlayViewState, readyOverlay } from './support/overlay';
import { openScmProject, scmSection, setSection } from './support/scm';
import { setReducedMotion } from './support/screenshots';
import { setContentSize } from './support/settings';
import { openedExternally, recordOpenExternal } from './support/updates';

// The CI chip and job list, the job log tab and the commit status row, against the forge stub, whose gitlab.com carries the
// sample pipeline #4312. The journeys keep the design's role and name selectors.

const GITLAB = 'gitlab.com';
const TOKEN = 'glpat-stubAlexiosSApi000000008';
const RUNNING = 'Pipeline #4312 running, 3 of 5 jobs done';

interface CiRun {
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  readonly shell: Page;
  readonly dir: string;
}

const stubs: ForgeStub[] = [];
test.afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()!.close();
});

/** The app signed in as alexios-s on gitlab.com, showing a project on the design's branch, whose origin is on the stub. */
async function launchCi(launch: (options?: LaunchOptions) => Promise<DesktopApp>, home: HermeticHome, width: number): Promise<CiRun> {
  const started = await startStubOnTestCa(home);
  const { stub } = started;
  stubs.push(stub);
  const { app } = await launchReady(launch, forgeEnv(started));
  await setContentSize(app, width, 900);
  await recordOpenExternal(app);
  await inAccounts(app, (overlay) => tokenSignIn(overlay, GITLAB, TOKEN, 'alexios-s'));

  const dir = path.join(home.root, 'projects', 'damocles');
  fs.mkdirSync(dir, { recursive: true });
  await initRepo(home, dir, { 'a.ts': 'export const a = 1;\n' }, { branch: CI_UI_FIXTURES.branch });
  await git(home, dir, 'remote', 'add', 'origin', `${stub.gitlab.webUrl}/alexios-s/damocles.git`);
  await git(home, dir, 'update-ref', `refs/remotes/origin/${CI_UI_FIXTURES.branch}`, 'HEAD');
  await git(home, dir, 'branch', '--set-upstream-to', `origin/${CI_UI_FIXTURES.branch}`, CI_UI_FIXTURES.branch);
  stub.gitlab.ci.reset();
  const shell = await openScmProject(app, dir);
  await expect(ciChip(shell)).toHaveAccessibleName(RUNNING, { timeout: 30_000 });
  return { app, stub, shell, dir };
}

const ciChip = (shell: Page): Locator => scmSection(shell).getByTestId('forge-ci-chip');
const pipelineDialog = (overlay: Page): Locator => overlay.getByRole('dialog', { name: 'Pipeline #4312', exact: true });
const jobLog = (shell: Page, job = 'unit'): Locator => shell.getByRole('log', { name: `${job} log`, exact: true });

async function openJobList(run: CiRun): Promise<Page> {
  const overlay = await readyOverlay(run.app);
  await ciChip(run.shell).click();
  await expect(pipelineDialog(overlay)).toBeVisible();
  return overlay;
}

/** From the CI chip's job list, Open log for unit opens its tab in the editor. */
async function openUnitLog(run: CiRun): Promise<void> {
  const overlay = await openJobList(run);
  await overlay.getByRole('button', { name: 'Open log: unit', exact: true }).click();
  await expect(pipelineDialog(overlay)).toBeHidden();
  await overlayHidden(run.app);
  await expect(jobLog(run.shell)).toBeVisible({ timeout: 30_000 });
}

// main hides the overlay view once the popover's exit played; until then a click lands on the overlay, not the shell
const overlayHidden = (app: ElectronApplication): Promise<void> => expect.poll(async () => (await overlayViewState(app)).visible).toBe(false);

const traceReads = (stub: ForgeStub): number => stub.gitlab.requests.filter((request) => request.path.endsWith(`/jobs/${CI_UI_FIXTURES.gitlabJobs.unit}/trace`)).length;
const pipelineReads = (stub: ForgeStub): number => stub.gitlab.requests.filter((request) => /\/pipelines(\/\d+(\/jobs)?)?$/.test(request.path)).length;

for (const width of [768, 1280]) {
  test(`CI chip, job log tab and CI status link journeys at ${width} px`, async ({ home, launch }) => {
    test.setTimeout(240_000);
    const run = await launchCi(launch, home, width);
    const { shell, app, stub } = run;

    // the CI chip, the job list, Retry e2e ↔ Cancel e2e, Escape back to the chip
    const overlay = await readyOverlay(app);
    await shell.getByRole('button', { name: RUNNING, exact: true }).click();
    await expect(pipelineDialog(overlay)).toBeVisible();
    await overlay.getByRole('button', { name: 'Retry e2e', exact: true }).click();
    await expect(overlay.getByRole('button', { name: 'Cancel e2e', exact: true })).toBeVisible();
    await expect(overlay.getByRole('button', { name: 'Cancel e2e', exact: true })).toBeFocused();
    await overlay.getByRole('button', { name: 'Cancel e2e', exact: true }).press('Escape');
    await expect(pipelineDialog(overlay)).toBeHidden();
    await overlayHidden(app);
    await expect(ciChip(shell)).toBeFocused();

    // the job log tab: content, Fold and Unfold, Timestamps, Cancel job → Retry job
    await openUnitLog(run);
    const log = jobLog(shell);
    await expect(log).toContainText('npm ci');
    await shell.getByRole('button', { name: 'Fold Executing "step_script" stage of the job script', exact: true }).click();
    await expect(shell.getByRole('button', { name: 'Unfold Executing "step_script" stage of the job script', exact: true })).toBeVisible();
    await shell.getByRole('button', { name: 'Timestamps', exact: true }).click();
    await expect(log).toContainText('Preparing the');
    await shell.getByRole('button', { name: 'Cancel job', exact: true }).click();
    await expect(shell.getByRole('button', { name: 'Retry job', exact: true })).toBeVisible();

    // the commit's CI status links the pipeline, which opens on its server as a user click
    const sha = (await git(home, run.dir, 'rev-parse', 'HEAD')).trim();
    stub.gitlab.ci.sha = sha;
    stub.gitlab.ci.pipelineState = 'success';
    await setSection(shell, 'graph-section', true);
    const graph = shell.getByTestId('graph-section');
    await graph.getByTestId('graph-row').first().click();
    const link = graph.getByRole('link', { name: 'Pipeline #4312 passed', exact: true });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await link.click();
    await expect(shell.getByText(`Opened Pipeline #4312 on ${GITLAB} in your browser.`, { exact: true })).toBeVisible();
    await expect.poll(() => openedExternally(app)).toEqual([expect.stringContaining(`/pipelines/${CI_UI_FIXTURES.pipeline.id}`)]);
  });
}

test('the job list updates a job live and opens its log; the job log tab appends every 3 s, follows, and shows New output once scrolled away', async ({ foreground: _foreground, home, launch }) => {
  // a blurred window polls no CI, and another worker's app takes the focus as it opens or closes
  test.setTimeout(240_000);
  const run = await launchCi(launch, home, 1280);
  const { shell, stub } = run;

  // the job list's live job update: unit finishes while the list is open
  const overlay = await openJobList(run);
  const unitRow = overlay.getByTestId('forge-pipeline-job').filter({ hasText: 'unit' });
  await expect(unitRow).toHaveAttribute('data-state', 'running');
  stub.gitlab.ci.finishUnit('success');
  await expect(unitRow).toHaveAttribute('data-state', 'passed', { timeout: 30_000 });
  await expect(overlay.getByTestId('forge-pipeline-status')).toHaveText('unit passed. 4 of 5 jobs done. Pipeline #4312 passed.');
  // a running unit again for the log: Retry runs a new attempt, whose log grows
  await overlay.getByRole('button', { name: 'Retry unit', exact: true }).click();
  await expect(overlay.getByRole('button', { name: 'Cancel unit', exact: true })).toBeVisible();
  stub.gitlab.ci.freezeLog(false);
  await overlay.keyboard.press('Escape');
  await expect(pipelineDialog(overlay)).toBeHidden();
  await overlayHidden(run.app);

  // a short window, so a few appended lines run past the log's viewport
  await setContentSize(run.app, 1280, 560);
  await openUnitLog(run);
  const log = jobLog(shell);
  await expect(shell.getByTestId('job-log-running')).toHaveText('Running. New output appears every few seconds.');
  const rows = log.getByTestId('job-log-row');
  const before = await rows.count();
  await expect.poll(() => rows.count(), { timeout: 4 * LOG_TICK_MS + 10_000 }).toBeGreaterThan(before);
  await expect(shell.getByRole('button', { name: 'Follow', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // grow the log past the window, then scroll away: Follow turns off and later lines show New output
  await expect.poll(async () => log.evaluate((element) => element.scrollHeight > element.clientHeight + 40), { timeout: 120_000, intervals: [LOG_TICK_MS] }).toBe(true);
  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(shell.getByRole('button', { name: 'Follow', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const pill = shell.getByRole('button', { name: 'New output', exact: true });
  await expect(pill).toBeVisible({ timeout: 4 * LOG_TICK_MS + 10_000 });
  await pill.click();
  await expect(shell.getByRole('button', { name: 'Follow', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(pill).toBeHidden();
  await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(20);
});

test('polling stops while the window is blurred, an unchanged log answers 304, and reduced motion stops the spinner', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchCi(launch, home, 1280);
  const { app, shell, stub } = run;

  // reduced motion: the running chip keeps its spinner's shape and stops turning
  const spinner = ciChip(shell).getByTestId('forge-ci-chip-spinner');
  await expect(spinner).toHaveClass(/d-spinning/);
  const motion = (): Promise<{ readonly turns: string; readonly transform: string }> =>
    spinner.evaluate((element) => ({ turns: getComputedStyle(element).animationIterationCount, transform: getComputedStyle(element).transform }));
  await expect.poll(async () => (await motion()).turns).toBe('infinite');
  await setReducedMotion(app, true);
  // the global reduced-motion rule ends every animation at once, so the icon stands upright
  await expect.poll(motion).toEqual({ turns: '1', transform: 'none' });
  await expect(ciChip(shell).getByTestId('forge-ci-chip-icon')).toHaveAttribute('data-icon', 'running');
  await setReducedMotion(app, false);

  await openUnitLog(run);
  await expect.poll(() => traceReads(stub), { timeout: 2 * LOG_TICK_MS + 10_000 }).toBeGreaterThan(1);

  // an unchanged log: the poll still asks, and the stub answers 304
  stub.gitlab.ci.freezeLog(true);
  await expect.poll(() => stub.gitlab.ci.notModified, { timeout: 3 * LOG_TICK_MS + 10_000 }).toBeGreaterThan(0);
  stub.gitlab.ci.freezeLog(false);

  // blur: neither the log nor the status is polled until the window has focus again
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit('blur'));
  const traces = traceReads(stub);
  const pipelines = pipelineReads(stub);
  // longer than the 15 s status cadence of a running pipeline, so a status poll during the blur would show
  await new Promise((resolve) => setTimeout(resolve, 18_000));
  expect(traceReads(stub)).toBe(traces);
  expect(pipelineReads(stub)).toBe(pipelines);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit('focus'));
  await expect.poll(() => traceReads(stub), { timeout: 2 * LOG_TICK_MS + 10_000 }).toBeGreaterThan(traces);
});
