import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { corePid } from './support/app';
import { expect, test } from './support/fixtures';
import { git, initRepo } from './support/git';
import { writeAuth, writeUserSettings, type HermeticHome } from './support/hermetic';
import { attachDaemonLogs, credentialRequests, filesHolding, mergeJson, newLoopbackChat, sendPrompt, servedProviders, startLoopbackStub, systemPrompts, targetAgentDir, targetDamoclesDir, witnessCommand, witnessed, WITNESS } from './support/loopback-agent';
import { cleanUp, daemonPid, endLeftoverDaemon, filesUnder, listRuns, LOCAL_DAEMON, loopbackHome, LOOPBACK_ENV, LOOPBACK_TAG, processTree, REVIEW_SHOTS, shutdownDaemon } from './support/loopback';
import { chatRequests, type OpenAIStub, type StubReply } from './support/openai-stub';
import { readyOverlay } from './support/overlay';
import { openProjectChat, setReducedMotion, showShellTheme, THEMES } from './support/screenshots';
import { holdToast, popupPage, popupToasts, recordToasts, setWindowFocused, shellPage, shellState } from './support/shell';
import { awaitTurnEnd, chatInput, clickMenu, hostMessages, postFromWebview, recordHostMessages } from './support/ui';
import { openTerminal } from './support/terminal';
import { optIn, setupReview } from './support/worktree-chat';
import { FILE_DRAG_MIME } from '../../src/shared/file-drag';

// A loopback chat's agent runs in the daemon's core.
const PROMPT_REGION = 'Permission request';
// This computer's API key and refresh token: neither may ever reach the target's home.
const REFRESH_TOKEN = 'e2e-refresh-token-0f3c9a';
const STUB_KEY = 'stub-key';
// The reason a remote core gives for a user-scope service, which runs on the client (agent-core's constant, English text).
const BROWSER_REFUSAL = 'The browser is not available in a chat on a remote host yet: it runs on your computer (user-scope-unavailable).';
const MEMORY_REFUSAL = 'Global memory is not available in a chat on a remote host yet: it runs on your computer (user-scope-unavailable).';

// the shown card: one that answered leaves through a transition while the next one enters
const prompt = (tab: Page): Locator => tab.locator(`section[role="region"][aria-label="${PROMPT_REGION}"]:not([class*="-leave-"])`);
// Answers the shown card; the next prompt may enter while it leaves, so this waits for that card's own element to go.
const yes = async (tab: Page): Promise<void> => {
  const card = prompt(tab);
  const handle = await card.elementHandle();
  await card.getByRole('option', { name: 'Yes', exact: true }).click();
  await handle!.waitForElementState('hidden');
};

function remoteFolder(home: HermeticHome, name = 'remote'): string {
  const folder = path.join(home.root, 'p', name);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/** Every tool result the stub received, in order, as text. */
function toolResults(stub: OpenAIStub): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const request of chatRequests(stub)) {
    for (const message of (request.body as { messages?: { role: string; tool_call_id?: string; content: unknown }[] }).messages ?? []) {
      if (message.role !== 'tool' || message.tool_call_id === undefined || seen.has(message.tool_call_id)) continue;
      seen.add(message.tool_call_id);
      results.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    }
  }
  return results;
}

/** pi's session files for chats in `cwd` under an agent dir (src/core/pi-session/session-store/session-dir.ts). */
function sessionFiles(agentDir: string, cwd: string): string[] {
  const dir = path.join(agentDir, 'sessions', `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name)) : [];
}

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (REVIEW_SHOTS === undefined) return;
  fs.mkdirSync(REVIEW_SHOTS, { recursive: true });
  await (target ?? page).screenshot({ path: path.join(REVIEW_SHOTS, `${name}.png`), animations: 'disabled' });
}

/** Captures `name` in dark, in light, and in dark with reduced motion, when review screenshots are asked for. */
async function shootThemes(app: ElectronApplication, page: Page, name: string, target?: Locator): Promise<void> {
  if (REVIEW_SHOTS === undefined) return;
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await shoot(page, `${name}-${theme}`, target);
  }
  await showShellTheme(app, 'dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setReducedMotion(app, true);
  await shoot(page, `${name}-reduced-motion`, target);
  await page.emulateMedia({ reducedMotion: null });
  await setReducedMotion(app, false);
}

/** The chat page that shows `text`, among every loaded chat page. */
async function pageShowing(app: ElectronApplication, text: string): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(async () => {
    found = undefined;
    for (const page of app.windows().filter((candidate) => !candidate.isClosed() && candidate.url().includes('/panel/'))) {
      if ((await page.getByText(text).count().catch(() => 0)) > 0) found = page;
    }
    return found !== undefined;
  }, { timeout: 90_000, message: `no chat page shows ${text}` }).toBe(true);
  return found!;
}

test('a loopback chat\'s bash, Write, Read and Edit run in the daemon\'s core with its environment, the prompt describes the target, one credential request serves the turns, and the target\'s home holds no key or refresh token', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(360_000);
  const stub = await startLoopbackStub(home);
  const folder = remoteFolder(home);
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n' });
  // this computer's sign-ins: the stub's key, and a grant no turn or sub-call uses whose refresh token stays here
  writeAuth(home, {
    openai: { type: 'api_key', key: STUB_KEY },
    'github-copilot': { type: 'oauth', access: 'e2e-access-token', refresh: REFRESH_TOKEN, expires: Date.now() + 3_600_000 },
  });
  const witness = path.join(home.root, 'bash-witness.jsonl');
  const release = path.join(home.root, 'bash-release');
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    const { tab } = await newLoopbackChat(app, folder);

    stub.replies.push(
      { chunks: ['Checking where I run. '], toolCalls: [{ name: 'bash', arguments: { command: witnessCommand(witness, 'hold', release) } }] },
      { chunks: [], toolCalls: [{ name: 'write', arguments: { path: path.join(folder, 'made.txt'), content: 'made on the target\n' } }] },
      { chunks: [], toolCalls: [{ name: 'read', arguments: { path: path.join(folder, 'a.ts') } }] },
      { chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: path.join(folder, 'a.ts'), old_string: 'a = 1', new_string: 'a = 2' } }] },
      { chunks: ['Tools done on the target.'] },
    );
    await sendPrompt(tab, 'Use your tools on the target');

    // bash: its process is the daemon's descendant, never the local core's, and its home is the daemon's.
    await expect(prompt(tab).getByTestId('permission-title')).toHaveText(`Run this command on ${LOCAL_DAEMON}?`);
    await yes(tab);
    await expect.poll(() => witnessed(witness).length, { timeout: 60_000 }).toBe(1);
    const [shellRun] = witnessed(witness);
    expect(await processTree(await daemonPid(home))).toContain(shellRun!.pid);
    const localCore = await corePid(app);
    expect(localCore).toBeDefined();
    expect(await processTree(localCore!)).not.toContain(shellRun!.pid);
    expect(path.resolve(shellRun!.home)).toBe(path.resolve(loopbackHome(home)));
    expect(path.resolve(shellRun!.cwd)).toBe(path.resolve(folder));
    fs.writeFileSync(release, '');

    // Write and Edit ask with their diff (shown through the daemon's workspace) and land in the target folder; Read reads it.
    const asked: string[] = [];
    const done = tab.getByText('Tools done on the target.');
    while (!(await done.isVisible())) {
      await expect(prompt(tab).or(done)).toBeVisible({ timeout: 60_000 });
      if (await done.isVisible()) break;
      asked.push(await prompt(tab).innerText());
      await yes(tab);
    }
    expect(asked, JSON.stringify(toolResults(stub))).toEqual([expect.stringContaining('made.txt'), expect.stringContaining('a.ts')]);
    await awaitTurnEnd(tab);
    expect(read(path.join(folder, 'made.txt'))).toBe('made on the target\n');
    expect(read(path.join(folder, 'a.ts'))).toBe('export const a = 2;\n');
    expect(toolResults(stub).some((result) => result.includes('export const a = 1;'))).toBe(true);

    // The conversation lives in the daemon's home only: the target's pi agent dir has it, this computer's has none.
    expect(sessionFiles(targetAgentDir(home), folder)).toHaveLength(1);
    expect(sessionFiles(home.agentDir, folder)).toEqual([]);
    expect(read(sessionFiles(targetAgentDir(home), folder)[0]!)).toContain('made on the target');

    // The system prompt names the target's working directory, platform, shell and OS.
    const system = systemPrompts(stub).at(-1) ?? '';
    expect(system).toContain(`Primary working directory: ${folder}`);
    expect(system).toContain(`Platform: ${process.platform}`);
    expect(system).toMatch(/Shell: \S+/);
    expect(system).toContain(`OS Version: ${os.type()} ${os.release()}`);

    // One credential request for openai served the five model calls, and a second turn while the key holds asks none.
    expect(chatRequests(stub).length).toBeGreaterThanOrEqual(5);
    expect(credentialRequests(home, 'openai')).toBe(1);
    // only the provider the turns used: the key-presence checks and the model list ask for nothing
    expect(servedProviders(home)).toEqual(['openai']);
    await sendPrompt(tab, 'Once more');
    await expect(tab.getByText('Echo: Once more', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    expect(credentialRequests(home, 'openai')).toBe(1);
    expect(servedProviders(home)).toEqual(['openai']);

    await shutdownDaemon(app, home);
    // After the session the target's home holds neither this computer's API key nor its refresh token, in any file.
    expect(filesHolding(loopbackHome(home), [STUB_KEY, REFRESH_TOKEN])).toEqual([]);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    fs.writeFileSync(release, '');
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
    await attachDaemonLogs(testInfo, home);
  }
});

test('a loopback turn keeps running across an app quit; the relaunched view rejoins it through views.join and streams to the end with no gap and no duplicate', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(360_000);
  const stub = await startLoopbackStub(home);
  const folder = remoteFolder(home);
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n' });
  const gate = (): { until: Promise<void>; open: () => void; reached: Promise<void>; sent: () => void } => {
    let open = (): void => undefined;
    let sent = (): void => undefined;
    const until = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (sent = resolve));
    return { until, open, reached, sent };
  };
  const whileAway = gate();
  const afterRejoin = gate();
  const PARTS = ['Part one, ', 'part two, ', 'part three, ', 'part four, ', 'part five.'];
  const reply: StubReply = { chunks: PARTS, holds: [{ before: 1, until: whileAway.until, sent: whileAway.sent }, { before: 3, until: afterRejoin.until, sent: afterRejoin.sent }] };
  let current: ElectronApplication | undefined;
  let failure: unknown;
  try {
    const first = await launch(LOOPBACK_ENV);
    current = first.app;
    const { tab } = await newLoopbackChat(first.app, folder);
    stub.replies.push(reply);
    await sendPrompt(tab, 'Tell me a long story');
    await whileAway.reached;
    await expect(tab.getByText('Part one,')).toBeVisible();
    const running = (await listRuns(first.app)).runs.filter((run) => run.kind === 'chat');
    expect(running).toEqual([expect.objectContaining({ state: expect.stringMatching(/running/) })]);

    // The quit detaches this computer; parts two and three stream into the daemon's core while no view shows them.
    await first.close();
    current = undefined;
    whileAway.open();
    await afterRejoin.reached;

    const second = await launch(LOOPBACK_ENV);
    current = second.app;
    // Only a views.join shows parts of a reply that has not ended: a restore replays the session file, which holds none yet.
    const rejoined = await pageShowing(second.app, 'part three,');
    await expect(rejoined.getByText('part four,')).toHaveCount(0);
    afterRejoin.open();
    const whole = PARTS.join('');
    await expect(rejoined.getByText(whole.trim(), { exact: true })).toHaveCount(1, { timeout: 60_000 });
    await awaitTurnEnd(rejoined);
    // contiguous and once: no part is missing, and none shows twice
    for (const part of PARTS) expect(((await rejoined.locator('body').innerText()).match(new RegExp(part.trim().replace(/[.,]/g, '\\$&'), 'g')) ?? []).length).toBe(1);
    expect(chatRequests(stub).filter((request) => JSON.stringify(request.body).includes('Tell me a long story') && (((request.body as { tools?: unknown[] }).tools?.length ?? 0) !== 1))).toHaveLength(1);
    await shutdownDaemon(second.app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    whileAway.open();
    afterRejoin.open();
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(current, home));
    await stub.close();
    await attachDaemonLogs(testInfo, home);
  }
});

test('checkpoints and rewind restore the target\'s files, from a checkpoint store in the daemon\'s home', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const stub = await startLoopbackStub(home);
  const folder = remoteFolder(home);
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n' });
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    const { tab } = await newLoopbackChat(app, folder);
    await recordHostMessages(tab);
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: path.join(folder, 'a.ts'), old_string: 'a = 1', new_string: 'a = 5' } }] },
      { chunks: [], toolCalls: [{ name: 'write', arguments: { path: path.join(folder, 'new.ts'), content: 'export const fresh = true;\n' } }] },
      { chunks: ['Changed two files.'] },
    );
    await sendPrompt(tab, 'Change the files');
    await yes(tab);
    await yes(tab);
    await expect(tab.getByText('Changed two files.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    expect(read(path.join(folder, 'a.ts'))).toBe('export const a = 5;\n');
    expect(read(path.join(folder, 'new.ts'))).toBe('export const fresh = true;\n');

    // The checkpoint store is the target's: under the daemon's ~/.damocles/pi/checkpoints, none under this computer's.
    await expect.poll(() => filesUnder(path.join(targetDamoclesDir(home), 'pi', 'checkpoints')).length, { timeout: 60_000 }).toBeGreaterThan(0);
    expect(filesUnder(path.join(home.damoclesDir, 'pi', 'checkpoints'))).toEqual([]);

    let prompts: { messageId: string; content: string }[] = [];
    await expect.poll(async () => {
      await postFromWebview(tab, { type: 'requestRewindHistory' });
      prompts = ((await hostMessages(tab, 'rewindHistory')).at(-1)?.['prompts'] as typeof prompts | undefined) ?? [];
      return prompts.map((item) => item.content);
    }, { timeout: 60_000 }).toContain('Change the files');
    const target = prompts.find((item) => item.content === 'Change the files')!;
    await postFromWebview(tab, { type: 'rewindToMessage', userMessageId: target.messageId, option: 'code-only' });
    await expect.poll(async () => (await hostMessages(tab, 'rewindComplete')).length, { timeout: 60_000 }).toBe(1);
    expect((await hostMessages(tab, 'rewindComplete'))[0]?.['fileRewindWarning']).toBeUndefined();
    expect(read(path.join(folder, 'a.ts'))).toBe('export const a = 1;\n');
    expect(fs.existsSync(path.join(folder, 'new.ts'))).toBe(false);
    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
    await attachDaemonLogs(testInfo, home);
  }
});

test('a trusted loopback project runs its hooks and its .mcp.json stdio server on the target, an untrusted one runs neither; subagents and teams run there too', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(420_000);
  const stub = await startLoopbackStub(home);
  mergeJson(path.join(home.damoclesDir, 'settings.json'), { 'damocles.team.enabled': true });
  mergeJson(path.join(targetDamoclesDir(home), 'settings.json'), { 'damocles.team.enabled': true });
  const out = (name: string): string => path.join(home.root, `${name}.jsonl`);
  // A project whose prompt hook and stdio MCP server each record where they ran.
  const project = async (name: string): Promise<string> => {
    const folder = remoteFolder(home, name);
    await initRepo(home, folder, {
      'a.ts': 'export const a = 1;\n',
      '.damocles/hooks.json': `${JSON.stringify({ hooks: { input: [{ command: [process.execPath, WITNESS, out(`${name}-hook`)] }] } }, null, 2)}\n`,
      '.mcp.json': `${JSON.stringify({ mcpServers: { 'e2e-witness': { command: process.execPath, args: [WITNESS, out(`${name}-mcp`), 'mcp'] } } }, null, 2)}\n`,
    });
    return folder;
  };
  const trusted = await project('trusted');
  const untrusted = await project('untrusted');
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    const { tab } = await newLoopbackChat(app, trusted);
    await recordHostMessages(tab);
    stub.replies.push({ chunks: ['Hooked turn done.'] });
    await sendPrompt(tab, 'Run with hooks');
    await expect(tab.getByText('Hooked turn done.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const turnEnded = Date.now();
    await expect.poll(async () => {
      await postFromWebview(tab, { type: 'requestMcpStatus' });
      const servers = ((await hostMessages(tab, 'mcpServerStatus')).at(-1)?.['servers'] as { name: string; status: string }[] | undefined) ?? [];
      return servers.find((server) => server.name === 'e2e-witness')?.status;
    }, { timeout: 60_000 }).toBe('connected');
    // how long the trusted server took to start after its turn, which the untrusted one below is given too
    const startedWithin = Date.now() - turnEnded;
    const hook = witnessed(out('trusted-hook'));
    const mcp = witnessed(out('trusted-mcp'));
    expect(hook.length).toBeGreaterThan(0);
    expect(mcp.length).toBeGreaterThan(0);
    for (const run of [...hook, ...mcp]) expect(path.resolve(run.home)).toBe(path.resolve(loopbackHome(home)));
    // the server is alive now: it is under the daemon, not under this computer's core
    expect(await processTree(await daemonPid(home))).toContain(mcp.at(-1)!.pid);
    expect(await processTree((await corePid(app))!)).not.toContain(mcp.at(-1)!.pid);

    // A subagent and a team agent each run a bash command on the target.
    const agentWitness = out('agents');
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Agent', arguments: { description: 'Survey the target', prompt: 'Run one command.', subagent_type: 'general-purpose' } }] },
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: witnessCommand(agentWitness) } }] },
      { chunks: ['Subagent done.'] },
      { chunks: ['Main agent done.'] },
    );
    await sendPrompt(tab, 'Start a subagent');
    await expect(prompt(tab)).toContainText('Survey the target wants to run this command:');
    await yes(tab);
    await expect(tab.getByText('Main agent done.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    expect(witnessed(agentWitness).map((run) => path.resolve(run.home))).toEqual([path.resolve(loopbackHome(home))]);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'create_team', arguments: { title: 'Lockout', brief: 'Lock an account after ten failed logins.', agents: [{ name: 'Atlas', role: 'lead' }, { name: 'Mira', role: 'specialist' }] } }] },
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: witnessCommand(agentWitness) } }] },
      { chunks: ['Waiting on the team'], holdAfterFirst: new Promise<void>(() => undefined) },
    );
    await sendPrompt(tab, 'Start a team');
    await expect(prompt(tab)).toContainText('Atlas from team Lockout wants to run this command:');
    await yes(tab);
    await expect.poll(() => witnessed(agentWitness).length, { timeout: 60_000 }).toBe(2);
    expect(path.resolve(witnessed(agentWitness)[1]!.home)).toBe(path.resolve(loopbackHome(home)));

    // The untrusted project: a finished turn ran no hook; its chat's MCP status, once answered, lists the server as not
    // started, and as long as the trusted server took to start, it still has not.
    const { tab: other } = await newLoopbackChat(app, untrusted, false);
    stub.replies.push({ chunks: ['Untrusted turn done.'] });
    await sendPrompt(other, 'Run without hooks');
    await expect(other.getByText('Untrusted turn done.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(other);
    const otherEnded = Date.now();
    expect(witnessed(out('untrusted-hook'))).toEqual([]);
    await recordHostMessages(other);
    await postFromWebview(other, { type: 'requestMcpStatus' });
    await expect.poll(async () => {
      const servers = (await hostMessages(other, 'mcpServerStatus')).at(-1)?.['servers'] as { name: string; status: string; untrusted?: boolean }[] | undefined;
      const witness = servers?.find((server) => server.name === 'e2e-witness');
      return witness && { status: witness.status, untrusted: witness.untrusted };
    }, { timeout: 60_000 }).toEqual({ status: 'disabled', untrusted: true });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, startedWithin - (Date.now() - otherEnded))));
    expect(witnessed(out('untrusted-mcp'))).toEqual([]);
    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
    await attachDaemonLogs(testInfo, home);
  }
});

test('a worktree chat on a loopback project is created, set up in a Setup terminal on the daemon\'s pty host, and applied to the project folder', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(360_000);
  const stub = await startLoopbackStub(home);
  mergeJson(path.join(home.damoclesDir, 'settings.json'), { 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const folder = remoteFolder(home, 'acme');
  const setupWitness = path.join(home.root, 'setup.jsonl');
  const setupRelease = path.join(home.root, 'setup-release');
  // held until the test has looked at its process; quoted to run the same in PowerShell and a POSIX shell
  const setup = `node ${[WITNESS, setupWitness, 'hold', setupRelease].map((arg) => `"${arg.split(path.sep).join('/')}"`).join(' ')}`;
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n', '.damocles/worktree.json': `${JSON.stringify({ setup: [setup] }, null, 2)}\n` });
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    await newLoopbackChat(app, folder);
    const tab = await optIn(app);
    stub.replies.push({ chunks: ['Worktree ready.'] });
    await sendPrompt(tab, 'Start in a worktree');
    const overlay = await readyOverlay(app);
    await expect(setupReview(overlay)).toBeVisible({ timeout: 60_000 });
    await setupReview(overlay).getByTestId('worktree-dialog-run').click();

    // Setup runs in a terminal of the daemon's pty host: its process is under the daemon, and control.listRuns lists the terminal.
    await expect.poll(() => witnessed(setupWitness).length, { timeout: 60_000 }).toBe(1);
    const [setupRun] = witnessed(setupWitness);
    expect(await processTree(await daemonPid(home))).toContain(setupRun!.pid);
    expect(await processTree((await corePid(app))!)).not.toContain(setupRun!.pid);
    expect(path.resolve(setupRun!.home)).toBe(path.resolve(loopbackHome(home)));
    const terminals = (await listRuns(app)).runs.filter((run) => run.kind === 'terminal');
    expect(terminals.length).toBeGreaterThan(0);
    const shown = await (await shellPage(app)).evaluate(() => window.damoclesShell!.terminal.getState());
    // this window shows the daemon's Setup terminal
    expect(shown.terminals.map((terminal) => terminal.id), JSON.stringify(shown.terminals)).toEqual(expect.arrayContaining(terminals.map((run) => run.id)));
    fs.writeFileSync(setupRelease, '');
    await expect(tab.getByText('Worktree ready.')).toBeVisible({ timeout: 90_000 });
    await awaitTurnEnd(tab);

    // The registry and the worktree are the target's: under the daemon's ~/.damocles/worktrees, none on this computer.
    const registry = JSON.parse(read(path.join(targetDamoclesDir(home), 'worktrees', 'registry.json'))) as { records: { kind: string; workingFolder: string; deletedAt?: number }[] };
    const record = registry.records.find((candidate) => candidate.kind === 'chat' && candidate.deletedAt === undefined);
    expect(record).toBeDefined();
    expect(path.relative(path.join(targetDamoclesDir(home), 'worktrees'), record!.workingFolder).startsWith('..')).toBe(false);
    expect(fs.existsSync(path.join(home.damoclesDir, 'worktrees', 'registry.json'))).toBe(false);
    expect(read(path.join(record!.workingFolder, 'a.ts')), JSON.stringify(filesUnder(record!.workingFolder))).toBe('export const a = 1;\n');

    // The chat's Edit asks with its diff and lands in the worktree only.
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: path.join(record!.workingFolder, 'a.ts'), old_string: 'a = 1', new_string: 'a = 3' } }] },
      { chunks: ['Edited in the worktree.'] },
    );
    await sendPrompt(tab, 'Raise a in the worktree');
    await expect(prompt(tab)).toContainText('a.ts', { timeout: 60_000 });
    await yes(tab);
    await expect(tab.getByText('Edited in the worktree.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    expect(read(path.join(record!.workingFolder, 'a.ts'))).toBe('export const a = 3;\n');
    expect(read(path.join(folder, 'a.ts'))).toBe('export const a = 1;\n');

    // Setup ran in the worktree.
    expect(path.resolve(setupRun!.cwd)).toBe(path.resolve(record!.workingFolder));

    // Apply: the worktree's change reaches the project folder through the daemon's core.
    await clickMenu(app, 'damocles.worktree.apply');
    await expect.poll(() => read(path.join(folder, 'a.ts')), { timeout: 60_000 }).toBe('export const a = 3;\n');
    expect(await git(home, folder, 'status', '--porcelain')).toContain('a.ts');

    // The worktree chat's New chat in project opens a chat in the loopback project.
    const launched = app;
    const worktreeChat = (await shellState(launched)).selected;
    await postFromWebview(tab, { type: 'worktreeAction', action: 'newChatInProject' });
    await expect.poll(async () => (await shellState(launched)).selected.chatId, { timeout: 60_000 }).not.toBe(worktreeChat.chatId);
    expect((await shellState(launched)).selected.projectKey).toBe(worktreeChat.projectKey);
    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    fs.writeFileSync(setupRelease, '');
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
    await attachDaemonLogs(testInfo, home);
  }
});

test('permissions on a loopback chat: "Always allow on Local daemon" writes the target\'s settings only, a deny rule on this computer beats a target allow, and YOLO is refused even forged', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(360_000);
  const stub = await startLoopbackStub(home);
  const folder = remoteFolder(home);
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n' });
  // This computer denies the command; the target's Claude settings allow it.
  mergeJson(path.join(home.damoclesDir, 'settings.json'), { permissions: { deny: ['Bash(printf client-deny-%s ok)'] } });
  mergeJson(path.join(loopbackHome(home), '.claude', 'settings.json'), { permissions: { allow: ['Bash(printf client-deny-%s ok)'] } });
  const clientFiles = [
    path.join(home.damoclesDir, 'settings.json'),
    path.join(home.damoclesDir, 'settings.local.json'),
    path.join(home.home, '.claude', 'settings.json'),
    path.join(home.home, '.claude', 'settings.local.json'),
    path.join(folder, '.damocles', 'settings.json'),
    path.join(folder, '.damocles', 'settings.local.json'),
  ];
  const snapshot = (): Record<string, string | null> => Object.fromEntries(clientFiles.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null]));
  const targetSettings = path.join(targetDamoclesDir(home), 'settings.json');
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    const { tab } = await newLoopbackChat(app, folder);
    await recordHostMessages(tab);
    const before = snapshot();

    // A client deny blocks the call without asking, though the target's ~/.claude/settings.json allows it.
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'printf client-deny-%s ok' } }] }, { chunks: ['Deny checked.'] });
    await sendPrompt(tab, 'Try the denied command');
    await expect(tab.getByText('Deny checked.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    expect(toolResults(stub).at(-1)).not.toContain('client-deny-ok');
    expect(toolResults(stub).at(-1)).toMatch(/denied|deny|blocked/i);

    // "Always allow" for all projects: the card names the host, and the rule lands in the target's ~/.damocles/settings.json.
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'printf always-%s ok' } }] },
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'printf always-%s ok' } }] },
      { chunks: ['Allowed twice.'] },
    );
    await sendPrompt(tab, 'Run it twice');
    await expect(prompt(tab)).toContainText('printf always-%s ok');
    // a remote chat's card names the host in its title, with the host badge
    const title = prompt(tab).getByTestId('permission-title');
    await expect(title).toHaveText(`Run this command on ${LOCAL_DAEMON}?`);
    await expect(title.getByTestId('host-name-badge')).toHaveText(LOCAL_DAEMON);
    await shootThemes(app, tab, 'permission-card-on-host', prompt(tab));
    await prompt(tab).getByRole('option', { name: /^Always allow/ }).click();
    const allHosts = tab.getByTestId('permission-destination-userSettings');
    await expect(allHosts).toContainText(`Always allow on ${LOCAL_DAEMON}`);
    await expect(allHosts.getByTestId('host-name-badge')).toHaveText(LOCAL_DAEMON);
    await shootThemes(app, tab, 'permission-always-allow-on-host');
    await allHosts.click();
    await expect.poll(() => (JSON.parse(read(targetSettings) || '{}') as { permissions?: { allow?: string[] } }).permissions?.allow ?? []).toContain('Bash(printf:*)');
    await expect(tab.getByText('Allowed twice.').or(prompt(tab))).toBeVisible({ timeout: 60_000 });
    await expect(prompt(tab), 'the saved rule lets the second identical call run unasked').toHaveCount(0);
    await expect(tab.getByText('Allowed twice.')).toBeVisible();
    await awaitTurnEnd(tab);
    expect(toolResults(stub).filter((result) => result.includes('always-ok'))).toHaveLength(2);
    const saved = JSON.parse(read(targetSettings)) as { permissions?: { allow?: string[] } };
    expect(saved.permissions?.allow).toContain('Bash(printf:*)');
    expect(snapshot()).toEqual(before);

    // YOLO: a forged switch from the view is refused inline, naming the host; the next command still asks.
    const refused = tab.getByTestId('yolo-refused');
    // the notice shows for a few seconds, so each capture forges the switch again
    const forgeYolo = async (): Promise<void> => {
      await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
      await expect(refused).toBeVisible();
      await expect(refused).toContainText(`YOLO is off for your turns on ${LOCAL_DAEMON}`);
    };
    for (const theme of THEMES) {
      await showShellTheme(app, theme);
      await forgeYolo();
      await shoot(tab, `yolo-refused-${theme}`, refused);
    }
    await showShellTheme(app, 'dark');
    await setReducedMotion(app, true);
    await tab.emulateMedia({ reducedMotion: 'reduce' });
    await forgeYolo();
    await shoot(tab, 'yolo-refused-reduced-motion', refused);
    await tab.emulateMedia({ reducedMotion: null });
    await setReducedMotion(app, false);
    await postFromWebview(tab, { type: 'setPermissionMode', mode: 'bypassPermissions' });
    await postFromWebview(tab, { type: 'setDefaultDangerouslySkipPermissions', enabled: true });
    await expect.poll(async () => (await hostMessages(tab, 'permissionModeRefused')).map((message) => `${String(message['mode'])}:${String(message['reason'])}`)).toEqual([
      ...THEMES.map(() => 'dangerouslySkipPermissions:remote-host'),
      'dangerouslySkipPermissions:remote-host',
      'bypassPermissions:unknown-mode',
      'dangerouslySkipPermissions:remote-host',
    ]);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'echo still-asks' } }] }, { chunks: ['Asked anyway.'] });
    await sendPrompt(tab, 'Run after YOLO');
    await expect(prompt(tab)).toContainText('echo still-asks');
    await yes(tab);
    await expect(tab.getByText('Asked anyway.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    expect(read(targetSettings)).not.toMatch(/dangerouslySkipPermissions"\s*:\s*true/);
    expect(snapshot()).toEqual(before);
    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
    await attachDaemonLogs(testInfo, home);
  }
});

interface VoiceHooks {
  __damoclesE2e: { voice: { fake(transcript: string): Promise<{ pid: number }>; recorder(): Promise<{ starts: number; recorderPid: number | null }> } };
}

test('on a loopback chat voice records in this computer\'s core and fills the remote composer; browser tools and global memory give the user-scope reason; a local file drop is refused naming both places, the host\'s own file is mentioned, and a pasted image and a local terminal\'s output attach', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(360_000);
  const stub = await startLoopbackStub(home);
  const folder = remoteFolder(home);
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n' });
  mergeJson(path.join(home.damoclesDir, 'settings.json'), { 'damocles.browser.enabled': true, 'damocles.memory.enabled': true, 'damocles.voice.provider': 'openai-whisper', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    // a local project whose file the drop below carries
    fs.writeFileSync(path.join(home.project, 'notes.md'), '# Notes\n');
    await openProjectChat(app, home.project);
    const localKey = (await shellState(app)).selected.projectKey;
    expect(localKey?.startsWith('loopback|')).toBe(false);
    // a terminal of the local project, whose output the remote chat takes below
    const terminalShell = await openTerminal(app);
    const localTerminal = (await terminalShell.evaluate(() => window.damoclesShell!.terminal.getState())).activeId!;
    await app.evaluate(async () => (globalThis as unknown as { __damoclesE2e: { secrets: { store(key: string, value: string): Promise<void> } } }).__damoclesE2e.secrets.store('damocles.voice.apiKey:openai-whisper', 'e2e-voice-key'));
    const { key: remoteKey, tab } = await newLoopbackChat(app, folder);

    // Voice: the recorder process is a child of this computer's core, never of the daemon's tree; the transcript fills the composer.
    const { pid: localCore } = await app.evaluate((_electron) => (globalThis as unknown as VoiceHooks).__damoclesE2e.voice.fake('Transcribed on this computer'));
    expect(localCore).toBe(await corePid(app));
    const mic = tab.getByTestId('composer-voice');
    await expect(mic).toBeEnabled();
    await mic.click();
    let recorderPid: number | null = null;
    await expect.poll(async () => (recorderPid = (await app!.evaluate(() => (globalThis as unknown as VoiceHooks).__damoclesE2e.voice.recorder())).recorderPid)).not.toBeNull();
    expect(await processTree(localCore)).toContain(recorderPid);
    expect(await processTree(await daemonPid(home))).not.toContain(recorderPid);
    await mic.click();
    await expect(chatInput(tab)).toHaveValue(/Transcribed on this computer/);
    await shootThemes(app, tab, 'voice-transcript-in-remote-composer');
    await chatInput(tab).fill('');

    // Browser tools: off the ToolSearch menu of the remote chat; loading one answers with the user-scope reason.
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'ToolSearch', arguments: { tools: ['BrowserNavigate'] } }] },
      { chunks: [], toolCalls: [{ name: 'BrowserNavigate', arguments: { url: 'https://example.com' } }] },
      { chunks: ['Browser checked.'] },
    );
    await sendPrompt(tab, 'Open a page');
    await expect(tab.getByText('Browser checked.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const [load, direct] = toolResults(stub).slice(-2);
    expect(load).toContain(`Not available: BrowserNavigate. ${BROWSER_REFUSAL}`);
    // a deferred tool that was never loaded is unknown to pi, which answers before any Damocles hook runs
    expect(direct).toBe('Tool BrowserNavigate not found');
    // the tools offered with the prompt: no browser tool, and ToolSearch's menu lists none to load
    const tools = ((chatRequests(stub).find((request) => JSON.stringify(request.body).includes('Open a page'))?.body as { tools?: { function?: { name?: string; description?: string } }[] } | undefined)?.tools ?? []).map((tool) => tool.function ?? {});
    expect(tools.map((tool) => tool.name).filter((name) => /^Browser/.test(name ?? ''))).toEqual([]);
    const toolSearch = tools.find((tool) => tool.name === 'ToolSearch');
    expect(toolSearch).toBeDefined();
    expect(toolSearch!.description).not.toMatch(/BrowserNavigate|BrowserScreenshot|BrowserClick/);

    // Global memory: search and save refuse with the user-scope reason, and the target's database holds no global row.
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'SearchMemories', arguments: { query: 'anything', tiers: ['global'] } }] },
      { chunks: [], toolCalls: [{ name: 'SaveMemory', arguments: { content: 'e2e global preference', kind: 'preference', scope: 'global' } }] },
      { chunks: ['Memory checked.'] },
    );
    await sendPrompt(tab, 'Use global memory');
    await expect(tab.getByText('Memory checked.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const [search, save] = toolResults(stub).slice(-2);
    expect(search).toContain(MEMORY_REFUSAL);
    expect(save).toContain(MEMORY_REFUSAL);

    // A drop of this computer's file is refused with a toast naming both places; nothing reaches the composer.
    const composer = tab.getByTestId('composer');
    const drop = (file: { readonly projectKey: string | undefined; readonly relativePath: string }): Promise<void> => composer.evaluate((card, [mime, value]) => {
      const data = new DataTransfer();
      data.setData(mime, value);
      for (const type of ['dragenter', 'dragover', 'drop']) card.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }, [FILE_DRAG_MIME, JSON.stringify(file)] as const);
    await drop({ projectKey: localKey, relativePath: 'notes.md' });
    const popup = await popupPage(app);
    await expect(popupToasts(popup).filter({ hasText: LOCAL_DAEMON }).filter({ hasText: 'This computer' })).toHaveCount(1);
    await expect(chatInput(tab)).toHaveValue('');

    // A drop of the host's own project file is mentioned in the composer, as a drop is in a local chat.
    await drop({ projectKey: remoteKey, relativePath: 'a.ts' });
    await expect(chatInput(tab)).toHaveValue(/a\.ts/);
    await chatInput(tab).fill('');

    // Output of a terminal on this computer is attached text, which a chat on any host takes.
    await terminalShell.evaluate((id) => window.damoclesShell!.terminal.addToChat({ id, source: 'selection', commandId: null, text: 'local terminal output', omittedLines: 0 }), localTerminal);
    await expect(composer.getByTestId('terminal-attachment-chip')).toHaveCount(1);

    // A pasted image attaches to the remote chat's composer as it does locally.
    await chatInput(tab).focus();
    await chatInput(tab).evaluate((input) => {
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([png], 'pasted.png', { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(tab.getByTestId('composer').getByRole('img')).toHaveCount(1);
    await shutdownDaemon(app, home);

    // Read once the daemon's core closed it: the target's memory database holds no global row and not the refused text.
    const db = new DatabaseSync(path.join(targetDamoclesDir(home), 'memory.v3.db'), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM memories WHERE scope = 'global'").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    // the conversation records the refused call; the memory database files never hold its text
    expect(filesHolding(targetDamoclesDir(home), ['e2e global preference']).filter((hit) => hit.startsWith('memory'))).toEqual([]);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
    await attachDaemonLogs(testInfo, home);
  }
});

test('a loopback chat\'s UI: a remote toast and bell row name the host, and the model picker offers a provider at a loopback endpoint, which the loopback daemon shares with this computer', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const stub = await startLoopbackStub(home);
  // DeepSeek pointed at a loopback address on the target, which runs on this computer
  const models = path.join(targetAgentDir(home), 'models.json');
  const providers = (JSON.parse(read(models)) as { providers: Record<string, unknown> }).providers;
  mergeJson(models, { providers: { ...providers, deepseek: { baseUrl: 'http://127.0.0.1:9/v1' } } });
  // DeepSeek has no credential, so the picker lists it only when asked to
  writeUserSettings(home, { 'damocles.modelPicker.providers': { deepseek: true } });
  const folder = remoteFolder(home);
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n' });
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    const { tab } = await newLoopbackChat(app, folder);

    // A turn that finishes while the window is not focused raises a done toast and a bell row, each naming the host.
    await recordToasts(app);
    await setWindowFocused(app, false);
    await sendPrompt(tab, 'Work while I look away');
    await expect(tab.getByText('Echo: Work while I look away', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const popup = await popupPage(app);
    const toast = popupToasts(popup).filter({ hasText: 'Finished' });
    await holdToast(app, toast);
    await expect(toast.getByTestId('host-name-badge')).toHaveText(LOCAL_DAEMON);
    if (REVIEW_SHOTS !== undefined) {
      fs.mkdirSync(REVIEW_SHOTS, { recursive: true });
      for (const theme of THEMES) {
        await showShellTheme(app, theme);
        await toast.screenshot({ path: path.join(REVIEW_SHOTS, `remote-toast-${theme}.png`), animations: 'disabled' });
      }
      await showShellTheme(app, 'dark');
      await popup.emulateMedia({ reducedMotion: 'reduce' });
      await toast.screenshot({ path: path.join(REVIEW_SHOTS, 'remote-toast-reduced-motion.png'), animations: 'disabled' });
      await popup.emulateMedia({ reducedMotion: null });
    }
    await toast.getByTestId('overlay-toast-dismiss').click();
    await setWindowFocused(app, true);
    const shell = await shellPage(app);
    await shell.getByTestId('notification-bell').click();
    const overlay = await readyOverlay(app);
    const row = overlay.locator('[data-testid="notification-row"][data-kind="done"]');
    await expect(row.getByTestId('host-name-badge')).toHaveText(LOCAL_DAEMON);
    await shootThemes(app, overlay, 'remote-bell-row', overlay.getByTestId('notification-center'));
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByTestId('notification-center')).toHaveCount(0);

    // The model picker leaves a provider at a loopback endpoint selectable: the loopback daemon's core reaches this computer's loopback.
    await tab.getByTestId('composer-model').click();
    const menu = tab.getByTestId('composer-model-menu');
    await expect(menu).toBeVisible();
    const deepseek = menu.locator('[data-testid="composer-model-option"]').filter({ hasText: 'DeepSeek V4 Pro' });
    await expect(deepseek).toHaveCount(1).catch(async (error: unknown) => {
      fs.writeFileSync(testInfo.outputPath('menu.txt'), await menu.evaluate((element) => element.outerHTML));
      throw error;
    });
    await expect(deepseek).not.toHaveAttribute('data-unavailable');
    await expect(deepseek).not.toHaveAttribute('data-disabled');
    await expect(menu.locator('[data-testid="composer-model-option"]:not([data-unavailable])').filter({ hasText: 'GPT-6 Luna' })).toHaveCount(1);
    await tab.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
    await attachDaemonLogs(testInfo, home);
  }
});

test('a loopback chat\'s sign-in opens the settings overlay on the User tab, served by this computer\'s core, and a key saved there reaches the remote chat through clientAuth', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const stub = await startLoopbackStub(home);
  // this computer starts with no credential at all; the target serves DeepSeek from the stub, so a DeepSeek key saved here is usable
  writeAuth(home, {});
  const models = path.join(targetAgentDir(home), 'models.json');
  const providers = (JSON.parse(read(models)) as { providers: Record<string, unknown> }).providers;
  mergeJson(models, { providers: { ...providers, deepseek: { baseUrl: stub.baseUrl } } });
  // signed out of both, so the picker lists them only when asked to
  writeUserSettings(home, { 'damocles.modelPicker.providers': { openai: true, deepseek: true } });
  const DEEPSEEK_KEY = 'sk-e2e-deepseek-key';
  const folder = remoteFolder(home);
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n' });
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    const { tab } = await newLoopbackChat(app, folder);
    await recordHostMessages(tab);

    // Picking a GPT model with no OpenAI sign-in is refused, and its sign-in opens settings on the User tab at the OpenAI account.
    const pick = async (model: string): Promise<void> => {
      await tab.getByTestId('composer-model').click();
      const options = tab.getByTestId('composer-model-menu').locator('[data-testid="composer-model-option"]');
      // the picker lists every model until the chat's account state arrives, the GitHub Copilot copies included
      await expect(options.filter({ hasText: 'Gemini 4 Argon' })).toHaveCount(0);
      await options.filter({ hasText: model }).click();
    };
    await pick('GPT-6 Astra');
    await expect.poll(async () => (await hostMessages(tab, 'openaiAuthRequired')).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const overlay = await readyOverlay(app);
    await expect(overlay.getByTestId('settings-modal')).toBeVisible({ timeout: 30_000 });
    await expect(overlay.getByTestId('settings-scope-user')).toHaveAttribute('aria-selected', 'true');
    const account = overlay.getByTestId('settings-row-account-openai');
    await expect(account).toBeVisible();
    await shootThemes(app, overlay, 'sign-in-opens-user-tab');

    // A key saved in the User tab is stored on this computer; the clientAuth delta reaches the remote chat, whose next pick and
    // turn use it through the broker. The OpenAI key field validates online, so the offline sign-in is DeepSeek's key.
    const accountsBefore = (await hostMessages(tab, 'accountInfo')).length;
    const deepseek = overlay.getByTestId('settings-row-account-deepseek');
    await deepseek.getByRole('button', { name: /Add key/ }).click();
    const key = deepseek.getByLabel('API Key', { exact: true });
    await key.fill(DEEPSEEK_KEY);
    await key.press('Enter');
    await expect(deepseek.getByRole('status').first()).toHaveText('Key saved');
    await expect.poll(async () => (await hostMessages(tab, 'accountInfo')).length, { timeout: 30_000 }).toBeGreaterThan(accountsBefore);
    await expect.poll(async () => (await hostMessages(tab, 'providerAuthStatusChanged')).filter((message) => message['provider'] === 'deepseek').at(-1)?.['configured'], { timeout: 30_000 }).toBe(true);
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByTestId('settings-modal')).toHaveCount(0);
    await pick('DeepSeek V4 Pro');
    await expect.poll(async () => (await hostMessages(tab, 'modelUpdate')).at(-1)?.['activeModel']).toBe('deepseek-v4-pro');
    await sendPrompt(tab, 'Signed in now');
    await expect(tab.getByText('Echo: Signed in now', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    expect(credentialRequests(home, 'deepseek')).toBe(1);
    expect(chatRequests(stub).filter((request) => JSON.stringify(request.body).includes('Signed in now')).map((request) => (request.body as { model?: string }).model)).toContain('deepseek-v4-pro');
    // the key lives in this computer's secret store, never in the target's home
    await shutdownDaemon(app, home);
    expect(filesHolding(loopbackHome(home), [DEEPSEEK_KEY])).toEqual([]);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
    await attachDaemonLogs(testInfo, home);
  }
});
