import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { fileUrlOfRoot } from '../../src/shared/served-file-url';
import { chromeEnv, PAGE_TIMEOUT, systemChrome } from './support/browser';
import { expect, test } from './support/fixtures';
import { seedStubModel, writeUserSettings } from './support/hermetic';
import { agentRequests, call, startOpenAIStub, type OpenAIStub, type StubReply } from './support/openai-stub';
import { openProjectChat } from './support/screenshots';
import { awaitTurnEnd, chatInput } from './support/ui';

// Every local chat's pages share one browser profile, so each chat's grant of a served root is a host of its own: one chat's
// agent reads no page of another chat's root on any host it can name, while a page's own root-absolute links work.

const chrome = systemChrome();

test.describe.configure({ timeout: 300_000 });
test.skip(chrome === undefined, 'No system-wide Chrome or Edge is installed on this runner, and the browser feature launches the installed browser by channel.');

/** The text of every tool result the agent's last request carried, in order. */
function toolResults(stub: OpenAIStub): string[] {
  const messages = (agentRequests(stub).at(-1)?.body as { messages?: Array<{ role: string; content?: string | Array<{ text?: string }> }> } | undefined)?.messages ?? [];
  return messages.filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join('')));
}

async function turn(chat: Page, stub: OpenAIStub, prompt: string, replies: readonly StubReply[]): Promise<string[]> {
  stub.replies.push(...replies, { chunks: ['Done.'] });
  await chatInput(chat).fill(prompt);
  await chatInput(chat).press('Enter');
  await expect.poll(() => stub.replies.length, { timeout: PAGE_TIMEOUT }).toBe(0);
  await awaitTurnEnd(chat);
  return toolResults(stub);
}

function valueOf(results: readonly string[], name: string): string {
  const match = new RegExp(`${name}=([^\\s"\\\\]+)`).exec(results.join('\n'));
  if (!match) throw new Error(`no ${name}= in the tool results`);
  return match[1]!;
}

test('a chat\'s browser reads no page of another chat\'s served root on any host it can name', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.browser.enabled': true, 'damocles.dangerouslySkipPermissions': true });
    fs.mkdirSync(path.join(home.project, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(home.project, 'docs', 'page.html'), '<!doctype html><title>First page</title><p>first-secret</p>\n');
    fs.writeFileSync(path.join(home.project, 'docs', 'data.txt'), 'first-data');
    const secondProject = path.join(home.root, 'second');
    fs.mkdirSync(secondProject, { recursive: true });
    fs.writeFileSync(path.join(secondProject, 'index.html'), '<!doctype html><title>Second page</title><p>second</p>\n');

    const { app } = await launch({ env: chromeEnv() });
    const first = await openProjectChat(app, home.project);
    const opened = await turn(first, stub, 'open the first page', [
      call('ToolSearch', { tools: ['browser'] }),
      call('BrowserOpen', { url: `${fileUrlOfRoot(home.project)}/docs/page.html` }),
      call('BrowserEvaluate', { expression: '"port=" + location.port' }),
      // a root-absolute fetch of the page's own root
      call('BrowserEvaluate', { expression: 'fetch("/docs/data.txt").then((r) => r.text()).then((t) => "data=" + t)' }),
    ]);
    const port = valueOf(opened, 'port');
    expect(valueOf(opened, 'data')).toBe('first-data');
    expect(opened.join('\n')).not.toMatch(/localhost:\d+|127\.0\.0\.1:\d+/);

    const second = await openProjectChat(app, secondProject);
    const own = await turn(second, stub, 'open the second page', [
      call('ToolSearch', { tools: ['browser'] }),
      call('BrowserOpen', { url: `${fileUrlOfRoot(secondProject)}/index.html` }),
      call('BrowserEvaluate', { expression: '"host=" + location.hostname' }),
    ]);
    const hosts = ['127.0.0.1', 'localhost', valueOf(own, 'host')];
    const reached = await turn(second, stub, 'open the first chat\'s port', hosts.flatMap((host) => [
      call('BrowserNavigate', { url: `http://${host}:${port}/docs/page.html` }),
      call('BrowserEvaluate', { expression: '"body=" + encodeURIComponent(document.body ? document.body.innerText : "")' }),
    ]));
    const bodies = reached.slice(own.length).filter((text) => text.includes('body='));
    expect(bodies).toHaveLength(hosts.length);
    for (const body of bodies) expect(body).not.toContain('first-secret');
  } finally {
    await stub.close();
  }
});
