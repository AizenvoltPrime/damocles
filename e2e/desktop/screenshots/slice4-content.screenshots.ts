import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { activeChat, expect, test } from '../support/fixtures';
import { seedStubModel } from '../support/hermetic';
import { chatRequests, startOpenAIStub } from '../support/openai-stub';
import { hostMessage, saveScreenshot, showTheme, THEMES } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { chatInput } from '../support/ui';

// Review captures of the message column, the dock cards and an overlay (slice 4).

async function shoot(app: ElectronApplication, tab: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const theme of THEMES) {
    await showTheme(app, tab, theme);
    await saveScreenshot(tab, testInfo, `content-${name}-${theme}`);
  }
  await showTheme(app, tab, 'dark');
}

const LONG_REPLY = Array.from({ length: 30 }, (_, i) =>
  `Step ${i + 1}: the limiter keys on the client address and the route, keeps a sliding window in memory, and answers 429 with a Retry-After header once the window is full.\n\n`);

test('message column, dock cards and an overlay in Dark and Light', async ({ home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const notes = path.join(home.project, 'routes.ts');
  fs.writeFileSync(notes, "export const login = '/login';\n");
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    await setContentSize(app, 1280, 860);

    // A tool card, a subagent card and the status row while the closing reply is still streaming.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    stub.replies.push(
      { chunks: ['Let me read the routes first.'], toolCalls: [{ name: 'read', arguments: { path: notes } }] },
      { chunks: [], toolCalls: [{ name: 'Agent', arguments: { description: 'Survey rate limiting', prompt: 'Find how requests are throttled today.', subagent_type: 'general-purpose' } }] },
      { chunks: ['Nothing throttles requests yet; the login handler is unguarded.'] },
      { chunks: ['The route has no limiter yet. ', 'I will add a sliding window keyed on the client address.'], holdAfterFirst: held },
    );
    await chatInput(tab).fill('Rate-limit the /login route');
    await chatInput(tab).press('Enter');
    await expect(tab.getByTestId('tool-card').first()).toBeVisible();
    await expect(tab.getByTestId('subagent-card')).toBeVisible();
    await expect(tab.getByTestId('status-row')).toBeVisible();
    await shoot(app, tab, testInfo, 'conversation');
    release();
    await expect(tab.getByTestId('status-row')).toBeHidden();
    await expect.poll(() => chatRequests(stub).some((r) => JSON.stringify(r.body).includes('descriptive title'))).toBe(true);

    // The numbered permission card for an edit; its Monaco proposal waits for the card's Open diff.
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: notes, old_string: "export const login = '/login';", new_string: "export const login = '/login';\nexport const loginLimit = { windowMs: 60_000, max: 5 };" } }] });
    await chatInput(tab).fill('Add the limit settings');
    await chatInput(tab).press('Enter');
    const card = tab.getByTestId('permission-card');
    await expect(card).toBeVisible();
    await expect(tab.getByTestId('editor-overlay')).toBeHidden();
    await shoot(app, tab, testInfo, 'permission-card');
    await card.getByRole('option', { name: /^Yes$/ }).click();
    await expect(card).toBeHidden();

    // The plan-ready banner: the review overlay opens with the request and Escape leaves the banner.
    await hostMessage(app, tab, {
      type: 'requestPlanApproval',
      toolUseId: 'e2e-plan',
      planContent: '# Rate-limit /login\n\n1. Add a sliding-window limiter\n2. Wire it into the login route\n3. Answer 429 with Retry-After\n4. Cover the 429 case with a test\n',
    });
    await expect(tab.getByRole('dialog', { name: /Ready to code/ })).toBeVisible();
    await tab.keyboard.press('Escape');
    await expect(tab.getByTestId('plan-ready-banner')).toBeVisible();
    await shoot(app, tab, testInfo, 'plan-ready-banner');
    await tab.getByTestId('plan-ready-banner').getByRole('button').click();
    await expect(tab.getByRole('dialog', { name: /Ready to code/ })).toBeVisible();
    await shoot(app, tab, testInfo, 'plan-review-overlay');
    await tab.keyboard.press('Escape');

    // The Context usage overlay, from the composer's context menu.
    await tab.getByTestId('composer-context').click();
    await tab.getByRole('menuitem', { name: /View details/ }).click();
    await expect(tab.getByRole('dialog', { name: /Context/ })).toBeVisible();
    await shoot(app, tab, testInfo, 'context-usage-overlay');
    await tab.keyboard.press('Escape');
    await expect(tab.getByRole('dialog', { name: /Context/ })).toBeHidden();

    // The pinned header: a long reply scrolls its prompt off the top.
    stub.replies.push({ chunks: LONG_REPLY });
    await chatInput(tab).fill('Explain the limiter step by step');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Step 30:', { exact: false })).toBeVisible();
    await tab.mouse.move(640, 300);
    await tab.mouse.wheel(0, -240);
    await expect(tab.getByTestId('pinned-hide')).toBeVisible();
    await shoot(app, tab, testInfo, 'pinned-header');
    await tab.getByTestId('pinned-hide').click();
    await expect(tab.getByTestId('pinned-restore-chip')).toBeVisible();
    await shoot(app, tab, testInfo, 'pinned-restore-chip');
  } finally {
    await stub.close();
  }
});
