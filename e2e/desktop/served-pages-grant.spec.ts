import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileUrlOfRoot } from '../../src/shared/served-file-url';
import { chromeEnv, PAGE_TIMEOUT, systemChrome } from './support/browser';
import { expect, test } from './support/fixtures';
import { seedStubModel, writeUserSettings } from './support/hermetic';
import { agentRequests, call, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { openProjectChat } from './support/screenshots';
import { awaitTurnEnd, chatInput } from './support/ui';

// A page outside the chat's project asks on the approval card; Yes serves the page's folder to that chat, whose later pages there
// open unasked, with the serve policy's deny list.

const chrome = systemChrome();
const TITLE = 'Open a page outside this chat\'s folders?';

test.describe.configure({ timeout: 300_000 });
test.skip(chrome === undefined, 'No system-wide Chrome or Edge is installed on this runner, and the browser feature launches the installed browser by channel.');

/** The text of every tool result the agent's last request carried, in order. */
function toolResults(stub: OpenAIStub): string[] {
  const messages = (agentRequests(stub).at(-1)?.body as { messages?: Array<{ role: string; content?: string | Array<{ text?: string }> }> } | undefined)?.messages ?? [];
  return messages.filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join('')));
}

test('a page outside the project asks once, and Yes serves its folder to that chat with the deny list', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.browser.enabled': true });
    const reports = path.join(home.root, 'reports');
    fs.mkdirSync(path.join(reports, 'week'), { recursive: true });
    fs.writeFileSync(path.join(reports, 'index.html'), '<!doctype html><title>Reports</title><p>report-index</p>\n');
    fs.writeFileSync(path.join(reports, 'week', 'page.html'), '<!doctype html><title>Week</title><p>report-week</p>\n');
    fs.writeFileSync(path.join(reports, '.env'), 'SECRET=1');

    const { app } = await launch({ env: chromeEnv() });
    const chat = await openProjectChat(app, home.project);
    stub.replies.push(
      call('ToolSearch', { tools: ['browser'] }),
      call('BrowserOpen', { url: `${fileUrlOfRoot(reports)}/index.html` }),
      call('BrowserEvaluate', { expression: '"body=" + encodeURIComponent(document.body.innerText)' }),
      call('BrowserNavigate', { url: `${fileUrlOfRoot(reports)}/week/page.html` }),
      call('BrowserEvaluate', { expression: 'fetch("/.env").then((r) => "env=" + r.status)' }),
      { chunks: ['Done.'] },
    );
    await chatInput(chat).fill('open the report');
    await chatInput(chat).press('Enter');
    const card = chat.getByTestId('permission-card');
    await expect(card.getByTestId('permission-title')).toHaveText(TITLE, { timeout: PAGE_TIMEOUT });
    await expect(card.getByTestId('permission-facts')).toContainText(reports);
    const options = chat.getByRole('listbox', { name: TITLE, exact: true });
    await expect(options.getByRole('option')).toHaveCount(2);
    await options.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect.poll(() => stub.replies.length, { timeout: PAGE_TIMEOUT }).toBe(0);
    await awaitTurnEnd(chat);
    const results = toolResults(stub).join('\n');
    expect(results).toContain('body=report-index');
    expect(results).toContain(`${fileUrlOfRoot(reports)}/week/page.html`);
    expect(results).toContain('env=404');
    expect(results).not.toMatch(/localhost:\d+|127\.0\.0\.1:\d+/);
    // the page in the granted folder opened with no second card
    await expect(chat.getByTestId('permission-card')).toHaveCount(0);
  } finally {
    await stub.close();
  }
});
