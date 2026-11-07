import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { expectNoAxeViolations } from './support/axe';
import { approveDesign, DESIGN_APP, grounding, startDesignChat } from './support/design';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { agentRequests, call, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { openProjectChat, setPageSize } from './support/screenshots';
import { awaitTurnEnd, chatInput } from './support/ui';

// A plan approved after design v1 records v1, and a v2 delivered after that approval pauses the main chat with the update
// card and the version prompt before any run; the prompt's answer decides how the run starts.

const PLAN = '# Plan\n\n1. Build the contacts page\n';

const ENTER_PLAN = call('EnterPlanMode', {});
const EXIT_PLAN = call('ExitPlanMode', {});
// The design chat's requests for v2: the user's message, then the write's result; FinishDesign ends its turn.
const V2_DESIGN_REQUESTS = 2;

const DESIGN_MD = [
  '---',
  'app: Laravel 11, Inertia, Vue 3, Tailwind 4',
  'viewports:',
  '  primary: xl',
  '  checked: [sm, xl]',
  '  journey: []',
  '---',
  '# Contacts',
  '',
  'S1 lists contacts in a table with a search field and an Add contact button.',
  '',
].join('\n');

const screen = (name: string): string => [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default empty">',
  '<head><meta charset="utf-8"><title>Contacts</title><link rel="stylesheet" href="../tokens.css"></head>',
  '<body><main>',
  '<h1 style="color: var(--color-primary)">Contacts</h1>',
  '<input data-ds-component="Input" aria-label="Search contacts">',
  '<button data-ds-component="Button" data-ds-decision="D1">Add contact</button>',
  `<table data-ds-component="Table"><tr><td data-ds-bind="Contact.name">${name}</td></tr></table>`,
  '<p data-ds-state-only="empty">No contacts yet</p>',
  '</main></body></html>',
  '',
].join('\n');

/** The parent's plan file, where `getPlanContent` finds it: any name ending in the session's 8-hex suffix. */
async function writePlanFile(tab: Page, h: HermeticHome): Promise<void> {
  let sessionId: string | undefined;
  await expect.poll(async () => (sessionId = await tab.evaluate(() => (window.damoclesBridge?.getState() as { sessionId?: string } | null | undefined)?.sessionId))).toBeDefined();
  const file = path.join(h.damoclesDir, 'plans', `plan-${crypto.createHash('sha256').update(sessionId!).digest('hex').slice(0, 8)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PLAN);
}

const planCards = (tab: Page): Locator => tab.getByTestId('plan-card');
const resultCards = (tab: Page): Locator => tab.getByTestId('design-result-card');
const updateCard = (tab: Page): Locator => tab.locator('[data-testid="design-result-card"][data-version-pause="true"]');
const versionPrompt = (tab: Page): Locator => tab.getByTestId('design-version-card');
const strip = (tab: Page): Locator => tab.getByTestId('design-plan-strip');

interface Linked {
  readonly app: ElectronApplication;
  readonly parent: Page;
  readonly design: Page;
  readonly folder: string;
}

/** A parent with a linked design chat that finished v1; the parent ran once on the card, before any plan approval. */
async function finishDesignV1(launch: () => Promise<{ app: ElectronApplication }>, home: HermeticHome, stub: OpenAIStub): Promise<Linked> {
  seedStubModel(home, stub.baseUrl);
  fs.cpSync(DESIGN_APP, home.project, { recursive: true });
  const { app } = await launch();
  const parent = await openProjectChat(app, home.project);
  await setPageSize(parent, 900, 6000);

  const { design, folder } = await startDesignChat(app, parent, stub, home, {
    fidelity: 'Static mockup',
    script: (designDir) => [
      ...grounding(designDir, DESIGN_MD),
      call('write', { path: path.join(designDir, 'screens', 'S1-contacts.html'), content: screen('Ada Lovelace') }),
      call('FinishDesign', { summary: 'The contacts list page.' }),
      { chunks: ['Read design v1.'] },
    ],
  });
  await setPageSize(design, 900, 6000);
  await approveDesign(design);
  await expect(design.getByTestId('design-header-version')).toHaveText('v1');
  await awaitTurnEnd(design);

  // A version before any plan approval asks nothing: the plain card lands and the parent runs once.
  await expect(parent.getByText('Read design v1.')).toBeVisible();
  await awaitTurnEnd(parent);
  await expect(resultCards(parent)).toHaveCount(1);
  await expect(resultCards(parent).getByTestId('design-result-title')).toHaveText('Design finished · v1');
  await expect(versionPrompt(parent)).toHaveCount(0);
  return { app, parent, design, folder };
}

/** Plans in the parent and approves it manually; the approval records `version`. */
async function approvePlan(parent: Page, stub: OpenAIStub, version: number, reply: string, start?: string): Promise<void> {
  if (start !== undefined) {
    await chatInput(parent).fill(start);
    await chatInput(parent).press('Enter');
  }
  await expect(strip(parent)).toBeVisible();
  await expect(strip(parent).getByTestId('design-plan-strip-title')).toHaveText('Contacts list');
  await expect(strip(parent).getByTestId('design-plan-strip-version')).toHaveText(`v${version}`);
  await expect(strip(parent).getByTestId('design-plan-strip-counts')).toHaveText('1 screen · 1 decision · 0 warnings');
  await expect(strip(parent).getByTestId('design-plan-strip-records')).toHaveText(`approval records v${version}`);
  await expectNoAxeViolations(parent, '[data-testid="design-plan-strip"]');
  stub.replies.push({ chunks: [reply] });
  await parent.getByRole('button', { name: 'Yes, manually approve' }).click();
  await expect(parent.getByText(reply)).toBeVisible();
  await awaitTurnEnd(parent);
  await expect(planCards(parent).last().getByTestId('plan-card-design-version')).toHaveText(`approved · against design v${version}`);
}

/**
 * The designer finishes v2 from a message in the design chat; the parent is idle and was approved against v1. Resolves the
 * agent request count from before the message.
 */
async function finishDesignV2(linked: Linked, stub: OpenAIStub): Promise<number> {
  const { design, folder } = linked;
  const before = agentRequests(stub).length;
  stub.replies.push(
    call('write', { path: path.join(folder, 'screens', 'S1-contacts.html'), content: screen('Grace Hopper') }),
    call('FinishDesign', { summary: 'The contacts list page with a new sample row.' }),
  );
  await chatInput(design).fill('Use another sample contact');
  await chatInput(design).press('Enter');
  await approveDesign(design);
  await expect(design.getByTestId('design-header-version')).toHaveText('v2');
  await awaitTurnEnd(design);
  return before;
}

/** The update card and the dock question, with no run started for either since `requestsBefore` agent requests. */
async function expectVersionPause(parent: Page, stub: OpenAIStub, requestsBefore: number): Promise<void> {
  await expect(updateCard(parent)).toHaveCount(1);
  await expect(updateCard(parent).getByTestId('design-result-title')).toHaveText('Design updated · v1 → v2');
  await expect(updateCard(parent).getByTestId('design-result-changes')).toContainText('S1 changed');
  await expect(updateCard(parent).getByTestId('design-result-continue')).toHaveCount(0);
  const prompt = versionPrompt(parent);
  await expect(prompt).toHaveAttribute('aria-label', 'The design changed after you approved the plan');
  await expect(prompt.getByTestId('design-version-body')).toHaveText('The plan was approved against v1. The design is now v2:');
  await expect(prompt.getByTestId('design-version-changes')).toContainText('S1 changed');
  await expect(prompt.getByRole('option')).toHaveText([/Update the plan and re-approve/, /Finish v1 first/]);
  expect(agentRequests(stub).length).toBe(requestsBefore + V2_DESIGN_REQUESTS);
  await awaitTurnEnd(parent);
  expect(agentRequests(stub).length).toBe(requestsBefore + V2_DESIGN_REQUESTS);
  // Every scripted reply was used and nothing asked for another: a run past the script would answer with an echo.
  expect(stub.replies).toHaveLength(0);
  await expect(parent.getByText(/^Echo: /)).toHaveCount(0);
}

test('a plan approved after design v1 records it, and v2 pauses the main chat until Update the plan re-plans against v2', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    const linked = await finishDesignV1(launch, home, stub);
    const { parent } = linked;

    await writePlanFile(parent, home);
    stub.replies.push(ENTER_PLAN, EXIT_PLAN);
    await approvePlan(parent, stub, 1, 'Building against design v1.', 'Plan the contacts page');

    const requests = await finishDesignV2(linked, stub);
    await expectVersionPause(parent, stub, requests);
    await expectNoAxeViolations(parent, '[data-testid="design-version-card"]');
    await expectNoAxeViolations(parent, '[data-testid="design-result-card"][data-version-pause="true"]');

    // A reload replays the stamp from the tool result, and core posts the open prompt again to the new view.
    await parent.reload();
    await expect(chatInput(parent)).toBeVisible();
    await expect(planCards(parent).last().getByTestId('plan-card-design-version')).toHaveText('approved · against design v1');
    await expect(versionPrompt(parent)).toHaveCount(1);
    await expect(updateCard(parent)).toHaveCount(1);

    // Update the plan: plan mode is on before the run starts, so the agent re-plans and the new approval records v2.
    stub.replies.push(EXIT_PLAN);
    await versionPrompt(parent).getByRole('option', { name: /Update the plan and re-approve/ }).click();
    await expect(versionPrompt(parent)).toHaveCount(0);
    await expect(parent.getByTestId('composer-mode')).toContainText('Plan mode');
    await approvePlan(parent, stub, 2, 'Building against design v2.');
    await expect(planCards(parent).first().getByTestId('plan-card-design-version')).toHaveText('approved · against design v1');
    await expect(updateCard(parent).getByTestId('design-result-continue')).toHaveCount(0);
    expect(stub.replies).toHaveLength(0);
    await expect(parent.getByText(/^Echo: /)).toHaveCount(0);
  } finally {
    await stub.close();
  }
});

test('Finish v1 first answers the version pause with exactly one run in the current mode', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    const linked = await finishDesignV1(launch, home, stub);
    const { parent } = linked;

    await writePlanFile(parent, home);
    stub.replies.push(ENTER_PLAN, EXIT_PLAN);
    await approvePlan(parent, stub, 1, 'Building against design v1.', 'Plan the contacts page');

    const requests = await finishDesignV2(linked, stub);
    await expectVersionPause(parent, stub, requests);

    stub.replies.push({ chunks: ['Finishing the plan approved against v1.'] });
    // A digit answers the dock prompt that holds focus, as on the other dock prompts.
    await versionPrompt(parent).getByRole('option').first().focus();
    await parent.keyboard.press('2');
    await expect(versionPrompt(parent)).toHaveCount(0);
    await expect(parent.getByText('Finishing the plan approved against v1.')).toBeVisible();
    await awaitTurnEnd(parent);
    await expect(parent.getByTestId('composer-mode')).not.toContainText('Plan mode');
    await expect(updateCard(parent).getByTestId('design-result-continue')).toHaveCount(0);
    expect(stub.replies).toHaveLength(0);
    await expect(parent.getByText(/^Echo: /)).toHaveCount(0);
  } finally {
    await stub.close();
  }
});
