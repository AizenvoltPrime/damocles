import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { filesRow } from './editor';
import { readyOverlay } from './overlay';
import { SHELL_CHANNELS, type FilesTransferProgress } from '../../../src/desktop/preload/shell-channels';

// Real drops: the files come from a file input filled through CDP (a folder included, which setInputFiles refuses outside a
// webkitdirectory input), and the page dispatches dragenter, dragover and drop with a DataTransfer of those disk-backed Files.

const INPUT_ID = 'e2e-transfer-input';

export async function stageFiles(shell: Page, paths: readonly string[]): Promise<void> {
  await shell.evaluate((id) => {
    document.getElementById(id)?.remove();
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = id;
    input.style.display = 'none';
    document.body.append(input);
  }, INPUT_ID);
  const cdp = await shell.context().newCDPSession(shell);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${INPUT_ID}` });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [...paths] });
  } finally {
    await cdp.detach();
  }
  await expect.poll(() => shell.evaluate((id) => (document.getElementById(id) as HTMLInputElement).files?.length ?? 0, INPUT_ID)).toBe(paths.length);
}

// whether the tree accepted the drop (it called preventDefault on dragover and drop)
export async function dropOnRow(shell: Page, treePath: string, paths: readonly string[]): Promise<boolean> {
  await stageFiles(shell, paths);
  return shell.evaluate(([id, rowPath]) => {
    const files = (document.getElementById(id) as HTMLInputElement).files!;
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    const row = document.querySelector(`[data-testid="files-row"][data-tree-path="${rowPath}"]`)!;
    const at = row.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer: data, clientX: at.left + 10, clientY: at.top + at.height / 2 };
    row.dispatchEvent(new DragEvent('dragenter', init));
    const over = new DragEvent('dragover', init);
    row.dispatchEvent(over);
    const drop = new DragEvent('drop', init);
    row.dispatchEvent(drop);
    return over.defaultPrevented && drop.defaultPrevented;
  }, [INPUT_ID, treePath] as const);
}

export async function pasteOnRow(shell: Page, treePath: string, paths: readonly string[]): Promise<void> {
  await stageFiles(shell, paths);
  await filesRow(shell, treePath).focus();
  await shell.evaluate(([id, rowPath]) => {
    const files = (document.getElementById(id) as HTMLInputElement).files!;
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    const row = document.querySelector(`[data-testid="files-row"][data-tree-path="${rowPath}"]`)!;
    row.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, [INPUT_ID, treePath] as const);
}

// A Files row dragged onto a folder row, as the tree's own drag: dragstart fills the DataTransfer the drop then reads.
export async function dragRow(shell: Page, from: string, to: string, copy: boolean): Promise<void> {
  await shell.evaluate(([source, target, ctrl, mac]) => {
    const data = new DataTransfer();
    const row = (treePath: string): Element => document.querySelector(`[data-testid="files-row"][data-tree-path="${treePath}"]`)!;
    const point = (element: Element): { clientX: number; clientY: number } => {
      const at = element.getBoundingClientRect();
      return { clientX: at.left + 10, clientY: at.top + at.height / 2 };
    };
    const modifiers = { ctrlKey: ctrl && !mac, altKey: ctrl && mac };
    row(source).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data, ...point(row(source)) }));
    const init = { bubbles: true, cancelable: true, dataTransfer: data, ...modifiers, ...point(row(target)) };
    row(target).dispatchEvent(new DragEvent('dragenter', init));
    row(target).dispatchEvent(new DragEvent('dragover', init));
    row(target).dispatchEvent(new DragEvent('drop', init));
    row(source).dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
  }, [from, to, copy, process.platform === 'darwin'] as const);
}

export const messageDialog = (overlay: Page, text: string): Locator => overlay.locator('[role="alertdialog"]', { has: overlay.locator('h2', { hasText: text }) });

// answers the overlay's question holding text with button, ticking its checkbox first when check is true
export async function answerMessage(app: ElectronApplication, text: string, button: string, check = false): Promise<void> {
  const overlay = await readyOverlay(app);
  const dialog = messageDialog(overlay, text);
  await expect(dialog).toBeVisible();
  if (check) {
    await dialog.getByTestId('overlay-message-checkbox').click();
    await expect(dialog.getByTestId('overlay-message-checkbox')).toHaveAttribute('aria-checked', 'true');
  }
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

export function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      out.push(entry.isSymbolicLink() ? `${rel} -> ${fs.readlinkSync(path.join(dir, entry.name))}` : entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(root, '');
  return out;
}

export const partsUnder = (root: string): string[] => tree(root).filter((entry) => /\.damocles-[0-9a-f]{8}\.part$/.test(entry));

/** Records every Files transfer progress main sends a page, from now on. */
export async function recordTransfers(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, webContents }, channel) => {
    const g = globalThis as unknown as { __e2eTransfers?: unknown[] };
    if (g.__e2eTransfers) return;
    const sent: unknown[] = [];
    g.__e2eTransfers = sent;
    const wrap = (contents: Electron.WebContents): void => {
      const send = contents.send.bind(contents);
      contents.send = (name: string, ...args: unknown[]): void => {
        if (name === channel) sent.push(args[0]);
        send(name, ...args);
      };
    };
    for (const contents of webContents.getAllWebContents()) wrap(contents);
    electronApp.on('web-contents-created', (_event, contents) => wrap(contents));
  }, SHELL_CHANNELS.filesTransferProgress);
}

/** The end state of every transfer recordTransfers saw end, in order: done, failed or cancelled. */
export async function endedTransfers(app: ElectronApplication): Promise<Array<FilesTransferProgress['state']>> {
  const sent = await app.evaluate(() => (globalThis as unknown as { __e2eTransfers?: FilesTransferProgress[] }).__e2eTransfers ?? []);
  return sent.filter((progress) => progress.state === 'done' || progress.state === 'failed' || progress.state === 'cancelled').map((progress) => progress.state);
}
