import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub, STUB_MODEL_ID, type OpenAIStub } from './support/openai-stub';
import { addProject, chatInput, sendAndAwaitEcho } from './support/ui';

const PLAN = '# Plan\n\n1. Ship it\n';
// About 10k tokens to pi's estimate, well over the 1% of the stub's window kept, so the compaction summarises both plans.
const LONG_REPLY = 'All of this is context the compaction summarises. '.repeat(800);

async function openProject(app: ElectronApplication, h: HermeticHome): Promise<Page> {
  const home = await activeChat(app);
  await expect(chatInput(home)).toBeVisible();
  const opened = nextChat(app, [home]);
  await addProject(app, h.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

async function send(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
}

/** The session's plan file, where `getPlanContent` finds it: any name ending in the session's 8-hex suffix. */
async function planFilePath(tab: Page, h: HermeticHome): Promise<string> {
  let sessionId: string | undefined;
  await expect.poll(async () => (sessionId = await tab.evaluate(() => (window.damoclesBridge?.getState() as { sessionId?: string } | null | undefined)?.sessionId))).toBeDefined();
  return path.join(h.damoclesDir, 'plans', `plan-${crypto.createHash('sha256').update(sessionId!).digest('hex').slice(0, 8)}.md`);
}

async function writePlanFile(tab: Page, h: HermeticHome): Promise<void> {
  const file = await planFilePath(tab, h);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PLAN);
}

const planCard = (tab: Page): Locator => tab.getByTestId('plan-card').last();
const banner = (tab: Page): Locator => tab.getByTestId('plan-ready-banner');

async function sendPlanBack(tab: Page, feedback: string): Promise<void> {
  await tab.getByTestId('plan-feedback').fill(feedback);
  await tab.getByRole('button', { name: 'Send Feedback' }).click();
}

async function awaitTitleRequest(stub: OpenAIStub): Promise<void> {
  await expect.poll(() => chatRequests(stub).some((r) => JSON.stringify(r.body).includes('descriptive title'))).toBe(true);
}

const ENTER_PLAN = { chunks: [], toolCalls: [{ name: 'EnterPlanMode', arguments: {} }] };
const EXIT_PLAN = { chunks: [], toolCalls: [{ name: 'ExitPlanMode', arguments: {} }] };

// A plan-mode turn settles only through an approved plan (the plan-mode hold), so each one ends with an approval.
test('D51: a plan after a compaction is Version 3 on its card and the banner, and keeps it across a relaunch', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, {
      'damocles.autoCompact': { enabled: true, triggerPercent: 95, modelOverrides: { [STUB_MODEL_ID]: { keepRecentPercent: 1 } } },
    });
    let desktop = await launch();
    const tab = await openProject(desktop.app, home);

    await sendAndAwaitEcho(tab, 'hello');
    await awaitTitleRequest(stub);
    await writePlanFile(tab, home);

    stub.replies.push(ENTER_PLAN, EXIT_PLAN);
    await send(tab, 'plan the release');
    await expect(banner(tab)).toContainText('Version 1 · 1 step');
    await expect(planCard(tab)).toContainText('Plan · Version 1 · 1 step');

    stub.replies.push(EXIT_PLAN);
    await sendPlanBack(tab, 'add a rollback');
    await expect(banner(tab)).toContainText('Version 2 · 1 step');
    await expect(planCard(tab)).toContainText('Plan · Version 2 · 1 step');

    stub.replies.push({ chunks: [LONG_REPLY] });
    await tab.getByRole('button', { name: 'Yes, manually approve' }).click();
    await expect(banner(tab)).toBeHidden();
    await expect(tab.getByText('All of this is context', { exact: false }).first()).toBeVisible();

    // The first Enter picks /compact from the slash command menu, the second sends it.
    await chatInput(tab).fill('/compact');
    await chatInput(tab).press('Enter');
    if ((await chatInput(tab).inputValue()).trim()) await chatInput(tab).press('Enter');
    await expect(tab.getByTestId('compact-marker')).toBeVisible({ timeout: 60_000 });
    // The compaction cleared the earlier plan cards; a count over the loaded messages would call the next plan Version 1.
    await expect(tab.getByTestId('plan-card')).toHaveCount(0);

    stub.replies.push(ENTER_PLAN, EXIT_PLAN);
    await send(tab, 'plan it again');
    await expect(banner(tab)).toContainText('Version 3 · 1 step');
    await expect(planCard(tab)).toContainText('Plan · Version 3 · 1 step');

    stub.replies.push({ chunks: ['Shipping.'] });
    await tab.getByRole('button', { name: 'Yes, manually approve' }).click();
    await expect(tab.getByText('Shipping.', { exact: true })).toBeVisible();
    await expect(planCard(tab)).toContainText('Plan · Version 3');

    await desktop.close();
    desktop = await launch();
    const reopened = await activeChat(desktop.app);
    await expect(planCard(reopened)).toContainText('Plan · Version 3', { timeout: 60_000 });
  } finally {
    await stub.close();
  }
});

// A model that calls ExitPlanMode before writing its plan, then writes it and calls ExitPlanMode in one batch.
test('D51: a call that found no plan file takes no number, and a plan written in the same batch as ExitPlanMode is Version 1', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const desktop = await launch();
    const tab = await openProject(desktop.app, home);

    await sendAndAwaitEcho(tab, 'hello');
    await awaitTitleRequest(stub);
    const planFile = await planFilePath(tab, home);

    stub.replies.push(ENTER_PLAN, EXIT_PLAN, {
      chunks: [],
      toolCalls: [{ name: 'write', arguments: { path: planFile, content: PLAN } }, { name: 'ExitPlanMode', arguments: {} }],
    });
    await send(tab, 'plan the release');
    await expect(banner(tab)).toContainText('Version 1 · 1 step');
    await expect(planCard(tab)).toContainText('Plan · Version 1 · 1 step');

    stub.replies.push(EXIT_PLAN);
    await sendPlanBack(tab, 'add a rollback');
    await expect(banner(tab)).toContainText('Version 2 · 1 step');
    await expect(planCard(tab)).toContainText('Plan · Version 2 · 1 step');

    stub.replies.push({ chunks: ['Shipping.'] });
    await tab.getByRole('button', { name: 'Yes, manually approve' }).click();
    await expect(tab.getByText('Shipping.', { exact: true })).toBeVisible();
  } finally {
    await stub.close();
  }
});
