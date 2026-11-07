import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { designMarkupView, MAX_MARKUP_MARKS, MAX_MARKUP_PIN_TEXT, type MarkupJsonInput } from '../../../shared/design-markup';
import { MAX_IMAGE_BASE64_LENGTH } from '../../../shared/types/content';
import { markupEntriesOnBranch, markupEntryData, MarkupInvalidError, markupPromptText, nextFeedbackId, parseMarkupJson, parseMarkupPng, writeMarkupFiles } from '../markup';

const pin = (n: number, kind: 'change' | 'note' = 'change', fields: Record<string, unknown> = {}) => ({ type: 'pin', n, kind, text: `Pin text ${n}`, at: [10, 20], anchor: { element: 'ui/Table', facts: ['variant compact'] }, ...fields });
const stroke = (type: 'pen' | 'arrow' | 'box', anchors: string[], fields: Record<string, unknown> = {}) => ({ type, bbox: [0, 0, 100, 50], anchors, ...fields });
const markup = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  screen: 'S1', file: 'screens/S1.html', viewport: { breakpoint: 'xl', width: 1280 }, zoom: 1.25, pixelRatio: 2, state: 'default', marks: [pin(1)], ...fields,
});

// A PNG header whose IHDR names `width` × `height`.
function png(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function tempFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-markup-'));
  folders.push(folder);
  return folder;
}

describe('the markup the shell sends, parsed as hostile', () => {
  it('takes the contract\'s fields into a fresh object and drops any other', () => {
    const parsed = parseMarkupJson({ ...markup({ marks: [pin(1), stroke('arrow', ['ui/Table', 'ui/Button'])] }), image: '../../escape.png', extra: 1 });
    expect(parsed).toEqual({
      screen: 'S1', file: 'screens/S1.html', viewport: { breakpoint: 'xl', width: 1280 }, zoom: 1.25, pixelRatio: 2, state: 'default',
      marks: [{ type: 'pin', n: 1, kind: 'change', text: 'Pin text 1', at: [10, 20], anchor: { element: 'ui/Table', facts: ['variant compact'] } }, { type: 'arrow', bbox: [0, 0, 100, 50], anchors: ['ui/Table', 'ui/Button'] }],
    });
    expect(parseMarkupJson(markup({ screen: null, marks: [pin(1, 'note', { anchor: null, text: '' })] })).marks).toEqual([{ type: 'pin', n: 1, kind: 'note', text: '', at: [10, 20], anchor: null }]);
  });

  it('refuses every bound the contract sets', () => {
    const refusals: Array<[string, unknown]> = [
      ['no marks', markup({ marks: [] })],
      ['too many marks', markup({ marks: Array.from({ length: MAX_MARKUP_MARKS + 1 }, (_, index) => pin(index + 1)) })],
      ['a pin text past 4000', markup({ marks: [pin(1, 'change', { text: 'x'.repeat(MAX_MARKUP_PIN_TEXT + 1) })] })],
      ['two pins sharing a number', markup({ marks: [pin(1), pin(1)] })],
      ['a pin numbered 0', markup({ marks: [pin(0)] })],
      ['an unknown pin kind', markup({ marks: [{ ...pin(1), kind: 'decision' }] })],
      ['a pin with no anchor field', markup({ marks: [(({ anchor: _anchor, ...rest }) => rest)(pin(1))] })],
      ['a non-finite x', markup({ marks: [pin(1, 'change', { at: [Number.NaN, 0] })] })],
      ['an x past the width', markup({ marks: [pin(1, 'change', { at: [1281, 0] })] })],
      ['a negative y', markup({ marks: [pin(1, 'change', { at: [0, -1] })] })],
      ['a stroke past the width', markup({ marks: [stroke('box', [], { bbox: [1200, 0, 100, 10] })] })],
      ['a negative stroke height', markup({ marks: [stroke('box', [], { bbox: [0, 0, 10, -1] })] })],
      ['an unknown mark type', markup({ marks: [stroke('box', []), { type: 'circle', bbox: [0, 0, 1, 1], anchors: [] }] })],
      ['an element name past 200', markup({ marks: [stroke('pen', ['x'.repeat(201)])] })],
      ['an element name with a control character', markup({ marks: [stroke('pen', ['ui/Table\n'])] })],
      ['an empty element name', markup({ marks: [pin(1, 'change', { anchor: { element: '', facts: [] } })] })],
      ['too many facts', markup({ marks: [pin(1, 'change', { anchor: { element: 'ui/Table', facts: Array.from({ length: 9 }, () => 'f') } })] })],
      ['too many stroke anchors', markup({ marks: [stroke('pen', Array.from({ length: 65 }, () => 'a'))] })],
      ['a file outside screens/', markup({ file: 'variants/a/screens/S1.html' })],
      ['a file escaping the folder', markup({ file: 'screens/../manifest.html' })],
      ['a file that is not html', markup({ file: 'screens/S1.json' })],
      ['a Windows device name', markup({ file: 'screens/CON.html' })],
      ['a fractional width', markup({ viewport: { breakpoint: 'xl', width: 1280.5 } })],
      ['a width below 320', markup({ viewport: { breakpoint: 'xl', width: 100 } })],
      ['a breakpoint outside the alphabet', markup({ viewport: { breakpoint: 'x"l', width: 1280 } })],
      ['a state outside the alphabet', markup({ state: 'default; drop' })],
      ['a zero zoom', markup({ zoom: 0 })],
      ['an infinite pixel ratio', markup({ pixelRatio: Number.POSITIVE_INFINITY })],
      ['no object', 'markup'],
    ];
    for (const [what, value] of refusals) expect(() => parseMarkupJson(value), what).toThrow(MarkupInvalidError);
  });

  it('takes a PNG only with its signature, an IHDR first and both sides at most 1950 px', () => {
    expect(parseMarkupPng(png(1950, 975)).length).toBe(33);
    expect(() => parseMarkupPng(png(1951, 10))).toThrow(/1951 x 10/);
    expect(() => parseMarkupPng(png(10, 1951))).toThrow(MarkupInvalidError);
    expect(() => parseMarkupPng(png(0, 10))).toThrow(MarkupInvalidError);
    const jpeg = Buffer.from(png(10, 10), 'base64');
    jpeg[0] = 0xff;
    expect(() => parseMarkupPng(jpeg.toString('base64'))).toThrow(/not a PNG/);
    const chunk = Buffer.from(png(10, 10), 'base64');
    chunk.write('IDAT', 12, 'latin1');
    expect(() => parseMarkupPng(chunk.toString('base64'))).toThrow(/not a PNG/);
    expect(() => parseMarkupPng('iVBOR w0KGgo=')).toThrow(/base64/);
    expect(() => parseMarkupPng('A'.repeat(MAX_IMAGE_BASE64_LENGTH + 4))).toThrow(/base64/);
    expect(() => parseMarkupPng(42)).toThrow(MarkupInvalidError);
  });
});

describe('the markup\'s number, prompt and files', () => {
  it('takes the next F<n> past the folder\'s files, the branch\'s markups and the ones still on their way', async () => {
    const folder = tempFolder();
    expect(await nextFeedbackId(folder, [], [])).toBe('F1');
    fs.mkdirSync(path.join(folder, 'feedback'));
    fs.writeFileSync(path.join(folder, 'feedback', 'F2.png'), '');
    fs.writeFileSync(path.join(folder, 'feedback', 'notes.txt'), '');
    expect(await nextFeedbackId(folder, [], [])).toBe('F3');
    const branch = [{ type: 'custom', customType: 'damocles.design-markup', data: { userEntryId: 'u1', feedbackId: 'F7' } }];
    expect(await nextFeedbackId(folder, branch, [])).toBe('F8');
    expect(await nextFeedbackId(folder, branch, ['F9'])).toBe('F10');
  });

  it('lists each mark on its own line after a header, pins with their kind and element, strokes with what they cover', () => {
    const input = parseMarkupJson(markup({ marks: [
      pin(1, 'change', { text: 'Make rows\n taller' }),
      pin(2, 'note', { anchor: null, text: '' }),
      stroke('arrow', ['ui/Table', 'ui/Button']),
      stroke('box', []),
      stroke('pen', ['td']),
    ] }));
    expect(markupPromptText('F4', input)).toBe([
      'Markup F4 on screens/S1.html at xl · 1280 · default:',
      'Pin 1 (change) on ui/Table: Make rows taller',
      'Pin 2 (note) on no element',
      'Arrow over ui/Table, ui/Button',
      'Box over no element',
      'Pen over td',
    ].join('\n'));
  });

  it('writes feedback/F<n>.png and its JSON, which names the image, and reads the entries that tie a markup to its message', async () => {
    const folder = tempFolder();
    const input: MarkupJsonInput = parseMarkupJson(markup());
    const bytes = Buffer.from(png(10, 10), 'base64');
    const written = await writeMarkupFiles(folder, 'F1', bytes, input);
    expect(written).toEqual({ ...input, image: 'feedback/F1.png' });
    expect(fs.readFileSync(path.join(folder, 'feedback', 'F1.png'))).toEqual(bytes);
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'feedback', 'F1.json'), 'utf8'))).toEqual(written);
    const branch = [
      { type: 'custom', customType: 'damocles.design-markup', data: { userEntryId: 'u1', feedbackId: 'F1' } },
      { type: 'custom', customType: 'damocles.design-markup', data: { userEntryId: 'u2', feedbackId: '../F2' } },
      { type: 'custom', customType: 'damocles.design', data: { userEntryId: 'u3', feedbackId: 'F3' } },
    ];
    expect([...markupEntriesOnBranch(branch)]).toEqual([['u1', { feedbackId: 'F1' }]]);
  });

  it('records the marks on its entry as the card shows them, which the replay reads back, beside the prompt the model reads', () => {
    const input: MarkupJsonInput = parseMarkupJson(markup());
    const data = markupEntryData('u1', 'F1', input);
    const view = designMarkupView(input);
    expect(data).toEqual({ userEntryId: 'u1', feedbackId: 'F1', markup: view });
    expect(view).toMatchObject({ file: input.file, breakpoint: input.viewport.breakpoint, width: input.viewport.width, state: input.state });
    expect(view.marks).toHaveLength(input.marks.length);
    expect(view.marks.map((mark) => mark.type)).toEqual(input.marks.map((mark) => mark.type));

    const branch = [{ type: 'custom', customType: 'damocles.design-markup', data }];
    expect(markupEntriesOnBranch(branch).get('u1')).toEqual({ feedbackId: 'F1', markup: view });
    // A view that does not parse leaves the card its text, and the markup still counts for numbering.
    const broken = [{ type: 'custom', customType: 'damocles.design-markup', data: { ...data, markup: { file: 7 } } }];
    expect(markupEntriesOnBranch(broken).get('u1')).toEqual({ feedbackId: 'F1' });
    expect(markupPromptText('F1', input).split('\n')).toHaveLength(input.marks.length + 1);
  });
});
