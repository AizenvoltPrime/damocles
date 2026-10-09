import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { EditorOpenRequest, EditorOpenResult, ShellEditorState, ShellEditorTab } from '../../../src/desktop/preload/shell-channels';
import { overlayPage, PRIMARY, pressKeys, SHELL_URL, shellPage } from './shell';
import { clickMenu } from './ui';

export const editorPane = (shell: Page): Locator => shell.getByTestId('editor-pane');
export const editorTab = (shell: Page, title: string): Locator => shell.locator('[data-testid="editor-tab"]', { hasText: title });
export const codeEditor = (shell: Page): Locator => shell.getByTestId('code-editor');
export const diffEditor = (shell: Page): Locator => shell.getByTestId('diff-editor');
export const conflictBar = (shell: Page): Locator => shell.getByTestId('conflict-bar');
export const filesTree = (shell: Page): Locator => shell.getByTestId('files-tree');
export const filesRow = (shell: Page, path: string): Locator => shell.locator(`[data-testid="files-row"][data-tree-path="${path}"]`);
export const quickPick = (overlay: Page): Locator => overlay.getByTestId('quick-pick');

/** Main's editor tabs and active tab, read through the shell's own preload. */
export async function editorState(app: ElectronApplication): Promise<ShellEditorState> {
  const shell = await shellPage(app);
  return shell.evaluate(() => window.damoclesShell!.getEditorState());
}

export async function activeTab(app: ElectronApplication): Promise<ShellEditorTab | undefined> {
  const state = await editorState(app);
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}

/** A user open from the shell (a Files click does the same), answered with main's result. */
export async function openInEditor(app: ElectronApplication, request: EditorOpenRequest): Promise<EditorOpenResult> {
  const shell = await shellPage(app);
  return shell.evaluate((r) => window.damoclesShell!.openEditor(r), request);
}

/** Waits until the shared Monaco editor shows the active tab, whose text holds `text`. */
export async function editorShows(shell: Page, text: string): Promise<void> {
  await expect(codeEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  await expect(codeEditor(shell).locator('.view-line', { hasText: text }).first()).toBeVisible();
}

/** The text of the active editor's model, read through Monaco's own view of the buffer. */
export async function bufferText(shell: Page): Promise<string> {
  return codeEditor(shell).locator('.view-lines').evaluate((lines) => [...lines.querySelectorAll('.view-line')]
    .sort((a, b) => parseFloat((a as HTMLElement).style.top) - parseFloat((b as HTMLElement).style.top))
    .map((line) => (line.textContent ?? '').replace(/\u00a0/g, ' '))
    .join('\n'));
}

/** Opens Quick Open with its accelerator from `fromUrl`'s page, types `query` and returns the overlay page. */
export async function quickOpen(app: ElectronApplication, query: string, fromUrl = '/shell/'): Promise<Page> {
  const overlay = await overlayPage(app);
  // A closing Quick Open plays its exit before main hides the overlay; the next one opens after it.
  await expect(quickPick(overlay)).toHaveCount(0);
  await pressKeys(app, fromUrl, 'P', [PRIMARY]);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(query);
  return overlay;
}

/** Saves the active editor with Ctrl+S (Cmd+S), as a user does while the editor has focus. */
export async function saveWithKeyboard(app: ElectronApplication): Promise<void> {
  await pressKeys(app, '/shell/', 'S', [PRIMARY]);
}

// Monaco's cursorTop and cursorBottom: Ctrl+Home and Ctrl+End, and on macOS Cmd+Up and Cmd+Down, where Ctrl+Home/End are unbound.
export const DOCUMENT_START = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';
export const DOCUMENT_END = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

export async function toggleTerminal(app: ElectronApplication): Promise<void> {
  await clickMenu(app, 'damocles.toggleTerminal');
}

/** The file's bytes as the editor saved them: a BOM, CRLF and no lone LF are what the encoding round trip keeps. */
export function lineEndings(bytes: Buffer): { bom: boolean; crlf: number; loneLf: number } {
  const text = bytes.toString('latin1');
  return {
    bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    crlf: (text.match(/\r\n/g) ?? []).length,
    loneLf: (text.match(/(?<!\r)\n/g) ?? []).length,
  };
}

type Rgb = readonly [number, number, number];

/**
 * The active tab's top device-pixel row as the window paints it, from two columns left of the tab to two right of it, with
 * what the accent and border tokens resolve to and where the tab's box lies in device px.
 */
export async function activeTabTopRow(app: ElectronApplication): Promise<{ row: Rgb[]; start: number; left: number; right: number; accent: Rgb; border: Rgb }> {
  const shell = await shellPage(app);
  const png = await app.evaluate(async ({ webContents }, url) => (await webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.capturePage()).toDataURL(), SHELL_URL);
  return shell.evaluate(async (data) => {
    const image = new Image();
    image.src = data;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const scale = image.width / window.innerWidth;
    const box = document.querySelector<HTMLElement>('[data-editor-tab][aria-selected="true"]')!.getBoundingClientRect();
    const start = Math.floor(box.left * scale) - 2;
    const end = Math.ceil(box.right * scale) + 2;
    const pixels = context.getImageData(start, Math.floor(box.top * scale), end - start, 1).data;
    const row: Array<[number, number, number]> = [];
    for (let i = 0; i < pixels.length; i += 4) row.push([pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]);
    const colour = (token: string): [number, number, number] => {
      const probe = document.createElement('div');
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const [r, g, b] = getComputedStyle(probe).color.match(/[0-9]+/g)!.map(Number);
      probe.remove();
      return [r!, g!, b!];
    };
    return { row, start, left: box.left * scale, right: box.right * scale, accent: colour('--d-accent'), border: colour('--d-border') };
  }, png);
}
