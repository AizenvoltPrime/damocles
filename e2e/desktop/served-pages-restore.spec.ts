import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication } from '@playwright/test';
import { fileUrlOfRoot } from '../../src/shared/served-file-url';
import { activePageTab, browserTabs, chromeEnv, PAGE_TIMEOUT, systemChrome } from './support/browser';
import { DESIGN_APP, grounding, startDesignChat } from './support/design';
import { chatById, expect, panelIdOf, selectChatPage, test } from './support/fixtures';
import { seedStubModel, writeUserSettings } from './support/hermetic';
import { call, startOpenAIStub } from './support/openai-stub';
import { openProjectChat } from './support/screenshots';
import { shellPage } from './support/shell';
import { awaitTurnEnd, chatInput, postFromWebview } from './support/ui';

// A local chat's project and design pages are saved as their file:// addresses and come back after a restart through the
// chat's served roots, with their query, fragment and active tab; a saved address outside the roots never loads.

const chrome = systemChrome();

test.describe.configure({ timeout: 300_000 });
test.skip(chrome === undefined, 'No system-wide Chrome or Edge is installed on this runner, and the browser feature launches the installed browser by channel.');

const DESIGN_MD = ['---', 'app: Laravel 11, Inertia, Vue 3, Tailwind 4', 'viewports:', '  primary: xl', '  checked: [sm, xl]', '  journey: []', '---', '# Contacts', ''].join('\n');
const SCREEN = '<!doctype html><html lang="en" data-ds-screen="S1"><head><meta charset="utf-8"><title>Contacts</title></head><body><main><h1>Contacts</h1></main></body></html>\n';

async function titles(app: ElectronApplication): Promise<string[]> {
  return (await browserTabs(app)).map((tab) => tab.title);
}

async function urls(app: ElectronApplication): Promise<string[]> {
  return (await browserTabs(app)).map((tab) => tab.browser.url);
}

test('a local chat\'s project and design pages come back after a restart at their file:// addresses, and one outside its roots does not', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.browser.enabled': true });
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    fs.mkdirSync(path.join(home.project, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(home.project, 'docs', 'page.html'), '<!doctype html><title>Project page</title><p>Project</p>\n');
    const secret = path.join(home.root, 'secret.html');
    fs.writeFileSync(secret, '<!doctype html><title>Secret</title>\n');

    const { app } = await launch({ env: chromeEnv() });
    const parent = await openProjectChat(app, home.project);
    const parentId = panelIdOf(parent);
    const { design, folder } = await startDesignChat(app, parent, stub, home, {
      fidelity: 'Static mockup',
      script: (designDir) => [...grounding(designDir, DESIGN_MD), call('write', { path: path.join(designDir, 'screens', 'S1-contacts.html'), content: SCREEN }), { chunks: ['Drafted the screen.'] }],
    });
    await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(0);
    await awaitTurnEnd(design);

    // the main chat sees its project and its linked design folder
    const projectUrl = `${fileUrlOfRoot(home.project)}/docs/page.html?x=1#intro`;
    const screenUrl = `${fileUrlOfRoot(folder)}/screens/S1-contacts.html?state=empty#list`;
    await selectChatPage(app, parent);
    stub.replies.push(
      call('ToolSearch', { tools: ['browser'] }),
      call('BrowserOpen', { url: projectUrl }),
      call('BrowserTabs', { action: 'new' }),
      call('BrowserNavigate', { url: screenUrl }),
      { chunks: ['Opened both pages.'] },
    );
    await chatInput(parent).fill('open the project page and the design screen');
    await chatInput(parent).press('Enter');
    await expect.poll(() => stub.replies.length, { timeout: PAGE_TIMEOUT }).toBe(0);
    await awaitTurnEnd(parent);
    await expect.poll(() => titles(app), { timeout: PAGE_TIMEOUT }).toEqual(['Project page', 'Contacts']);
    expect(await urls(app)).toEqual([projectUrl, screenUrl]);
    await expect((await shellPage(app)).getByTestId('browser-address')).toHaveValue(screenUrl);
    await (await shellPage(app)).locator('[data-editor-tab]', { hasText: 'Project page' }).click();
    await expect.poll(async () => (await activePageTab(app))?.title).toBe('Project page');
    await app.close();

    // saved as shown; a page whose saved address is outside the chat's roots is added to the restore
    const file = path.join(home.userData, 'panels.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { chats: Array<{ panelId: string; pages?: string[]; activePage?: number }> };
    const entry = saved.chats.find((chat) => chat.panelId === parentId)!;
    expect({ pages: entry.pages, activePage: entry.activePage }).toEqual({ pages: [projectUrl, screenUrl], activePage: 0 });
    entry.pages!.push(pathToFileURL(secret).href);
    fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);

    const relaunched = await launch({ env: chromeEnv() });
    const parentAgain = await chatById(relaunched.app, `new:${parentId}`);
    await selectChatPage(relaunched.app, parentAgain);
    await expect.poll(() => titles(relaunched.app), { timeout: PAGE_TIMEOUT }).toEqual(['Project page', 'Contacts']);
    expect(await urls(relaunched.app)).toEqual([projectUrl, screenUrl]);
    // a restore leaves the active editor tab alone; the header's open browser shows the chat's active page
    await postFromWebview(parentAgain, { type: 'openBrowser' });
    await expect.poll(async () => (await activePageTab(relaunched.app))?.title, { timeout: PAGE_TIMEOUT }).toBe('Project page');
    await expect((await shellPage(relaunched.app)).getByTestId('browser-address')).toHaveValue(projectUrl);
  } finally {
    await stub.close();
  }
});
