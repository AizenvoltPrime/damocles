import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { expectNoAxeViolations } from './support/axe';
import { answerFidelity, approveDesign, DESIGN_APP, designApproval, designChatPage, designFolder, FIDELITY_QUESTION, grounding, startDesignChat } from './support/design';
import { seedStubModel } from './support/hermetic';
import { agentRequests, call, startOpenAIStub } from './support/openai-stub';
import { openProjectChat, setPageSize } from './support/screenshots';
import { shellPage } from './support/shell';
import { awaitTurnEnd, chatInput } from './support/ui';

// A scripted StartDesign opens a linked design chat nested under its parent, the designer grounds itself in the fixture
// app, records the fidelity answer as D1, fails and then passes DesignCheck, and FinishDesign, once the user approves, puts
// exactly one "Design finished" card in the parent, which runs once.

test.describe.configure({ timeout: 300_000 });

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

// Three DesignCheck errors: an off-token color, a component the inventory lacks and a button with no accessible name.
const SCREEN_FAILING = [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default empty">',
  '<head><meta charset="utf-8"><title>Contacts</title><link rel="stylesheet" href="../tokens.css"></head>',
  '<body><main>',
  '<h1 style="color: #ff0000">Contacts</h1>',
  '<div data-ds-component="Carousel"></div>',
  '<button data-ds-component="Button"></button>',
  '</main></body></html>',
  '',
].join('\n');

const SCREEN_PASSING = [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default empty">',
  '<head><meta charset="utf-8"><title>Contacts</title><link rel="stylesheet" href="../tokens.css"></head>',
  '<body><main>',
  '<h1 style="color: var(--color-primary)">Contacts</h1>',
  '<input data-ds-component="Input" aria-label="Search contacts">',
  '<button data-ds-component="Button" data-ds-decision="D1">Add contact</button>',
  '<table data-ds-component="Table"><tr><td data-ds-bind="Contact.name">Ada Lovelace</td></tr></table>',
  '<p data-ds-state-only="empty">No contacts yet</p>',
  '</main></body></html>',
  '',
].join('\n');

/** The rules of a DesignCheck report's errors, as their issues render them. */
const errorRules = (card: Locator): Promise<(string | null)[]> =>
  card.getByTestId('design-check-errors').getByTestId('design-check-issue').evaluateAll((issues) => issues.map((issue) => issue.getAttribute('data-rule')));

test('a design chat opens nested under its parent, records D1, gates FinishDesign on DesignCheck and delivers one Design finished card', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const parent = await openProjectChat(app, home.project);

    let releaseFirstReply!: () => void;
    const pageShown = new Promise<void>((resolve) => { releaseFirstReply = resolve; });
    stub.replies.push(
      call('StartDesign', { title: 'Contacts list', brief: 'Design the contacts list page: a searchable table of contacts with an Add contact button.' }),
      // Held until the design chat's page shows, so the reply writes its file while the page already shows its running turn.
      { ...FIDELITY_QUESTION, holdAfterFirst: pageShown },
    );
    await chatInput(parent).fill('Design the contacts page before we build it');
    await chatInput(parent).press('Enter');

    // The parent's turn ends at StartDesign, from the engine: its card says the design chat opened and the design is a draft.
    const startCard = parent.getByTestId('start-design-card');
    await expect(startCard).toContainText('Design chat opened');
    await expect(startCard).toContainText('Contacts list');
    await awaitTurnEnd(parent);
    await expect(startCard.getByTestId('start-design-status')).toHaveText('Draft');

    const design = await designChatPage(app, [parent]);
    // Tall enough that the virtualized transcript keeps every card of the run mounted.
    await setPageSize(design, 900, 6000);
    await expect(design.getByTestId('design-brief-note')).toContainText('searchable table of contacts');
    releaseFirstReply();
    const mode = design.getByTestId('composer-mode');
    await expect(mode).toHaveAttribute('data-mode', 'design');
    await expect(mode).toHaveText('Design');

    // The design chat is nested under its parent in the sidebar, with its badge.
    const shell = await shellPage(app);
    const row = shell.locator('[data-chat-id][data-nested="true"]');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('chat-design-icon')).toBeVisible();
    await expect(row.getByTestId('chat-title')).toHaveText(/^Design · /);

    // The design chat opens selected, and the chat pane's gutter continues its header level with it, in window coordinates.
    await expect(row).toHaveAttribute('aria-selected', 'true');
    const slot = (await shell.getByTestId('chat-slot').boundingBox())!;
    const header = (await design.getByTestId('design-header').boundingBox())!;
    const edge = (await shell.getByTestId('design-header-edge').boundingBox())!;
    // Within 1 px: at a fractional device scale factor the two pages' boxes round apart.
    const offsets = [edge.y - (slot.y + header.y), edge.height - header.height, edge.x + edge.width - slot.x];
    for (const offset of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(1);

    const folder = designFolder(home.damoclesDir);
    stub.replies.push(
      ...grounding(folder, DESIGN_MD),
      call('write', { path: path.join(folder, 'screens', 'S1-contacts.html'), content: SCREEN_FAILING }),
      call('DesignCheck', {}),
      call('FinishDesign', { summary: 'The contacts list page.' }),
      call('write', { path: path.join(folder, 'screens', 'S1-contacts.html'), content: SCREEN_PASSING }),
      call('DesignCheck', {}),
      call('FinishDesign', { summary: 'The contacts list page: a searchable table with an Add contact button.' }),
      { chunks: ['Planning against design v1.'] },
    );

    // The answered fidelity question becomes D1 in the header's strip. A static design needs no journey (PD-21, design-journey.spec.ts).
    const question = design.getByRole('region', { name: 'Question prompt' });
    await expect(question).toContainText('Static mockup or interactive prototype?');
    // The designer's first reply wrote the chat's file while its turn waits: the one row is named by that session, never `new:`.
    await expect(row).not.toHaveAttribute('data-chat-id', /^new:/);
    await expect(row).toHaveCount(1);
    await answerFidelity(design, 'Static mockup');
    const d1 = design.getByTestId('design-decisions').locator('[data-decision-id="D1"]');
    await expect(d1).toContainText('Fidelity');
    await expect(d1).toContainText('Static mockup');

    // Grounding: the inventory card lists the fixture's components, and the tokens land in the design folder.
    const inventory = design.locator('[data-testid="design-tool-card"][data-tool="Inventory"]');
    await expect(inventory.locator('[data-category="components"] > span').last()).toHaveText('4');
    await expect(design.locator('[data-testid="design-tool-card"][data-tool="ExtractTokens"]').getByTestId('design-tokens')).toBeVisible();

    // The first check fails with its errors listed first, and FinishDesign refuses with the same issues.
    const checks = design.locator('[data-testid="design-tool-card"][data-tool="DesignCheck"]');
    const failing = checks.filter({ has: design.getByTestId('design-check-errors') });
    await expect(failing).toHaveCount(1);
    await expect(failing.getByTestId('design-check-errors')).toContainText('tokens.color');
    await expect(failing.getByTestId('design-check-errors')).toContainText('ds.component-known');
    await expect(failing.getByTestId('design-check-errors')).toContainText('a11y.control-name');
    await expect(failing).toContainText('No model call.');
    const finishes = design.getByTestId('finish-design-card');
    const refused = finishes.filter({ hasText: 'Finish refused' });
    await expect(refused).toHaveCount(1);
    const failingRules = await errorRules(failing);
    expect(failingRules).toEqual(expect.arrayContaining(['tokens.color', 'ds.component-known', 'a11y.control-name']));
    expect(await errorRules(refused)).toEqual(failingRules);

    // The fixed screen passes, and FinishDesign asks before it makes v1: the summary, a first version, D1 and S1's live preview.
    await expect(checks.filter({ has: design.getByTestId('design-check-pass') })).toContainText('0 errors');
    const approval = designApproval(design);
    await expect(approval).toBeVisible({ timeout: 120_000 });
    await expect(approval.getByTestId('design-approval-summary')).toHaveText('The contacts list page: a searchable table with an Add contact button.');
    await expect(approval.getByTestId('design-approval-changes')).toHaveText('This will be the design\'s first version.');
    await expect(approval.getByTestId('design-approval-decisions')).toContainText('D1 Fidelity · Static mockup');
    await expect(approval.getByRole('button', { name: 'Open screens/S1-contacts.html in the preview tab' })).toBeVisible();
    await expect(approval.getByRole('option')).toHaveText([/Approve and send to main chat/, /Request changes/, /Stop/]);
    // While it waits no version exists, the card says so and the sidebar row says the design chat needs the user.
    await expect(finishes.last()).toHaveAttribute('data-approval', 'awaiting');
    await expect(design.getByTestId('design-header-version')).toHaveText('Draft');
    await expect(shell.locator('[data-chat-id][data-nested="true"] [data-testid="chat-design-dot"]')).toHaveAttribute('data-state', 'waiting');
    await expect(parent.getByTestId('design-result-card')).toHaveCount(0);
    await expectNoAxeViolations(design, '[data-testid="design-approval-card"]');
    await approveDesign(design);

    // Approved, FinishDesign stamps v1 for the parent.
    await expect(finishes.filter({ hasText: 'Design v1 finished' })).toHaveAttribute('data-delivery', 'live');
    await expect(design.getByTestId('design-header-version')).toHaveText('v1');
    await awaitTurnEnd(design);
    // The sidebar learns v1 from the design chat's session file, so the idle row's dot turns to finished.
    await expect(shell.locator('[data-chat-id][data-nested="true"] [data-testid="chat-design-dot"]')).toHaveAttribute('data-state', 'finished');

    // The parent, live and idle, gets exactly one card and runs once in its current mode.
    await setPageSize(parent, 900, 6000);
    const result = parent.getByTestId('design-result-card');
    await expect(result).toHaveCount(1);
    await expect(result.getByTestId('design-result-title')).toHaveText('Design finished · v1');
    await expect(result.getByTestId('design-result-subtitle')).toHaveText('1 screen · 1 decision · check passed');
    await expect(result.getByTestId('design-result-decisions')).toContainText('D1 Fidelity · Static mockup');
    await expect(parent.getByText('Planning against design v1.')).toBeVisible();
    await awaitTurnEnd(parent);
    await expect(result.getByTestId('design-result-continue')).toHaveCount(0);
    await expect(startCard.getByTestId('start-design-status')).toHaveText('Finished · v1');
    expect(fs.existsSync(path.join(folder, 'decisions.md'))).toBe(true);
    // Every scripted reply was used and no second run asked for one: a run past the script would answer with an echo.
    expect(stub.replies).toHaveLength(0);
    await expect(parent.getByText(/^Echo: /)).toHaveCount(0);

    // The design surfaces only: the transcript around them holds other tools' cards, which their own specs scan.
    for (const selector of ['[data-testid="design-header"]', '[data-testid="composer-mode"]', '[data-testid="design-brief-note"]', '[data-testid="design-tool-card"]', '[data-testid="finish-design-card"]']) {
      await expectNoAxeViolations(design, selector);
    }
    for (const selector of ['[data-testid="start-design-card"]', '[data-testid="design-result-card"]']) await expectNoAxeViolations(parent, selector);
    await expectNoAxeViolations(shell, '[data-chat-id][data-nested="true"]');
  } finally {
    await stub.close();
  }
});

test('Request changes hands the note to the designer, who goes on in the same turn, and Stop ends it with no version', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const parent = await openProjectChat(app, home.project);
    const NOTE = 'Use Grace Hopper as the sample contact.';
    const { design } = await startDesignChat(app, parent, stub, home, {
      fidelity: 'Static mockup',
      script: (folder) => {
        const screen = path.join(folder, 'screens', 'S1-contacts.html');
        return [
          ...grounding(folder, DESIGN_MD),
          call('write', { path: screen, content: SCREEN_PASSING }),
          call('FinishDesign', { summary: 'The contacts list page.' }),
          // The designer's answer to the note, in the turn that asked.
          call('write', { path: screen, content: SCREEN_PASSING.replace('Ada Lovelace', 'Grace Hopper') }),
          call('FinishDesign', { summary: 'The contacts list page, with Grace Hopper as the sample contact.' }),
        ];
      },
    });
    // Tall enough that the virtualized transcript keeps every card of the run mounted.
    await setPageSize(design, 900, 6000);

    // Request changes asks for a note, and sends nothing while it is blank.
    const approval = designApproval(design);
    await expect(approval).toBeVisible({ timeout: 120_000 });
    await approval.getByRole('option', { name: 'Request changes' }).click();
    const note = approval.getByRole('textbox', { name: 'What should the designer change?' });
    await expect(note).toBeFocused();
    const send = approval.getByRole('button', { name: 'Send to the designer' });
    await expect(send).toBeDisabled();
    await note.fill('   ');
    await expect(send).toBeDisabled();
    await note.fill(NOTE);
    await expectNoAxeViolations(design, '[data-testid="design-approval-card"]');
    await send.click();

    // No version: the card shows the note, and the designer works on it and asks again within the same turn.
    const finishes = design.getByTestId('finish-design-card');
    const changes = finishes.filter({ hasText: 'Changes requested' });
    await expect(changes).toHaveAttribute('data-approval', 'changesRequested');
    await expect(changes.getByTestId('finish-design-note')).toHaveText(NOTE);
    await expect(approval).toBeVisible({ timeout: 120_000 });
    await expect(approval.getByTestId('design-approval-summary')).toHaveText('The contacts list page, with Grace Hopper as the sample contact.');
    expect(agentRequests(stub).some((request) => JSON.stringify(request.body).includes(NOTE))).toBe(true);
    await expect(design.getByTestId('design-header-version')).toHaveText('Draft');

    // Stop ends the designer's turn with no version, and the main chat gets nothing.
    await approval.getByRole('option', { name: 'Stop', exact: true }).click();
    await expect(approval).toHaveCount(0);
    await awaitTurnEnd(design);
    await expect(finishes.filter({ hasText: 'Stopped without a version' })).toHaveAttribute('data-approval', 'stopped');
    await expect(design.getByTestId('design-header-version')).toHaveText('Draft');
    await expect(parent.getByTestId('design-result-card')).toHaveCount(0);
    // Every scripted reply was used and no run asked for another: a run past the script would answer with an echo.
    expect(stub.replies).toHaveLength(0);
    await expect(design.getByText(/^Echo: /)).toHaveCount(0);
    await expect(parent.getByText(/^Echo: /)).toHaveCount(0);
    await expectNoAxeViolations(design, '[data-testid="finish-design-card"]');
  } finally {
    await stub.close();
  }
});
