import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { seedStubModel } from '../support/hermetic';
import { startOpenAIStub } from '../support/openai-stub';
import { hostMessage, openProjectChat, settled, shoot, shootReferences } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { chatInput, postFromWebview, sendAndAwaitEcho } from '../support/ui';

// Review captures of alpha's slice 4b overlays and message cards beside the design reference.

const openOverlay = (overlay: string): string => `logic.openOv(${JSON.stringify(overlay)});`;

test('bind-plan overlay beside the reference', async ({ home, launch }, testInfo) => {
  test.setTimeout(300_000);
  for (const [file, minutesAgo] of [['docs/plans/login-hardening.md', 120], ['PLAN.md', 1500], ['docs/plans/express-5.md', 6000]] as const) {
    const full = path.join(home.project, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `# ${file}\n`);
    const when = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(full, when, when);
  }
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    await setContentSize(app, 1280, 860);
    await sendAndAwaitEcho(tab, 'Rate-limit the /login route');

    await shootReferences(app, testInfo, [{ name: 'bind-plan', setup: openOverlay('bindPlan') }]);

    await tab.getByTestId('chat-header-plan').click();
    await tab.getByRole('menuitem', { name: /Bind a plan file/ }).click();
    const overlay = tab.getByTestId('bind-plan-overlay');
    await expect(overlay.getByTestId('bind-plan-file')).toHaveCount(3);
    await shoot(app, tab, testInfo, 'bind-plan');

    // Binding once gives the session a plan file, so the reopened overlay shows the overwrite warning.
    await overlay.getByTestId('bind-plan-bind').click();
    await expect(overlay).toBeHidden();
    await tab.getByTestId('chat-header-plan').click();
    await tab.getByRole('menuitem', { name: /Bind a plan file/ }).click();
    await expect(tab.getByTestId('bind-plan-overwrite')).toBeVisible();
    await shoot(app, tab, testInfo, 'bind-plan-hasplan');
  } finally {
    await stub.close();
  }
});

const LONG_PROMPT = 'The /login route has no rate limiting. Add it and make sure the tests still pass.\n\nSome context:\n- We run 3 instances behind the load balancer\n- Use 5 attempts per 15 minutes per IP\n- Return a JSON 429 body, not the default HTML page\n- Keep the existing auth tests green';
const REPLY = "`express-rate-limit` is already a dependency but nothing uses it. I'll add a limiter scoped to `/login`:\n\n- 5 attempts per 15 minutes per IP\n- standard `RateLimit-*` headers and a JSON 429 body\n\nThe tests live in `test/auth.spec.ts`.\n\n```ts\nconst loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 });\nrouter.post('/login', loginLimiter, login);\n```";
const PLAN = '# Rate-limit /login\n\nAdd a per-IP limiter with standard headers.\n\n1. Add a sliding-window limiter\n2. Wire it into the login route\n3. Answer 429 with Retry-After\n4. Cover the 429 case with a test\n';
/** Scrolls the element holding `text` to 56px below the top of its scroller, so no pinned header covers it. */
async function scrollTo(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: false }).first().evaluate((el) => {
    let scroller = el.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
    if (!scroller) return;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 56;
  });
  await settled(page);
}
const NO_PENDING = 'const c = logic.conv; c.pending = null; c.busy = false; logic.setState({});';

test('message cards beside the reference', async ({ home, launch }, testInfo) => {
  test.setTimeout(600_000);
  const routes = path.join(home.project, 'routes.ts');
  fs.mkdirSync(path.join(home.project, 'plans'));
  fs.writeFileSync(path.join(home.project, 'plans', 'rate-limit.md'), PLAN);
  fs.writeFileSync(routes, "export const login = '/login';\n");
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    await setContentSize(app, 1280, 860);

    await shootReferences(app, testInfo, [
      { name: 'card-conversation', setup: NO_PENDING, focus: (page) => scrollTo(page, 'The /login route has no rate limiting') },
      { name: 'card-text', setup: NO_PENDING, focus: (page) => scrollTo(page, 'is already a dependency') },
      { name: 'card-permission', setup: '' },
      {
        name: 'card-plan',
        setup: `const c = logic.conv; c.pending = null; c.busy = false; c.items.push({ kind: 'plan', id: 'p9', status: 'await', version: 1, plan: ${JSON.stringify(PLAN)} }); c.planWait = 'p9'; logic.setState({});`,
        focus: (page) => scrollTo(page, 'Click to review the plan'),
      },
    ]);

    stub.replies.push({ chunks: [REPLY] });
    await chatInput(tab).fill(LONG_PROMPT);
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('The tests live in', { exact: false })).toBeVisible();
    await hostMessage(app, tab, { type: 'assistantReplay', content: "I'll check how the auth routes are wired and whether a limiter is already installed.", thinking: 'Check whether a limiter dependency exists, see how routes are composed, then find the auth tests so they can be run after the change.' });
    await hostMessage(app, tab, { type: 'panelFocused' });
    await expect(tab.getByRole('dialog'), 'no overlay over the message list').toHaveCount(0);
    await shoot(app, tab, testInfo, 'card-conversation', () => scrollTo(tab, 'The /login route has no rate limiting'));
    await shoot(app, tab, testInfo, 'card-text', () => scrollTo(tab, 'is already a dependency'));
    await tab.getByTestId('thinking-trigger').last().click();
    await shoot(app, tab, testInfo, 'card-thinking', () => scrollTo(tab, 'Check whether a limiter dependency exists'));

    await hostMessage(app, tab, { type: 'compactBoundary', preTokens: 182_000, postTokens: 24_000, trigger: 'threshold', summary: 'The user asked for a rate limiter on /login.', timestamp: Date.now(), entryId: 'e2e-compaction' });
    await hostMessage(app, tab, { type: 'compactionAborted', trigger: 'auto', willRetry: true, errorMessage: 'The summary request timed out.', timestamp: Date.now() });
    await hostMessage(app, tab, { type: 'cacheMissNotice', missedTokens: 48_200, missedCost: 0.14, idleMs: 7 * 60_000, modelChanged: false, timestamp: Date.now() });
    await hostMessage(app, tab, { type: 'thinkingDroppedNotice', count: 2, reasons: ['signature mismatch'], timestamp: Date.now() });
    await hostMessage(app, tab, { type: 'errorReplay', content: 'The provider returned 529: overloaded.' });
    await hostMessage(app, tab, { type: 'panelFocused' });
    await shoot(app, tab, testInfo, 'card-notices', () => scrollTo(tab, 'Context compacted'));
    await tab.getByRole('button', { name: /Rewind to before compaction/ }).click();
    await expect(tab.getByRole('alertdialog')).toBeVisible();
    await shoot(app, tab, testInfo, 'confirm-compaction-rewind');
    await tab.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(tab.getByRole('alertdialog')).toBeHidden();

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: routes, old_string: "export const login = '/login';", new_string: "export const login = '/login';\nexport const loginLimit = { windowMs: 60_000, max: 5 };" } }] });
    await chatInput(tab).fill('Add the limit settings');
    await chatInput(tab).press('Enter');
    const card = tab.getByTestId('permission-card');
    await expect(card).toBeVisible();
    await expect(tab.getByTestId('editor-overlay')).toBeHidden();
    await expect(tab.getByRole('dialog')).toHaveCount(0);
    await shoot(app, tab, testInfo, 'card-permission');
    await card.getByRole('option', { name: /^Yes$/ }).click();
    await expect(card).toBeHidden();
    await tab.getByTestId('user-message-rewind').last().click();
    await expect(tab.getByRole('alertdialog')).toBeVisible();
    await shoot(app, tab, testInfo, 'confirm-rewind');
    await tab.keyboard.press('Escape');
    await expect(tab.getByRole('alertdialog')).toBeHidden();

    await hostMessage(app, tab, { type: 'requestQuestion', toolUseId: 'e2e-q', questions: [{ header: 'Store', question: 'Where should the limiter keep its counters?', multiSelect: false, options: [{ label: 'In memory', description: 'Per instance; resets on deploy' }, { label: 'Redis', description: 'Shared by all 3 instances' }] }] });
    await expect(tab.getByText('Where should the limiter keep its counters?')).toBeVisible();
    await shoot(app, tab, testInfo, 'card-question');
    await hostMessage(app, tab, { type: 'sessionCancelled' });

    await hostMessage(app, tab, { type: 'requestSkillApproval', toolUseId: 'e2e-skill', skillName: 'review-pr', skillDescription: 'Review a pull request against our checklist' });
    await expect(tab.getByTestId('skill-card')).toBeVisible();
    await shoot(app, tab, testInfo, 'card-skill');
    await hostMessage(app, tab, { type: 'sessionCancelled' });

    await hostMessage(app, tab, { type: 'requestForm', toolUseId: 'e2e-form', form: { title: 'Sign in to staging', description: 'Values go straight into the page.', fields: [{ id: 'user', label: 'Email', type: 'email', selector: '#email', required: true }, { id: 'pass', label: 'Password', type: 'password', selector: '#password', sensitive: true }] } });
    await expect(tab.getByTestId('form-card')).toBeVisible();
    await shoot(app, tab, testInfo, 'card-form');
    await tab.getByTestId('form-card').getByRole('button', { name: 'Cancel' }).click();
    await expect(tab.getByTestId('form-card')).toBeHidden();

    // Binding the plan through the D44 overlay gives the session the plan file ExitPlanMode presents.
    await tab.getByTestId('chat-header-plan').click();
    await tab.getByRole('menuitem', { name: /Bind a plan file/ }).click();
    await tab.getByTestId('bind-plan-file').first().click();
    await tab.getByTestId('bind-plan-bind').click();
    await expect(tab.getByTestId('bind-plan-overlay')).toBeHidden();
    await postFromWebview(tab, { type: 'setPermissionMode', mode: 'plan' });
    stub.replies.push({ chunks: ['The plan is ready.'], toolCalls: [{ name: 'ExitPlanMode', arguments: {} }] });
    await chatInput(tab).fill('Plan the limiter');
    await chatInput(tab).press('Enter');
    await expect(tab.getByRole('dialog', { name: /Ready to code/ })).toBeVisible();
    await tab.keyboard.press('Escape');
    await expect(tab.getByTestId('plan-ready-banner')).toBeVisible();
    await expect(tab.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
    await shoot(app, tab, testInfo, 'card-plan', () => scrollTo(tab, 'Plan the limiter'));

    // Feedback sends the plan back: the card shows the revising state with the quoted feedback.
    await tab.getByTestId('plan-ready-banner').getByRole('button').click();
    await tab.getByTestId('plan-feedback').fill('Keep the limiter in memory for now.');
    stub.replies.push({ chunks: ['Revised.'], toolCalls: [{ name: 'ExitPlanMode', arguments: {} }] });
    await tab.getByRole('button', { name: /Send feedback/i }).click();
    await expect(tab.getByText('Keep the limiter in memory for now.', { exact: false }).first()).toBeVisible();
    await expect(tab.getByRole('dialog', { name: /Ready to code/ })).toBeVisible();
    await tab.getByRole('button', { name: /auto-accept edits/i }).first().click();
    await expect(tab.getByTestId('plan-ready-banner')).toBeHidden();
    await shoot(app, tab, testInfo, 'card-plan-done', () => scrollTo(tab, 'Plan the limiter'));
  } finally {
    await stub.close();
  }
});

/** Opens an entry of the chat header's More menu. */
async function moreMenu(tab: Page, name: RegExp): Promise<void> {
  await tab.getByTestId('chat-header-more').click();
  await tab.getByRole('menuitem', { name }).click();
}

test('alpha overlays beside the reference', async ({ home, launch }, testInfo) => {
  test.setTimeout(600_000);
  fs.mkdirSync(path.join(home.project, 'plans'));
  fs.writeFileSync(path.join(home.project, 'plans', 'rate-limit.md'), PLAN);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    await setContentSize(app, 1280, 860);

    const overlays = [['navigator', 'navigator'], ['rewind', 'rewind'], ['consolidation', 'consolidation'], ['plan', 'plan-view'], ['memory', 'memory'], ['usage', 'usage'], ['stats', 'stats']] as const;
    await shootReferences(app, testInfo, overlays.map(([overlay, name]) => ({ name, setup: openOverlay(overlay) })));

    // One prompt with tools, so the navigator shows its tool chips.
    const routes = path.join(home.project, 'routes.ts');
    fs.writeFileSync(routes, "export const login = '/login';\n");
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'read', arguments: { path: routes } }, { name: 'grep', arguments: { pattern: 'login', path: home.project } }] },
      { chunks: [], toolCalls: [{ name: 'find', arguments: { pattern: '*.ts', path: home.project } }, { name: 'ls', arguments: { path: home.project } }] },
      { chunks: ['The login route has no limiter yet.'] },
    );
    await chatInput(tab).fill('Rate-limit the /login route');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('The login route has no limiter yet.')).toBeVisible();
    await sendAndAwaitEcho(tab, 'Add a test for the 429 case');

    const shootOverlay = async (name: string, open: () => Promise<unknown>, testId: string, prepare?: () => Promise<void>): Promise<void> => {
      await expect(tab.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
      // The previous overlay's exit finishes before the next opener is clicked.
      await settled(tab);
      await chatInput(tab).focus();
      await open();
      await expect(tab.getByTestId(testId)).toBeVisible();
      await prepare?.();
      await shoot(app, tab, testInfo, name);
      await tab.keyboard.press('Escape');
      await expect(tab.getByTestId(testId)).toBeHidden();
    };

    await shootOverlay('navigator', () => tab.getByRole('button', { name: /Prompt navigator/ }).first().click(), 'prompt-navigator');
    await shootOverlay('rewind', () => moreMenu(tab, /^Rewind/), 'rewind-browser', async () => {
      await expect(tab.getByTestId('rewind-browser').getByRole('option').first()).toBeVisible();
    });
    await shootOverlay('consolidation', () => tab.getByRole('button', { name: /Memory consolidation/ }).first().click(), 'consolidation-overlay');
    await shootOverlay('usage', () => moreMenu(tab, /Subscription usage/), 'subscription-usage-overlay');
    await shootOverlay('stats', () => moreMenu(tab, /Usage statistics/), 'usage-stats-overlay');

    const now = Date.now();
    const memory = (id: string, kind: string, scope: string, content: string, extra: Record<string, unknown> = {}) => ({
      id, tier: scope, kind, scope, content, sessionId: null, workspace: home.project, createdAt: now - 3_600_000, updatedAt: now - 3_600_000, tags: [], ...extra,
    });
    await shootOverlay('memory', () => tab.getByTestId('chat-header-memory').click(), 'memory-panel', async () => {
      await hostMessage(app, tab, {
        type: 'memoriesUpdate',
        observationCursor: null,
        memories: [
          memory('m1', 'preference', 'global', 'Prefers small, reviewable PRs and Vitest over Jest.', { pinned: true }),
          memory('m2', 'fact', 'project', 'The API runs Express 5 with Zod validation; Postgres via the db/client pool.', { sourceCount: 3 }),
          memory('m3', 'episode', 'project', 'Fixed an N+1 in listOrders by batching customers into one IN query.', { isInference: true }),
          memory('m4', 'fact', 'session', 'The user wants 5 login attempts per 15 minutes per IP.'),
        ],
      });
      await expect(tab.locator('[data-memory-id="m1"]')).toBeVisible();
    });

    await tab.getByTestId('chat-header-plan').click();
    await tab.getByRole('menuitem', { name: /Bind a plan file/ }).click();
    await tab.getByTestId('bind-plan-file').first().click();
    await tab.getByTestId('bind-plan-bind').click();
    await expect(tab.getByTestId('bind-plan-overlay')).toBeHidden();
    await shootOverlay('plan-view', async () => {
      await tab.getByTestId('chat-header-plan').click();
      await tab.getByRole('menuitem', { name: /View session plan/ }).click();
    }, 'plan-view-overlay');

    // A system prompt row opens the prompt read-only in the chat's in-app editor, over the context usage overlay.
    await tab.getByTestId('composer-context').click();
    await tab.getByRole('menuitem', { name: /View details/ }).click();
    await expect(tab.getByRole('dialog', { name: /Context/ })).toBeVisible();
    await tab.getByRole('button', { name: /System Prompt Sections/ }).click();
    await tab.getByTestId('context-row-open').first().click();
    await expect(tab.getByTestId('editor-overlay')).toBeVisible();
    await shoot(app, tab, testInfo, 'context-usage-preview');
    await tab.getByTestId('editor-overlay-close').focus();
    await tab.keyboard.press('Escape');
    await expect(tab.getByTestId('editor-overlay')).toBeHidden();
    await tab.keyboard.press('Escape');
    await expect(tab.getByRole('dialog', { name: /Context/ })).toBeHidden();

    await shootOverlay('context-injection', () => tab.getByRole('button', { name: /View injected context/ }).first().click(), 'context-injection-overlay');
    await shootOverlay('memory-audit', async () => {
      await tab.getByTestId('chat-header-memory').click();
      await tab.locator('[data-audit-open]').click();
    }, 'memory-audit-overlay');
    await tab.keyboard.press('Escape');
  } finally {
    await stub.close();
  }
});

test('voice modals in the overlay vocabulary', async ({ home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    await setContentSize(app, 1280, 860);

    await hostMessage(app, tab, { type: 'voiceFirstRunRequired', reason: 'first-time' });
    await expect(tab.getByTestId('voice-first-run')).toBeVisible();
    await shoot(app, tab, testInfo, 'voice-first-run');
    await tab.keyboard.press('Escape');
    await expect(tab.getByTestId('voice-first-run')).toBeHidden();

    // A pointer press ends keyboard modality, so the next overlay's initially focused X shows no focus ring.
    await tab.mouse.click(640, 400);
    await hostMessage(app, tab, { type: 'voiceModelDownloadProgress', modelId: 'whisper-small', bytesReceived: 180_000_000, bytesTotal: 466_000_000, status: 'downloading' });
    await hostMessage(app, tab, { type: 'voiceModelDownloadProgress', modelId: 'kokoro-v1', bytesReceived: 330_000_000, bytesTotal: 330_000_000, status: 'verifying' });
    await expect(tab.getByTestId('voice-model-download')).toBeVisible();
    await shoot(app, tab, testInfo, 'voice-model-download');
    await hostMessage(app, tab, { type: 'voiceModelDownloadCancelled' });
    await expect(tab.getByTestId('voice-model-download')).toBeHidden();

    await hostMessage(app, tab, { type: 'voiceModelUpgradeAvailable', upgrades: [{ modelId: 'whisper-small', description: 'Faster decoding and better punctuation.', installedVersion: '1.2.0', newVersion: '1.3.0', bytesDelta: 52_000_000, totalBytes: 52_000_000, licenseUrl: 'https://example.com/license', license: 'MIT', gated: false }] });
    await expect(tab.getByTestId('voice-model-upgrade')).toBeVisible();
    await shoot(app, tab, testInfo, 'voice-model-upgrade');
  } finally {
    await stub.close();
  }
});
