import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { mainLog } from './app';
import { activeChat, expect, nextChat } from './fixtures';
import { seedStubModel, type HermeticHome } from './hermetic';
import { chatRequests, startOpenAIStub, STUB_MODEL_ID, type OpenAIStub } from './openai-stub';
import { filesUnder, loopbackHome, openThroughLocalDaemon, serverDir } from './loopback';
import { shellState } from './shell';
import { chatInput, clickMenu } from './ui';

// What the loopback agent spec shares: the target's files, a stub the daemon's core may use, witnesses and scans.

export const WITNESS = path.join(__dirname, 'process-witness.cjs');

/** The daemon's ~/.damocles: its settings (machine scope), memory database, worktree registry and pi agent dir. */
export const targetDamoclesDir = (home: HermeticHome): string => path.join(loopbackHome(home), '.damocles');
export const targetAgentDir = (home: HermeticHome): string => path.join(targetDamoclesDir(home), 'pi', 'agent');

function providerModels(baseUrl: string): Record<string, unknown> {
  return {
    baseUrl,
    api: 'openai-completions',
    models: [{ id: STUB_MODEL_ID, name: 'Stub model', reasoning: false, input: ['text', 'image'], contextWindow: 272000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  };
}

/**
 * The stub as pi's `openai` provider on both sides: this computer holds its key (auth.json, moved to the secret store at the
 * first start) and selects its model; the daemon's agent dir lists the provider with no key, which the broker supplies. It
 * listens on loopback, which the loopback daemon's core shares with this computer.
 */
export async function startLoopbackStub(home: HermeticHome): Promise<OpenAIStub> {
  const stub = await startOpenAIStub();
  seedStubModel(home, stub.baseUrl);
  fs.mkdirSync(targetAgentDir(home), { recursive: true });
  fs.writeFileSync(path.join(targetAgentDir(home), 'models.json'), JSON.stringify({ providers: { openai: providerModels(stub.baseUrl) } }, null, 2));
  return stub;
}

/** Merges `values` into a JSON settings file, creating its folder. */
export function mergeJson(file: string, values: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  fs.writeFileSync(file, JSON.stringify({ ...current, ...values }, null, 2));
}

/** Opens `folder` through the local daemon and starts a new chat there; resolves with its page once its composer shows. */
export async function newLoopbackChat(app: ElectronApplication, folder: string, trust = true): Promise<{ key: string; tab: Page }> {
  // the launch's own chat first, so it is never taken for the new one
  const known = [await activeChat(app), ...app.windows()];
  const key = await openThroughLocalDaemon(app, folder, trust);
  await clickMenu(app, 'damocles.newChat');
  const tab = await nextChat(app, known);
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(key);
  await expect(chatInput(tab)).toBeVisible();
  return { key, tab };
}

/** Sends `text` from the composer without waiting for anything. */
export async function sendPrompt(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
}

/** The system prompt of every agent turn request the stub saw (sub-calls offer one tool and are left out). */
export function systemPrompts(stub: OpenAIStub): string[] {
  return chatRequests(stub)
    .map((request) => request.body as { messages?: { role: string; content: unknown }[]; tools?: unknown[] })
    .filter((body) => (body.tools?.length ?? 0) !== 1)
    .flatMap((body) => (body.messages ?? []).filter((message) => message.role === 'system' || message.role === 'developer'))
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
}

/** The JSON lines a process witness appended to `file`; empty while none ran. */
export function witnessed(file: string): { pid: number; ppid: number; home: string; cwd: string; mode: string }[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pid: number; ppid: number; home: string; cwd: string; mode: string });
}

/** A witness command line for the agent's bash: this runner's node, forward slashes, every argument quoted. */
export function witnessCommand(...args: string[]): string {
  return [process.execPath, WITNESS, ...args].map((arg) => `"${arg.split(path.sep).join('/')}"`).join(' ');
}

/** How many credential requests for `provider` the daemon routed from its core to a client, from the daemon's logs. */
export function credentialRequests(home: HermeticHome, provider: string): number {
  const root = serverDir(home);
  return filesUnder(root)
    .filter((file) => file.endsWith('.log'))
    .flatMap((file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8').split('\n'))
    .filter((line) => line.includes(`[core-host] user.credentials for ${provider} from client `)).length;
}

/** Every provider main served a remote core's credential request for, in the order of its log lines. */
export function servedProviders(home: HermeticHome): string[] {
  return [...mainLog(home).matchAll(/\[remote\] user\.credentials (\S+) for loopback/g)].map((match) => match[1]!);
}

/** Every file below `root` whose bytes hold any of `needles`, as UTF-8 or UTF-16LE, with the needle it holds. */
export function filesHolding(root: string, needles: readonly string[]): string[] {
  const hits: string[] = [];
  for (const relative of filesUnder(root)) {
    const bytes = fs.readFileSync(path.join(root, ...relative.split('/')));
    for (const needle of needles) {
      if (bytes.includes(Buffer.from(needle, 'utf8')) || bytes.includes(Buffer.from(needle, 'utf16le'))) hits.push(`${relative}: ${needle}`);
    }
  }
  return hits;
}

/** Attaches the daemon's logs (daemon, core, pty host) from its home, which the launch fixture's diagnostics do not reach. */
export async function attachDaemonLogs(testInfo: TestInfo, home: HermeticHome): Promise<void> {
  const root = serverDir(home);
  for (const relative of filesUnder(root).filter((file) => file.endsWith('.log'))) {
    await testInfo.attach(`daemon-${relative.split('/').join('-')}`, { path: path.join(root, ...relative.split('/')), contentType: 'text/plain' });
  }
}
