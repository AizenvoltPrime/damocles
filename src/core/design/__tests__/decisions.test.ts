import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DESIGN_DECISIONS_DETAIL_KEY } from '../../../shared/types/design';
import { DecisionRefusedError, questionDecisions, recordDecision } from '../decisions';
import { decisionsMarkdown, fidelityOf, readManifest, writeDecisions } from '../design-files';
import type { DesignDecisionRecord } from '../design-entries';
import { writeMarkupFiles } from '../markup';

let n = 0;
const entry = (fields: Record<string, unknown>) => ({ id: `e${++n}`, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', ...fields });
const user = (text: string) => entry({ type: 'message', message: { role: 'user', content: text } });
const brief = (briefId: string) => entry({ type: 'custom_message', customType: 'damocles-design-brief', content: 'x', display: true, details: { briefId, text: 'x', reopened: false } });
const result = (toolName: string, decisions: DesignDecisionRecord[]) => entry({ type: 'message', message: { role: 'toolResult', toolCallId: `c${n}`, toolName, content: [], details: { [DESIGN_DECISIONS_DETAIL_KEY]: decisions } } });

const FIDELITY = { question: 'Static mockup or interactive prototype?', header: 'Fidelity', options: [{ label: 'Static mockup' }, { label: 'Interactive prototype' }] };
const DENSITY = { question: 'How dense is the table?', header: 'Density', options: [{ label: 'Comfortable' }, { label: 'Compact' }] };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function tempFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-decisions-'));
  folders.push(folder);
  return folder;
}
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('decisions', () => {
  it('records one decision per answered question, numbered from the branch root', () => {
    const made = questionDecisions([], [FIDELITY, DENSITY], { [FIDELITY.question]: 'Interactive prototype' });
    expect(made).toEqual([{ v: 1, id: 'D1', title: 'Fidelity', chosen: 'Interactive prototype', rejected: ['Static mockup'], source: { kind: 'question', ref: FIDELITY.question }, files: [] }]);
    const next = questionDecisions([result('AskUserQuestion', made)], [DENSITY, FIDELITY], { [DENSITY.question]: 'Compact', [FIDELITY.question]: 'Static mockup' });
    expect(next.map((d) => [d.id, d.title, d.supersedes])).toEqual([['D2', 'Density', undefined], ['D3', 'Fidelity', 'D1']]);
  });

  it('records a RecordDecision only with a real source (acceptance)', async () => {
    const branch = [user('Let us make the table compact, please'), brief('b-1')];
    const folder = tempFolder();
    const fromChat = await recordDecision(branch, { title: 'Density', chosen: 'Compact', source: { kind: 'chat', ref: 'make the table compact' } }, [], folder);
    expect([fromChat.id, fromChat.source]).toEqual(['D1', { kind: 'chat', ref: 'make the table compact' }]);
    expect((await recordDecision(branch, { title: 'Layout', chosen: 'Cards on mobile', source: { kind: 'brief', ref: 'b-1' } }, [], folder)).id).toBe('D1');
    await expect(recordDecision(branch, { title: 'Density', chosen: 'Compact', source: { kind: 'chat', ref: 'the user said so' } }, [], folder)).rejects.toThrow(DecisionRefusedError);
    await expect(recordDecision(branch, { title: 'Layout', chosen: 'x', source: { kind: 'brief', ref: 'b-9' } }, [], folder)).rejects.toThrow(/No brief with id b-9/);
    await expect(recordDecision(branch, { title: 'x', chosen: 'y', source: { kind: 'question', ref: 'F1' } }, [], folder)).rejects.toThrow(/recorded only by AskUserQuestion/);
    await expect(recordDecision(branch, { title: 'x'.repeat(4001), chosen: 'y', source: { kind: 'brief', ref: 'b-1' } }, [], folder)).rejects.toThrow(/at most 4000/);
  });

  it('records a markup source only for a change pin of core\'s own feedback/F<n>.json (acceptance)', async () => {
    const folder = tempFolder();
    const markup = { screen: 'S1', file: 'screens/S1.html', viewport: { breakpoint: 'xl', width: 1280 }, zoom: 1, pixelRatio: 2, state: 'default', marks: [
      { type: 'pin', n: 1, kind: 'change', text: 'Taller rows', at: [40, 200], anchor: { element: 'ui/Table', facts: [] } },
      { type: 'pin', n: 2, kind: 'note', text: 'Nice header', at: [40, 20], anchor: null },
    ] } as const;
    await writeMarkupFiles(folder, 'F1', PNG_1x1, markup);
    const record = await recordDecision([], { title: 'Row height', chosen: 'Taller', source: { kind: 'markup', ref: 'F1#pin1' } }, [], folder);
    expect([record.id, record.source]).toEqual(['D1', { kind: 'markup', ref: 'F1#pin1' }]);
    await expect(recordDecision([], { title: 'Header', chosen: 'Keep', source: { kind: 'markup', ref: 'F1#pin2' } }, [], folder)).rejects.toThrow(/Pin 2 of F1 is a note/);
    await expect(recordDecision([], { title: 'x', chosen: 'y', source: { kind: 'markup', ref: 'F1#pin3' } }, [], folder)).rejects.toThrow(/F1 has no pin 3/);
    await expect(recordDecision([], { title: 'x', chosen: 'y', source: { kind: 'markup', ref: 'F2#pin1' } }, [], folder)).rejects.toThrow(/No markup F2/);
    for (const ref of ['F1', 'F1#1', 'f1#pin1', 'F0#pin1', 'F1#pin1 ', '../F1#pin1']) {
      await expect(recordDecision([], { title: 'x', chosen: 'y', source: { kind: 'markup', ref } }, [], folder)).rejects.toThrow(/is not one/);
    }
    fs.writeFileSync(path.join(folder, 'feedback', 'F3.json'), '{"marks": "nope"}');
    await expect(recordDecision([], { title: 'x', chosen: 'y', source: { kind: 'markup', ref: 'F3#pin1' } }, [], folder)).rejects.toThrow(/cannot be read/);
  });

  it('records a tweak source only when chosen is the latest value kept for that tweak (acceptance)', async () => {
    const folder = tempFolder();
    const kept = (tweakId: string, value: string) => entry({ type: 'custom', customType: 'damocles-design-tweak-kept', data: { userEntryId: 'u1', toolCallId: 't1', tweakId, label: 'Corner radius', property: '--radius', value } });
    const branch = [kept('radius', '--radius-sm'), kept('radius', '--radius-lg')];
    const record = await recordDecision(branch, { title: 'Corner radius', chosen: '--radius-lg', source: { kind: 'tweak', ref: 'radius' } }, [], folder);
    expect([record.id, record.source]).toEqual(['D1', { kind: 'tweak', ref: 'radius' }]);
    await expect(recordDecision(branch, { title: 'Corner radius', chosen: '--radius-sm', source: { kind: 'tweak', ref: 'radius' } }, [], folder)).rejects.toThrow(/kept --radius-lg/);
    await expect(recordDecision(branch, { title: 'Accent', chosen: '--accent-blue', source: { kind: 'tweak', ref: 'accent' } }, [], folder)).rejects.toThrow(/No tweak "accent" was kept/);
    await expect(recordDecision([], { title: 'Corner radius', chosen: '--radius-lg', source: { kind: 'tweak', ref: 'radius' } }, [], folder)).rejects.toThrow(DecisionRefusedError);
  });

  it('records a reference source only for a mapping row of an existing reference (acceptance)', async () => {
    const folder = tempFolder();
    fs.mkdirSync(path.join(folder, 'references'));
    fs.writeFileSync(path.join(folder, 'references', 'R1.json'), JSON.stringify({ schemaVersion: 1, image: 'references/R1.png', userEntryId: 'u1', sha256: 'x', mapping: [{ element: 'Hero card', mapsTo: null, status: 'needsDecision' }] }));
    fs.writeFileSync(path.join(folder, 'references', 'R2.json'), JSON.stringify({ schemaVersion: 1, image: 'references/R2.png', userEntryId: 'u2', sha256: 'y' }));
    const record = await recordDecision([], { title: 'Hero', chosen: 'A new hero card', source: { kind: 'reference', ref: 'R1#Hero card' } }, [], folder);
    expect([record.id, record.source]).toEqual(['D1', { kind: 'reference', ref: 'R1#Hero card' }]);
    await expect(recordDecision([], { title: 'x', chosen: 'y', source: { kind: 'reference', ref: 'R1#Footer' } }, [], folder)).rejects.toThrow(/R1 has no mapping row "Footer"/);
    await expect(recordDecision([], { title: 'x', chosen: 'y', source: { kind: 'reference', ref: 'R2#Hero card' } }, [], folder)).rejects.toThrow(/R2 has no mapping row/);
    await expect(recordDecision([], { title: 'x', chosen: 'y', source: { kind: 'reference', ref: 'R3#Hero card' } }, [], folder)).rejects.toThrow(/No reference R3/);
    for (const ref of ['R1', 'R1#', 'r1#Hero card', '../R1#Hero card', 'R0#Hero card']) {
      await expect(recordDecision([], { title: 'x', chosen: 'y', source: { kind: 'reference', ref } }, [], folder)).rejects.toThrow(/is not one/);
    }
  });

  it('rebuilds decisions.md in branch order and sets the manifest\'s fidelity from the Fidelity decision', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-decisions-'));
    folders.push(folder);
    const decisions = questionDecisions([], [FIDELITY, DENSITY], { [FIDELITY.question]: 'Interactive prototype', [DENSITY.question]: 'Compact' });
    await writeDecisions(folder, 'contacts-abcd1234', decisions);
    const markdown = fs.readFileSync(path.join(folder, 'decisions.md'), 'utf8');
    expect(markdown).toBe(decisionsMarkdown(decisions));
    expect(markdown.indexOf('## D1 · Fidelity')).toBeLessThan(markdown.indexOf('## D2 · Density'));
    expect(markdown.startsWith('<!-- Generated by Damocles')).toBe(true);
    expect((await readManifest(folder, 'contacts-abcd1234')).fidelity).toBe('interactive');
    expect(fidelityOf(questionDecisions([], [FIDELITY], { [FIDELITY.question]: 'Static mockup' }))).toBe('static');
    expect(fidelityOf([])).toBeNull();
  });
});

describe('an answer whose option labels hold commas', () => {
  const LAYOUT = { question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Cards, then a table' }, { label: 'Table' }, { label: 'Cards' }] };
  const PARTS = { question: 'Which parts?', header: 'Parts', multiSelect: true, options: [{ label: 'Search, with filters' }, { label: 'Search' }, { label: 'Export' }] };

  it('takes a single-select answer that is one whole label as that label', () => {
    expect(questionDecisions([], [LAYOUT], { [LAYOUT.question]: 'Cards, then a table' })[0]!.rejected).toEqual(['Table', 'Cards']);
    expect(questionDecisions([], [LAYOUT], { [LAYOUT.question]: 'Cards' })[0]!.rejected).toEqual(['Cards, then a table', 'Table']);
  });

  it('reads a multi-select answer as its labels joined with ", ", and typed text after them chooses no label', () => {
    expect(questionDecisions([], [PARTS], { [PARTS.question]: 'Export, Search, with filters' })[0]!.rejected).toEqual(['Search']);
    expect(questionDecisions([], [PARTS], { [PARTS.question]: 'Search, Export, and print' })[0]!.rejected).toEqual(['Search, with filters']);
    expect(questionDecisions([], [PARTS], { [PARTS.question]: 'Something else' })[0]!.rejected).toEqual(['Search, with filters', 'Search', 'Export']);
  });
});

describe('the Fidelity decision', () => {
  const fidelity = (chosen: string): DesignDecisionRecord => ({ v: 1, id: 'D1', title: 'Fidelity', chosen, rejected: [], source: { kind: 'question', ref: 'q' }, files: [] });

  it('sets the fidelity only from an answer that is one of the option labels, case-blind', () => {
    expect(fidelityOf([fidelity('Interactive prototype')])).toBe('interactive');
    expect(fidelityOf([fidelity('static MOCKUP')])).toBe('static');
    expect(fidelityOf([fidelity('Static mockups, not an interactive prototype')])).toBeNull();
    expect(fidelityOf([fidelity('Interactive')])).toBeNull();
  });
});

describe('decisions made in one batch (F3)', () => {
  it('number after the ones whose results are not on the branch yet', async () => {
    const folder = tempFolder();
    const first = await recordDecision([user('use compact rows and cards on mobile')], { title: 'Density', chosen: 'Compact', source: { kind: 'chat', ref: 'compact rows' } }, [], folder);
    const second = await recordDecision([user('use compact rows and cards on mobile')], { title: 'Mobile', chosen: 'Cards', source: { kind: 'chat', ref: 'cards on mobile' } }, [first], folder);
    expect([first.id, second.id]).toEqual(['D1', 'D2']);
    expect(questionDecisions([], [DENSITY], { [DENSITY.question]: 'Comfortable' }, [first, second]).map((d) => [d.id, d.supersedes])).toEqual([['D3', 'D1']]);
  });
});
