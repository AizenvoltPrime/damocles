import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { MIN_SIDEBAR_WIDTH, DEFAULT_GRID_LAYOUT } from '../../src/desktop/preload/shell-channels';
import { expectNoAxeViolations } from './support/axe';
import { expect, test } from './support/fixtures';
import { readUserSettings, type HermeticHome } from './support/hermetic';
import { chooseMenuItem, menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { dragRow, groupHeader, LOCAL_GROUP, projectGroup, projectsAnnouncement, showInFiles, showView, shownProjectOrder, storedSidebar, THIS_COMPUTER, viewButton, viewToggle } from './support/projects';
import { filesRow, quickPick } from './support/editor';
import { selectedProjectKey, shellState } from './support/shell';
import { projectKeyOf, projectRow, projectsList, readyShell, sectionAction, sidebarSectionOf } from './support/shell-ui';
import { answerDialogs, askedDialogs, clickMenu, TRUST_PROMPT } from './support/ui';

const NAMES = ['alpha', 'beta', 'gamma'] as const;

// Three local projects as a user who added them in this order has them; alpha holds src/packages/api.
function seedProjects(home: HermeticHome): Record<(typeof NAMES)[number], string> {
  const parent = path.dirname(home.project);
  const folders = Object.fromEntries(NAMES.map((name) => [name, path.join(parent, name)])) as Record<(typeof NAMES)[number], string>;
  for (const folder of Object.values(folders)) fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(folders.alpha, 'src', 'packages', 'api'), { recursive: true });
  fs.writeFileSync(path.join(folders.alpha, 'src', 'packages', 'api', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(home.userData, 'projects.json'), `${JSON.stringify({ version: 1, projects: Object.values(folders) }, null, 2)}\n`);
  return folders;
}

async function keysByName(shell: Page): Promise<Record<string, string>> {
  const { projects } = await shell.evaluate(() => window.damoclesShell!.getState());
  return Object.fromEntries(projects.map((project) => [project.name, project.key]));
}

/** The names the list shows, top to bottom. */
async function shownNames(shell: Page): Promise<string[]> {
  const byKey = new Map(Object.entries(await keysByName(shell)).map(([name, key]) => [key, name]));
  return (await shownProjectOrder(shell)).map((key) => byKey.get(key) ?? key);
}

// The default open Files, Source control and Graph leave Projects two rows on a 1024x768 screen (macOS runners); a drag
// between the first and last row needs all three painted.
function seedSidebarWithRoomForProjects(home: HermeticHome): void {
  fs.writeFileSync(path.join(home.userData, 'window-layout.json'), JSON.stringify({
    version: 2,
    sidebar: { sidebarVisible: true, sidebarWidth: 264, sections: { projects: { collapsed: false, size: 180 }, chats: { collapsed: false }, files: { collapsed: true, size: 230 }, scm: { collapsed: true, size: 300 }, graph: { collapsed: true, size: 190 } }, grid: DEFAULT_GRID_LAYOUT },
  }));
}

async function readyProjects(shell: Page): Promise<void> {
  await expect(projectsList(shell).locator('[role="option"][data-project-key]')).toHaveCount(NAMES.length);
}

test('flat view: a dragged project keeps its place after a relaunch, and main wrote the order before the list moved', async ({ foreground: _foreground, home, launch }) => {
  seedProjects(home);
  seedSidebarWithRoomForProjects(home);
  const first = await launch();
  const shell = await readyShell(first.app);
  await readyProjects(shell);
  expect(await shownNames(shell)).toEqual(['alpha', 'beta', 'gamma']);
  await expect(viewButton(shell, 'flat')).toHaveAttribute('aria-pressed', 'true');
  const keys = await keysByName(shell);
  const selectedBefore = await selectedProjectKey(first.app);

  await dragRow(shell, projectRow(shell, keys.gamma!), projectRow(shell, keys.alpha!), 'above');
  await expect.poll(() => shownNames(shell)).toEqual(['gamma', 'alpha', 'beta']);
  // the store rule: remote-hosts.json holds the order by the time the shell shows it
  expect(storedSidebar(home.userData).order).toEqual([keys.gamma, keys.alpha, keys.beta]);
  // a drag is not a click: the selection stayed
  expect((await shellState(first.app)).selected.projectKey).toBe(selectedBefore);
  // every other list of projects follows the sidebar order: File > Open Chat in Project, and New Terminal's project step
  await expect.poll(() => first.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('damocles.openChatForProject')?.submenu?.items.map((item) => item.label))).toEqual(['gamma', 'alpha', 'beta']);
  const overlay = await readyOverlay(first.app);
  await clickMenu(first.app, 'damocles.terminal.new');
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-item').first().click();
  const items = overlay.getByTestId('quick-pick-item');
  await expect(items).toHaveCount(3);
  // the current project (alpha) leads the step by design; the others follow the sidebar order
  await expect(items).toHaveText([/^alphaCurrent/, /^gamma/, /^beta/]);
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);

  await dragRow(shell, projectRow(shell, keys.gamma!), projectRow(shell, keys.beta!), 'below');
  await expect.poll(() => shownNames(shell)).toEqual(['alpha', 'beta', 'gamma']);
  await dragRow(shell, projectRow(shell, keys.beta!), projectRow(shell, keys.alpha!), 'above');
  await expect.poll(() => shownNames(shell)).toEqual(['beta', 'alpha', 'gamma']);
  await first.close();

  const second = await launch();
  const relaunched = await readyShell(second.app);
  await readyProjects(relaunched);
  expect(await shownNames(relaunched)).toEqual(['beta', 'alpha', 'gamma']);
  expect((await shellState(second.app)).projects.map((project) => project.name)).toEqual(['beta', 'alpha', 'gamma']);
});

test('Alt+Up and Alt+Down and the context menu\'s Move up and Move down move a project one place, and stop at the ends', async ({ foreground: _foreground, home, launch }) => {
  seedProjects(home);
  const { app } = await launch();
  const shell = await readyShell(app);
  const overlay = await readyOverlay(app);
  await readyProjects(shell);
  const keys = await keysByName(shell);

  // the keyboard: the active row moves and stays active
  await projectRow(shell, keys.beta!).click();
  await expect(projectsList(shell)).toBeFocused();
  await shell.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => shownNames(shell)).toEqual(['beta', 'alpha', 'gamma']);
  await expect(projectsAnnouncement(shell)).toHaveText('Moved beta up');
  await expect(projectsList(shell)).toHaveAttribute('aria-activedescendant', (await projectRow(shell, keys.beta!).getAttribute('id'))!);
  // at the top Alt+Up moves nothing, so the Alt+Down after it lands beta second
  await shell.keyboard.press('Alt+ArrowUp');
  await shell.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => shownNames(shell)).toEqual(['alpha', 'beta', 'gamma']);
  await expect(projectsAnnouncement(shell)).toHaveText('Moved beta down');
  await shell.keyboard.press('Alt+ArrowDown');
  await shell.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => shownNames(shell)).toEqual(['alpha', 'gamma', 'beta']);
  expect(storedSidebar(home.userData).order).toEqual([keys.alpha, keys.gamma, keys.beta]);

  // the context menu: the same moves with a single pointer, disabled at the ends
  await projectRow(shell, keys.beta!).click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect(menuItem(overlay, 'moveDown')).toHaveAttribute('aria-disabled', 'true');
  await expect(menuItem(overlay, 'moveUp')).toHaveText(/Move up/);
  await chooseMenuItem(app, 'moveUp');
  await expect.poll(() => shownNames(shell)).toEqual(['alpha', 'beta', 'gamma']);
  await projectRow(shell, keys.alpha!).click({ button: 'right' });
  await expect(menuItem(overlay, 'moveUp')).toHaveAttribute('aria-disabled', 'true');
  await chooseMenuItem(app, 'moveDown');
  await expect.poll(() => shownNames(shell)).toEqual(['beta', 'alpha', 'gamma']);
  expect(storedSidebar(home.userData).order).toEqual([keys.beta, keys.alpha, keys.gamma]);
});

test('By host groups the projects under This computer, collapse and the view outlive a relaunch, and both views pass an axe scan', async ({ foreground: _foreground, home, launch }) => {
  seedProjects(home);
  const first = await launch();
  const shell = await readyShell(first.app);
  await readyProjects(shell);
  const keys = await keysByName(shell);
  await expectNoAxeViolations(shell, '[data-testid="sidebar-projects"]');

  await showView(shell, 'grouped');
  await expect(viewButton(shell, 'flat')).toHaveAttribute('aria-pressed', 'false');
  expect(readUserSettings(home)['damocles.desktop.projects.view']).toBe('grouped');
  const local = projectGroup(shell, LOCAL_GROUP);
  await expect(local).toHaveAttribute('role', 'group');
  await expect(local).toHaveAccessibleName(THIS_COMPUTER);
  await expect(groupHeader(shell, LOCAL_GROUP)).toHaveAttribute('aria-label', `${THIS_COMPUTER}, expanded`);
  // switching views never reshuffles a host's projects
  expect(await shownNames(shell)).toEqual(['alpha', 'beta', 'gamma']);
  await expectNoAxeViolations(shell, '[data-testid="sidebar-projects"]');

  // in a group, Alt+Down steps among the group's projects; the one group cannot move
  await projectRow(shell, keys.alpha!).click();
  await shell.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => shownNames(shell)).toEqual(['beta', 'alpha', 'gamma']);
  await groupHeader(shell, LOCAL_GROUP).click({ button: 'right' });
  const overlay = await readyOverlay(first.app);
  await expect(menuItem(overlay, 'moveUp')).toHaveAttribute('aria-disabled', 'true');
  await expect(menuItem(overlay, 'moveDown')).toHaveAttribute('aria-disabled', 'true');
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);

  // the header row is the group's disclosure: Home makes it active, Left collapses, Right expands, Enter toggles
  await projectsList(shell).focus();
  await shell.keyboard.press('Home');
  await expect(projectsList(shell)).toHaveAttribute('aria-activedescendant', (await groupHeader(shell, LOCAL_GROUP).getAttribute('id'))!);
  await shell.keyboard.press('ArrowLeft');
  await expect(groupHeader(shell, LOCAL_GROUP)).toHaveAttribute('aria-label', `${THIS_COMPUTER}, collapsed`);
  await expect(local).toHaveAttribute('data-collapsed', 'true');
  await expect(projectRow(shell, keys.alpha!)).toHaveCount(0);
  await shell.keyboard.press('ArrowRight');
  await expect(projectRow(shell, keys.alpha!)).toBeVisible();
  await shell.keyboard.press('Enter');
  await expect(groupHeader(shell, LOCAL_GROUP)).toHaveAttribute('aria-label', `${THIS_COMPUTER}, collapsed`);
  expect(storedSidebar(home.userData).collapsedGroups).toEqual([LOCAL_GROUP]);
  await expectNoAxeViolations(shell, '[data-testid="sidebar-projects"]');
  await first.close();

  const second = await launch();
  const relaunched = await readyShell(second.app);
  await expect(viewButton(relaunched, 'grouped')).toHaveAttribute('aria-pressed', 'true');
  await expect(groupHeader(relaunched, LOCAL_GROUP)).toHaveAttribute('aria-label', `${THIS_COMPUTER}, collapsed`);
  await expect(projectsList(relaunched).locator('[role="option"][data-project-key]')).toHaveCount(0);
  await groupHeader(relaunched, LOCAL_GROUP).click();
  await readyProjects(relaunched);
  expect(storedSidebar(home.userData).collapsedGroups).toEqual([]);
  await showView(relaunched, 'flat');
  expect(await shownNames(relaunched)).toEqual(['beta', 'alpha', 'gamma']);
  expect(readUserSettings(home)['damocles.desktop.projects.view']).toBe('flat');
});

test('at the narrowest sidebar the view toggle shows in full inside the section header, its actions revealed or not', async ({ foreground: _foreground, home, launch }) => {
  seedProjects(home);
  fs.writeFileSync(path.join(home.userData, 'window-layout.json'), JSON.stringify({
    version: 2,
    sidebar: { sidebarVisible: true, sidebarWidth: MIN_SIDEBAR_WIDTH, sections: { projects: { collapsed: false, size: 180 }, chats: { collapsed: false }, files: { collapsed: false, size: 230 } }, grid: DEFAULT_GRID_LAYOUT },
  }));
  const { app } = await launch();
  const shell = await readyShell(app);
  await readyProjects(shell);
  await expect.poll(async () => Math.round((await shell.getByTestId('sidebar').boundingBox())?.width ?? 0)).toBe(MIN_SIDEBAR_WIDTH);
  const header = sidebarSectionOf(shell, viewToggle(shell)).getByTestId('sidebar-section-header');
  const fits = async (): Promise<void> => {
    const box = await viewToggle(shell).boundingBox();
    const outer = await header.boundingBox();
    expect(box && outer).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(outer!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 0.5);
    expect(box!.y).toBeGreaterThanOrEqual(outer!.y);
    expect(box!.y + box!.height).toBeLessThanOrEqual(outer!.y + outer!.height + 0.5);
    // neither label is cut: each button's text fits its own box
    for (const view of ['flat', 'grouped'] as const) {
      expect(await viewButton(shell, view).evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
    }
    await expect(viewButton(shell, 'flat')).toHaveText('Flat');
    await expect(viewButton(shell, 'grouped')).toHaveText('By host');
  };
  await fits();
  const connect = shell.getByTestId('connect-host');
  await expect(connect).toBeHidden();
  // the title actions show on hover, Connect to host before Open a project folder, and the title gives way, never the toggle
  const add = await sectionAction(shell, 'add-project');
  await fits();
  await expect(connect).toBeVisible();
  await expect(connect).toHaveAccessibleName('Connect to host');
  const [connectBox, addBox, outer] = await Promise.all([connect.boundingBox(), add.boundingBox(), header.boundingBox()]);
  expect(connectBox!.x + connectBox!.width).toBeLessThanOrEqual(addBox!.x);
  expect(addBox!.x + addBox!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 0.5);
  await expectNoAxeViolations(shell, '[data-testid="sidebar-projects"]');
  await connect.click();
  await expect((await readyOverlay(app)).getByTestId('connect-dialog')).toBeVisible();
});

test('Files Open as project asks the trust question, adds the subfolder right after its project and selects it; asked again, it selects the one it added', async ({ foreground: _foreground, home, launch }) => {
  const folders = seedProjects(home);
  const { app } = await launch();
  const shell = await readyShell(app);
  await readyProjects(shell);
  const keys = await keysByName(shell);
  await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder' });

  await projectRow(shell, keys.alpha!).click();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(keys.alpha);
  await showInFiles(shell, 'src/packages/api');
  await filesRow(shell, 'src/packages/api').click({ button: 'right' });
  await chooseMenuItem(app, 'openAsProject');
  const api = path.join(folders.alpha, 'src', 'packages', 'api');
  await expect.poll(async () => (await shellState(app)).projects.map((project) => project.name)).toEqual(['alpha', 'api', 'beta', 'gamma']);
  const apiKey = await projectKeyOf(app, 'api');
  expect((await shellState(app)).projects.find((project) => project.key === apiKey)?.fsPath).toBe(api);
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(apiKey);
  await expect(projectRow(shell, apiKey)).toHaveAttribute('aria-selected', 'true');
  expect(await shownNames(shell)).toEqual(['alpha', 'api', 'beta', 'gamma']);
  const trustQuestions = async (): Promise<number> => (await askedDialogs(app)).filter((dialog) => dialog.message.startsWith(TRUST_PROMPT)).length;
  expect(await trustQuestions()).toBe(1);
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === apiKey)?.trusted).toBe(true);

  // the subfolder is a project now: asking again selects it and adds nothing
  await projectRow(shell, keys.alpha!).click();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(keys.alpha);
  await showInFiles(shell, 'src/packages/api');
  await filesRow(shell, 'src/packages/api').click({ button: 'right' });
  await chooseMenuItem(app, 'openAsProject');
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(apiKey);
  expect((await shellState(app)).projects.map((project) => project.name)).toEqual(['alpha', 'api', 'beta', 'gamma']);
  expect(await trustQuestions()).toBe(1);
});
