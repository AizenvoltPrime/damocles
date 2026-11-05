import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { REMOTE_AUTO_FORWARD_PORTS_SETTING } from '../../src/desktop/local-services/desktop-configuration';
import { expect, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { activeTab, bufferText, codeEditor, DOCUMENT_END, editorShows, editorState, editorTab, quickOpen, quickPick, saveWithKeyboard } from './support/editor';
import { newLoopbackChat, sendPrompt, startLoopbackStub, targetDamoclesDir } from './support/loopback-agent';
import { cleanUp, endLeftoverDaemon, LOCAL_DAEMON, loopbackHome, LOOPBACK_ENV, LOOPBACK_TAG, openThroughLocalDaemon } from './support/loopback';
import { shellPage } from './support/shell';
import { awaitTurnEnd, postFromWebview } from './support/ui';

const PLAN_NAME = 'ship-the-release-0123abcd.md';
// the shown card: one that answered leaves through a transition while the next one enters
const permissionCard = (tab: Page): Locator => tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');

// A folder outside the hermetic project, so the loopback project and the local one are told apart in every list.
function remoteFolder(home: HermeticHome): string {
  const folder = path.join(home.root, 'p', 'remote');
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function typeAtEnd(shell: Page, text: string): Promise<void> {
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type(text);
}

test('a loopback chat\'s plan opens editable in a tab named with its host, saves on the target and reloads when it changes there, and every other file outside its projects opens editable too', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const stub = await startLoopbackStub(home);
  const folder = remoteFolder(home);
  write(path.join(folder, 'notes.md'), '# Notes\n');
  // the daemon's own ~/.damocles/plans
  const plans = path.join(targetDamoclesDir(home), 'plans');
  const plan = write(path.join(plans, PLAN_NAME), '# Plan\n\n1. Ship it\n');
  // the loopback daemon sees every port this computer listens on; their forward toasts would open the popup while keys go to the shell
  writeUserSettings(home, { [REMOTE_AUTO_FORWARD_PORTS_SETTING]: false });
  const { app } = await launch(LOOPBACK_ENV);
  let failure: unknown;
  try {
    const shell = await shellPage(app);
    const { tab } = await newLoopbackChat(app, folder);

    // the plan overlay's Open in editor posts the plan's path on the target
    await postFromWebview(tab, { type: 'openFile', filePath: plan });
    // titled by the file's own name; the tooltip and the breadcrumb's first crumb name the host
    await expect(editorTab(shell, PLAN_NAME)).toHaveAttribute('aria-selected', 'true');
    await expect(editorTab(shell, PLAN_NAME)).toHaveAttribute('title', `${LOCAL_DAEMON}: ${fs.realpathSync.native(plan)}`);
    await expect(shell.locator('[data-testid="editor-breadcrumbs"] [data-crumb]').first()).toHaveText(LOCAL_DAEMON);
    await expect.poll(async () => activeTab(app)).toMatchObject({ kind: 'code', host: 'loopback', readOnly: false, displayPath: fs.realpathSync.native(plan) });
    await expect.poll(async () => {
      const state = await editorState(app);
      const documentId = state.tabs.find((candidate) => candidate.id === state.activeTabId)?.documentId;
      return documentId === undefined ? undefined : state.documents[documentId]?.languageId;
    }).toBe('markdown');
    await editorShows(shell, '1. Ship it');
    await typeAtEnd(shell, '2. Roll back');
    await saveWithKeyboard(app);
    await expect.poll(() => fs.readFileSync(plan, 'utf8')).toBe('# Plan\n\n1. Ship it\n2. Roll back');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(false);

    // the agent rewrites the plan on the target: the clean tab takes the new text once the host's watch reports it
    await expect.poll(async () => {
      fs.writeFileSync(plan, '# Plan\n\n1. Rewritten by the agent\n');
      return bufferText(shell);
    }, { timeout: 30_000, intervals: [500] }).toContain('1. Rewritten by the agent');

    // a .txt beside the plan and the target home's .bashrc open editable, each in a tab named with its host
    const notes = write(path.join(plans, 'notes.txt'), 'plan notes\n');
    const bashrc = write(path.join(loopbackHome(home), '.bashrc'), 'export EDITOR=vi\n');
    for (const [target, text] of [[notes, 'plan notes'], [bashrc, 'export EDITOR=vi']] as const) {
      await postFromWebview(tab, { type: 'openFile', filePath: target });
      await expect(editorTab(shell, path.basename(target))).toHaveAttribute('aria-selected', 'true');
      await expect.poll(async () => activeTab(app)).toMatchObject({ kind: 'code', readOnly: false, displayPath: fs.realpathSync.native(target) });
      await editorShows(shell, text);
    }
    // the .bashrc tab's save lands on the target through the daemon
    await typeAtEnd(shell, 'export PAGER=less');
    await saveWithKeyboard(app);
    await expect.poll(() => fs.readFileSync(bashrc, 'utf8')).toBe('export EDITOR=vi\nexport PAGER=less');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(false);

    // an Edit approval of .bashrc shows the file's text on the target as its original, beside the proposal
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: bashrc, old_string: 'PAGER=less', new_string: 'PAGER=more' } }] },
      { chunks: ['Edited the bashrc.'] },
    );
    await sendPrompt(tab, 'Change the pager');
    await expect(permissionCard(tab)).toBeVisible({ timeout: 60_000 });
    await permissionCard(tab).getByRole('button', { name: 'Open diff' }).click();
    await expect(tab.getByTestId('editor-overlay')).toHaveAttribute('data-purpose', 'proposal');
    const diff = tab.getByTestId('editor-diff-view');
    await expect(diff).toHaveAttribute('data-monaco-ready', 'true');
    await expect(diff.locator('.editor.original .view-line', { hasText: 'export PAGER=less' })).toBeVisible();
    await expect(diff.locator('.editor.modified .view-line', { hasText: 'export PAGER=more' })).toBeVisible();
    await tab.getByTestId('editor-overlay-close').click();
    await permissionCard(tab).getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(tab.getByText('Edited the bashrc.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    expect(fs.readFileSync(bashrc, 'utf8')).toBe('export EDITOR=vi\nexport PAGER=more');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // a test that failed midway still ends its daemon
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
  }
});

test('with the loopback project selected, Ctrl+P lists the host\'s home on ~/ with its chip, and a host path outside its projects opens editable in a tab named by its file with the host in its tooltip, saves it through the daemon, and returns it after a relaunch once the host connects', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const folder = remoteFolder(home);
  const file = write(path.join(home.root, 'host-only', 'notes.txt'), 'one\ntwo\nthree\n');
  const real = fs.realpathSync.native(file);
  const title = 'notes.txt';
  // exact, since the loop-notes.txt tab holds the same text
  const notesTab = (page: Page) => page.locator('[data-testid="editor-tab"]', { has: page.getByTestId('editor-tab-title').getByText(title, { exact: true }) });
  // the loopback daemon sees every port this computer listens on; their forward toasts would open the popup while keys go to the shell
  writeUserSettings(home, { [REMOTE_AUTO_FORWARD_PORTS_SETTING]: false });
  const first = await launch(LOOPBACK_ENV);
  // the app that can still reach the daemon, for the finally
  let current = first.app;
  let failure: unknown;
  try {
    await openThroughLocalDaemon(first.app, folder);
    const shell = await shellPage(first.app);

    // ~/ lists the host's home, each row with the host's chip, and a file row there opens editable in a tab named with its host
    const homeFile = write(path.join(loopbackHome(home), 'loop-notes.txt'), 'from the host home\n');
    const browse = await quickOpen(first.app, '~/');
    const listed = quickPick(browse).getByTestId('quick-pick-item').filter({ hasText: 'loop-notes.txt' });
    await expect(listed).toHaveCount(1);
    await expect(listed.getByTestId('quick-pick-badge')).toHaveText(LOCAL_DAEMON);
    await browse.getByTestId('quick-pick-input').fill('~/loop-');
    await expect(quickPick(browse).getByTestId('quick-pick-item')).toHaveCount(1);
    await browse.getByTestId('quick-pick-input').press('Enter');
    await expect(editorTab(shell, 'loop-notes.txt')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => activeTab(first.app)).toMatchObject({ kind: 'code', readOnly: false, displayPath: fs.realpathSync.native(homeFile) });
    await editorShows(shell, 'from the host home');

    // the selected project's host resolves the typed path; the file is the first row, with the host's chip
    const overlay = await quickOpen(first.app, `${file}:2:3`);
    const rows = quickPick(overlay).getByTestId('quick-pick-item');
    await expect(rows.first()).toContainText('notes.txt');
    await expect(rows.first().getByTestId('quick-pick-badge')).toHaveText(LOCAL_DAEMON);
    await overlay.getByTestId('quick-pick-input').press('Enter');
    await expect(notesTab(shell)).toHaveAttribute('aria-selected', 'true');
    await expect(notesTab(shell)).toHaveAttribute('title', `${LOCAL_DAEMON}: ${fs.realpathSync.native(file)}`);
    await expect.poll(async () => activeTab(first.app)).toMatchObject({ kind: 'code', readOnly: false, displayPath: real });
    await editorShows(shell, 'three');
    await typeAtEnd(shell, 'four');
    await saveWithKeyboard(first.app);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\nfour');
    await expect.poll(async () => (await activeTab(first.app))?.dirty).toBe(false);
    await first.close();

    // the launch connects the loopback daemon before the editor restores, so the tab reopens editable through the daemon, as one tab
    const second = await launch(LOOPBACK_ENV);
    current = second.app;
    const again = await shellPage(second.app);
    await expect(notesTab(again)).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => activeTab(second.app), { timeout: 60_000 }).toMatchObject({ kind: 'code', readOnly: false, displayPath: real });
    await editorShows(again, 'four');
    await typeAtEnd(again, '\nfive');
    await saveWithKeyboard(second.app);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\nfour\nfive');
    expect((await editorState(second.app)).tabs.filter((tab) => tab.title === title)).toHaveLength(1);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(current, home));
  }
});
