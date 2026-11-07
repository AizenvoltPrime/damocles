import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, selectChatPage, test } from './support/fixtures';
import { expectNoAxeViolations } from './support/axe';
import { DESIGN_APP, designViews, grounding, inShownDesignView, startDesignChat } from './support/design';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { agentRequests, call, lastToolResult, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { openProjectChat, setPageSize } from './support/screenshots';
import { shellPage } from './support/shell';
import { awaitTurnEnd, chatInput } from './support/ui';
import type { MarkupJson } from '../../src/shared/design-markup';

// The user freezes the preview, pins and boxes elements of the frozen capture, and sends it all to the designer as one
// message, whose files land in feedback/ and whose card replays after a reload; a change pin can become a decision and a
// note pin cannot.

test.describe.configure({ timeout: 300_000 });

const DESIGN_MD = ['---', 'app: Laravel 11, Inertia, Vue 3, Tailwind 4', 'viewports:', '  primary: xl', '  checked: [xl]', '  journey: []', '---', '# Contacts', ''].join('\n');

// The fixture's components by their path below resources/js/components, so a pin on a row names ui/Table.
const SCREEN = [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default">',
  '<head><meta charset="utf-8"><title>Contacts</title>',
  '<style>body{margin:0;font:16px sans-serif}main{padding:40px}button{display:block;margin-bottom:24px;padding:8px 16px}table{width:100%;border-collapse:collapse}td{padding:16px;border-bottom:1px solid #ccc}</style></head>',
  '<body><main>',
  '<h1>Contacts</h1>',
  '<button data-ds-component="ui/Button" data-ds-decision="D1">Add contact</button>',
  '<table data-ds-component="ui/Table"><tbody>',
  '<tr id="row-1"><td>Ada Lovelace</td><td>ada@example.com</td></tr>',
  '<tr id="row-2"><td>Grace Hopper</td><td>grace@example.com</td></tr>',
  '<tr id="row-3"><td>Alan Turing</td><td>alan@example.com</td></tr>',
  '</tbody></table>',
  '</main></body></html>',
  '',
].join('\n');

/** A design chat on the fixture app whose designer wrote the contacts screen; its preview tab is open and selected. */
async function designWithScreen(home: HermeticHome, stub: OpenAIStub, app: ElectronApplication): Promise<{ design: Page; folder: string }> {
  const parent = await openProjectChat(app, home.project);
  const { design, folder } = await startDesignChat(app, parent, stub, home, {
    fidelity: 'Static mockup',
    script: (designDir) => [
      ...grounding(designDir, DESIGN_MD),
      call('write', { path: path.join(designDir, 'screens', 'S1-contacts.html'), content: SCREEN }),
      { chunks: ['Drafted the screen.'] },
    ],
  });
  await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(0);
  await awaitTurnEnd(design);
  await selectChatPage(app, design);
  // Tall enough that the virtualized transcript keeps every row mounted.
  await setPageSize(design, 900, 6000);
  return { design, folder };
}

/** An element's rectangle in the shown design view, in the page's CSS px. */
async function rectInView(app: ElectronApplication, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  return inShownDesignView(app, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
}

/**
 * 'as expected' once the pin's popover lies whole inside the markup layer, 0.5rem beside the pin's resting box and level with
 * its top when a side of the layer holds it, else 0.5rem below or above the pin; else what it found. Polled, since the pin's
 * pop scales it meanwhile.
 */
async function popoverPlacement(shell: Page, pin: Locator): Promise<string> {
  const [layer, pinBox, box] = await Promise.all([shell.getByTestId('design-markup-layer').boundingBox(), pin.boundingBox(), shell.getByTestId('design-markup-popover').boundingBox()]);
  if (!layer || !pinBox || !box) return 'not shown';
  // + 0 turns a rounded -0 into 0
  const px = (value: number): number => Math.round(value) + 0;
  const inside = box.x >= layer.x - 0.5 && box.y >= layer.y - 0.5 && box.x + box.width <= layer.x + layer.width + 0.5 && box.y + box.height <= layer.y + layer.height + 0.5;
  const room = Math.max(layer.x + layer.width - (pinBox.x + pinBox.width), pinBox.x - layer.x);
  const placed = box.x >= pinBox.x + pinBox.width ? `beside ${px(box.x - pinBox.x - pinBox.width)}, top ${px(box.y - pinBox.y)}`
    : box.x + box.width <= pinBox.x ? `beside ${px(pinBox.x - box.x - box.width)}, top ${px(box.y - pinBox.y)}`
      : box.y >= pinBox.y + pinBox.height ? `below ${px(box.y - pinBox.y - pinBox.height)}` : `above ${px(pinBox.y - box.y - box.height)}`;
  // the popover's gap from the pin and from the layer's edge
  const expected = room >= box.width + 16 ? ['beside 8, top 0'] : ['below 8', 'above 8'];
  return inside && expected.includes(placed) ? 'as expected' : JSON.stringify({ placed, inside, expected, layer, pin: pinBox, box });
}

const shownDesignViews = async (app: ElectronApplication): Promise<number> => (await designViews(app)).filter((view) => view.visible).length;

test('markup on the frozen preview: a pin on a row anchors to ui/Table, a box lists what it covers, Send makes F1 and one card that replays', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    // An image-reading model, so the markup reaches it as an image.
    seedStubModel(home, stub.baseUrl, ['text', 'image']);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const { design, folder } = await designWithScreen(home, stub, app);
    const shell = await shellPage(app);
    await expect(shell.getByTestId('design-preview-status')).toHaveCount(0, { timeout: 30_000 });
    await expect(shell.getByTestId('design-preview-readout')).toHaveText(/^xl · 1280 px · \d+%$/);

    // At base the frame is narrower than the popover beside a centered pin on either side, so it opens below the pin (or
    // above), whole inside the layer and so inside the window.
    await shell.locator('[data-testid="design-preview-preset"][data-preset="base"]').click();
    await expect(shell.getByTestId('design-preview-readout')).toHaveText(/^base · 390 px · \d+%$/);
    await expect.poll(() => inShownDesignView<number>(app, 'window.innerWidth'), { timeout: 30_000 }).toBe(390);
    await shell.getByTestId('design-preview-markup').click();
    await expect(shell.getByTestId('design-markup-chip')).toHaveText('Frozen at base · 390 · default', { timeout: 30_000 });
    const narrowImage = (await shell.getByTestId('design-markup-image').boundingBox())!;
    await shell.mouse.click(narrowImage.x + narrowImage.width / 2, narrowImage.y + narrowImage.height / 3);
    const narrowPopover = shell.getByTestId('design-markup-popover');
    await expect(narrowPopover).toHaveAttribute('data-side', /^(bottom|top)$/);
    await expect.poll(() => popoverPlacement(shell, shell.getByTestId('design-markup-pin'))).toBe('as expected');
    await expect(narrowPopover.getByTestId('design-markup-done')).toBeInViewport({ ratio: 1 });
    // A capture with no marks left is dropped on Exit, so the xl freeze below captures afresh.
    await narrowPopover.getByTestId('design-markup-delete').click();
    await expect(shell.getByTestId('design-markup-pin')).toHaveCount(0);
    await shell.getByTestId('design-markup-exit').click();
    await expect(shell.getByTestId('design-markup-canvas')).toHaveCount(0);
    await shell.locator('[data-testid="design-preview-preset"][data-preset="xl"]').click();
    await expect(shell.getByTestId('design-preview-readout')).toHaveText(/^xl · 1280 px · \d+%$/);
    await expect.poll(() => inShownDesignView<number>(app, 'window.innerWidth'), { timeout: 30_000 }).toBe(1280);

    // Where the second row and the button are, read from the live page before it freezes.
    await expect.poll(() => rectInView(app, '#row-2').then(() => 'shown').catch(() => 'hidden'), { timeout: 30_000 }).toBe('shown');
    const row = await rectInView(app, '#row-2');
    const button = await rectInView(app, '[data-ds-component="ui/Button"]');
    const table = await rectInView(app, '[data-ds-component="ui/Table"]');
    const firstRow = await rectInView(app, '#row-1');

    // Freeze: the view hides, the capture shows in the frame, and row 2 of the toolbar becomes the markup tools.
    await shell.getByTestId('design-preview-markup').click();
    const canvas = shell.getByTestId('design-markup-canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect(shell.getByTestId('design-markup-chip')).toHaveText('Frozen at xl · 1280 · default');
    await expect(shell.getByTestId('design-markup-send')).toHaveText('Send to designer (0)');
    // Markup's button left with its toolbar row; focus lands on the selected tool once the markup row swapped in.
    const selectedTool = shell.locator('[data-testid="design-markup-tool"][data-state="on"]');
    await expect(selectedTool).toHaveAttribute('data-tool', 'pin');
    await expect(selectedTool).toBeFocused();
    await expect.poll(() => shownDesignViews(app)).toBe(0);
    const image = (await shell.getByTestId('design-markup-image').boundingBox())!;
    const scale = image.width / 1280;
    const onImage = (x: number, y: number): [number, number] => [image.x + x * scale, image.y + y * scale];

    // A pin on row 2 anchors to the table; its popover takes the comment as a change.
    await shell.mouse.click(...onImage(row.x + row.width / 2, row.y + row.height / 2));
    const firstPin = shell.locator('[data-testid="design-markup-pin"][data-n="1"]');
    await expect(firstPin).toHaveAttribute('data-element', 'ui/Table');
    const popover = shell.getByTestId('design-markup-popover');
    await expect(popover.getByTestId('design-markup-anchor')).toHaveText('ui/Table');
    await expect.poll(() => popoverPlacement(shell, firstPin)).toBe('as expected');
    await expect(popover.getByTestId('design-markup-text')).toBeFocused();
    await shell.keyboard.type('Make the rows denser');
    await expectNoAxeViolations(shell, '[data-testid="design-markup-popover"]');
    await popover.getByTestId('design-markup-done').click();
    await expect(popover).toHaveCount(0);
    await expect(firstPin).toBeFocused();

    // A second pin, on the button, made a note.
    await shell.mouse.click(...onImage(button.x + button.width / 2, button.y + button.height / 2));
    const secondPin = shell.locator('[data-testid="design-markup-pin"][data-n="2"]');
    await expect(secondPin).toHaveAttribute('data-element', 'ui/Button');
    await expect.poll(() => popoverPlacement(shell, secondPin)).toBe('as expected');
    await expect(popover.getByTestId('design-markup-text')).toBeFocused();
    await shell.keyboard.type('Keep this label');
    await popover.locator('[data-testid="design-markup-kind-option"][data-kind="note"]').click();
    await expect(secondPin).toHaveAttribute('data-kind', 'note');
    await shell.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);

    // A box around the button and the table lists both.
    await shell.getByTestId('design-markup-tool').filter({ hasText: 'Box' }).click();
    const from = onImage(button.x - 8, button.y - 8);
    const to = onImage(table.x + table.width + 4, table.y + table.height + 8);
    await shell.mouse.move(...from);
    await shell.mouse.down();
    await shell.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
    await shell.mouse.move(...to);
    await shell.mouse.up();
    await expect(shell.locator('[data-testid="design-markup-stroke"][data-type="box"]')).toHaveCount(1);
    await expect(shell.getByTestId('design-markup-send')).toHaveText('Send to designer (3)');
    await expectNoAxeViolations(shell, '[data-testid="design-preview-tab"]');

    // Exit keeps the marks and gives focus to Markup, which reopens them over the same capture and focuses the tool again.
    await shell.getByTestId('design-markup-exit').click();
    await expect(canvas).toHaveCount(0);
    await expect(shell.getByTestId('design-preview-markup')).toBeFocused();
    await expect(shell.getByTestId('design-preview-markup-count')).toHaveText('3');
    await shell.keyboard.press('Enter');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect(selectedTool).toHaveAttribute('data-tool', 'box');
    await expect(selectedTool).toBeFocused();

    // Send: the designer gets one message with the flattened image, and core writes F1.png and F1.json.
    stub.replies.push({ chunks: ['Noted the markup.'] });
    const before = agentRequests(stub).length;
    await shell.getByTestId('design-markup-send').click();
    await expect(canvas).toHaveCount(0, { timeout: 30_000 });
    await expect(shell.getByTestId('design-markup-announcement')).toHaveText('Sent to the design chat as F1');
    await expect(shell.getByTestId('design-preview-screenshot')).toBeVisible();
    await expect(shell.getByTestId('design-preview-markup')).toBeFocused();
    // main ended markup with the send, so the live view shows again
    await expect.poll(() => shownDesignViews(app)).toBe(1);
    await awaitTurnEnd(design);
    await expect.poll(() => agentRequests(stub).length).toBeGreaterThan(before);
    const sent = JSON.stringify(agentRequests(stub).at(-1)!.body);
    expect(sent).toContain('data:image/png;base64,');
    expect(sent).toContain('Pin 1 (change) on ui/Table: Make the rows denser');

    const png = path.join(folder, 'feedback', 'F1.png');
    const json = path.join(folder, 'feedback', 'F1.json');
    await expect.poll(() => fs.existsSync(png) && fs.existsSync(json), { timeout: 30_000 }).toBe(true);
    const header = fs.readFileSync(png);
    expect(header.subarray(1, 4).toString('latin1')).toBe('PNG');
    // PD-41: captured at the largest scale up to 2 whose longest side is at most 1950 px, whatever zoom the tab shows.
    const [pngWidth, pngHeight] = [header.readUInt32BE(16), header.readUInt32BE(20)];
    test.info().annotations.push({ type: 'F1.png', description: `${pngWidth} x ${pngHeight}` });
    expect(Math.max(pngWidth, pngHeight)).toBeLessThanOrEqual(1950);
    expect(pngWidth).toBeGreaterThan(1280);
    // The page fills the capture at that scale: row 1's #ccc bottom border lies at its CSS rect × (image px per CSS px) in F1.png,
    // three quarters across the table, away from the pins and the box's strokes. A capture of the page shrunk into a corner is white there.
    const perCss = pngWidth / 1280;
    const borderShade = await app.evaluate(({ nativeImage }, [file, x, top, bottom]) => {
      const image = nativeImage.createFromPath(file);
      const { width } = image.getSize();
      const bitmap = image.toBitmap();
      let darkest = 255;
      for (let y = top; y <= bottom; y++) {
        const at = (y * width + x) * 4;
        darkest = Math.min(darkest, bitmap[at]!, bitmap[at + 1]!, bitmap[at + 2]!);
      }
      return darkest;
    }, [png, Math.round((table.x + table.width * 0.75) * perCss), Math.floor((firstRow.y + firstRow.height - 3) * perCss), Math.ceil((firstRow.y + firstRow.height + 2) * perCss)] as const);
    expect(borderShade).toBeLessThan(230);
    const markup = JSON.parse(fs.readFileSync(json, 'utf8')) as MarkupJson;
    expect(markup).toMatchObject({ file: 'screens/S1-contacts.html', viewport: { breakpoint: 'xl', width: 1280 }, state: 'default', image: 'feedback/F1.png' });
    expect(markup.marks).toEqual([
      expect.objectContaining({ type: 'pin', n: 1, kind: 'change', text: 'Make the rows denser', anchor: expect.objectContaining({ element: 'ui/Table' }) }),
      expect.objectContaining({ type: 'pin', n: 2, kind: 'note', text: 'Keep this label', anchor: expect.objectContaining({ element: 'ui/Button' }) }),
      expect.objectContaining({ type: 'box', anchors: expect.arrayContaining(['ui/Button', 'ui/Table']) }),
    ]);
    // A markup image is never a reference.
    expect(fs.existsSync(path.join(folder, 'references'))).toBe(false);

    // One user message, shown as the markup card.
    const card = design.getByTestId('markup-message');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-feedback-id', 'F1');
    await expect(card.getByTestId('markup-message-mark')).toHaveCount(3);
    await expect(card.getByTestId('markup-message-file')).toHaveText(['F1.png', 'F1.json']);
    await expectNoAxeViolations(design, '[data-testid="markup-message"]');

    // RecordDecision takes the change pin and refuses the note pin.
    stub.replies.push(
      call('RecordDecision', { title: 'Row density', chosen: 'Denser rows', source: { kind: 'markup', ref: 'F1#pin1' } }),
      call('RecordDecision', { title: 'Button label', chosen: 'Keep the label', source: { kind: 'markup', ref: 'F1#pin2' } }),
      { chunks: ['Recorded what the markup decided.'] },
    );
    await chatInput(design).fill('Record the markup decisions');
    await chatInput(design).press('Enter');
    await expect.poll(() => stub.replies.length, { timeout: 60_000 }).toBe(0);
    await awaitTurnEnd(design);
    const decisions = design.getByTestId('design-decisions');
    await expect(decisions.locator('[data-decision-id="D2"]')).toContainText('Denser rows');
    await expect(decisions.locator('[data-decision-id="D3"]')).toHaveCount(0);
    expect(lastToolResult(stub)).toBe('RecordDecision recorded nothing: Pin 2 of F1 is a note, and only a change pin becomes a decision.');

    // After a reload the card replays from the session.
    await design.reload();
    await expect(chatInput(design)).toBeVisible();
    await setPageSize(design, 900, 6000);
    await expect(design.getByTestId('markup-message')).toHaveCount(1, { timeout: 30_000 });
    await expect(design.getByTestId('markup-message')).toHaveAttribute('data-feedback-id', 'F1');
    await expect(design.getByTestId('markup-message').getByTestId('markup-message-mark')).toHaveCount(3);
  } finally {
    await stub.close();
  }
});
