import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT, seedStubModel } from '../support/hermetic';
import { startOpenAIStub } from '../support/openai-stub';
import { captureThemes, openProjectChat } from '../support/screenshots';
import { pressKeys, PRIMARY, shellPage } from '../support/shell';
import { chatInput, sendAndAwaitEcho } from '../support/ui';

// Review captures of a restored message's send time and a restored Replace row, saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'smokefix');
const HOURS_EARLIER = 3;

test.setTimeout(180_000);

// Every session file under `dir`, recursively.
function sessionFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sessionFiles(full) : entry.name.endsWith('.jsonl') ? [full] : [];
  });
}

// Moves every entry of the stored conversations `hours` back, so a restore shows the time each message was sent.
function backdate(dir: string, hours: number): void {
  const shift = hours * 3_600_000;
  for (const file of sessionFiles(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').map((line) => {
      if (line.trim() === '') return line;
      const entry = JSON.parse(line) as { timestamp?: string; message?: { timestamp?: number } };
      if (typeof entry.timestamp === 'string') entry.timestamp = new Date(Date.parse(entry.timestamp) - shift).toISOString();
      if (typeof entry.message?.timestamp === 'number') entry.message.timestamp -= shift;
      return JSON.stringify(entry);
    });
    fs.writeFileSync(file, lines.join('\n'));
  }
}

async function openSearch(app: ElectronApplication): Promise<Page> {
  const shell = await shellPage(app);
  await pressKeys(app, '/shell/', 'H', [PRIMARY, 'shift']);
  await expect(shell.getByTestId('search-query')).toBeFocused();
  return shell;
}

test('a restored message shows when it was sent, and Search comes back with its Replace text', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.writeFileSync(path.join(home.project, 'greeting.ts'), 'export const greeting = "hello";\n');
    const first = await launch();
    await sendAndAwaitEcho(await openProjectChat(first.app, home.project), 'what did I ask three hours ago?');
    const shell = await openSearch(first.app);
    await shell.getByTestId('search-query').fill('greeting');
    await shell.getByTestId('search-query').press('Enter');
    await shell.getByTestId('search-replace').fill('welcome');
    const layoutFile = path.join(home.userData, 'window-layout.json');
    await expect.poll(() => (fs.existsSync(layoutFile) ? fs.readFileSync(layoutFile, 'utf8') : '')).toContain('"replaceText": "welcome"');
    await first.close();
    backdate(path.join(home.agentDir, 'sessions'), HOURS_EARLIER);

    const second = await launch();
    const chat = await activeChat(second.app);
    await expect(chatInput(chat)).toBeVisible();
    await expect(chat.getByText('what did I ask three hours ago?', { exact: true }).first()).toBeVisible();
    await expect((await shellPage(second.app)).getByTestId('search-replace')).toHaveValue('welcome');
    await captureThemes(second.app, OUT, 'restored-time-and-replace');
  } finally {
    await stub.close();
  }
});
