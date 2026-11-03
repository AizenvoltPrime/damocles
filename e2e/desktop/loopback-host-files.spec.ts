import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { REMOTE_AUTO_FORWARD_PORTS_SETTING } from '../../src/desktop/local-services/desktop-configuration';
import { expect, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { activeTab, bufferText, codeEditor, DOCUMENT_END, editorShows, editorState, editorTab, quickOpen, quickPick, saveWithKeyboard } from './support/editor';
import { newLoopbackChat, targetDamoclesDir } from './support/loopback-agent';
import { cleanUp, endLeftoverDaemon, LOCAL_DAEMON, loopbackHome, LOOPBACK_ENV, LOOPBACK_TAG, openThroughLocalDaemon } from './support/loopback';
import { popupPage, popupToasts, recordToasts, shellPage } from './support/shell';
import { postFromWebview } from './support/ui';

const PLAN_NAME = 'ship-the-release-0123abcd.md';

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

test('a loopback chat\'s plan opens editable in a tab named with its host, saves on the target and reloads when it changes there, and any other path outside its projects stays closed with a toast', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const folder = remoteFolder(home);
  write(path.join(folder, 'notes.md'), '# Notes\n');
  // the daemon's own ~/.damocles/plans, which its plans rule checks against
  const plans = path.join(targetDamoclesDir(home), 'plans');
  const plan = write(path.join(plans, PLAN_NAME), '# Plan\n\n1. Ship it\n');
  // the loopback daemon sees every port this computer listens on; their forward toasts would open the popup while keys go to the shell
  writeUserSettings(home, { [REMOTE_AUTO_FORWARD_PORTS_SETTING]: false });
  const { app } = await launch(LOOPBACK_ENV);
  let failure: unknown;
  try {
    const shell = await shellPage(app);
    const { tab } = await newLoopbackChat(app, folder);
    await recordToasts(app);

    // the plan overlay's Open in editor posts the plan's path on the target
    await postFromWebview(tab, { type: 'openFile', filePath: plan });
    await expect(editorTab(shell, `${LOCAL_DAEMON}: ${PLAN_NAME}`)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => activeTab(app)).toMatchObject({ kind: 'code', readOnly: false, displayPath: fs.realpathSync.native(plan) });
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

    // a .txt in the plans folder and a file outside the plans folder exist on the target, and main opens neither
    const tabsBefore = (await editorState(app)).tabs.length;
    for (const target of [write(path.join(plans, 'notes.txt'), 'notes'), write(path.join(loopbackHome(home), '.bashrc'), 'export SECRET=1\n')]) {
      await postFromWebview(tab, { type: 'openFile', filePath: target });
      // the popup window opens with the first toast
      await expect(popupToasts(await popupPage(app)).filter({ hasText: `Could not open file: ${target}` })).toHaveCount(1);
    }
    expect((await editorState(app)).tabs).toHaveLength(tabsBefore);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // a test that failed midway still ends its daemon
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
  }
});

test('with the loopback project selected, Ctrl+P of a host path outside its projects opens it editable in a tab named with its host, saves it through the daemon, and returns it after a relaunch once the host connects', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const folder = remoteFolder(home);
  const file = write(path.join(home.root, 'host-only', 'notes.txt'), 'one\ntwo\nthree\n');
  const real = fs.realpathSync.native(file);
  const title = `${LOCAL_DAEMON}: notes.txt`;
  // the loopback daemon sees every port this computer listens on; their forward toasts would open the popup while keys go to the shell
  writeUserSettings(home, { [REMOTE_AUTO_FORWARD_PORTS_SETTING]: false });
  const first = await launch(LOOPBACK_ENV);
  // the app that can still reach the daemon, for the finally
  let current = first.app;
  let failure: unknown;
  try {
    await openThroughLocalDaemon(first.app, folder);
    const shell = await shellPage(first.app);
    // the selected project's host resolves the typed path; the file is the only row, with the host's chip
    const overlay = await quickOpen(first.app, `${file}:2:3`);
    const rows = quickPick(overlay).getByTestId('quick-pick-item');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('notes.txt');
    await expect(rows.first().getByTestId('quick-pick-badge')).toHaveText(LOCAL_DAEMON);
    await overlay.getByTestId('quick-pick-input').press('Enter');
    await expect(editorTab(shell, title)).toHaveAttribute('aria-selected', 'true');
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
    await expect(editorTab(again, title)).toBeVisible({ timeout: 60_000 });
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
