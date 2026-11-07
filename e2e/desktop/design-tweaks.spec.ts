import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, selectChatPage, test } from './support/fixtures';
import { expectNoAxeViolations } from './support/axe';
import { DESIGN_APP, designViews, grounding, inShownDesignView, startDesignChat } from './support/design';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { agentRequests, call, lastToolResult, lastToolResultRequest, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { openProjectChat, setPageSize } from './support/screenshots';
import { shellPage } from './support/shell';
import { awaitTurnEnd, chatInput } from './support/ui';

// The user tries the designer's declared tweaks on the live preview (token stops only, no file change),
// keeps one, which becomes a decision only through the designer's RecordDecision and then shows locked; and an image the user
// pastes into the design chat is saved by core as references/R1.png, which the designer maps onto the app.

test.describe.configure({ timeout: 300_000 });

// The app's own radius and accent tokens beside app.css's scale, so a control's property is a token as its stops are.
const THEME_CSS = ['@theme {', '  --radius: 0.375rem;', '  --color-accent: #2563eb;', '  --color-accent-violet: #7c5cff;', '}', ''].join('\n');

const DESIGN_MD = ['---', 'app: Laravel 11, Inertia, Vue 3, Tailwind 4', 'viewports:', '  primary: xl', '  checked: [xl]', '  journey: []', '---', '# Contacts', ''].join('\n');

const SCREEN = [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default">',
  '<head><meta charset="utf-8"><title>Contacts</title>',
  '<link rel="stylesheet" href="../tokens.css">',
  '<style>body{margin:0;font:16px sans-serif}main{padding:40px}#add{padding:8px 16px;border:0;border-radius:var(--radius);background:var(--color-accent);color:#fff}</style></head>',
  '<body><main>',
  '<h1>Contacts</h1>',
  '<button id="add" data-ds-component="ui/Button" data-ds-decision="D1">Add contact</button>',
  '</main></body></html>',
  '',
].join('\n');

const TWEAKS = {
  controls: [
    { id: 'radius', label: 'Corner radius', property: '--radius', stops: ['--radius-sm', '--radius-md', '--radius-lg'] },
    { id: 'accent', label: 'Accent', property: '--color-accent', stops: ['--color-primary', '--color-accent-violet'] },
  ],
};

// A 1 × 1 PNG, pasted from outside Damocles.
const OUTSIDE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Every file below the design folder and its bytes, as a sorted listing. */
function folderSnapshot(folder: string): string[] {
  return (fs.readdirSync(folder, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return `${path.relative(folder, file)}:${fs.readFileSync(file).toString('base64')}`;
    })
    .sort();
}

/**
 * A design chat on the fixture app whose designer wrote the contacts screen and declared two tweaks, the first time with a
 * stop that is no token; its preview tab is selected. Resolves the tool result the refused declaration got.
 */
async function designWithTweaks(home: HermeticHome, stub: OpenAIStub, app: ElectronApplication): Promise<{ design: Page; folder: string; refusal: string }> {
  const parent = await openProjectChat(app, home.project);
  let releaseSecond!: () => void;
  const refusalRead = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const { design, folder } = await startDesignChat(app, parent, stub, home, {
    fidelity: 'Static mockup',
    script: (designDir) => [
      ...grounding(designDir, DESIGN_MD, ['resources/css/app.css', 'resources/css/theme.css']),
      call('write', { path: path.join(designDir, 'screens', 'S1-contacts.html'), content: SCREEN }),
      // A stop that is not a token is refused; the declaration that follows holds tokens only.
      call('DeclareTweaks', { controls: [TWEAKS.controls[0], { ...TWEAKS.controls[1], stops: ['--color-primary', '#ff00ff'] }] }),
      // Served for the request that carries the refusal, and held until the test has read it there.
      { ...call('DeclareTweaks', TWEAKS), holdAfterFirst: refusalRead },
      { chunks: ['Drafted the screen. Try the radius and the accent.'] },
    ],
  });
  await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(1);
  const refusal = lastToolResult(stub);
  releaseSecond();
  await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(0);
  await awaitTurnEnd(design);
  await selectChatPage(app, design);
  await setPageSize(design, 900, 6000);
  return { design, folder, refusal };
}

/** The shown design view's `#add` computed corner radius, in CSS px. */
const buttonRadius = (app: ElectronApplication): Promise<string> => inShownDesignView(app, 'getComputedStyle(document.getElementById("add")).borderTopLeftRadius');

/** The shown design view's bounds, in window DIPs. */
async function viewBounds(app: ElectronApplication): Promise<{ x: number; y: number; width: number; height: number }> {
  const [view] = (await designViews(app)).filter((candidate) => candidate.visible);
  if (!view) throw new Error('no design view is shown');
  return view.bounds;
}

test('tweaks: token stops restyle the live preview with no file change, Reset clears them, Keep asks the designer, whose decision locks the control', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl, ['text', 'image']);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    fs.writeFileSync(path.join(home.project, 'resources', 'css', 'theme.css'), THEME_CSS);
    const { app } = await launch();
    const { design, folder, refusal } = await designWithTweaks(home, stub, app);
    const shell = await shellPage(app);
    await expect(shell.getByTestId('design-preview-status')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => buttonRadius(app).catch(() => 'hidden'), { timeout: 30_000 }).toBe('6px');

    // The refused declaration failed, declaring nothing, with its stop named; the next card lists the declaration.
    const stopRefusal = '"accent": the stop "#ff00ff" is not a token in tokens.css. Stops are existing tokens only.';
    expect(refusal).toBe(`DeclareTweaks declared nothing:\n${stopRefusal}`);
    const cards = design.locator('[data-testid="design-tool-card"][data-tool="DeclareTweaks"]');
    await expect(cards).toHaveCount(2);
    await expect(cards.first().getByTestId('design-declared-tweak')).toHaveCount(0);
    await expect(cards.first()).toContainText(stopRefusal);
    await expect(cards.last().getByTestId('design-declared-tweak')).toHaveCount(2);

    // The column opens beside the frame: the native view shrinks to stay clear of it.
    const toggle = shell.getByTestId('design-preview-tweaks');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await toggle.click();
    const panel = shell.getByTestId('design-tweaks');
    await expect(panel).toBeVisible();
    // The view and the column share no pixel: beside it in a wide pane, above it in a narrow one (shell CSS px are window DIPs here).
    // Both sides are read on every try, since the column may still be sliding in.
    await expect.poll(async () => {
      const view = await viewBounds(app);
      const column = await panel.boundingBox();
      if (!column) return 'no column';
      const across = Math.min(view.x + view.width, column.x + column.width) - Math.max(view.x, column.x);
      const down = Math.min(view.y + view.height, column.y + column.height) - Math.max(view.y, column.y);
      return across <= 1 || down <= 1 ? 'clear' : JSON.stringify({ view, column });
    }, { timeout: 10_000 }).toBe('clear');
    await expect(panel.getByTestId('design-tweak')).toHaveCount(2);
    await expect(panel.locator('[data-tweak="radius"] [data-testid="design-tweak-stop"]')).toHaveText(['sm', 'md', 'lg']);
    await expect(panel.locator('[data-tweak="accent"] [data-testid="design-tweak-stops"]')).toHaveAttribute('data-kind', 'swatch');
    await expectNoAxeViolations(shell, '[data-testid="design-tweaks"]');

    // A stop restyles the live page through main's user sheet; no design file changes.
    const files = folderSnapshot(folder);
    await panel.getByRole('button', { name: 'Corner radius: lg, 0.5rem' }).click();
    await expect.poll(() => buttonRadius(app), { timeout: 10_000 }).toBe('8px');
    await expect(shell.getByTestId('design-preview-tweaks-count')).toContainText('1');
    await expect(shell.getByTestId('design-preview-markup')).toBeDisabled();
    expect(folderSnapshot(folder)).toEqual(files);

    // Reset removes every tweak.
    await panel.getByTestId('design-tweaks-reset').click();
    await expect.poll(() => buttonRadius(app), { timeout: 10_000 }).toBe('6px');
    await expect(shell.getByTestId('design-preview-tweaks-count')).toHaveCount(0);
    expect(folderSnapshot(folder)).toEqual(files);

    // Keep sends the user prompt; the designer's RecordDecision with another value is refused, with the kept value accepted.
    await panel.getByRole('button', { name: 'Corner radius: lg, 0.5rem' }).click();
    await expect.poll(() => buttonRadius(app), { timeout: 10_000 }).toBe('8px');
    stub.replies.push(
      call('RecordDecision', { title: 'Corner radius', chosen: '--radius-sm', source: { kind: 'tweak', ref: 'radius' } }),
      call('RecordDecision', { title: 'Corner radius', chosen: '--radius-lg', source: { kind: 'tweak', ref: 'radius' } }),
      { chunks: ['Recorded the radius.'] },
    );
    const requests = agentRequests(stub).length;
    await panel.getByTestId('design-tweaks-keep').click();
    await expect(shell.getByTestId('design-markup-announcement')).toHaveText('Sent to the designer: Corner radius → --radius-lg');
    await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(0);
    await awaitTurnEnd(design);
    expect(JSON.stringify(agentRequests(stub)[requests]!.body)).toContain('Keep: Corner radius → --radius-lg');
    await expect(design.getByText('Keep: Corner radius → --radius-lg', { exact: true })).toHaveCount(1);
    expect(lastToolResultRequest(stub)).toContain('The user kept --radius-lg for Corner radius');
    const decisions = design.getByTestId('design-decisions');
    await expect(decisions.locator('[data-decision-id="D2"]')).toContainText('--radius-lg');
    await expect(decisions.locator('[data-decision-id="D3"]')).toHaveCount(0);
    await expect(design.locator('[data-testid="design-recorded-decisions"]').last()).toContainText('From tweak radius');

    // The decision locks the control in the column: a lock and D2, nothing changeable.
    const radius = panel.locator('[data-testid="design-tweak"][data-tweak="radius"]');
    await expect(radius).toHaveAttribute('data-locked', 'true', { timeout: 30_000 });
    await expect(radius.getByTestId('design-tweak-lock')).toContainText('D2');
    await expect(radius.locator('[data-testid="design-tweak-stop"][data-token="--radius-lg"]')).toHaveAttribute('aria-pressed', 'true');
    for (const stop of await radius.getByTestId('design-tweak-stop').all()) await expect(stop).toBeDisabled();
    await expectNoAxeViolations(shell, '[data-testid="design-preview-tab"]');
    expect(fs.readFileSync(path.join(folder, 'screens', 'S1-contacts.html'), 'utf8')).toBe(SCREEN);
  } finally {
    await stub.close();
  }
});

test('references: an image pasted into the design chat is saved by core as references/R1.png, shown on the message, and mapped onto the app', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl, ['text', 'image']);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    fs.writeFileSync(path.join(home.project, 'resources', 'css', 'theme.css'), THEME_CSS);
    const { app } = await launch();
    const { design, folder } = await designWithTweaks(home, stub, app);

    // Paste an image from outside Damocles and send it.
    await chatInput(design).focus();
    await chatInput(design).evaluate((input, data) => {
      const png = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([png], 'liked-product.png', { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, OUTSIDE_PNG);
    await expect(design.getByTestId('composer').getByRole('img')).toHaveCount(1);
    // A row naming a component the inventory lacks is refused; the mapping that follows is written into R1.json.
    stub.replies.push(
      call('MapReference', { reference: 'R1', rows: [{ element: 'Carousel', mapsTo: 'Carousel', status: 'mapped' }] }),
      call('MapReference', { reference: 'R1', rows: [
        { element: 'Primary button', mapsTo: 'Button', status: 'mapped' },
        { element: 'Corner radius', mapsTo: '--radius-lg', status: 'mapped' },
        { element: 'Avatar stack', status: 'needsDecision' },
        { element: 'Ad banner', status: 'out' },
      ] }),
      { chunks: ['Mapped R1. The avatar stack needs a decision.'] },
    );
    await chatInput(design).fill('Make it feel like this');
    await chatInput(design).press('Enter');
    await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(0);
    await awaitTurnEnd(design);

    const png = path.join(folder, 'references', 'R1.png');
    const json = path.join(folder, 'references', 'R1.json');
    await expect.poll(() => fs.existsSync(png) && fs.existsSync(json), { timeout: 30_000 }).toBe(true);
    expect(fs.readFileSync(png).toString('base64')).toBe(OUTSIDE_PNG);
    const record = JSON.parse(fs.readFileSync(json, 'utf8')) as { image: string; mapping?: { element: string; status: string }[] };
    expect(record.image).toBe('references/R1.png');
    expect(record.mapping?.map((row) => `${row.element}:${row.status}`)).toEqual(['Primary button:mapped', 'Corner radius:mapped', 'Avatar stack:needsDecision', 'Ad banner:out']);
    expect(lastToolResultRequest(stub)).toContain('Carousel is not a component in inventory.json');

    // The user message shows the thumbnail and the file core saved.
    const note = design.getByTestId('reference-note');
    await expect(note).toHaveCount(1);
    await expect(note).toHaveAttribute('data-reference', 'R1');
    await expect(note.getByTestId('reference-note-text')).toHaveText('saved by core as references/R1.png');
    await expect(note.getByRole('img', { name: 'Reference image R1' })).toBeVisible();
    await expectNoAxeViolations(design, '[data-testid="reference-note"]');

    // The MapReference card: the refused call failed, the next one is a table of Element, Maps to and Status.
    const mapCards = design.locator('[data-testid="design-tool-card"][data-tool="MapReference"]');
    await expect(mapCards).toHaveCount(2);
    await expect(mapCards.first()).toContainText('Carousel');
    const table = mapCards.last().getByTestId('design-map-reference');
    await expect(table.locator('th')).toHaveText(['Element', 'Maps to', 'Status']);
    await expect(table.getByTestId('design-map-reference-row')).toHaveCount(4);
    await expect(table.locator('[data-testid="design-map-reference-row"][data-status="needsDecision"]')).toContainText('Avatar stack');
    await expectNoAxeViolations(design, '[data-testid="design-map-reference"]');

    // After a reload the note replays from the session.
    await design.reload();
    await expect(chatInput(design)).toBeVisible();
    await setPageSize(design, 900, 6000);
    await expect(design.getByTestId('reference-note')).toHaveCount(1, { timeout: 30_000 });
    await expect(design.getByTestId('reference-note-text')).toHaveText('saved by core as references/R1.png');
  } finally {
    await stub.close();
  }
});
