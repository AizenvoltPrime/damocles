import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import type { ProjectsView } from '../../../src/desktop/preload/shell-channels';
import { filesRow } from './editor';
import { settled } from './screenshots';
import { cssString, projectsList } from './shell-ui';

// The Projects section's views, groups and reordering (en locale), as a user reaches them.

export const LOCAL_GROUP = 'local';
export const THIS_COMPUTER = 'This computer';

export const viewToggle = (shell: Page): Locator => shell.getByTestId('projects-view');
export const viewButton = (shell: Page, view: ProjectsView): Locator => shell.getByTestId(`projects-view-${view}`);
export const projectGroup = (shell: Page, group: string): Locator => shell.locator(`[data-testid="project-group"][data-group=${cssString(group)}]`);
export const groupHeader = (shell: Page, group: string): Locator => shell.locator(`[data-testid="project-group-header"][data-group=${cssString(group)}]`);
export const projectsRefusal = (shell: Page): Locator => shell.getByTestId('projects-refusal');
export const projectsAnnouncement = (shell: Page): Locator => shell.getByTestId('projects-announcement');

/** Switches the view with its toggle and waits until the list shows it. */
export async function showView(shell: Page, view: ProjectsView): Promise<void> {
  await viewButton(shell, view).click();
  await expect(viewButton(shell, view)).toHaveAttribute('aria-pressed', 'true');
  await expect(projectsList(shell).getByTestId('project-group')).toHaveCount(view === 'grouped' ? await projectGroupCount(shell) : 0);
}

async function projectGroupCount(shell: Page): Promise<number> {
  // a group shows only while it has a project, though main's group order always holds this computer
  return shell.evaluate(async () => new Set((await window.damoclesShell!.getState()).projects.map((project) => project.authority.key)).size);
}

/** The project keys the list shows, top to bottom. */
export function shownProjectOrder(shell: Page): Promise<string[]> {
  return projectsList(shell).locator('[role="option"][data-project-key]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-project-key')!));
}

/** The group keys the grouped view shows, top to bottom. */
export function shownGroupOrder(shell: Page): Promise<string[]> {
  return projectsList(shell).getByTestId('project-group').evaluateAll((groups) => groups.map((group) => group.getAttribute('data-group')!));
}

export interface StoredSidebar {
  readonly order: readonly string[];
  readonly groupOrder: readonly string[];
  readonly collapsedGroups: readonly string[];
}

/** The sidebar order, group order and collapsed groups as remote-hosts.json holds them now. */
export function storedSidebar(userData: string): StoredSidebar {
  const file = JSON.parse(fs.readFileSync(path.join(userData, 'remote-hosts.json'), 'utf8')) as Partial<StoredSidebar>;
  return { order: file.order ?? [], groupOrder: file.groupOrder ?? [], collapsedGroups: file.collapsedGroups ?? [] };
}

/**
 * Drags `row` with the primary button and drops it in the upper or lower quarter of `target`, as a user does: past the
 * drag threshold first, then in small steps, so every pointermove lands. The pointer must be the test's alone, so callers
 * hold the `foreground` fixture. `dragged` is what lifts: the row itself, or the whole group when `row` is its header.
 */
export async function dragRow(shell: Page, row: Locator, target: Locator, place: 'above' | 'below', dragged: Locator = row): Promise<void> {
  // rows still gliding from the last move are not where they will be pressed
  // the mouse presses where a row is painted, so the user scrolls the list to it first
  await row.scrollIntoViewIfNeeded();
  await settled(shell);
  await expect(row).toBeInViewport({ ratio: 1 });
  await expect(target).toBeInViewport();
  const from = await row.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('the dragged row or its target is not shown');
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endY = place === 'above' ? to.y + to.height * 0.25 : to.y + to.height * 0.75;
  await shell.mouse.move(startX, startY);
  await shell.mouse.down();
  await shell.mouse.move(startX, startY + Math.sign(endY - startY) * 8, { steps: 4 });
  await expect(dragged).toHaveAttribute('data-dragging', 'true');
  await shell.mouse.move(startX, endY, { steps: 12 });
  await shell.mouse.up();
  await expect(dragged).not.toHaveAttribute('data-dragging', 'true');
}

/** Expands each folder above `treePath` in Files that is not expanded yet; Files keeps a project's expanded folders. */
export async function showInFiles(shell: Page, treePath: string): Promise<void> {
  const parts = treePath.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    const folder = filesRow(shell, parts.slice(0, depth).join('/'));
    await expect(folder).toBeVisible();
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
  }
  await expect(filesRow(shell, treePath)).toBeVisible();
}
