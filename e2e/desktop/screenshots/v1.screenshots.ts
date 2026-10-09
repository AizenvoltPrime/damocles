import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { setWindowContentSize } from '../support/browser';
import { captureThemes, hostMessage, openProjectChat } from '../support/screenshots';
import { chatInput } from '../support/ui';

// Review captures for a prompt pi queued into a running run and a Stop then withdrew, saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'v1');
const TYPED = 'what failed in these two runs?';

/** A small RGB PNG with a diagonal gradient, so the composer's thumbnail shows an image rather than a blank square. */
function gradientPng(width: number, height: number): string {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      rows[row + 1 + x * 3] = Math.round((x / width) * 255);
      rows[row + 2 + x * 3] = Math.round((y / height) * 255);
      rows[row + 3 + x * 3] = 180;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

const chip = (id: string, commandLine: string, preview: string) => ({
  id, source: 'command', commandLine, exitCode: 1, terminalTitle: 'pwsh', lineCount: 1, omittedLines: 0, preview,
});

test.setTimeout(300_000);

test('a queued prompt a Stop withdrew: its echo, then the composer it returns to', async ({ home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  await setWindowContentSize(app, 1280, 820);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: gradientPng(96, 64) } };
  const chips = [chip('t1', 'npm test', 'FAIL src/a.test.ts'), chip('t2', 'npm run lint', '2 problems (2 errors, 0 warnings)')];

  // The stub model cannot hold pi streaming a run no prompt owns, so the host messages core sends are delivered directly.
  await hostMessage(app, tab, {
    type: 'userMessage', content: TYPED, contentBlocks: [{ type: 'text', text: TYPED }, image], terminalAttachments: chips, correlationId: 'c1', promptIndex: 0,
  });
  await expect(tab.getByTestId('user-message-terminal-attachments').getByTestId('terminal-attachment-chip')).toHaveCount(2);
  await captureThemes(app, OUT, 'v1-queued-echo');

  await hostMessage(app, tab, { type: 'queueCancelled', messageId: 'c1', returnToInput: true });
  await hostMessage(app, tab, { type: 'terminalAttachmentsUpdate', attachments: chips });
  await expect(tab.getByTestId('user-message-terminal-attachments')).toHaveCount(0);
  await expect(chatInput(tab)).toHaveValue(TYPED);
  await expect(tab.getByTestId('composer').getByTestId('terminal-attachment-chip')).toHaveCount(2);
  await captureThemes(app, OUT, 'v1-restored-composer');
});

const OUT_V1B = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'v1b');
const QUEUED_TEXT = 'also check the lint output';
const RETURNED_TOAST = 'Your queued messages were not sent. They are back in the input.';

test('a new chat returns a queued message to the composer, with a toast true for every cause', async ({ home, launch }) => {
  fs.mkdirSync(OUT_V1B, { recursive: true });
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  await setWindowContentSize(app, 1280, 820);

  // The order core sends on a new chat: each queued message goes back, then the conversation clears.
  await hostMessage(app, tab, { type: 'messageQueued', message: { id: 'q1', content: QUEUED_TEXT, timestamp: Date.now() } });
  await hostMessage(app, tab, { type: 'queueCancelled', messageId: 'q1', returnToInput: true });
  await hostMessage(app, tab, { type: 'conversationCleared' });
  await expect(chatInput(tab)).toHaveValue(QUEUED_TEXT);
  await expect(tab.locator('[data-sonner-toast]').filter({ hasText: RETURNED_TOAST })).toHaveCount(1);
  await captureThemes(app, OUT_V1B, 'v1b-new-chat-returned');
});

test('a prompt stopped before its run comes back with its typed text and image', async ({ home, launch }) => {
  fs.mkdirSync(OUT_V1B, { recursive: true });
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  await setWindowContentSize(app, 1280, 820);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: gradientPng(96, 64) } };

  // Stopped before its echo, so the host's message is all the webview has to restore from.
  await hostMessage(app, tab, { type: 'interruptRecovery', correlationId: 'c1', promptContent: TYPED, contentBlocks: [{ type: 'text', text: TYPED }, image] });
  await expect(chatInput(tab)).toHaveValue(TYPED);
  await expect(tab.getByTestId('composer').locator('img')).toHaveCount(1);
  await captureThemes(app, OUT_V1B, 'v1b-interrupted-restored');
});

const OUT_V1C = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'v1c');
const PLAN_MESSAGE = 'Implement the following plan:\n\n# Plan: split the parser';

test('a plan approved with clear context returns a queued message to the composer before the continuation starts', async ({ home, launch }) => {
  fs.mkdirSync(OUT_V1C, { recursive: true });
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  await setWindowContentSize(app, 1280, 820);

  // The order core sends: the clear returns each queued message, then the conversation clears to the continuation.
  await hostMessage(app, tab, { type: 'messageQueued', message: { id: 'q1', content: QUEUED_TEXT, timestamp: Date.now() } });
  await hostMessage(app, tab, { type: 'queueCancelled', messageId: 'q1', returnToInput: true });
  await hostMessage(app, tab, { type: 'sessionCleared', pendingMessage: { content: PLAN_MESSAGE, correlationId: 'plan-impl-1' } });
  // The continuation is running, so the composer offers to queue.
  await expect(tab.getByPlaceholder('Type to queue your next message…')).toHaveValue(QUEUED_TEXT);
  await expect(tab.getByText(/split the parser/).first()).toBeVisible();
  await expect(tab.locator('[data-sonner-toast]').filter({ hasText: RETURNED_TOAST })).toHaveCount(1);
  await captureThemes(app, OUT_V1C, 'v1c-plan-clear-returned');
});

test('a folder switch returns a queued message to the composer before the new conversation starts', async ({ home, launch }) => {
  fs.mkdirSync(OUT_V1C, { recursive: true });
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  await setWindowContentSize(app, 1280, 820);
  const folders = [{ key: 'k-web', name: 'web', label: 'web', path: 'C:/work/web' }, { key: 'k-api', name: 'api', label: 'api', path: 'C:/work/api' }];

  // The order core sends: disposing the old session returns each queued message, then the panel moves.
  await hostMessage(app, tab, { type: 'messageQueued', message: { id: 'q1', content: QUEUED_TEXT, timestamp: Date.now() } });
  await hostMessage(app, tab, { type: 'queueCancelled', messageId: 'q1', returnToInput: true });
  await hostMessage(app, tab, { type: 'workspaceFolderUpdate', folders, panelFolderKey: 'k-api', defaultFolderKey: 'k-web', switched: true });
  await expect(chatInput(tab)).toHaveValue(QUEUED_TEXT);
  await expect(tab.locator('[data-sonner-toast]').filter({ hasText: RETURNED_TOAST })).toHaveCount(1);
  await captureThemes(app, OUT_V1C, 'v1c-folder-switch-returned');
});
