import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, selectChatPage, test } from './support/fixtures';
import { expectNoAxeViolations } from './support/axe';
import { DESIGN_APP, designTabs, grounding, startDesignChat, type Fidelity } from './support/design';
import { seedStubModel, REPO_ROOT, type HermeticHome } from './support/hermetic';
import { agentRequests, call, startOpenAIStub, type OpenAIStub, type StubReply } from './support/openai-stub';
import { openProjectChat, setPageSize } from './support/screenshots';
import { shellPage } from './support/shell';
import { awaitTurnEnd, chatInput } from './support/ui';

// The designer screenshots its screen at every checked width, DesignCheck runs there with the overflow sweep and the hints
// of the skills it loaded, FinishDesign refuses while a width fails, a layout question shows its variants as thumbnails
// that open live, and the preview's Screenshot lands in the design chat's composer with its origin marker.

test.describe.configure({ timeout: 300_000 });

// The design files the scripted designer writes; apart from the app, which every design spec copies whole into its project.
const DESIGN_FILES = path.join(REPO_ROOT, 'e2e', 'fixtures', 'design-checks');
const VARIANTS = path.join(DESIGN_FILES, 'variants');
const SCREENS = path.join(DESIGN_FILES, 'screens');

// One width per band on the fixture's Tailwind breakpoints: base 390, then sm 640 to 2xl 1536.
const DESIGN_MD = ['---', 'app: Laravel 11, Inertia, Vue 3, Tailwind 4', 'viewports:', '  primary: xl', '  checked: [base, sm, md, lg, xl, 2xl]', '  journey: []', '---', '# Contacts', ''].join('\n');
const WIDTHS = ['base · 390 px', 'sm · 640 px', 'md · 768 px', 'lg · 1024 px', 'xl · 1280 px', '2xl · 1536 px'];

const fixtureFile = (dir: string, ...parts: string[]): string => fs.readFileSync(path.join(dir, ...parts), 'utf8');

/** A design chat on the fixture app whose fidelity answer is `fidelity` and whose designer then grounds itself and runs `script(folder)`. */
async function designChat(home: HermeticHome, stub: OpenAIStub, app: ElectronApplication, fidelity: Fidelity, script: (folder: string) => StubReply[]): Promise<{ design: Page; folder: string }> {
  const parent = await openProjectChat(app, home.project);
  return startDesignChat(app, parent, stub, home, { fidelity, script: (folder) => [...grounding(folder, DESIGN_MD), ...script(folder)] });
}

async function launchDesign(home: HermeticHome, launch: () => Promise<{ app: ElectronApplication }>, stub: OpenAIStub): Promise<ElectronApplication> {
  // An image-reading model, so DesignScreenshot answers with images rather than the text outline.
  seedStubModel(home, stub.baseUrl, ['text', 'image']);
  fs.cpSync(DESIGN_APP, home.project, { recursive: true });
  return (await launch()).app;
}

test('DesignScreenshot shows every checked width, and a width check plus a loaded skill\'s hint keep FinishDesign refused', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    const app = await launchDesign(home, launch, stub);
    // Interactive, so the screen's own script runs in the capture.
    const { design } = await designChat(home, stub, app, 'Interactive prototype', (folder) => [
      call('write', { path: path.join(folder, 'screens', 'S1-contacts.html'), content: fixtureFile(SCREENS, 'S1-overflow.html') }),
      call('DesignScreenshot', { screens: ['screens/S1-contacts.html'] }),
      call('LoadDesignSkill', { names: ['accessibility-states'] }),
      call('DesignCheck', {}),
      call('FinishDesign', { summary: 'The contacts list page.' }),
      { chunks: ['The table overflows on phones; fixing it next.'] },
    ]);
    // Tall enough that the virtualized transcript keeps every card of the run mounted.
    await setPageSize(design, 900, 6000);
    await expect.poll(() => stub.replies.length, { timeout: 90_000 }).toBe(0);
    await awaitTurnEnd(design);

    // Six screenshots, base to 2xl, each labelled with its width and none longer than 1950 px on a side.
    const shots = design.locator('[data-testid="design-tool-card"][data-tool="DesignScreenshot"]');
    await expect(shots).toContainText('Screenshot');
    await expect(shots.getByTestId('tool-result-image-caption')).toHaveText(WIDTHS, { timeout: 30_000 });
    const sizes = await shots.locator('[data-testid="tool-result-image"] img').evaluateAll((images) => images.map((image) => {
      const img = image as HTMLImageElement;
      return Math.max(img.naturalWidth, img.naturalHeight);
    }));
    expect(sizes).toHaveLength(6);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(1950);
    // The band the screen's script draws across its top 120 CSS px is in the base capture, in --color-danger.
    const band = await shots.locator('[data-testid="tool-result-image"] img').first().evaluate((image) => {
      const img = image as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(img, 0, 0);
      const scale = img.naturalWidth / 390;
      return [...context.getImageData(Math.round(20 * scale), Math.round(60 * scale), 1, 1).data.slice(0, 3)];
    });
    // #dc2626, within PNG and color-profile rounding.
    const [red, green, blue] = band as [number, number, number];
    expect(Math.abs(red - 220) + Math.abs(green - 38) + Math.abs(blue - 38)).toBeLessThanOrEqual(12);

    const skill = design.locator('[data-testid="design-tool-card"][data-tool="LoadDesignSkill"]');
    await expect(skill.getByTestId('design-loaded-skill')).toContainText('accessibility-states');

    // The 812 px table plus 32 px of padding overflows at base, sm and md and fits from lg up; the unlabeled input quotes the skill's hint.
    const check = design.locator('[data-testid="design-tool-card"][data-tool="DesignCheck"]');
    const errors = check.getByTestId('design-check-errors');
    const overflows = errors.locator('[data-testid="design-check-issue"][data-rule="layout.overflow"]');
    await expect(overflows.getByTestId('design-check-issue-width')).toHaveText(['base · 390 px', 'sm · 640 px', 'md · 768 px']);
    const overflow = overflows.first();
    await expect(overflow).toContainText('390');
    // The screen's script builds that table, so the probe saw the page after its script ran.
    await expect(overflow).toContainText('<div data-ds-component="Table">');
    const label = errors.getByTestId('design-check-issue').filter({ hasText: 'a11y.input-label' });
    await expect(label.getByTestId('design-check-issue-hint')).toContainText('accessibility-states');
    await expect(label.getByTestId('design-check-issue-hint').locator('q')).toHaveText(/^Associate a label with every input/);
    await expect(check).toContainText(/plus \d+ skill hints?, at 6 widths\. No model call\./);

    const refused = design.getByTestId('finish-design-card').filter({ hasText: 'Finish refused' });
    await expect(refused).toHaveCount(1);
    await expect(refused).toContainText('layout.overflow');

    for (const selector of ['[data-testid="design-tool-card"][data-tool="DesignScreenshot"]', '[data-testid="design-tool-card"][data-tool="LoadDesignSkill"]', '[data-testid="design-tool-card"][data-tool="DesignCheck"]']) {
      await expectNoAxeViolations(design, selector);
    }
  } finally {
    await stub.close();
  }
});

test('a layout question shows each variant as a thumbnail that opens live, and the preview\'s Screenshot joins the composer marked', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    const app = await launchDesign(home, launch, stub);
    const variant = (key: string, label: string, description: string) => ({ label, description, preview: { kind: 'design', path: `variants/${key}/screens/S1.html` } });
    const { design, folder } = await designChat(home, stub, app, 'Static mockup', (designDir) => [
      call('write', { path: path.join(designDir, 'screens', 'S1-contacts.html'), content: fixtureFile(SCREENS, 'S1-contacts.html') }),
      ...['a', 'b', 'c'].map((key) => call('write', { path: path.join(designDir, 'variants', key, 'screens', 'S1.html'), content: fixtureFile(VARIANTS, key, 'screens', 'S1.html') })),
      call('AskUserQuestion', { questions: [{ header: 'Layout', question: 'Which layout should the contacts page use?', multiSelect: false, options: [
        variant('a', 'Table', 'Dense rows with sortable columns'),
        variant('b', 'Cards', 'One card per contact'),
        variant('c', 'Split', 'A list beside the selected contact'),
      ] }] }),
      { chunks: ['Going with the cards.'] },
    ]);

    // Three thumbnails, each rendered at the primary width by the app, side by side.
    const question = design.getByRole('region', { name: 'Question prompt' });
    await expect(question).toContainText('Which layout should the contacts page use?');
    await expect(question.getByRole('radiogroup', { name: 'Which layout should the contacts page use?' })).toBeVisible();
    await expect(question.getByTestId('question-design-image')).toHaveCount(3, { timeout: 60_000 });
    await expect(question.getByTestId('question-design-file')).toHaveText(['variants/a/screens/S1.html', 'variants/b/screens/S1.html', 'variants/c/screens/S1.html']);
    // Each thumbnail is its own variant's render: their decoded pixels differ.
    const pixelHashes = await question.getByTestId('question-design-image').evaluateAll((images) => Promise.all(images.map(async (image) => {
      const img = image as HTMLImageElement;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(img, 0, 0);
      let hash = 0x811c9dc5;
      for (const byte of context.getImageData(0, 0, canvas.width, canvas.height).data) hash = Math.imul(hash ^ byte, 0x01000193);
      return `${canvas.width}x${canvas.height}:${(hash >>> 0).toString(16)}`;
    })));
    expect(new Set(pixelHashes).size).toBe(3);
    const tops = await question.getByTestId('question-design-option').evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    await expectNoAxeViolations(design, '[data-testid="question-card"]');

    // Open live opens that variant in the design chat's preview tab.
    await question.getByRole('button', { name: 'Open live: Cards' }).click();
    await expect.poll(async () => (await designTabs(app)).some((tab) => tab.designPreview.relPath === 'variants/b/screens/S1.html'), { timeout: 30_000 }).toBe(true);

    // The arrow keys choose among the cards without leaving the question; Review answers then Submit answers it.
    await question.getByRole('radio', { name: 'Table' }).click();
    // Held as a person holds it: the radio checks on the focus the key moved while the key is still down.
    await design.keyboard.down('ArrowRight');
    await expect(question.getByRole('radio', { name: 'Cards' })).toHaveAttribute('aria-checked', 'true');
    await design.keyboard.up('ArrowRight');
    await question.getByRole('button', { name: 'Review answers' }).click();
    // The tab strip has a Submit too, so the footer's is clicked only once the review shows it.
    await expect(question).toContainText('Review your answers');
    await question.getByRole('button', { name: 'Submit', exact: true }).last().click();
    await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(0);
    await awaitTurnEnd(design);

    // Screenshot: the frame flashes and the image lands in the design chat's composer, marked as the preview's.
    await selectChatPage(app, design);
    const shell = await shellPage(app);
    await shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]', { hasText: 'S1' }).last().click();
    await expect(shell.getByTestId('design-preview-status')).toHaveCount(0, { timeout: 30_000 });
    await shell.getByTestId('design-preview-screenshot').click();
    await expect(shell.getByTestId('design-preview-flash')).toHaveCount(1);
    await expect(shell.getByTestId('design-preview-screenshot-status')).toHaveText('Screenshot added to the design chat.');
    const attachment = design.getByTestId('composer-image-attachment');
    await expect(attachment).toHaveCount(1);
    await expect(attachment).toHaveAttribute('data-origin', 'designPreview');
    await expectNoAxeViolations(shell, '[data-testid="design-preview-view-toolbar"]');

    // It goes to the designer as an image, and nothing saves it as a reference.
    const before = agentRequests(stub).length;
    stub.replies.push({ chunks: ['Tightening the card spacing.'] });
    await chatInput(design).fill('Tighten this spacing');
    await chatInput(design).press('Enter');
    await awaitTurnEnd(design);
    await expect.poll(() => agentRequests(stub).length).toBeGreaterThan(before);
    expect(JSON.stringify(agentRequests(stub).at(-1)!.body)).toContain('data:image/png;base64,');
    expect(fs.existsSync(path.join(folder, 'references'))).toBe(false);
  } finally {
    await stub.close();
  }
});

test('a screen that prints as it loads renders through DesignScreenshot and the preview while the app stays responsive', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    const app = await launchDesign(home, launch, stub);
    const { design } = await designChat(home, stub, app, 'Interactive prototype', (folder) => [
      call('write', { path: path.join(folder, 'screens', 'S2-print.html'), content: fixtureFile(SCREENS, 'S2-print.html') }),
      call('DesignScreenshot', { screens: ['screens/S2-print.html'] }),
      { chunks: ['Captured the print screen.'] },
    ]);
    await setPageSize(design, 900, 6000);
    await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(0);
    await awaitTurnEnd(design);
    // Six captures of a page that called print() and execCommand('print').
    const shots = design.locator('[data-testid="design-tool-card"][data-tool="DesignScreenshot"]');
    await expect(shots.getByTestId('tool-result-image-caption')).toHaveText(WIDTHS, { timeout: 30_000 });

    // The preview tab shows the same screen, and main still answers the shell: a preset changes the width the view lays out at.
    await selectChatPage(app, design);
    const shell = await shellPage(app);
    await expect(shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]', { hasText: 'S2' })).toHaveCount(1);
    await expect(shell.getByTestId('design-preview-status')).toHaveCount(0, { timeout: 30_000 });
    await shell.locator('[data-testid="design-preview-preset"][data-preset="sm"]').click();
    await expect(shell.getByTestId('design-preview-readout')).toHaveText(/^sm · 640 px · /);
    await expect.poll(async () => (await designTabs(app))[0]?.designPreview.width, { timeout: 10_000 }).toBe(640);
    expect(await app.evaluate(() => 'main answers')).toBe('main answers');
  } finally {
    await stub.close();
  }
});

/** Each image of a DesignScreenshot card: its device size, and its colour at CSS px points of a `cssWidth` frame. */
async function cardImages(card: Locator, cssWidth: number, points: readonly (readonly [number, number])[] = []): Promise<{ width: number; height: number; colors: number[][] }[]> {
  return card.locator('[data-testid="tool-result-image"] img').evaluateAll(async (images, [width, at]) => Promise.all(images.map(async (image) => {
    const img = image as HTMLImageElement;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(img, 0, 0);
    const scale = img.naturalWidth / (width as number);
    const colors = (at as [number, number][]).map(([x, y]) => [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)]);
    return { width: img.naturalWidth, height: img.naturalHeight, colors };
  })), [cssWidth, points] as const);
}

/** A JPEG's width from its first start-of-frame segment. */
function jpegWidth(bytes: Buffer): number | undefined {
  for (let at = 2; at + 9 <= bytes.length;) {
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return bytes.readUInt16BE(at + 7);
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return undefined;
}

/** Whether `color` is within JPEG rounding of `hex`. */
const near = (color: number[], hex: string): boolean => {
  const want = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return want.reduce((sum, value, index) => sum + Math.abs(value - color[index]!), 0) <= 30;
};

test('DesignScreenshot renders settled, media-pinned JPEG frames of any state, variant, region or interaction', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    const app = await launchDesign(home, launch, stub);
    const fixture = (name: string): string => fixtureFile(SCREENS, name);
    const shoot = (args: Record<string, unknown>): StubReply => call('DesignScreenshot', args);
    // Interactive, so the screens' own scripts run in the captures.
    const { design } = await designChat(home, stub, app, 'Interactive prototype', (folder) => [
      call('ImportAsset', { path: 'resources/fonts/inter-var.woff2' }),
      call('write', { path: path.join(folder, 'screens', 'S3-motion.html'), content: fixture('S3-motion.html') }),
      call('write', { path: path.join(folder, 'screens', 'S4-long.html'), content: fixture('S4-long.html') }),
      call('write', { path: path.join(folder, 'screens', 'S5-carousel.html'), content: fixture('S5-carousel.html') }),
      call('write', { path: path.join(folder, 'variants', 'accent', 'a.html'), content: fixtureFile(VARIANTS, 'accent', 'a.html') }),
      shoot({ screens: ['screens/S3-motion.html'], widths: [1440] }),
      shoot({ screens: ['screens/S3-motion.html'], widths: [390], media: { colorScheme: 'dark' } }),
      shoot({ screens: ['screens/S3-motion.html'], widths: [390], media: { forcedColors: 'active' } }),
      shoot({ screens: ['screens/S4-long.html'], widths: [390], fullPage: true }),
      shoot({ screens: ['screens/S4-long.html'], widths: [390], selector: '#tasks' }),
      shoot({ screens: ['screens/S4-long.html'], widths: [390], steps: [{ action: 'click', target: { role: 'button', name: 'More' } }] }),
      shoot({ screens: ['screens/S5-carousel.html'], widths: [390] }),
      shoot({ screens: ['variants/accent/a.html'], state: 'empty', widths: [390] }),
      { chunks: ['Every capture is in.'] },
    ]);
    await setPageSize(design, 900, 9000);
    await expect.poll(() => stub.replies.length, { timeout: 180_000 }).toBe(0);
    await awaitTurnEnd(design);
    const cards = design.locator('[data-testid="design-tool-card"][data-tool="DesignScreenshot"]');
    await expect(cards).toHaveCount(8, { timeout: 30_000 });
    for (const [index, count] of [1, 1, 1, 4, 1, 1, 1, 1].entries()) await expect(cards.nth(index).locator('[data-testid="tool-result-image"] img')).toHaveCount(count, { timeout: 30_000 });

    // The default look at 1440 px: a JPEG within 1568 px and 400 KB, the 2 s fade finished, the font drawn, the 2 s count-up ended, and light.
    const [main] = await cardImages(cards.nth(0), 1440, [[150, 150], [350, 150], [200, 370], [200, 540]]);
    expect(Math.max(main!.width, main!.height)).toBeLessThanOrEqual(1568);
    // the bytes the model got: the one image of a 1440 px frame is a JPEG of the same size, under 400 KB
    const sentImages = [...JSON.stringify(agentRequests(stub).at(-1)!.body).matchAll(/data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)/g)].map(([, type, data]) => ({ type, bytes: Buffer.from(data!, 'base64') }));
    const wide = sentImages.filter(({ bytes }) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.length > 0).find(({ bytes }) => jpegWidth(bytes) === main!.width);
    expect(wide?.type).toBe('image/jpeg');
    expect(wide!.bytes.length).toBeLessThan(400 * 1024);
    expect(sentImages.every(({ type }) => type === 'image/jpeg')).toBe(true);
    // the page is 700 CSS px tall, so its one frame is too
    expect(Math.abs((main!.height / main!.width) * 1440 - 700)).toBeLessThanOrEqual(2);
    const [glyph, fade, counted, theme] = main!.colors;
    expect(near(glyph!, '#dc2626'), `glyph ${glyph}`).toBe(true);
    expect(near(fade!, '#16a34a'), `fade ${fade}`).toBe(true);
    expect(near(counted!, '#2563eb'), `count-up ${counted}`).toBe(true);
    expect(near(theme!, '#facc15'), `light ${theme}`).toBe(true);

    // colorScheme dark renders the dark theme; forced colors replace the author's background with the system's.
    const [dark] = await cardImages(cards.nth(1), 390, [[200, 540]]);
    expect(near(dark!.colors[0]!, '#1e1b4b'), `dark ${dark!.colors[0]}`).toBe(true);
    const [forced] = await cardImages(cards.nth(2), 390, [[200, 540]]);
    expect(near(forced!.colors[0]!, '#facc15'), `forced ${forced!.colors[0]}`).toBe(false);

    // fullPage: a 3000 px page in four frames, the fourth rows 2700 to 3000.
    const frames = await cardImages(cards.nth(3), 390);
    // within the device px rounding of a scaled frame
    const cssHeights = frames.map((frame) => (frame.height / frame.width) * 390);
    expect(cssHeights.map((height, index) => Math.abs(height - [900, 900, 900, 300][index]!) <= 2), cssHeights.join()).toEqual([true, true, true, true]);
    // selector: the task cards' box, 358 × 332 CSS px (300 and the padding), in their colour.
    const [tasks] = await cardImages(cards.nth(4), 358, [[179, 150]]);
    expect(Math.abs((tasks!.height / tasks!.width) * 358 - 332)).toBeLessThanOrEqual(2);
    expect(near(tasks!.colors[0]!, '#0f766e'), `tasks ${tasks!.colors[0]}`).toBe(true);
    // steps: the menu "More" opened, still open in the capture.
    const [menu] = await cardImages(cards.nth(5), 390, [[290, 140]]);
    expect(near(menu!.colors[0]!, '#c026d3'), `menu ${menu!.colors[0]}`).toBe(true);
    // a variant in its empty state.
    const [variant] = await cardImages(cards.nth(7), 390, [[100, 100]]);
    expect(near(variant!.colors[0]!, '#ea580c'), `variant ${variant!.colors[0]}`).toBe(true);

    // The endless carousel is captured with the note that it never held still.
    const sent = JSON.stringify(agentRequests(stub).at(-1)!.body);
    expect(sent).toContain('screens/S5-carousel.html at 390 px never became still within 5 s (an endless animation, a carousel or a timer); the image shows one moment of it.');
    expect(sent).toContain('data:image/jpeg;base64,');
  } finally {
    await stub.close();
  }
});
