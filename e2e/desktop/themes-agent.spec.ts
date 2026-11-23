import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat, panelIdOf, selectChatPage, test } from './support/fixtures';
import type { DesktopApp, LaunchOptions } from './support/app';
import { killTree, mainLog } from './support/app';
import { startDesignChat } from './support/design';
import { readUserSettings, seedStubModel, writeAuth, writeUserSettings, type HermeticHome } from './support/hermetic';
import { agentRequests, call, chatRequests, startOpenAIStub, type OpenAIStub, type StubReply } from './support/openai-stub';
import { hostMessage, setPageSize } from './support/screenshots';
import { closeSettingsModal, setContentSize } from './support/settings';
import { pressKeys, SHELL_URL, shellPage, shellState, viewFocused } from './support/shell';
import { cssToken, HOOKS, loadThemeTools, openAppearance, readTheme, themeHooks, windowBackground, writeTheme } from './support/themes';
import { awaitTurnEnd, chatInput, clickMenu, postFromWebview, promptReady } from './support/ui';

// The agent's theme tools on this computer (docs/invariants.md "Desktop themes", "Permissions and plan mode"): the theme
// cards are content decisions raised in every permission mode, the keep-changes banner settles an on-the-fly apply, and
// the design journeys S2, S3 (screenshot) and S4 (keep, show in window) replay by role and accessible name. Every launch has
// main's e2e hooks: a test that starts a keep-changes countdown holds its timer first and ends it itself, so no assertion
// races the 15 s it runs for.

const CHECKED = { timeout: 30_000 };
const NEVER = new Promise<void>(() => {});
const BUILTIN_DARK_BG = '#0b0f14';
const BUILTIN_LIGHT_BG = '#f7f9fb';
const AMBER_BG = '#2a1a10';
const AMBER = { theme: 'damocles', saveAs: 'new', name: 'Amber Night', look: 'dark', colors: { background: AMBER_BG, accent: '#e0a030' } } as const;
const NIGHT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NIGHT_COLORS = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const NOTE = 'Less orange, keep the panels darker.';
// session-title.ts TITLE_OUTPUT_TOOL: the sub-call that names a chat after its first exchange
const TITLE_TOOL = 'set_session_title';
const CHAT_TITLE = 'Warmer Theme Ideas';

type Launch = (options?: LaunchOptions) => Promise<DesktopApp>;

interface Run {
  readonly desktop: DesktopApp;
  readonly app: ElectronApplication;
  readonly openai: OpenAIStub;
  readonly tab: Page;
}

const closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function stub(home: HermeticHome, settings: Record<string, unknown> = {}): Promise<OpenAIStub> {
  const openai = await startOpenAIStub();
  closers.push(() => openai.close());
  seedStubModel(home, openai.baseUrl, ['text', 'image']);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', ...settings });
  return openai;
}

async function start(launch: Launch, home: HermeticHome, settings: Record<string, unknown> = {}, prepare?: () => void, args: string[] = []): Promise<Run> {
  const openai = await stub(home, settings);
  prepare?.();
  const desktop = await launch({ ...HOOKS, args });
  const tab = await activeChat(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  return { desktop, app: desktop.app, openai, tab };
}

async function send(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
}

/** The agent calls `tool` with `args`, then says `after` once the call returns. */
function ask(run: Run, tool: string, args: Record<string, unknown>, after: string | StubReply): void {
  run.openai.replies.push(call(tool, args), typeof after === 'string' ? { chunks: [after] } : after);
}

/** Every tool result the model received, in order, as text. */
function toolResults(openai: OpenAIStub): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const request of chatRequests(openai)) {
    for (const message of (request.body as { messages?: { role: string; tool_call_id?: string; content: unknown }[] }).messages ?? []) {
      if (message.role !== 'tool' || message.tool_call_id === undefined || seen.has(message.tool_call_id)) continue;
      seen.add(message.tool_call_id);
      results.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    }
  }
  return results;
}

function offeredTools(openai: OpenAIStub): string[] {
  const last = chatRequests(openai).filter((request) => ((request.body as { tools?: unknown[] }).tools?.length ?? 0) > 1).at(-1);
  return ((last?.body as { tools?: { function?: { name?: string } }[] } | undefined)?.tools ?? []).map((tool) => tool.function?.name ?? '');
}

const previewCard = (tab: Page, name = 'Preview a new theme'): Locator => tab.getByRole('region', { name, exact: true });
const shotCard = (tab: Page): Locator => tab.getByRole('region', { name: 'Send a screenshot of the window to the model?', exact: true });
const genericCard = (tab: Page): Locator => tab.getByTestId('permission-card');
const answers = (tab: Page): Locator => tab.getByRole('listbox', { name: 'Answer the theme preview', exact: true });
const lastToolCard = (tab: Page): Locator => tab.getByTestId('theme-tool-card').last();
const keepBanner = (shell: Page): Locator => shell.getByRole('region', { name: 'Keep this theme?', exact: true });

/**
 * Loads the theme tools in a turn after which the model names the chat CHAT_TITLE, and waits for the name. A chat the model
 * never named has no title for a banner, a strip or the history to show, though the sidebar labels it by its first prompt.
 */
async function loadThemeToolsTitled(run: Run): Promise<void> {
  run.openai.subCallReplies.set(TITLE_TOOL, [{ chunks: [], toolCalls: [{ name: TITLE_TOOL, arguments: { title: CHAT_TITLE } }] }]);
  await loadThemeTools(run.openai, run.tab);
  await expect.poll(async () => (await shellState(run.app)).selectedChat?.title).toBe(CHAT_TITLE);
}

/** A screenful of reply lines, so the transcript scrolls. */
const longReply = (): string => Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the long reply.`).join('\n\n');

/** Scrolls the transcript away from its newest line, so the jump-to-latest button shows, and waits for its entrance to end. */
async function showJumpToLatest(tab: Page): Promise<Locator> {
  const transcript = tab.locator('.message-container');
  await transcript.evaluate((view) => view.scrollBy({ top: -400, behavior: 'instant' }));
  const jump = tab.getByTestId('scroll-to-bottom');
  await expect(jump).toBeVisible();
  await expect.poll(() => jump.evaluate((button) => button.getAnimations().length)).toBe(0);
  return jump;
}

/** What a fresh IntersectionObserver v2 reports for `card` now: whether Chromium sees it unobscured and undistorted. */
function reportedVisible(card: Locator): Promise<boolean> {
  return card.evaluate((element) => new Promise<boolean>((resolve) => {
    const observer = new IntersectionObserver((entries) => {
      observer.disconnect();
      resolve((entries.at(-1) as IntersectionObserverEntry & { isVisible?: boolean }).isVisible === true);
    }, { trackVisibility: true, delay: 100 } as IntersectionObserverInit);
    observer.observe(element);
  }));
}

const draftFiles = (home: HermeticHome): string[] => {
  const dir = path.join(home.damoclesDir, 'themes', 'drafts');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.json')) : [];
};

const appearanceFile = (home: HermeticHome): string => path.join(home.damoclesDir, 'themes', 'appearance.json');
const readAppearance = (home: HermeticHome): Record<string, unknown> => (fs.existsSync(appearanceFile(home)) ? JSON.parse(fs.readFileSync(appearanceFile(home), 'utf8')) as Record<string, unknown> : {});

test('with no ask rule ThemeSet raises the preview card, never the generic card, in default, acceptEdits, plan and YOLO; Apply paints the window and its pages', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await start(launch, home);
  const { tab } = run;
  await loadThemeTools(run.openai, tab);
  for (const name of ['ThemeRead', 'ThemeSet', 'ThemeSchedule']) expect(offeredTools(run.openai)).toContain(name);

  for (const mode of ['default', 'acceptEdits'] as const) {
    await postFromWebview(tab, { type: 'setPermissionMode', mode });
    ask(run, 'ThemeSet', AMBER, `Discarded in ${mode}.`);
    await send(tab, `a warmer theme in ${mode}`);
    await expect(previewCard(tab)).toBeVisible(CHECKED);
    await expect(genericCard(tab)).toHaveCount(0);
    await answers(tab).getByRole('option', { name: 'Discard', exact: true }).click();
    await expect(tab.getByText(`Discarded in ${mode}.`, { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'discarded');
  }

  // a plan-mode turn ends only at ExitPlanMode or AskUserQuestion, so the reply after the card stays open until stopped
  await postFromWebview(tab, { type: 'setPermissionMode', mode: 'plan' });
  ask(run, 'ThemeSet', AMBER, { chunks: ['Discarded in plan mode.'], holdAfterFirst: NEVER });
  await send(tab, 'a warmer theme in plan mode');
  await expect(previewCard(tab)).toBeVisible(CHECKED);
  await expect(genericCard(tab)).toHaveCount(0);
  await answers(tab).getByRole('option', { name: 'Discard', exact: true }).click();
  await expect(tab.getByText('Discarded in plan mode.', { exact: true })).toBeVisible(CHECKED);
  await tab.getByTestId('composer-send').click();
  await awaitTurnEnd(tab);

  // YOLO answers no theme card: it stays until the user answers it
  const yolo = tab.getByTestId('composer-yolo');
  await postFromWebview(tab, { type: 'setPermissionMode', mode: 'default' });
  await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
  await expect(yolo).toHaveAttribute('aria-pressed', 'true');
  ask(run, 'ThemeSet', AMBER, 'Applied in YOLO.');
  await send(tab, 'a warmer theme in YOLO');
  await expect(previewCard(tab)).toBeVisible(CHECKED);
  await expect(genericCard(tab)).toHaveCount(0);
  const answered = toolResults(run.openai).length;
  // Core echoes a toggle before it approves what waits, so the echo of the second toggle shows it handled the first whole.
  await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: false });
  await expect(yolo).toHaveAttribute('aria-pressed', 'false');
  await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
  await expect(yolo).toHaveAttribute('aria-pressed', 'true');
  await expect(previewCard(tab)).toBeVisible();
  await expect(lastToolCard(tab)).not.toHaveAttribute('data-outcome', 'applied');
  expect(toolResults(run.openai)).toHaveLength(answered);
  expect(await windowBackground(run.app)).toBe(BUILTIN_DARK_BG);
  await answers(tab).getByRole('option', { name: 'Apply', exact: true }).click();
  await expect(tab.getByText('Applied in YOLO.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'applied');
  await expect.poll(() => windowBackground(run.app)).toBe(AMBER_BG);
  // the window's color is main's own; each page is told the theme separately
  for (const page of [tab, await shellPage(run.app)]) await expect.poll(() => cssToken(page, '--d-bg')).toBe(AMBER_BG);
  expect(draftFiles(home)).toEqual([]);
});

test('a deny rule blocks ThemeSet with no card', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await start(launch, home, { permissions: { deny: ['ThemeSet'] } });
  await loadThemeTools(run.openai, run.tab);
  ask(run, 'ThemeSet', AMBER, 'Blocked.');
  await send(run.tab, 'a warmer theme');
  await expect(run.tab.getByText('Blocked.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(run.tab);
  await expect(previewCard(run.tab)).toHaveCount(0);
  await expect(genericCard(run.tab)).toHaveCount(0);
  expect(toolResults(run.openai).at(-1)).toMatch(/deny|denied|blocked/i);
  expect(await windowBackground(run.app)).toBe(BUILTIN_DARK_BG);
});

// A real picture the theme renderer decodes: Aurora's smaller wallpaper (scripts/generate-theme-art.ts).
const AURORA_DIR = path.resolve(import.meta.dirname, '..', '..', 'resources', 'themes', 'damocles-aurora');
const auroraPng = (): Buffer => fs.readdirSync(AURORA_DIR).filter((file) => file.endsWith('.png')).map((file) => fs.readFileSync(path.join(AURORA_DIR, file))).sort((a, b) => a.length - b.length)[0]!;
/** Claude Code's `//` absolute form of a native path, which a user settings rule names a folder by. */
const absRule = (native: string): string => {
  const slashed = native.split(path.sep).join('/');
  return `/${/^[A-Za-z]:\//.test(slashed) ? `/${slashed[0]!.toLowerCase()}${slashed.slice(2)}` : slashed}`;
};
/** Every file of the project but its .damocles folder, so a test can show a source left no file there. */
const projectFiles = (home: HermeticHome): string[] => (fs.readdirSync(home.project, { recursive: true }) as string[])
  .filter((entry) => !entry.split(/[\\/]/).includes('.damocles')).sort();
const blobFiles = (home: HermeticHome): string[] => {
  const dir = path.join(home.damoclesDir, 'themes', 'blobs');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const beach = (from: Record<string, unknown>): Record<string, unknown> => ({ ...AMBER, asset: { name: 'beach', from }, wallpapers: [{ panels: { chat: { image: 'beach' } } }] });

test('a file source is a Read of it: a Read deny rule blocks it with no card, another file reaches the preview card and goes into a blob, not the project', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const secret = path.join(home.project, 'secret');
  const run = await start(launch, home, { permissions: { deny: [`Read(${absRule(secret)}/**)`] } }, () => {
    fs.mkdirSync(secret, { recursive: true });
    fs.mkdirSync(path.join(home.project, 'img'), { recursive: true });
    fs.writeFileSync(path.join(secret, 'dawn.png'), auroraPng());
    fs.writeFileSync(path.join(home.project, 'img', 'dawn.png'), auroraPng());
  });
  const { tab } = run;
  const before = projectFiles(home);
  await loadThemeTools(run.openai, tab);

  ask(run, 'ThemeSet', beach({ file: path.join(secret, 'dawn.png') }), 'Blocked by your rule.');
  await send(tab, 'use my secret picture');
  await expect(tab.getByText('Blocked by your rule.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(previewCard(tab)).toHaveCount(0);
  await expect(genericCard(tab)).toHaveCount(0);
  expect(toolResults(run.openai).at(-1)).toContain('Permission denied by a rule in your Damocles settings');
  expect(blobFiles(home)).toEqual([]);

  ask(run, 'ThemeSet', beach({ file: path.join(home.project, 'img', 'dawn.png') }), 'Applied with your picture.');
  await send(tab, 'use the picture in img');
  await expect(previewCard(tab)).toBeVisible(CHECKED);
  await expect(genericCard(tab)).toHaveCount(0);
  await answers(tab).getByRole('option', { name: 'Apply', exact: true }).click();
  await expect(tab.getByText('Applied with your picture.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'applied');
  expect(blobFiles(home)).toHaveLength(1);
  expect(projectFiles(home)).toEqual(before);
});

test('a generated image asks on the image card in plan mode, naming no file; No generates nothing and leaves no file', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await start(launch, home, { 'damocles.imageGeneration.enabled': true, 'damocles.imageGeneration.model': 'google/gemini-2.5-flash-image' }, () => {
    // pi reads the OpenRouter key from auth.json; the marker keeps Damocles' one-time sweep of old plain-text keys from removing it
    writeAuth(home, { openai: { type: 'api_key', key: 'stub-key' }, openrouter: { type: 'api_key', key: 'stub-openrouter-key' } });
    fs.mkdirSync(home.damoclesDir, { recursive: true });
    fs.writeFileSync(path.join(home.damoclesDir, 'provider-key-sweep.json'), `${JSON.stringify({ sweptAt: Date.now() })}\n`);
  });
  const { tab } = run;
  const before = projectFiles(home);
  await loadThemeTools(run.openai, tab);
  await postFromWebview(tab, { type: 'setPermissionMode', mode: 'plan' });
  run.openai.replies.push(call('ThemeSet', beach({ generate: { prompt: 'warm dunes at dusk', aspect: '16:9' } })));
  await send(tab, 'generate a dune wallpaper');
  const card = genericCard(tab);
  await expect(card).toBeVisible(CHECKED);
  await expect(card.getByTestId('permission-title')).toHaveText('Generate an image for a theme?');
  await expect(card.getByTestId('image-permission-theme')).toBeVisible();
  await expect(card.getByTestId('image-permission-path')).toHaveCount(0);
  await expect(card.getByTestId('image-permission-prompt')).toHaveText('warm dunes at dusk\n\nAspect ratio 16:9 (width:height).');
  await expect(previewCard(tab)).toHaveCount(0);
  // a No with no note ends the turn, as for any tool
  await card.getByRole('option', { name: 'No', exact: true }).click();
  await expect(card).toHaveCount(0, CHECKED);
  await awaitTurnEnd(tab);
  await expect(previewCard(tab)).toHaveCount(0);
  expect(blobFiles(home)).toEqual([]);
  expect(projectFiles(home)).toEqual(before);
});

test('on the fly: plan mode shows the preview card instead; YOLO shows one keep-changes banner, Revert now restores the look, and undo works', async ({ home, launch }) => {
  test.setTimeout(360_000);
  const run = await start(launch, home, { 'damocles.desktop.themes.applyMode': 'onTheFly' });
  const { tab, app } = run;
  const shell = await shellPage(app);
  // no countdown below ends by the clock, so each end is the press that precedes it
  await themeHooks(app).holdKeepChanges();
  await loadThemeTools(run.openai, tab);

  await postFromWebview(tab, { type: 'setPermissionMode', mode: 'plan' });
  ask(run, 'ThemeSet', AMBER, { chunks: ['Plan mode preview answered.'], holdAfterFirst: NEVER });
  await send(tab, 'apply a warmer theme in plan mode');
  await expect(previewCard(tab)).toBeVisible(CHECKED);
  await expect(tab.getByTestId('theme-change-plan-mode')).toBeVisible();
  await expect(keepBanner(shell)).toHaveCount(0);
  await answers(tab).getByRole('option', { name: 'Discard', exact: true }).click();
  await expect(tab.getByText('Plan mode preview answered.', { exact: true })).toBeVisible(CHECKED);
  await tab.getByTestId('composer-send').click();
  await awaitTurnEnd(tab);

  await postFromWebview(tab, { type: 'setPermissionMode', mode: 'default' });
  await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
  ask(run, 'ThemeSet', AMBER, 'Reverted, as you chose.');
  await send(tab, 'apply a warmer theme');
  await expect(keepBanner(shell)).toBeVisible(CHECKED);
  await expect(previewCard(tab)).toHaveCount(0);
  await expect.poll(() => windowBackground(app)).toBe(AMBER_BG);
  await expect(shell.getByRole('progressbar', { name: 'Time left before revert', exact: true })).toBeVisible();
  await shell.getByRole('button', { name: 'Revert now', exact: true }).click();
  await expect(shell.getByText('Theme reverted.', { exact: true })).toBeVisible();
  await expect(shell.getByText("The agent's turn was told you reverted it.", { exact: false })).toBeVisible();
  await expect(tab.getByText('Reverted, as you chose.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'reverted');
  await expect.poll(() => windowBackground(app)).toBe(BUILTIN_DARK_BG);

  // undo on the fly: apply and keep, then the chat's own undo through the banner again
  ask(run, 'ThemeSet', AMBER, 'Kept.');
  await send(tab, 'apply it again');
  await expect(keepBanner(shell)).toBeVisible(CHECKED);
  await expect(keepBanner(shell)).toHaveCount(1);
  await shell.getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(shell.getByText('Theme kept.', { exact: true })).toBeVisible();
  await expect(tab.getByText('Kept.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'kept');

  ask(run, 'ThemeSet', { undo: true }, 'Undone on the fly.');
  await send(tab, 'undo that');
  await expect(keepBanner(shell).getByRole('button', { name: 'Keep', exact: true })).toBeVisible(CHECKED);
  await keepBanner(shell).getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(tab.getByText('Undone on the fly.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect.poll(() => windowBackground(app)).toBe(BUILTIN_DARK_BG);
});

test('on the fly: a countdown nobody answers runs out as a revert, and the turn is told so', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await start(launch, home, { 'damocles.desktop.themes.applyMode': 'onTheFly' });
  const { tab, app } = run;
  const shell = await shellPage(app);
  const hooks = themeHooks(app);
  await hooks.holdKeepChanges();
  await loadThemeTools(run.openai, tab);
  await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
  ask(run, 'ThemeSet', AMBER, 'It ran out.');
  await send(tab, 'apply a warmer theme');
  await expect(keepBanner(shell)).toBeVisible(CHECKED);
  await expect.poll(() => windowBackground(app)).toBe(AMBER_BG);
  await expect.poll(() => 'pendingConfirm' in readAppearance(home)).toBe(true);

  // the countdown's own timeout, fired here instead of waited for
  expect(await hooks.expireKeepChanges()).toBe(true);
  await expect(shell.getByText('Theme reverted.', { exact: true })).toBeVisible();
  await expect(shell.getByText('Nobody answered in time.', { exact: false })).toBeVisible();
  await expect(tab.getByText('It ran out.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'reverted');
  expect(toolResults(run.openai).at(-1)).toMatch(/revert/i);
  await expect.poll(() => windowBackground(app)).toBe(BUILTIN_DARK_BG);
  await expect.poll(() => 'pendingConfirm' in readAppearance(home)).toBe(false);
  expect(readUserSettings(home)['damocles.desktop.themes.dark'] ?? 'damocles').toBe('damocles');
  // nothing waits any more
  expect(await hooks.expireKeepChanges()).toBe(false);
});

test('on the fly: a pick of the user\'s while the banner counts joins the countdown, which starts again and covers both changes, each its own history entry', async ({ home, launch }) => {
  test.setTimeout(240_000);
  writeTheme(home, NIGHT, { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: NIGHT_COLORS } } });
  const run = await start(launch, home, { 'damocles.desktop.themes.applyMode': 'onTheFly' });
  const { tab, app } = run;
  const shell = await shellPage(app);
  await themeHooks(app).holdKeepChanges();
  await loadThemeTools(run.openai, tab);
  await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
  ask(run, 'ThemeSet', AMBER, 'Both went back.');
  await send(tab, 'apply a warmer theme');
  const banner = keepBanner(shell);
  await expect(banner).toBeVisible(CHECKED);
  await expect(banner).toContainText('applied Amber Night.');
  await expect.poll(() => windowBackground(app)).toBe(AMBER_BG);
  const first = (await shellState(app)).keepChanges!;
  expect(first).toMatchObject({ phase: 'counting', changeCount: 1 });

  const overlay = await openAppearance(app, 1280);
  await overlay.getByRole('radio', { name: 'Night, dark', exact: true }).click();
  await expect(overlay.getByRole('radio', { name: 'Night, dark, active', exact: true })).toBeVisible();
  await expect.poll(() => windowBackground(app)).toBe(NIGHT_COLORS.background);
  await expect(banner).toContainText('The theme changed 2 times, by more than one chat or by you and a chat.');
  const joined = (await shellState(app)).keepChanges!;
  expect(joined).toMatchObject({ phase: 'counting', changeCount: 2, several: true });
  expect(joined.endsAt).toBeGreaterThan(first.endsAt);
  // the agent's change and the user's are two entries, newest first
  await overlay.getByRole('button', { name: 'History', exact: true }).click();
  const entries = overlay.getByRole('dialog', { name: 'Theme history' }).getByRole('listitem');
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText('You · ');
  await expect(entries.nth(1)).toContainText('Agent in ');
  await overlay.keyboard.press('Escape');
  await closeSettingsModal(overlay);

  // one Revert takes both back
  await banner.getByRole('button', { name: 'Revert now', exact: true }).click();
  await expect(shell.getByText('Theme reverted.', { exact: true })).toBeVisible();
  await expect(shell.getByText('Back to the look from before the first change.', { exact: false })).toBeVisible();
  await expect(tab.getByText('Both went back.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect.poll(() => windowBackground(app)).toBe(BUILTIN_DARK_BG);
  await expect.poll(() => readUserSettings(home)['damocles.desktop.themes.dark'] ?? 'damocles').toBe('damocles');
});

test('ThemeSchedule goes through its card: Apply saves the schedule and the window follows it, and the chat\'s undo turns it off again', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await start(launch, home);
  const { tab, app } = run;
  const hooks = themeHooks(app);
  await loadThemeTools(run.openai, tab);
  // one rule for every day, so it shows whatever the day and the hour are
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  ask(run, 'ThemeSchedule', { enabled: true, rules: [{ days, at: '07:30', theme: 'damocles', look: 'light' }] }, 'Scheduled.');
  await send(tab, 'show the light look all week');
  const card = previewCard(tab, 'Preview a theme schedule');
  await expect(card).toBeVisible(CHECKED);
  await expect(genericCard(tab)).toHaveCount(0);
  expect(await hooks.shown()).toMatchObject({ themeId: 'damocles', kind: 'dark', decidedBy: 'mode' });
  await answers(tab).getByRole('option', { name: 'Apply', exact: true }).click();
  await expect(tab.getByText('Scheduled.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'applied');
  expect(readAppearance(home)['schedule']).toEqual({ enabled: true, rules: [{ days, minute: 450, theme: 'damocles', look: 'light' }] });
  await expect.poll(() => hooks.shown()).toMatchObject({ themeId: 'damocles', kind: 'light', decidedBy: 'schedule', themeSource: 'light' });
  await expect.poll(() => windowBackground(app)).toBe(BUILTIN_LIGHT_BG);
  await expect.poll(() => cssToken(tab, '--d-bg')).toBe(BUILTIN_LIGHT_BG);

  ask(run, 'ThemeSet', { undo: true }, 'Unscheduled.');
  await send(tab, 'undo that');
  const undoCard = previewCard(tab, 'Undo the agent\'s theme change?');
  await expect(undoCard).toBeVisible(CHECKED);
  await undoCard.getByRole('option', { name: 'Apply', exact: true }).click();
  await expect(tab.getByText('Unscheduled.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'undone');
  await expect.poll(() => hooks.shown()).toMatchObject({ themeId: 'damocles', kind: 'dark', decidedBy: 'mode' });
  await expect.poll(() => windowBackground(app)).toBe(BUILTIN_DARK_BG);
});

test('undo in Preview first: the chat\'s own change comes back through the card, and the history names the chat that made it', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await start(launch, home);
  const { tab, app } = run;
  await loadThemeToolsTitled(run);
  ask(run, 'ThemeSet', AMBER, 'Applied.');
  await send(tab, 'a warmer theme');
  await expect(previewCard(tab)).toBeVisible(CHECKED);
  // a digit typed in the composer is text, so the answers take focus first
  await answers(tab).focus();
  await promptReady(previewCard(tab));
  await tab.keyboard.press('1');
  await expect(tab.getByText('Applied.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect.poll(() => windowBackground(app)).toBe(AMBER_BG);

  // Settings › Appearance › History: the entry's actor is the agent, named by its chat
  const overlay = await openAppearance(app, 1280);
  await overlay.getByRole('button', { name: 'History', exact: true }).click();
  const entries = overlay.getByRole('dialog', { name: 'Theme history' }).getByRole('listitem');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText(`Agent in “${CHAT_TITLE}”`);
  await overlay.keyboard.press('Escape');
  await closeSettingsModal(overlay);

  ask(run, 'ThemeSet', { undo: true }, 'Undone.');
  await send(tab, 'undo that');
  const undoCard = previewCard(tab, 'Undo the agent\'s theme change?');
  await expect(undoCard).toBeVisible(CHECKED);
  await undoCard.getByRole('option', { name: 'Apply', exact: true }).click();
  await expect(tab.getByText('Undone.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'undone');
  await expect.poll(() => windowBackground(app)).toBe(BUILTIN_DARK_BG);
});

test('two chats keep their own drafts of one theme, and the later Apply turns Outdated with Discard only', async ({ home, launch }) => {
  test.setTimeout(300_000);
  writeTheme(home, NIGHT, { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: NIGHT_COLORS } } });
  const run = await start(launch, home);
  const first = run.tab;
  await loadThemeTools(run.openai, first);
  // The stub answers requests in arrival order across chats: each reply after a card is queued in the order the cards are
  // answered (the second chat's first, then the first's).
  run.openai.replies.push(call('ThemeSet', { theme: NIGHT, look: 'dark', colors: { accent: '#ff4040' } }));
  await send(first, 'redder accent');
  await expect(previewCard(first, 'Preview a theme change')).toBeVisible(CHECKED);

  await clickMenu(run.app, 'damocles.newChat');
  const second = await nextChat(run.app, [first]);
  await expect(chatInput(second)).toBeVisible();
  await loadThemeTools(run.openai, second);
  run.openai.replies.push(call('ThemeSet', { theme: NIGHT, look: 'dark', colors: { accent: '#40ff40' } }), { chunks: ['Second chat done.'] }, { chunks: ['First chat done.'] });
  await send(second, 'greener accent');
  await expect(previewCard(second, 'Preview a theme change')).toBeVisible(CHECKED);
  await expect.poll(() => draftFiles(home).length).toBe(2);

  await answers(second).getByRole('option', { name: 'Apply', exact: true }).click();
  await expect(second.getByText('Second chat done.', { exact: true })).toBeVisible(CHECKED);

  await selectChatPage(run.app, first);
  const firstCard = previewCard(first, 'Preview a theme change');
  await answers(first).getByRole('option', { name: 'Apply', exact: true }).click();
  await expect(firstCard.getByTestId('theme-change-outdated')).toBeVisible(CHECKED);
  await expect(answers(first).getByRole('option')).toHaveText(['1Discard']);
  await answers(first).getByRole('option', { name: 'Discard', exact: true }).click();
  await expect(first.getByText('First chat done.', { exact: true })).toBeVisible(CHECKED);
  await expect.poll(() => draftFiles(home)).toEqual([]);
  // the theme holds the second chat's change, never the outdated one's
  expect((readTheme(home, NIGHT) as { looks: { dark: { colors: { accent: string } } } }).looks.dark.colors.accent).toBe('#40ff40');
});

test("the agent's pick of a theme with a window arrangement puts it in place as a manual pick does, and the chat's undo gives the window back", async ({ home, launch }) => {
  test.setTimeout(240_000);
  writeTheme(home, NIGHT, { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: NIGHT_COLORS } }, layout: { sidebarWidth: 420 }, origin: { kind: 'created', installedAt: 1 } });
  const run = await start(launch, home);
  const { tab, app } = run;
  const shell = await shellPage(app);
  const sidebarWidth = (): Promise<number> => shell.getByTestId('sidebar').evaluate((element) => Math.round(element.getBoundingClientRect().width));
  const savedWidth = (): number | undefined => {
    const file = path.join(home.userData, 'window-layout.json');
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { sidebar: { sidebarWidth: number } }).sidebar.sidebarWidth : undefined;
  };
  const before = await sidebarWidth();
  expect(before).not.toBe(420);
  await loadThemeTools(run.openai, tab);

  ask(run, 'ThemeSet', { theme: NIGHT, look: 'dark', colors: { accent: '#ff4040' } }, 'Picked Night.');
  await send(tab, 'pick Night with a redder accent');
  await expect(previewCard(tab, 'Preview a theme change')).toBeVisible(CHECKED);
  await answers(tab).getByRole('option', { name: 'Apply', exact: true }).click();
  await expect(tab.getByText('Picked Night.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect.poll(sidebarWidth).toBe(420);
  await expect.poll(savedWidth).toBe(420);

  ask(run, 'ThemeSet', { undo: true }, 'Undone.');
  await send(tab, 'undo that');
  await answers(tab).getByRole('option', { name: 'Apply', exact: true }).click();
  await expect(tab.getByText('Undone.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'undone');
  await expect.poll(sidebarWidth).toBe(before);
  expect(readUserSettings(home)['damocles.desktop.themes.dark'] ?? 'damocles').toBe('damocles');
});

for (const [label, layout] of [['a new theme', false], ['a pick of a theme with a window arrangement', true]] as const) {
  test(`killing the app during the countdown of ${label} relaunches with the previous look${layout ? ' and window arrangement' : ''} and the change reverted`, async ({ home, launch }) => {
    test.setTimeout(300_000);
    if (layout) writeTheme(home, NIGHT, { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: NIGHT_COLORS } }, layout: { sidebarWidth: 420 }, origin: { kind: 'created', installedAt: 1 } });
    const run = await start(launch, home, { 'damocles.desktop.themes.applyMode': 'onTheFly' });
    const shell = await shellPage(run.app);
    const sidebarWidth = (page: Page): Promise<number> => page.getByTestId('sidebar').evaluate((element) => Math.round(element.getBoundingClientRect().width));
    const before = await sidebarWidth(shell);
    // the countdown cannot run out before the kill, so the launch is what reverts
    await themeHooks(run.app).holdKeepChanges();
    await loadThemeTools(run.openai, run.tab);
    await postFromWebview(run.tab, { type: 'setDangerouslySkipPermissions', enabled: true });
    ask(run, 'ThemeSet', layout ? { theme: NIGHT, look: 'dark', colors: { accent: '#ff4040' } } : AMBER, { chunks: ['Never seen.'], holdAfterFirst: NEVER });
    await send(run.tab, 'apply a warmer theme');
    await expect(keepBanner(shell)).toBeVisible(CHECKED);
    await expect.poll(() => windowBackground(run.app)).toBe(layout ? NIGHT_COLORS.background : AMBER_BG);
    if (layout) await expect.poll(() => sidebarWidth(shell)).toBe(420);
    await expect.poll(() => 'pendingConfirm' in readAppearance(home)).toBe(true);

    await killTree(run.app.process());
    // the killed launch ended other than with exit code 0, which its close reports once
    await expect(run.desktop.close()).rejects.toThrow(/instead of 0/);
    // main is gone, so the file is as the kill left it: the change still waits for its answer
    expect(readAppearance(home)).toHaveProperty('pendingConfirm');
    const relaunched = await launch(HOOKS);
    const tab = await activeChat(relaunched.app);
    await expect(chatInput(tab)).toBeVisible();
    expect(await windowBackground(relaunched.app)).toBe(BUILTIN_DARK_BG);
    const again = await shellPage(relaunched.app);
    await expect(keepBanner(again)).toHaveCount(0);
    await expect.poll(() => mainLog(home)).toContain('the last run ended during the keep-changes countdown');
    await expect.poll(() => 'pendingConfirm' in readAppearance(home)).toBe(false);
    expect(readUserSettings(home)['damocles.desktop.themes.dark'] ?? 'damocles').toBe('damocles');
    if (layout) await expect.poll(() => sidebarWidth(again)).toBe(before);
  });
}

test('a design chat cannot load the theme group', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await start(launch, home);
  const { design } = await startDesignChat(run.app, run.tab, run.openai, home, { fidelity: 'Static mockup', script: () => [call('ToolSearch', { tools: ['theme'] }), { chunks: ['No theme tools here.'] }] });
  await expect(design.getByText('No theme tools here.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(design);
  const answer = toolResults(run.openai).at(-1);
  expect(answer).toContain('No new tools were loaded.');
  expect(answer).not.toMatch(/Loaded \d+ tools?: .*Theme(Read|Set|Schedule)/);
  for (const name of ['ThemeRead', 'ThemeSet', 'ThemeSchedule']) expect(offeredTools(run.openai)).not.toContain(name);
});

// A shadow reaching 220 px up from the card below, far past the gap between dock cards.
const TALL_SHADOW = '0 -40px 120px 60px #ff0000ff';

for (const [label, shadow] of [['the built-in shadow', undefined], ['a theme\'s 220 px shadow', TALL_SHADOW]] as const) {
  test(`a permission card stacked above a theme card with ${label}: both report visible and the upper card answers`, async ({ home, launch }) => {
    test.setTimeout(240_000);
    if (shadow !== undefined) writeTheme(home, NIGHT, { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: NIGHT_COLORS, tokens: { '--d-shadow': shadow } } } });
    const run = await start(launch, home, shadow === undefined ? {} : { 'damocles.desktop.themes.dark': NIGHT });
    const { app, tab } = run;
    await setContentSize(app, 1280, 900);
    await loadThemeTools(run.openai, tab);
    ask(run, 'ThemeSet', AMBER, 'Discarded under the permission card.');
    await send(tab, 'a warmer theme');
    const themeCard = previewCard(tab);
    await expect(themeCard).toBeVisible(CHECKED);
    await hostMessage(app, tab, { type: 'requestPermission', toolUseId: 'e2e-stacked-permission', toolName: 'Bash', toolInput: { command: 'echo hi' }, command: 'echo hi', owner: { kind: 'main' } });
    const permission = genericCard(tab);
    await expect(permission).toBeVisible();
    if (shadow !== undefined) expect(await permission.evaluate((card) => getComputedStyle(card).getPropertyValue('--d-shadow').trim())).toBe(shadow);
    const [upper, lower] = await Promise.all([permission.boundingBox(), themeCard.boundingBox()]);
    expect(upper!.y + upper!.height).toBeLessThan(lower!.y);
    for (const card of [permission, themeCard]) expect(await card.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(/^rgb\(/);

    // the theme card's shadow reaches across the gap, and Chromium must not count it as covering the card above
    await expect.poll(() => reportedVisible(permission)).toBe(true);
    await expect.poll(() => reportedVisible(themeCard)).toBe(true);
    await expect(permission.getByTestId('trusted-checking')).toHaveCount(0);
    const firstAnswer = permission.locator('[role="option"], button').first();
    await expect(firstAnswer).not.toHaveAttribute('aria-disabled', 'true');
    await firstAnswer.click();
    await expect(permission).toBeHidden();

    await answers(tab).getByRole('option', { name: 'Discard', exact: true }).click();
    await expect(tab.getByText('Discarded under the permission card.', { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
  });
}

for (const [label, width] of [['1280 px', 1280], ['a 300 px chat column', 300]] as const) {
  test(`S2 journey at ${label}: Show in window with its strip, Expand preview, Change… with a note`, async ({ home, launch }) => {
    test.setTimeout(240_000);
    const run = await start(launch, home);
    const { tab, app } = run;
    await setContentSize(app, 1280, 900);
    if (width === 300) await setPageSize(tab, 300, 900);
    const shell = await shellPage(app);
    await loadThemeToolsTitled(run);
    run.openai.replies.push({ chunks: [longReply()] });
    await send(tab, 'Write a long answer.');
    await expect(tab.getByText('Line 60 of the long reply.', { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    ask(run, 'ThemeSet', AMBER, 'Got it: less orange, darker panels.');
    await send(tab, 'Make me something warmer.');
    await expect(previewCard(tab)).toBeVisible(CHECKED);
    await expect(tab.getByTestId('theme-change-subtitle')).toHaveText('Amber Night, dark and light · nothing changes until you choose');

    // nothing the transcript paints, the jump-to-latest button and its shadow included, reaches the docked card
    await showJumpToLatest(tab);
    await expect.poll(() => reportedVisible(previewCard(tab))).toBe(true);
    await expect(previewCard(tab).getByTestId('trusted-checking')).toHaveCount(0);

    const toggle = tab.getByRole('button', { name: 'Show in window', exact: true });
    const strip = shell.getByRole('region', { name: 'Showing the agent\'s proposal in the window.', exact: true });
    // the card's own surface, border and title text, none of which a highlight or focus changes
    const cardColors = (): Promise<string[]> => previewCard(tab).evaluate((card) => {
      const title = card.querySelector('h2')!;
      return [getComputedStyle(card).backgroundColor, getComputedStyle(card).borderTopColor, getComputedStyle(title).color];
    });
    const before = await cardColors();
    await toggle.click();
    await expect(tab.getByText('Showing in the window', { exact: true })).toBeVisible();
    // S4 show-in-window: the strip names the chat; the window and its pages paint the proposal while the card keeps the
    // current palette
    await expect(strip).toBeVisible();
    await expect(strip).toContainText(`Answer the card in “${CHAT_TITLE}” to keep or discard it.`);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => windowBackground(app)).toBe(AMBER_BG);
    for (const page of [tab, shell]) await expect.poll(() => cssToken(page, '--d-bg')).toBe(AMBER_BG);
    expect(await cardColors()).toEqual(before);
    await tab.getByRole('button', { name: 'Stop showing', exact: true }).click();
    await expect(tab.getByRole('button', { name: 'Stop showing', exact: true })).toBeHidden();
    await expect(strip).toBeHidden();
    await expect.poll(() => windowBackground(app)).toBe(BUILTIN_DARK_BG);
    for (const page of [tab, shell]) await expect.poll(() => cssToken(page, '--d-bg')).toBe(BUILTIN_DARK_BG);

    // the strip's own Stop showing ends it through main and core, and the card's toggle follows
    await toggle.click();
    await expect(strip).toBeVisible();
    await strip.getByRole('button', { name: 'Stop showing', exact: true }).click();
    await expect(strip).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => windowBackground(app)).toBe(BUILTIN_DARK_BG);

    await tab.getByRole('button', { name: 'Expand preview', exact: true }).click();
    await expect(tab.getByRole('dialog', { name: 'Amber Night preview', exact: true })).toBeVisible();
    await tab.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(tab.getByRole('dialog', { name: 'Amber Night preview', exact: true })).toBeHidden();

    await tab.getByRole('option', { name: 'Change…', exact: true }).click();
    await expect(tab.getByLabel('What should change?', { exact: true })).toBeVisible();
    await tab.getByLabel('What should change?', { exact: true }).fill(NOTE);
    await expect(tab.getByLabel('What should change?', { exact: true })).toHaveValue(NOTE);
    await tab.getByRole('button', { name: 'Send to agent', exact: true }).click();
    await expect(previewCard(tab)).toBeHidden();
    await expect(lastToolCard(tab)).toContainText(`Changes requested: “${NOTE}”`);
    await expect(tab.getByText('Got it: less orange, darker panels.', { exact: true })).toBeVisible(CHECKED);
    expect(toolResults(run.openai).at(-1)).toContain(NOTE);
  });

  test(`S3 screenshot steps at ${label} in YOLO: the card shows the shot first; Deny sends nothing, 1 allows one image`, async ({ home, launch }) => {
    test.setTimeout(240_000);
    const run = await start(launch, home);
    const { tab, app } = run;
    await setContentSize(app, 1280, 900);
    if (width === 300) await setPageSize(tab, 300, 900);
    await loadThemeTools(run.openai, tab);
    await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });

    ask(run, 'ThemeRead', { screenshot: true }, 'I will judge from the drawn preview.');
    await send(tab, 'Does the sidebar still read well?');
    await expect(shotCard(tab)).toBeVisible(CHECKED);
    await expect(genericCard(tab)).toHaveCount(0);
    const image = shotCard(tab).getByRole('img', { name: /^Screenshot of this window, \d+ by \d+$/ });
    await expect(image).toHaveAttribute('src', /^app:\/\/damocles\/theme-shot\/[^/]+$/);
    await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(shotCard(tab).getByRole('option')).toHaveText(['1Allow', '2Deny']);
    // a digit typed in the composer is text, so the answers take focus first
    await shotCard(tab).getByRole('listbox').focus();
    await promptReady(shotCard(tab));
    await tab.keyboard.press('2');
    await expect(shotCard(tab)).toBeHidden();
    await expect(tab.getByText('I will judge from the drawn preview.', { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'denied');
    // the agent's own turns, never a sub-call's: none carried an image so far
    expect(agentRequests(run.openai).filter((request) => JSON.stringify(request.body).includes('image_url'))).toEqual([]);

    ask(run, 'ThemeRead', { screenshot: true }, 'The sidebar reads well.');
    await send(tab, 'Look again, I allow it.');
    await expect(shotCard(tab)).toBeVisible(CHECKED);
    await shotCard(tab).getByRole('listbox').focus();
    await promptReady(shotCard(tab));
    await tab.keyboard.press('1');
    await expect(tab.getByText('The sidebar reads well.', { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'sent');
    expect(JSON.stringify(agentRequests(run.openai).at(-1)?.body)).toContain('image_url');
  });
}

// The banner lives in the shell, so its narrow size is the window's 900 px minimum rather than a chat column.
for (const width of [1280, 900]) test(`S4 keep journey at a ${width} px window: the banner asks, counts down and keeps; F6 reaches Keep, and Enter on it leaves focus on a part`, async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(240_000);
  const run = await start(launch, home, { 'damocles.desktop.themes.applyMode': 'onTheFly' });
  const { tab, app } = run;
  await setContentSize(app, width, 900);
  const shell = await shellPage(app);
  // the countdown ends at Keep below, however long the steps before it take
  await themeHooks(app).holdKeepChanges();
  await loadThemeTools(run.openai, tab);
  await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
  ask(run, 'ThemeSet', AMBER, 'It stays.');
  await send(tab, 'apply a warmer theme');

  const banner = keepBanner(shell);
  await expect(banner).toBeVisible(CHECKED);
  await expect(shell.getByRole('progressbar', { name: 'Time left before revert', exact: true })).toBeVisible();
  // the seconds it shows go down
  const count = banner.getByTestId('keep-changes-count');
  const shownFirst = Number(await count.textContent());
  expect(shownFirst).toBeGreaterThan(0);
  await expect.poll(async () => Number(await count.textContent())).toBeLessThan(shownFirst);
  // the banner wraps its buttons rather than overflowing the window
  expect(await banner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // F6 goes through main's part cycle, which holds the banner while it counts: from the chat one press reaches Keep
  const keep = shell.getByRole('button', { name: 'Keep', exact: true });
  await pressKeys(app, `/panel/${panelIdOf(tab)}/`, 'F6');
  await expect(keep).toBeFocused();
  await expect.poll(() => viewFocused(app, shell)).toBe(true);
  await promptReady(banner);
  await shell.keyboard.press('Enter');
  await expect(shell.getByText('Theme kept.', { exact: true })).toBeVisible();
  // Keep went with the countdown: keyboard focus is on the part F6 came from, never stranded on the shell page's body.
  // Main says which page holds focus; a page under test always reports itself focused.
  const stranded = async (): Promise<boolean> => (await app.evaluate(({ webContents }, shellUrl) => webContents.getFocusedWebContents()?.getURL().startsWith(shellUrl) ?? false, SHELL_URL))
    && (await shell.evaluate(() => document.activeElement === document.body));
  await expect(keep).toHaveCount(0);
  expect(await stranded()).toBe(false);
  await expect(shell.getByText('Undo Theme Change brings back', { exact: false })).toBeVisible();
  await expect(tab.getByText('It stays.', { exact: true })).toBeVisible(CHECKED);
  await expect(lastToolCard(tab)).toHaveAttribute('data-outcome', 'kept');
  await expect.poll(() => windowBackground(app)).toBe(AMBER_BG);
});

// Stacked strips share no elevation: a lower strip's shadow would paint over the one above it and hold its buttons.
test('the keep-changes banner under the safe-start banner: both report visible, fit the smallest window, and the upper banner answers', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await start(launch, home, { 'damocles.desktop.themes.applyMode': 'onTheFly' }, undefined, ['--damocles-safe-theme']);
  const { app, tab } = run;
  await setContentSize(app, 900, 600);
  const shell = await shellPage(app);
  // the countdown waits for the test, so both banners stay up
  await themeHooks(app).holdKeepChanges();
  await loadThemeTools(run.openai, tab);
  await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
  ask(run, 'ThemeSet', AMBER, 'It stays.');
  await send(tab, 'apply a warmer theme');

  const safeStart = shell.getByRole('region', { name: 'Started with the default theme.', exact: true });
  await expect(keepBanner(shell)).toBeVisible(CHECKED);
  await expect(safeStart).toBeVisible();
  for (const strip of [safeStart, keepBanner(shell)]) {
    await expect.poll(() => reportedVisible(strip)).toBe(true);
    expect(await strip.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth;
    })).toBe(true);
  }
  await safeStart.getByRole('button', { name: 'Use my theme', exact: true }).click();
  await expect(safeStart).toHaveCount(0);
  await keepBanner(shell).getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(shell.getByText('Theme kept.', { exact: true })).toBeVisible();
  await expect(tab.getByText('It stays.', { exact: true })).toBeVisible(CHECKED);
});
