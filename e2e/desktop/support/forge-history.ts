import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { addGitlabServer, forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn } from './forge';
import type { ForgeStub } from './forge-stub';
import { expect } from './fixtures';
import type { DesktopApp, LaunchOptions } from './app';
import { writeUserSettings, type HermeticHome } from './hermetic';
import { codeEditor, editorShows, openInEditor } from './editor';
import { git, initRepo } from './git';
import { openScmProject, setSection } from './scm';
import { setContentSize } from './settings';
import { recordToasts, selectedProjectKey } from './shell';
import { recordOpenExternal } from './updates';

// The history details of the design on the forge stub's self-managed GitLab (gitlab.indigital.gr's stand-in at 127.0.0.1:<port>), for
// forge-history.spec.ts and its screenshots.

const TOKEN = 'glpat-stubIndigitalAstefApi00006';
const BRANCH = 'feature/forge-accounts';
export const SUBJECT = 'Add the account chip to Source Control (#123)';
export const MESSAGE = `${SUBJECT}\n\nShows the bound account per server, marked auto\nwhen Damocles chose it. Follow-up to !45.`;
export const LINES = Array.from({ length: 6 }, (_, index) => `export const line${index + 1} = ${index + 1};`);
// the HEAD row's name in the Graph's format: subject, badges, author, age, HEAD
export const HEAD_ROW = `${SUBJECT}, current branch ${BRANCH}, remote branch origin/${BRANCH}, Alexios Stefanopoulos, 2 hours ago, current`;
const HOUR_MS = 3_600_000;

export interface HistoryRun {
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  readonly shell: Page;
  readonly dir: string;
  readonly sha: string;
  // the self-managed server's name in the app: its host, 127.0.0.1:<port>
  readonly server: string;
}

/** A commit by `author` dated `ago` ms back, changing one file. */
async function commitAs(home: HermeticHome, dir: string, author: string, ago: number, file: string, text: string, message: string): Promise<void> {
  fs.writeFileSync(path.join(dir, ...file.split('/')), text);
  await git(home, dir, 'add', '-A');
  await git(home, dir, { env: { GIT_AUTHOR_DATE: `@${Math.floor((Date.now() - ago) / 1000)} +0000` } }, 'commit', '-q', '--author', author, '-m', message);
}

/**
 * astefanopoulos signed in on the stub's self-managed GitLab, and platform/api (a project the stub gives him) at the design's
 * history: Nikos P. a day ago, Maria K. 5 hours ago and Alexios Stefanopoulos 2 hours ago at HEAD, whose pipeline #4312
 * passed. origin's branch is at HEAD, so the commit is on the server. onStub gets the started stub, which the caller closes.
 */
export async function launchHistory(launch: (options?: LaunchOptions) => Promise<DesktopApp>, home: HermeticHome, width: number, settings: Record<string, unknown> = {}, onStub: (stub: ForgeStub) => void = () => undefined): Promise<HistoryRun> {
  const started = await startStubOnTestCa(home);
  const { stub } = started;
  onStub(stub);
  if (Object.keys(settings).length > 0) writeUserSettings(home, settings);
  const { app } = await launchReady(launch, forgeEnv(started));
  await setContentSize(app, width, 900);
  await recordOpenExternal(app);
  await recordToasts(app);

  let server = '';
  await inAccounts(app, async (overlay) => {
    server = await addGitlabServer(overlay, stub.indigital);
    await tokenSignIn(overlay, server, TOKEN, 'astefanopoulos');
  });

  const dir = path.join(home.root, 'projects', 'proj');
  await initRepo(home, dir, { 'src/a.ts': `${LINES.join('\n')}\n`, 'src/b.ts': 'export const b = 1;\n' }, { branch: BRANCH });
  await commitAs(home, dir, 'Nikos P. <nikos.p@indigital.gr>', 24 * HOUR_MS, 'src/b.ts', 'export const b = 2;\n', 'Refresh tokens one at a time');
  await commitAs(home, dir, 'Maria K. <maria.k@indigital.gr>', 5 * HOUR_MS, 'src/b.ts', 'export const b = 3;\n', 'Bind the clone to the picked account');
  const changed = LINES.map((line, index) => (index === 2 ? 'export const line3 = 33;' : line));
  // a few minutes past two hours, so the age reads "2 hours ago" for the whole test
  await commitAs(home, dir, 'Alexios Stefanopoulos <a.stefanopoulos@indigital.gr>', 2 * HOUR_MS + 5 * 60_000, 'src/a.ts', `${changed.join('\n')}\n`, MESSAGE);
  const sha = await git(home, dir, 'rev-parse', 'HEAD');
  await git(home, dir, 'remote', 'add', 'origin', `${stub.indigital.webUrl}/platform/api.git`);
  await git(home, dir, 'update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
  await git(home, dir, 'branch', '--set-upstream-to', `origin/${BRANCH}`, BRANCH);
  stub.indigital.ci.reset();
  stub.indigital.ci.sha = sha;
  stub.indigital.ci.pipelineState = 'success';
  const shell = await openScmProject(app, dir);
  await setSection(shell, 'graph-section', true);
  await expect(graphRow(shell, SUBJECT)).toBeVisible({ timeout: 30_000 });
  return { app, stub, shell, dir, sha, server };
}

export const graph = (shell: Page): Locator => shell.getByTestId('graph-section');
export const graphRow = (shell: Page, subject: string): Locator => graph(shell).getByTestId('graph-row').filter({ has: shell.getByTestId('graph-subject').getByText(subject, { exact: true }) });
export const detailRow = (shell: Page, kind: string): Locator => graph(shell).locator(`[data-testid="graph-detail"][data-kind="${kind}"]`);
export const blameText = (shell: Page): Locator => codeEditor(shell).locator('.qd-blame');
export const blameCard = (shell: Page): Locator => shell.getByTestId('blame-card');
export const line = (shell: Page, n: number): Locator => codeEditor(shell).locator('.view-line', { hasText: `line${n} =` });

export async function expandHead(shell: Page): Promise<void> {
  await graphRow(shell, SUBJECT).getByTestId('graph-subject').click();
  await expect(graphRow(shell, SUBJECT)).toHaveAttribute('aria-expanded', 'true');
}

/** src/a.ts in the editor with the caret on line 3, Alexios Stefanopoulos's, and its blame shown. */
export async function blameLine3(run: HistoryRun): Promise<void> {
  expect((await openInEditor(run.app, { projectKey: await selectedProjectKey(run.app), relativePath: 'src/a.ts' })).ok).toBe(true);
  await editorShows(run.shell, LINES[0]!);
  await line(run.shell, 3).click({ position: { x: 1, y: 2 } });
  await expect(blameText(run.shell)).toContainText('Alexios Stefanopoulos, 2 hours ago', { timeout: 30_000 });
}
