import type { Page } from '@playwright/test';
import { chatRequests } from '../desktop/support/openai-stub';
import { writeUserSettings } from '../desktop/support/hermetic';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { activeTab, codeEditor, conflictBar, diffEditor, DOCUMENT_END, editorShows, filesRow, openInEditor, quickOpen, quickPick, saveWithKeyboard } from '../desktop/support/editor';
import { moreActions, commitMessage, scmSection, setSection } from '../desktop/support/scm';
import { overlayPage, pressKeys, PRIMARY, shellPage } from '../desktop/support/shell';
import { openTerminal, runInTerminal, waitForOutputLine } from '../desktop/support/terminal';
import { answerDialogs, awaitTurnEnd } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import type { SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';

const read = (fixture: SshdFixture, file: string): Promise<string> => fixture.sh(`cat '${file}'`, 'dev');
const exists = async (fixture: SshdFixture, file: string): Promise<boolean> => (await fixture.sh(`if [ -e '${file}' ]; then echo yes; fi`, 'dev')).trim() === 'yes';

async function typeAtEnd(shell: Page, text: string): Promise<void> {
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type(text);
}

test('on an SSH project, Files, the editor, a terminal with shell integration, search and replace, Quick Open, git commit and push, and an agent turn all run on the target', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  await fixture.sh('mkdir -p /srv/origin.git && chown dev:dev /srv/origin.git');
  await fixture.sh([
    "git config --global user.name 'E2E Dev'",
    'git config --global user.email dev@prod-1.invalid',
    'git init -q --bare -b main /srv/origin.git',
    `git init -q -b main ${APP}`,
    `cd ${APP}`,
    'mkdir -p src',
    `printf 'export const remote = "needle";\\n' > src/remote.ts`,
    "printf '# Notes\\n' > notes.md",
    'git add -A',
    'git commit -q -m init',
    'git remote add origin /srv/origin.git',
    'git push -q -u origin main',
  ].join(' && '), 'dev');
  const stub = await startTargetStub(home, fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(app, hostId, APP);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const shell = await shellPage(app);
    const overlay = await overlayPage(app);

    // Files: create, rename, and a delete that is permanent after one confirmation saying so.
    await expect(filesRow(shell, 'src')).toBeVisible();
    expect(await shell.evaluate((projectKey) => window.damoclesShell!.createFile({ projectKey, relativeDir: '', name: 'made.txt', kind: 'file' }), key)).toEqual({ ok: true, relativePath: 'made.txt' });
    await expect.poll(() => exists(fixture, `${APP}/made.txt`)).toBe(true);
    expect(await shell.evaluate((projectKey) => window.damoclesShell!.renameFile({ projectKey, relativePath: 'made.txt', newName: 'renamed.txt' }), key)).toEqual({ ok: true, relativePath: 'renamed.txt' });
    await expect.poll(() => exists(fixture, `${APP}/renamed.txt`)).toBe(true);
    await expect(filesRow(shell, 'renamed.txt')).toBeVisible();
    const deleted = shell.evaluate((projectKey) => window.damoclesShell!.deleteFile({ projectKey, relativePath: 'renamed.txt' }), key);
    const confirm = overlay.getByRole('alertdialog');
    await expect(confirm).toContainText('It is deleted permanently on prod-1, which has no trash. This action is irreversible.');
    await confirm.getByRole('button', { name: 'Delete Permanently' }).click();
    expect(await deleted).toEqual({ ok: true });
    expect(await exists(fixture, `${APP}/renamed.txt`)).toBe(false);
    await expect(filesRow(shell, 'renamed.txt')).toHaveCount(0);

    // Editor: open, edit, save; a change on the target under a dirty buffer is a conflict.
    expect(await openInEditor(app, { projectKey: key, relativePath: 'notes.md' })).toMatchObject({ ok: true });
    await editorShows(shell, '# Notes');
    await typeAtEnd(shell, 'more');
    await saveWithKeyboard(app);
    await expect.poll(() => read(fixture, `${APP}/notes.md`)).toBe('# Notes\nmore');
    await typeAtEnd(shell, ' dirty');
    await fixture.sh(`printf '# Changed on the target\\n' > ${APP}/notes.md`, 'dev');
    await saveWithKeyboard(app);
    await expect(conflictBar(shell)).toBeVisible();

    // Search and replace, and Quick Open, list the target's ripgrep results.
    await pressKeys(app, '/shell/', 'H', [PRIMARY, 'shift']);
    await shell.getByTestId('search-query').fill('needle');
    await shell.getByTestId('search-query').press('Enter');
    const found = shell.locator('[data-testid="search-row"][data-row-kind="file"][data-path="src/remote.ts"]');
    // a refused or failed search shows its reason as an alert instead of rows, so a failure here names it
    const alerts = shell.getByTestId('search-section').getByRole('alert');
    await expect(found.or(alerts).first()).toBeVisible();
    expect(await alerts.allTextContents()).toEqual([]);
    await expect(found).toBeVisible();
    await shell.getByTestId('search-replace').fill('found');
    await shell.getByTestId('search-replace-all').click();
    await overlay.getByRole('alertdialog').getByRole('button', { name: 'Replace', exact: true }).click();
    await expect.poll(() => read(fixture, `${APP}/src/remote.ts`)).toBe('export const remote = "found";\n');
    const picker = quickPick(await quickOpen(app, 'remote'));
    await expect(picker.locator('[data-testid="quick-pick-item"]', { hasText: 'remote.ts' })).toBeVisible();
    await overlay.keyboard.press('Escape');

    // A terminal on the target, in the project folder, with shell integration.
    const terminalShell = await openTerminal(app);
    const state = await terminalShell.evaluate(() => window.damoclesShell!.terminal.getState());
    const terminal = state.terminals.find((candidate) => candidate.id === state.activeId)!;
    expect(terminal.projectKey).toBe(key);
    await expect.poll(async () => (await terminalShell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.find((candidate) => candidate.id === terminal.id)?.integrated, { timeout: 30_000 }).toBe(true);
    await runInTerminal(terminalShell, 'echo "on-$(uname -n) in $(pwd)"');
    await waitForOutputLine(terminalShell, `on-prod-1 in ${APP}`);

    // Git: the replace shows as a change, and a commit and a push land in the target's repositories.
    await setSection(shell, 'scm-section', true);
    const change = scmSection(shell).locator('[data-testid="scm-change"][data-group="workingTree"][data-path="src/remote.ts"]');
    await expect(change).toHaveAttribute('data-letter', 'M', { timeout: 60_000 });
    await change.focus();
    await change.getByTestId('scm-row-stage').click();
    await expect(scmSection(shell).locator('[data-testid="scm-change"][data-group="index"][data-path="src/remote.ts"]')).toBeVisible();
    await commitMessage(shell).fill('Replace on prod-1');
    await commitMessage(shell).press('ControlOrMeta+Enter');
    await expect.poll(() => fixture.sh(`git -C ${APP} log -1 --format=%s`, 'dev').then((out) => out.trim())).toBe('Replace on prod-1');
    await moreActions(app, shell, 'push');
    await expect.poll(() => fixture.sh('git --git-dir=/srv/origin.git log -1 --format=%s main', 'dev').then((out) => out.trim()), { timeout: 60_000 }).toBe('Replace on prod-1');
    await setSection(shell, 'scm-section', false);

    // One agent turn: the chat's bash tool runs on the target, and the stub hears its result.
    const tab = await newRemoteChat(app, key);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'uname -n' } }] }, { chunks: ['Ran on the host.'] });
    await sendPrompt(tab, 'Where do you run?');
    const card = tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');
    await expect(card.getByTestId('permission-title')).toHaveText('Run this command on prod-1?');
    await card.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(tab.getByText('Ran on the host.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const toolResults = chatRequests(stub).flatMap((request) => ((request.body as { messages?: { role: string; content: unknown }[] }).messages ?? []).filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content)));
    expect(toolResults.some((result) => result.includes('prod-1'))).toBe(true);

    await shutdownHostDaemon(app, hostId, fixture);
    // the quit's question about the conflicted buffer, whose text the test leaves unsaved
    await answerDialogs(app, { 'Do you want to save': "Don't Save" });
  } finally {
    await stub.close();
  }
});

test('on an SSH project added through a symlinked folder, Source control opens its changes as the project\'s files and the editor shows their quick diff, while a link inside it that leads outside stays refused', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const real = '/srv/real-app';
  const linked = '/srv/linked-app';
  await fixture.sh(`mkdir -p ${real} && chown dev:dev ${real} && ln -s ${real} ${linked}`);
  await fixture.sh([
    "git config --global user.name 'E2E Dev'",
    'git config --global user.email dev@prod-1.invalid',
    `git init -q -b main ${real}`,
    `cd ${real}`,
    "printf 'one\ntwo\nthree\n' > app.ts",
    'git add -A',
    'git commit -q -m init',
    "printf 'one\nTWO\nthree\n' > app.ts",
    'ln -s /etc out',
  ].join(' && '), 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, linked);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, linked);
  const shell = await shellPage(app);

  // core names the change under the realpath; it opens as the linked project's file
  await setSection(shell, 'scm-section', true);
  const changed = scmSection(shell).locator('[data-testid="scm-change"][data-group="workingTree"][data-path="app.ts"]');
  await expect(changed).toHaveAttribute('data-letter', 'M', { timeout: 60_000 });
  await changed.click();
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  expect(await activeTab(app)).toMatchObject({ kind: 'diff', projectKey: key, relativePath: 'app.ts' });

  // the editor's file, named as registered, finds its repository: the gutter marks the changed line
  expect(await openInEditor(app, { projectKey: key, relativePath: 'app.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'TWO');
  await expect.poll(() => codeEditor(shell).getAttribute('data-quick-diff'), { timeout: 60_000 }).toBe('2-2');

  // the target confines the file again: a link inside the project that leads to /etc opens nothing
  expect(await openInEditor(app, { projectKey: key, relativePath: 'out/hostname' })).toEqual({ ok: false, reason: 'outside' });
  await setSection(shell, 'scm-section', false);

  await shutdownHostDaemon(app, hostId, fixture);
});
