import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { expectNoAxeViolations } from './support/axe';
import { chromeEnv, startSite, systemChrome, type Site } from './support/browser';
import { approveDesign, DESIGN_APP, grounding, startDesignChat } from './support/design';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { agentRequests, call, isSubCall, startOpenAIStub, type OpenAIStub, type RecordedRequest, type StubReply } from './support/openai-stub';
import { openProjectChat, setPageSize } from './support/screenshots';
import { awaitTurnEnd } from './support/ui';
import { DESIGN_PARITY_CHECK_IDS, PARITY_OUTPUT_TOOL } from '../../src/shared/design-parity';

// The main chat scores the real app against its linked finished design at each width with the fixed 12-check judge, whose
// score core counts from the booleans; without the browser setting or an image-reading background model DesignParity
// refuses and says which is missing.

test.describe.configure({ timeout: 300_000 });

const CONTACTS = fs.readFileSync(path.join(DESIGN_APP, 'static', 'contacts.html'), 'utf8');

// The stub routes the judge sub-calls by their output tool; one call per width, widths ascending.
const JUDGE_TOOL = PARITY_OUTPUT_TOOL;
const SCREEN_FILE = 'screens/S1-contacts.html';

/** The PNG images a request carries, in its order. */
const pngsOf = (request: RecordedRequest): string[] => [...JSON.stringify(request.body).matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map((match) => match[1]!);

// The checked widths are sm and xl, so parity's two widths are 640 and 1280 px.
const DESIGN_MD = ['---', 'app: Laravel 11, Inertia, Vue 3, Tailwind 4', 'viewports:', '  primary: xl', '  checked: [sm, xl]', '  journey: []', '---', '# Contacts', '', 'S1 lists contacts with a search field and an Add contact button.', ''].join('\n');
const SCREEN = [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default">',
  '<head><meta charset="utf-8"><title>Contacts</title><link rel="stylesheet" href="../tokens.css"></head>',
  '<body><main>',
  '<h1 style="color: var(--color-primary)">Contacts</h1>',
  '<input data-ds-component="Input" aria-label="Search contacts">',
  '<button data-ds-component="Button">Add contact</button>',
  '<table data-ds-component="Table"><tr><td data-ds-bind="Contact.name">Grace Hopper</td></tr></table>',
  '</main></body></html>',
  '',
].join('\n');

/** The judge's answer: every check passes except `failing`, each with a short reason, plus a score and status core must ignore. */
function verdict(failing: readonly string[]): StubReply {
  const checks = Object.fromEntries(DESIGN_PARITY_CHECK_IDS.map((id) => [id, { pass: !failing.includes(id), reason: failing.includes(id) ? `Judge: ${id} differs.` : 'Matches.' }]));
  return call(JUDGE_TOOL, { checks, score: 12, status: 'verified' });
}

/** The app page the parity run captures, on a loopback server the test owns. */
function startContactsApp(): Promise<Site> {
  return startSite(() => 'Not found', {
    '/contacts.html': (res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(CONTACTS);
    },
  });
}

/** A port held by a listener that resets every connection it accepts, as an app that is not running answers. */
async function startRefusingPort(): Promise<Site> {
  const server = net.createServer((socket) => socket.resetAndDestroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) };
}

/**
 * A parent with a linked design chat that finished v1; the parent's one run on the card is `parentRun`, which the test
 * scripts to call DesignParity.
 */
async function linkedParent(launch: (options?: { env?: Record<string, string> }) => Promise<{ app: ElectronApplication }>, home: HermeticHome, stub: OpenAIStub, options: { input: ('text' | 'image')[]; browser: boolean }, parentRun: StubReply[]): Promise<Page> {
  seedStubModel(home, stub.baseUrl, options.input);
  writeUserSettings(home, { 'damocles.browser.enabled': options.browser });
  fs.cpSync(DESIGN_APP, home.project, { recursive: true });
  const { app } = await launch({ env: chromeEnv() });
  const parent = await openProjectChat(app, home.project);
  await setPageSize(parent, 900, 6000);

  const { design } = await startDesignChat(app, parent, stub, home, {
    fidelity: 'Static mockup',
    script: (folder) => [
      ...grounding(folder, DESIGN_MD),
      call('write', { path: path.join(folder, ...SCREEN_FILE.split('/')), content: SCREEN }),
      call('FinishDesign', { summary: 'The contacts list page.' }),
      ...parentRun,
    ],
  });
  await approveDesign(design);
  await expect(design.getByTestId('design-header-version')).toHaveText('v1');
  await awaitTurnEnd(design);

  // The finished version lands in the parent, whose one run on it is the scripted parity run.
  await expect(parent.getByTestId('design-result-card')).toHaveCount(1);
  await expect.poll(() => stub.replies.length, { timeout: 120_000 }).toBe(0);
  await awaitTurnEnd(parent);
  return parent;
}

const parityCard = (parent: Page): Locator => parent.getByTestId('design-parity-card');

test('DesignParity scores the real app against the design at two widths, n/12 counted by core from the judge\'s booleans, and names an app that is not running', async ({ home, launch }) => {
  test.skip(systemChrome() === undefined, 'No system-wide Chrome or Edge is installed on this runner, and DesignParity captures the app in the Damocles browser.');
  const stub = await startOpenAIStub();
  const site = await startContactsApp();
  // Held for the whole test, so no other worker's listener can take the port.
  const stopped = await startRefusingPort();
  try {
    const url = `${site.url}/contacts.html`;
    // 640: two checks fail, 10/12; 1280: one fails, 11/12. The judge's own score of 12 is never shown.
    stub.subCallReplies.set(JUDGE_TOOL, [
      verdict(['layout.column_count_match', 'color.accent_color_match']),
      verdict(['components.icon_motif_match']),
    ]);
    const parent = await linkedParent(launch, home, stub, { input: ['text', 'image'], browser: true }, [
      call('DesignParity', { screen: SCREEN_FILE, url: `${stopped.url}/contacts.html`, widths: [640, 1280] }),
      call('DesignParity', { screen: SCREEN_FILE, url, widths: [640, 1280] }),
      { chunks: ['Parity scored at sm and xl.'] },
    ]);
    await expect(parent.getByText('Parity scored at sm and xl.')).toBeVisible();
    await expect(parityCard(parent)).toHaveCount(2);

    // R11: the refusal names the app's address and says to start it; the judge never ran for it.
    const refused = parityCard(parent).first();
    await expect(refused.getByTestId('design-parity-error')).toHaveText(`The app at ${stopped.url} did not load (net::ERR_CONNECTION_RESET). Start the app or check the address, then call DesignParity again.`);
    await expect(refused.getByTestId('design-parity-table')).toHaveCount(0);

    const card = parityCard(parent).last();
    const rows = card.getByTestId('design-parity-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('th')).toHaveText(['sm · 640 px, 2 failed checks', 'xl · 1280 px, 1 failed check']);
    await expect(card.locator('[data-testid="design-parity-score"] [aria-hidden="true"]')).toHaveText(['10/12', '11/12']);
    await expect(card.getByTestId('design-parity-status')).toHaveText(['Needs iteration', 'Needs review']);
    await expect(card.getByTestId('design-parity-weakest')).toContainText('10/12');

    // Each judge sub-call carried its width's two captures, design then app: the very images the result gives the chat in that
    // order, which the card captions below.
    const judged = stub.requests.filter((request) => isSubCall(request) && JSON.stringify(request.body).includes(JUDGE_TOOL));
    expect(judged).toHaveLength(2);
    const [sm, xl] = judged.map(pngsOf);
    expect(sm).toHaveLength(2);
    expect(xl).toHaveLength(2);
    expect(new Set([...sm!, ...xl!]).size).toBe(4);
    const scored = agentRequests(stub).filter((request) => JSON.stringify(request.body).includes(`DesignParity of S1 against ${url}`)).at(-1)!;
    expect(pngsOf(scored).slice(-4)).toEqual([...sm!, ...xl!]);

    // Four images, captioned in result order.
    await expect(card.getByTestId('tool-result-image-caption')).toHaveText(['sm · 640 px · design', 'sm · 640 px · app', 'xl · 1280 px · design', 'xl · 1280 px · app'], { timeout: 30_000 });

    // The keyboard opens a width's failed checks; the reason is the judge's text.
    const toggle = rows.first().getByRole('button');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.focus();
    await parent.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const failed = card.getByTestId('design-parity-failed').first();
    await expect(failed.getByTestId('design-parity-check-label')).toHaveText(['Column count', 'Accent color']);
    await expect(failed.getByTestId('design-parity-check-reason')).toHaveText(['Judge: layout.column_count_match differs.', 'Judge: color.accent_color_match differs.']);
    await expectNoAxeViolations(parent, '[data-testid="design-parity-card"]');

    await parent.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(failed).toBeHidden();
    await expect(card.getByTestId('design-parity-check')).toHaveCount(0);
  } finally {
    await stopped.close();
    await site.close();
    await stub.close();
  }
});

test('DesignParity refuses without the browser setting and names it', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  const site = await startContactsApp();
  try {
    const parent = await linkedParent(launch, home, stub, { input: ['text', 'image'], browser: false }, [
      call('DesignParity', { screen: SCREEN_FILE, url: `${site.url}/contacts.html`, widths: [640, 1280] }),
      { chunks: ['The browser is off.'] },
    ]);
    const card = parityCard(parent);
    await expect(card.getByTestId('design-parity-error')).toHaveText('DesignParity captures the app with the Damocles browser, which is off. Turn on the browser in Settings, then call DesignParity again.');
    await expect(card.getByTestId('design-parity-table')).toHaveCount(0);
    expect(stub.requests.some((request) => isSubCall(request) && JSON.stringify(request.body).includes(JUDGE_TOOL))).toBe(false);
    await expectNoAxeViolations(parent, '[data-testid="design-parity-card"]');
  } finally {
    await site.close();
    await stub.close();
  }
});

test('DesignParity refuses when the background model reads no images, with no fallback', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  const site = await startContactsApp();
  try {
    const parent = await linkedParent(launch, home, stub, { input: ['text'], browser: true }, [
      call('DesignParity', { screen: SCREEN_FILE, url: `${site.url}/contacts.html`, widths: [640, 1280] }),
      { chunks: ['The judge cannot see.'] },
    ]);
    await expect(parityCard(parent).getByTestId('design-parity-error')).toHaveText('The background model cannot read images. Choose one that can in Settings, Background.');
    expect(stub.requests.some((request) => isSubCall(request) && JSON.stringify(request.body).includes(JUDGE_TOOL))).toBe(false);
  } finally {
    await site.close();
    await stub.close();
  }
});
