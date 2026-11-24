import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { openProjectChat } from './support/screenshots';
import { openSettingsModal, setContentSize } from './support/settings';
import { selectedProjectKey, shellPage, shellState } from './support/shell';
import { projectRow } from './support/shell-ui';
import { openThemeEditor, storeBlob, writeTheme } from './support/themes';
import { answerOpenDialog } from './support/ui';

// Project characters (docs/themes.md "Characters"): the shown theme's characters replace the project letters in the sidebar and
// the title bar, a sprite strip steps through d-sprite and holds its first frame under forced colors, reduce motion and the
// Character motion setting; a character kept in every theme survives its theme's deletion; the editor refuses a sprite past
// the caps and blocks a flashing one until the user allows it.

const ARCADE = 'damocles-arcade';
const PIXEL = '3c2a9d1e-5b7f-4c8a-9e21-6d4b8a7c1f02';
const PLAIN = '8e4b2c1d-7a6f-4e3b-9c5d-2f1a0b9e8d7c';
const BARE = '4d7e9a12-6c3b-4f8e-a1d5-9b2c7e6f0a34';
const COLORS = { background: '#0b1020', panel: '#10172a', text: '#e4ecf5', accent: '#5ee6b0', success: '#4fd18b', warning: '#f2c14e', danger: '#ff6b7a', info: '#8ab4ff' };
const WIDTHS = [1280, 900] as const;

// Two frames of a still square and a cross, 8 pixels a side, side by side.
const STRIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8" viewBox="0 0 16 8" shape-rendering="crispEdges"><path fill="#5ee6b0" d="M1 1h6v6h-6z"/><path fill="#ff6b7a" d="M11 0h2v8h-2zM8 3h8v2h-8z"/></svg>\n';
// Four frames alternating black and white over the whole frame, stepped 12 times a second: far past three flashes a second.
const FLASH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="8" viewBox="0 0 32 8" shape-rendering="crispEdges"><path fill="#000000" d="M0 0h8v8h-8zM16 0h8v8h-8z"/><path fill="#ffffff" d="M8 0h8v8h-8zM24 0h8v8h-8z"/></svg>\n';
const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

const characterImage = (scope: Locator): Locator => scope.locator('[data-testid="project-character"] img');
const animationName = (image: Locator): Promise<string> => image.evaluate((element) => getComputedStyle(element).animationName);

/** A user theme whose one character is the 2-frame strip, its blob stored as core stores blobs. */
function writePixelTheme(home: HermeticHome, id = PIXEL, selection?: 'outline' | 'none'): string {
  const asset = storeBlob(home, STRIP_SVG);
  writeTheme(home, id, {
    schemaVersion: 1, id, name: id === PIXEL ? 'Pixel' : 'Bare', origin: { kind: 'created', installedAt: 1 },
    looks: { dark: { colors: COLORS } },
    characters: { name: 'Pixel', characters: [{ name: 'Blink', states: { idle: { strip: { asset, frameWidth: 8, frameHeight: 8, frames: 2, fps: 2 } } } }], ...(selection ? { selection } : {}) },
    assets: { [asset]: { kind: 'sprite', mime: 'image/svg+xml', bytes: STRIP_SVG.length, width: 16, height: 8, frames: 2, durationMs: 1000, license: {} } },
  });
  return asset;
}

for (const width of WIDTHS) {
  test.describe(`at ${width} px`, () => {
    test('draws the Arcade characters in the sidebar and the title bar, stepping a strip through d-sprite until something holds it still', async ({ foreground: _foreground, home, launch }) => {
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ARCADE });
      const { app } = await launch();
      await openProjectChat(app, home.project);
      await setContentSize(app, width, 820);
      const shell = await shellPage(app);
      const key = await selectedProjectKey(app);
      await expect.poll(async () => (await shellState(app)).characters?.characters.map((character) => character.name)).toEqual(['Pip', 'Mochi', 'Bolt', 'Gloop', 'Nova', 'Fizz']);

      const row = characterImage(projectRow(shell, key));
      const crumb = characterImage(shell.getByTestId('breadcrumb'));
      for (const image of [row, crumb]) {
        // the project's name stands beside both, so the character says nothing more
        await expect(image).toHaveAttribute('alt', '');
        await expect(image).toHaveClass(/d-sprite/);
        expect(await animationName(image)).toBe('d-sprite');
        expect(await image.evaluate((element) => getComputedStyle(element).imageRendering)).toBe('pixelated');
      }
      // a strip is as many boxes wide as it has frames, clipped to one; the row's avatar is 22 px and the title bar's 14 px at 13 px text
      const box = await projectRow(shell, key).getByTestId('project-character').boundingBox();
      expect(Math.round(box!.width)).toBe(22);
      expect(Math.round((await shell.getByTestId('breadcrumb').getByTestId('project-character').boundingBox())!.width)).toBe(14);
      const strip = await row.boundingBox();
      expect(Math.round(strip!.width / box!.width)).toBeGreaterThanOrEqual(2);

      // forced colors and reduce motion hold the first frame
      await shell.emulateMedia({ forcedColors: 'active' });
      expect(await animationName(row)).toBe('none');
      await shell.emulateMedia({ forcedColors: 'none' });
      expect(await animationName(row)).toBe('d-sprite');
      writeUserSettings(home, { 'damocles.desktop.reduceMotion': true });
      await expect.poll(async () => (await shellState(app)).characters?.motion).toBe('still');
      await expect(row).not.toHaveClass(/d-sprite/);
      await expect(projectRow(shell, key).getByTestId('project-character')).toHaveAttribute('data-character-moving', 'false');
      writeUserSettings(home, { 'damocles.desktop.reduceMotion': false });
      await expect(row).toHaveClass(/d-sprite/);

      // On hover: still until the pointer is over the row; Selected project: the selected project's moves
      writeUserSettings(home, { 'damocles.desktop.themes.characterMotion': 'hover' });
      await expect.poll(async () => (await shellState(app)).characters?.motion).toBe('hover');
      await shell.mouse.move(width - 10, 400);
      await expect.poll(() => animationName(row)).toBe('none');
      await projectRow(shell, key).hover();
      await expect.poll(() => animationName(row)).toBe('d-sprite');
      // Selected project: with two projects, only the selected one's character moves, wherever the pointer rests
      const website = path.join(path.dirname(home.project), 'website');
      fs.mkdirSync(website, { recursive: true });
      await openProjectChat(app, website);
      const other = await selectedProjectKey(app);
      expect(other).not.toBe(key);
      writeUserSettings(home, { 'damocles.desktop.themes.characterMotion': 'active' });
      await expect.poll(async () => (await shellState(app)).characters?.motion).toBe('active');
      const avatar = (project: string): Locator => projectRow(shell, project).getByTestId('project-character');
      const image = (project: string): Locator => characterImage(projectRow(shell, project));
      const expectOnlyMoving = async (selected: string, unselected: string): Promise<void> => {
        await expect(avatar(selected)).toHaveAttribute('data-character-moving', 'true');
        await expect(avatar(unselected)).toHaveAttribute('data-character-moving', 'false');
        await expect.poll(() => animationName(image(selected))).toBe('d-sprite');
        await expect.poll(() => animationName(image(unselected))).toBe('none');
        // On hover marks its moving image; Selected project does not, which tells the two modes apart
        for (const project of [selected, unselected]) expect(await image(project).getAttribute('data-sprite-hover')).toBeNull();
        await expect(crumb).toHaveClass(/d-sprite/);
      };
      await expectOnlyMoving(other, key);
      await projectRow(shell, key).click();
      await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(key);
      await expectOnlyMoving(key, other);
    });

    test('keeps a character pinned to every theme after its theme is deleted', async ({ home, launch }) => {
      const asset = writePixelTheme(home);
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': PIXEL });
      const { app } = await launch();
      await openProjectChat(app, home.project);
      await setContentSize(app, width, 820);
      const shell = await shellPage(app);
      const key = await selectedProjectKey(app);
      const project = (await shellState(app)).projects.find((candidate) => candidate.key === key)!;
      await expect(characterImage(projectRow(shell, key))).toHaveAttribute('src', `app://damocles/theme-blob/${asset}`);

      const editor = await openThemeEditor(app, 'Pixel', { tab: 'Characters' });
      const pin = editor.getByTestId('character-pins').locator('li', { hasText: project.name });
      await pin.getByRole('checkbox').click();
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      const projectsFile = path.join(home.damoclesDir, 'themes', 'projects.json');
      await expect.poll(() => (fs.existsSync(projectsFile) ? JSON.parse(fs.readFileSync(projectsFile, 'utf8')).pins?.[key]?.everyTheme?.name : undefined)).toBe('Blink');
      await editor.getByRole('button', { name: /^(Close|Cancel)$/ }).click();

      const overlay = await openSettingsModal(app, 'appearance');
      await overlay.getByRole('button', { name: 'More actions for Pixel', exact: true }).click();
      await overlay.getByRole('menuitem', { name: 'Delete…' }).click();
      await overlay.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect.poll(() => fs.existsSync(path.join(home.damoclesDir, 'themes', 'themes', PIXEL))).toBe(false);

      // the built-in look shows, and the project keeps its character; its blob stays, since projects.json names it
      await expect.poll(async () => (await shellState(app)).characters?.pins[key]).toMatchObject({ name: 'Blink' });
      await expect(characterImage(projectRow(shell, key))).toHaveAttribute('src', `app://damocles/theme-blob/${asset}`);
      await expect(projectRow(shell, key).getByTestId('project-character')).toHaveAttribute('data-character-state', /^(idle|running|waiting)$/);
      expect(fs.existsSync(path.join(home.damoclesDir, 'themes', 'blobs', asset))).toBe(true);
      expect(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).pins[key].everyTheme.assets[asset]).toMatchObject({ kind: 'sprite' });
    });

    test('refuses a sprite over 256 KB or 256 px, and blocks a flashing one until Allow flashing for this file', async ({ home, launch }) => {
      writeTheme(home, PLAIN, { schemaVersion: 1, id: PLAIN, name: 'Plain', origin: { kind: 'created', installedAt: 1 }, looks: { dark: { colors: COLORS } } });
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': PLAIN });
      const big = path.join(home.root, 'big.svg');
      fs.writeFileSync(big, `${STRIP_SVG.trimEnd()}<!--${'x'.repeat(257 * 1024)}-->`);
      const wide = path.join(home.root, 'wide.svg');
      fs.writeFileSync(wide, STRIP_SVG.replace('width="16" height="8" viewBox="0 0 16 8"', 'width="300" height="8" viewBox="0 0 300 8"'));
      const flashing = path.join(home.root, 'flash.svg');
      fs.writeFileSync(flashing, FLASH_SVG);
      const { app } = await launch();
      await activeChat(app);
      await setContentSize(app, width, 820);
      const editor = await openThemeEditor(app, 'Plain', { tab: 'Characters' });
      await editor.getByLabel('New character\'s name', { exact: true }).fill('Blink');

      await answerOpenDialog(app, big);
      await editor.getByTestId('character-add').click();
      await expect(editor.getByRole('alert')).toHaveText('This image is larger than 256 KB, the most a character sprite may be.');
      await answerOpenDialog(app, wide);
      await editor.getByTestId('character-add').click();
      await expect(editor.getByRole('alert')).toHaveText('This sprite is 300 by 8 pixels; a character frame may be at most 256 pixels on a side.');
      expect(fs.existsSync(path.join(home.damoclesDir, 'themes', 'blobs'))).toBe(false);

      await editor.getByLabel('Frames in the image', { exact: true }).fill('4');
      await editor.getByLabel('Frames a second', { exact: true }).fill('12');
      await answerOpenDialog(app, flashing);
      await editor.getByTestId('character-add').click();
      const blocked = editor.getByTestId('character-flash-blocked');
      await expect(blocked).toBeVisible({ timeout: 60_000 });
      await expect(blocked).toContainText('Blocked: flashes');
      await expect(blocked).toContainText('Seizure warning');
      const flashFile = path.join(home.damoclesDir, 'themes', 'cache', sha(FLASH_SVG), 'flash.json');
      expect(JSON.parse(fs.readFileSync(flashFile, 'utf8'))).toMatchObject({ flagged: true });
      // the editor's own preview holds the blocked strip on its first frame
      await expect(editor.getByTestId('character-cell-idle').locator('img')).not.toHaveClass(/d-sprite/);
      // main served the sprite to the dock at the request its draft made, before any preview named it
      await expect.poll(() => editor.getByTestId('character-cell-idle').locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBeGreaterThan(0);

      await editor.getByTestId('character-allow-flashing').click();
      await expect(blocked).toBeHidden();
      await expect(editor.getByTestId('character-cell-idle').locator('img')).toHaveClass(/d-sprite/);
      expect(JSON.parse(fs.readFileSync(flashFile, 'utf8'))).toMatchObject({ flagged: true, allowed: true });
    });
  });
}

// The outline follows the sprite's opaque pixels, so a sprite on a clear background gets no box around it.
test('outlines the selected project\'s character along its pixels with no box, drops the outline under selection none, and keeps a letter\'s ring', async ({ home, launch }) => {
  writePixelTheme(home);
  writePixelTheme(home, BARE, 'none');
  writeTheme(home, PLAIN, { schemaVersion: 1, id: PLAIN, name: 'Plain', origin: { kind: 'created', installedAt: 1 }, looks: { dark: { colors: COLORS } } });
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': PIXEL });
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const key = await selectedProjectKey(app);
  const website = path.join(path.dirname(home.project), 'website');
  fs.mkdirSync(website, { recursive: true });
  await openProjectChat(app, website);
  const selected = await selectedProjectKey(app);
  expect(selected).not.toBe(key);
  const shell = await shellPage(app);
  const style = (locator: Locator, property: string): Promise<string> => locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
  const shadows = async (locator: Locator): Promise<number> => (await style(locator, 'filter')).match(/drop-shadow\(/g)?.length ?? 0;
  const character = (project: string): Locator => projectRow(shell, project).getByTestId('project-character');

  await expect(character(selected)).toHaveAttribute('data-selection', 'outline');
  await expect.poll(() => shadows(character(selected))).toBe(4);
  expect(await style(character(selected), 'box-shadow')).toBe('none');
  await expect.poll(() => style(character(key), 'filter')).toBe('none');
  // the outline is the project's avatar hue, as a letter's ring is
  const hue = (await style(character(selected), '--avatar-hue')).trim();
  expect(hue).toMatch(/^\d+$/);
  const outline = await character(selected).evaluate((element, expected) => {
    // Chromium may serialize a computed color in another notation than its source, so both sides are painted and read as sRGB bytes
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const painted = (color: string): number[] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const colors = [...getComputedStyle(element).filter.matchAll(/drop-shadow\(((?:[a-z-]+\([^()]*\)|#[0-9a-f]+|[a-z]+))\s/gi)].map((match) => match[1]!);
    return { shadows: colors.map(painted), expected: painted(expected) };
  }, `oklch(0.72 0.14 ${hue})`);
  expect(outline.shadows).toHaveLength(4);
  expect(outline.expected[3]).toBe(255);
  for (const shadow of outline.shadows) {
    for (const [at, channel] of shadow.entries()) expect(Math.abs(channel - outline.expected[at]!), `${shadow.join(',')} against ${outline.expected.join(',')}`).toBeLessThanOrEqual(2);
  }
  // under forced colors, the system highlight
  await shell.emulateMedia({ forcedColors: 'active' });
  const highlight = await shell.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'Highlight';
    probe.style.forcedColorAdjust = 'none';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect.poll(() => style(character(selected), 'filter')).toContain(highlight);
  await shell.emulateMedia({ forcedColors: 'none' });

  writeUserSettings(home, { 'damocles.desktop.themes.dark': BARE });
  await expect(character(selected)).toHaveAttribute('data-selection', 'none');
  await expect.poll(() => style(character(selected), 'filter')).toBe('none');
  expect(await style(character(selected), 'box-shadow')).toBe('none');
  // the row alone marks the selection
  await expect(projectRow(shell, selected)).toHaveAttribute('aria-selected', 'true');
  expect(await style(projectRow(shell, selected), 'background-color')).not.toBe(await style(projectRow(shell, key), 'background-color'));

  writeUserSettings(home, { 'damocles.desktop.themes.dark': PLAIN });
  const letter = projectRow(shell, selected).locator('[data-avatar="letter"]');
  await expect(letter).toBeVisible();
  await expect.poll(() => style(letter, 'box-shadow')).toMatch(/1\.5px/);
  expect(await style(projectRow(shell, key).locator('[data-avatar="letter"]'), 'box-shadow')).toBe('none');
});
