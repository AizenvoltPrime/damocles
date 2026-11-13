import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { ForgeStub } from './support/forge-stub';
import { blameCard, blameLine3, blameText, detailRow, expandHead, graph, graphRow, HEAD_ROW, launchHistory, line, SUBJECT, type HistoryRun } from './support/forge-history';
import { expect, test } from './support/fixtures';
import type { DesktopApp, LaunchOptions } from './support/app';
import type { HermeticHome } from './support/hermetic';
import { codeEditor } from './support/editor';
import { recordedToasts } from './support/shell';
import { clickMenu } from './support/ui';
import { openedExternally } from './support/updates';

// History details (author avatars in the Graph and blame, #123 and !45 as links, "Merged in !45") with the commit's CI status
// row and "Open on server", against the forge stub's self-managed
// GitLab, which stands in for gitlab.indigital.gr at 127.0.0.1:<port>. The journey keeps the design's role and name selectors.

const stubs: ForgeStub[] = [];
test.afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()!.close();
});

async function launchRun(launch: (options?: LaunchOptions) => Promise<DesktopApp>, home: HermeticHome, width: number, settings?: Record<string, unknown>): Promise<HistoryRun> {
  return launchHistory(launch, home, width, settings, (stub) => stubs.push(stub));
}

/** The avatar's picture arrived through app://damocles/forge/avatar/<key> and decoded. */
async function expectPicture(avatar: Locator): Promise<void> {
  const image = avatar.locator('img');
  await expect(image).toHaveAttribute('src', /^app:\/\/damocles\/forge\/avatar\/[0-9a-f]{64}$/, { timeout: 30_000 });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), { timeout: 30_000 }).toBe(true);
}

/** The initial on the tint, and no picture: none was issued, or it failed and went. */
async function expectInitialOnly(avatar: Locator, initial: string): Promise<void> {
  await expect(avatar).toHaveText(initial);
  await expect(avatar.locator('img')).toHaveCount(0, { timeout: 30_000 });
}

/** Points at the blame text's start; locator.hover() would scroll Monaco's clipped lines natively. */
async function hoverBlame(shell: Page): Promise<void> {
  const box = await blameText(shell).boundingBox();
  if (!box) throw new Error('the blame text is not laid out');
  await shell.mouse.move(box.x + 24, box.y + box.height / 2);
}

/** Main's polite status for an open, once the newest toast says it. */
async function expectToast(app: ElectronApplication, message: string): Promise<void> {
  await expect.poll(async () => (await recordedToasts(app)).some((toast) => toast.message === message), { timeout: 30_000 }).toBe(true);
}

for (const width of [900, 1280]) {
  test(`history details journey at ${width} px, with the CI status row and Open on server`, async ({ home, launch }) => {
    test.setTimeout(240_000);
    const run = await launchRun(launch, home, width);
    const { app, shell, server, sha } = run;
    // the design's default state: the HEAD commit expanded, and the blame card open on one of its lines
    await expandHead(shell);
    await blameLine3(run);

    await expect(shell.getByRole('link', { name: 'Pipeline #4312 passed', exact: true })).toBeVisible({ timeout: 30_000 });
    await shell.getByRole('link', { name: 'Pipeline #4312 passed', exact: true }).click();
    await expect(shell.getByText(`Opened Pipeline #4312 on ${server} in your browser.`, { exact: true })).toBeVisible();
    await clickMenu(app, 'damocles.git.showLineBlame');
    await expect(blameCard(shell)).toBeVisible();
    await shell.getByRole('button', { name: 'Open Commit on Server', exact: true }).click();
    await expectToast(app, `Opened Commit ${sha.slice(0, 7)} on ${server} in your browser.`);
    await shell.getByRole('treeitem', { name: HEAD_ROW, exact: true }).press('ArrowLeft');
    await expect(shell.getByRole('link', { name: 'Pipeline #4312 passed', exact: true })).toBeHidden();
  });
}

test('#123 and !45 in a commit message are links that open on the server, and an expanded commit names its merge request', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchRun(launch, home, 1280);
  const { app, shell, server, stub } = run;
  const web = stub.indigital.webUrl;
  await expandHead(shell);

  const message = detailRow(shell, 'message');
  await expect(message.getByRole('link')).toHaveText(['#123', '!45']);
  await message.getByRole('link', { name: '#123', exact: true }).click();
  await expect.poll(() => openedExternally(app), { timeout: 30_000 }).toEqual([`${web}/platform/api/-/issues/123`]);
  await expectToast(app, `Opened #123 on ${server} in your browser.`);
  await message.getByRole('link', { name: '!45', exact: true }).click();
  await expect.poll(async () => (await openedExternally(app)).at(-1), { timeout: 30_000 }).toBe(`${web}/platform/api/-/merge_requests/45`);
  await expectToast(app, `Opened !45 on ${server} in your browser.`);

  // the CI status row names the merged MR beside the pipeline, and its !45 opens it too
  const status = detailRow(shell, 'status');
  await expect(status).toHaveAccessibleName('Pipeline #4312 passed, Merged in !45', { timeout: 30_000 });
  await expect(status.getByTestId('graph-merged-text')).toHaveText('Merged in !45');
  const before = (await openedExternally(app)).length;
  await status.getByRole('link', { name: '!45', exact: true }).click();
  await expect.poll(async () => (await openedExternally(app)).slice(before), { timeout: 30_000 }).toEqual([`${web}/platform/api/-/merge_requests/45`]);

  // the keyboard: the focused message row's links are in the tab order, and Enter opens the link, not the row
  await message.focus();
  await shell.keyboard.press('Tab');
  await expect(message.getByRole('link', { name: '#123', exact: true })).toBeFocused();
  await shell.keyboard.press('Enter');
  await expect.poll(async () => (await openedExternally(app)).slice(before), { timeout: 30_000 }).toEqual([`${web}/platform/api/-/merge_requests/45`, `${web}/platform/api/-/issues/123`]);
});

test('avatars show in the Graph, the commit details, the inline blame and its card; the card toggles and Escape closes it', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchRun(launch, home, 1280);
  const { app, shell, stub } = run;

  await expectPicture(graphRow(shell, SUBJECT).getByTestId('forge-avatar'));
  // Maria's picture is on a third-party origin the guard refuses here, Nikos's is an SVG: both keep the initial
  await expectInitialOnly(graphRow(shell, 'Bind the clone to the picked account').getByTestId('forge-avatar'), 'M');
  await expectInitialOnly(graphRow(shell, 'Refresh tokens one at a time').getByTestId('forge-avatar'), 'N');
  expect(stub.pictures.requests).toEqual([]);
  await expandHead(shell);
  await expectPicture(detailRow(shell, 'meta').getByTestId('forge-avatar'));

  await blameLine3(run);
  await expectPicture(blameText(shell).getByTestId('forge-avatar'));

  // the pointer on the blame text opens the card, and leaving both hides it
  await hoverBlame(shell);
  const card = blameCard(shell);
  await expect(card).toBeVisible();
  await expectPicture(card.getByTestId('forge-avatar'));
  await expect(card.getByTestId('blame-card-ref')).toHaveText('#123');
  await expect(card.getByTestId('blame-card-merged')).toHaveText('Merged in !45', { timeout: 30_000 });
  // the card covers the lines under its text, so the pointer leaves both for line 1, above it
  const first = (await line(shell, 1).boundingBox())!;
  await shell.mouse.move(first.x + 4, first.y + first.height / 2);
  await expect(card).toHaveCount(0);

  // Show Line Blame opens it with focus on its first action, and Escape closes it and gives the editor its focus back
  await clickMenu(app, 'damocles.git.showLineBlame');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Open Commit', exact: true })).toBeFocused();
  await shell.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect.poll(() => codeEditor(shell).evaluate((element) => element.contains(document.activeElement))).toBe(true);
});

test('with showAvatars off nothing shows an avatar and the server gets no avatar request', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchRun(launch, home, 1280, { 'damocles.desktop.forge.showAvatars': false });
  const { app, shell, stub } = run;
  await expandHead(shell);
  await expect(detailRow(shell, 'status')).toHaveAccessibleName('Pipeline #4312 passed, Merged in !45', { timeout: 30_000 });
  await expect(graph(shell).getByTestId('forge-avatar')).toHaveCount(0);

  await blameLine3(run);
  await expect(blameText(shell).getByTestId('forge-avatar')).toHaveCount(0);
  await clickMenu(app, 'damocles.git.showLineBlame');
  // the card keeps today's initial
  await expectInitialOnly(blameCard(shell).getByTestId('forge-avatar'), 'A');

  expect(stub.indigital.avatarRequests()).toEqual([]);
  expect(stub.pictures.requests).toEqual([]);
});
