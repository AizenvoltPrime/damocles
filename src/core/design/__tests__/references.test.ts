import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import type { UserContentBlock } from '../../../shared/types/content';
import type { MapReferenceDetails } from '../../../shared/types/design';
import { decisionDraft } from '../decisions';
import { runDesignCheck } from '../design-check';
import { isDesignerRelative } from '../design-paths';
import type { DesignInventory } from '../inventory';
import {
  mapReference,
  MAX_REFERENCE_BYTES,
  MAX_REFERENCES,
  MAX_REFERENCES_PER_MESSAGE,
  nextReferenceNumber,
  planReferences,
  readReference,
  referenceImageType,
  referencesEntryData,
  referencesOnBranch,
  ReferenceRefusedError,
  writeReference,
} from '../references';
import { createDesignChatTools, type DesignChatToolDeps } from '../tools/design-chat-tools';
import { createMapReferenceTool } from '../tools/map-reference';
import { designSection } from '../guidance';
import { designRuleSet, designRuleSetById } from '../rule-set';
import { ASK_AS_OFTEN_AS_NEEDED } from '../../pi-session/ask-user-question-rules';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

const image = (bytes: Buffer, origin?: 'designPreview', mediaType: 'image/png' | 'image/jpeg' = 'image/png'): UserContentBlock => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') },
  ...(origin ? { origin } : {}),
});
const text = (value: string): UserContentBlock => ({ type: 'text', text: value });

const INVENTORY: DesignInventory = {
  schemaVersion: 1,
  stack: 'Vue',
  tokens: null,
  breakpoints: null,
  components: [{ name: 'Card', path: 'a.vue' }, { name: 'Button', path: 'b.vue' }],
  screens: [],
  types: [{ name: 'Contact', path: 'a.ts:1', fields: ['name', 'email'] }],
  stores: [],
  actions: [],
};
const TOKENS = ['--radius-lg', '--accent'];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function tempFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-references-'));
  folders.push(folder);
  return folder;
}

describe('saving references (PD-40)', () => {
  it('reads the image type from the bytes, never the declared type', () => {
    expect([PNG, JPEG, GIF, WEBP].map(referenceImageType)).toEqual(['png', 'jpg', 'gif', 'webp']);
    expect(referenceImageType(Buffer.from('<svg/>'))).toBeUndefined();
    const [planned] = planReferences([image(JPEG, undefined, 'image/png')], 1).planned;
    expect(planned?.image).toBe('references/R1.jpg');
  });

  it('saves outside images and leaves the preview\'s own out, counting every image block for imageIndex (acceptance)', () => {
    const { planned, skipped } = planReferences([text('Like this'), image(PNG, 'designPreview'), image(PNG), image(WEBP)], 1);
    expect(planned.map(({ id, image: file, imageIndex }) => ({ id, image: file, imageIndex }))).toEqual([
      { id: 'R1', image: 'references/R1.png', imageIndex: 1 },
      { id: 'R2', image: 'references/R2.webp', imageIndex: 2 },
    ]);
    expect(skipped).toBe(0);
    expect(planReferences([image(PNG, 'designPreview')], 1)).toEqual({ planned: [], skipped: 0 });
  });

  it('bounds the count per message and per design, the size, and the type', () => {
    const many = Array.from({ length: MAX_REFERENCES_PER_MESSAGE + 2 }, () => image(PNG));
    expect(planReferences(many, 1)).toMatchObject({ skipped: 2 });
    expect(planReferences(many, 1).planned).toHaveLength(MAX_REFERENCES_PER_MESSAGE);
    expect(planReferences([image(PNG), image(PNG)], MAX_REFERENCES)).toMatchObject({ planned: [{ id: `R${MAX_REFERENCES}` }], skipped: 1 });
    const large = Buffer.concat([PNG, Buffer.alloc(MAX_REFERENCE_BYTES)]);
    expect(planReferences([image(large), image(Buffer.from('not an image'))], 1)).toEqual({ planned: [], skipped: 2 });
  });

  it('numbers past the folder\'s files, the branch\'s references and those in flight', async () => {
    const folder = tempFolder();
    expect(await nextReferenceNumber(folder, [], [])).toBe(1);
    fs.mkdirSync(path.join(folder, 'references'));
    fs.writeFileSync(path.join(folder, 'references', 'R3.png'), PNG);
    expect(await nextReferenceNumber(folder, [], [])).toBe(4);
    const branch = [{ type: 'custom', customType: 'damocles.design-references', data: referencesEntryData('u1', [{ id: 'R7', image: 'references/R7.png', imageIndex: 0 }]) }];
    expect(await nextReferenceNumber(folder, branch, [])).toBe(8);
    expect(await nextReferenceNumber(folder, branch, ['R9'])).toBe(10);
    expect(referencesOnBranch(branch).get('u1')).toEqual([{ id: 'R7', image: 'references/R7.png', imageIndex: 0 }]);
  });

  it('writes R<n>.<ext> and R<n>.json naming it, its user entry and its sha256, in core\'s own folder', async () => {
    const folder = tempFolder();
    const [planned] = planReferences([image(PNG)], 1).planned;
    await writeReference(folder, planned!, 'user-1');
    expect(fs.readFileSync(path.join(folder, 'references', 'R1.png'))).toEqual(PNG);
    expect(await readReference(folder, 'R1')).toEqual({ schemaVersion: 1, image: 'references/R1.png', userEntryId: 'user-1', sha256: createHash('sha256').update(PNG).digest('hex') });
    expect(isDesignerRelative('references/r1.png')).toBe(false);
    expect(isDesignerRelative('references/r1.json')).toBe(false);
  });
});

describe('MapReference', () => {
  async function withReference(): Promise<string> {
    const folder = tempFolder();
    await writeReference(folder, planReferences([image(PNG)], 1).planned[0]!, 'user-1');
    return folder;
  }

  it('maps rows onto components, tokens and type fields and writes the mapping into R<n>.json', async () => {
    const folder = await withReference();
    const details = await mapReference(folder, { reference: 'R1', rows: [
      { element: 'Hero card', mapsTo: 'Card', status: 'mapped' },
      { element: 'Rounded corners', mapsTo: '--radius-lg', status: 'mapped' },
      { element: 'Email line', mapsTo: 'Contact.email', status: 'mapped' },
      { element: 'Carousel', status: 'needsDecision' },
      { element: 'Ad banner', status: 'out' },
    ] }, INVENTORY, TOKENS);
    expect(details.rows.map((row) => [row.element, row.mapsTo, row.status])).toEqual([
      ['Hero card', 'Card', 'mapped'],
      ['Rounded corners', '--radius-lg', 'mapped'],
      ['Email line', 'Contact.email', 'mapped'],
      ['Carousel', null, 'needsDecision'],
      ['Ad banner', null, 'out'],
    ]);
    expect((await readReference(folder, 'R1'))?.mapping).toEqual(details.rows);
  });

  it('refuses a row naming a missing component, token or field, and writes nothing (acceptance)', async () => {
    const folder = await withReference();
    await expect(mapReference(folder, { reference: 'R1', rows: [{ element: 'Hero', mapsTo: 'HeroBanner', status: 'mapped' }] }, INVENTORY, TOKENS)).rejects.toThrow(/HeroBanner is not a component in inventory\.json/);
    await expect(mapReference(folder, { reference: 'R1', rows: [{ element: 'Pill', mapsTo: '--radius-full', status: 'mapped' }] }, INVENTORY, TOKENS)).rejects.toThrow(/--radius-full is not a token/);
    await expect(mapReference(folder, { reference: 'R1', rows: [{ element: 'Phone', mapsTo: 'Contact.phone', status: 'mapped' }] }, INVENTORY, TOKENS)).rejects.toThrow(/Contact has no field phone/);
    await expect(mapReference(folder, { reference: 'R1', rows: [{ element: 'Hero', mapsTo: 'HeroBanner', status: 'needsDecision' }] }, INVENTORY, TOKENS)).rejects.toThrow(ReferenceRefusedError);
    expect((await readReference(folder, 'R1'))?.mapping).toBeUndefined();
  });

  it('needs an unmapped row to be needsDecision or out, each element once, and an existing reference', async () => {
    const folder = await withReference();
    await expect(mapReference(folder, { reference: 'R1', rows: [{ element: 'Hero', status: 'mapped' }] }, INVENTORY, TOKENS)).rejects.toThrow(/mapped but names nothing/);
    await expect(mapReference(folder, { reference: 'R1', rows: [{ element: 'Hero', status: 'out' }, { element: 'Hero', status: 'out' }] }, INVENTORY, TOKENS)).rejects.toThrow(/listed twice/);
    await expect(mapReference(folder, { reference: 'R2', rows: [{ element: 'Hero', status: 'out' }] }, INVENTORY, TOKENS)).rejects.toThrow(/No reference "R2"/);
    await expect(mapReference(folder, { reference: '../R1', rows: [{ element: 'Hero', status: 'out' }] }, INVENTORY, TOKENS)).rejects.toThrow(/No reference/);
  });

  it('lets a mapping row become a decision, which data-ds-new then cites in DesignCheck', async () => {
    const folder = await withReference();
    await mapReference(folder, { reference: 'R1', rows: [{ element: 'Carousel', status: 'needsDecision' }] }, INVENTORY, TOKENS);
    const record = { ...(await decisionDraft([], { title: 'Carousel', chosen: 'A new carousel', source: { kind: 'reference', ref: 'R1#Carousel' } }, folder)), id: 'D1' };
    fs.mkdirSync(path.join(folder, 'screens'));
    const screen = (attributes: string): string => `<!doctype html><html data-ds-screen="S1" data-ds-states="default"><head><title>S1</title></head><body><section ${attributes}>Slides</section></body></html>`;
    fs.writeFileSync(path.join(folder, 'screens', 'S1.html'), screen(`data-ds-new="${record.id}"`));
    const input = { folder, inventory: INVENTORY, tokenNames: TOKENS, decisions: [record], fidelity: 'static' as const, skillHints: [], screenshots: true };
    expect((await runDesignCheck(input)).summary.errors.filter((issue) => issue.rule === 'ds.new-cites-decision')).toEqual([]);
    fs.writeFileSync(path.join(folder, 'screens', 'S1.html'), screen('data-ds-new="R1#Carousel"'));
    expect((await runDesignCheck(input)).summary.errors.map((issue) => issue.rule)).toContain('ds.new-cites-decision');
    fs.writeFileSync(path.join(folder, 'screens', 'S1.html'), screen('data-ds-component="Carousel"'));
    expect((await runDesignCheck(input)).summary.errors.map((issue) => issue.rule)).toContain('ds.component-known');
  });

  it('runs as a tool and lists what needs a decision', async () => {
    const folder = await withReference();
    fs.writeFileSync(path.join(folder, 'inventory.json'), JSON.stringify(INVENTORY));
    fs.writeFileSync(path.join(folder, 'tokens.css'), ':root {\n  --radius-lg: 12px;\n}\n');
    const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
    const deps = { role: () => ({ designId: 'd', folder, parentSessionId: null, ruleSet: 'reduced', title: 't' }), enabled: () => true, referenceWritten: async () => undefined } as unknown as DesignChatToolDeps;
    const tool = createMapReferenceTool(pi, deps) as unknown as { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: MapReferenceDetails }> };
    const result = await tool.execute('call-1', { reference: 'R1', rows: [{ element: 'Hero card', mapsTo: 'Card', status: 'mapped' }, { element: 'Carousel', status: 'needsDecision' }] });
    expect(result.details).toEqual({ reference: 'R1', image: 'references/R1.png', rows: [{ element: 'Hero card', mapsTo: 'Card', status: 'mapped' }, { element: 'Carousel', mapsTo: null, status: 'needsDecision' }] });
    expect(result.content[0]!.text).toContain('R1#<element>');
    expect(result.content[0]!.text).toContain(ASK_AS_OFTEN_AS_NEEDED);
    // an answer records its own decision, so the result never sends the designer to RecordDecision for it
    expect(result.content[0]!.text).toContain('Ask the user about Carousel with AskUserQuestion, one question per element, each with reference: "R1#<element>". Each answer records the element\'s decision; cite its id in the new UI\'s data-ds-new.');
    expect(result.content[0]!.text).not.toContain('RecordDecision');
    const { description } = tool as unknown as { description: string };
    expect(description).toContain('ask the user with AskUserQuestion, giving the question reference: "R<n>#<element>", and the answer records the decision');
    expect(description).toContain('when the user decides it in chat instead, record it with RecordDecision, source {kind: "reference", ref: "R<n>#<element>"}');
    await expect(tool.execute('call-2', { reference: 'R1', rows: [{ element: 'Hero', mapsTo: 'Nope', status: 'mapped' }] })).rejects.toThrow(/MapReference wrote nothing/);
  });

  it('tells the designer to ask about an element with a question naming its row, and to use RecordDecision only for a decision made in chat', () => {
    const guidance = designSection('/d', designRuleSet({ designPreview: true }));
    expect(guidance).toContain('ask the user about each element marked needsDecision with AskUserQuestion, giving its question reference: "R<n>#<element>", and the answer records the decision. When the user decides an element in chat instead, record it with RecordDecision, source {kind: "reference", ref: "R<n>#<element>"}.');
    expect(guidance).not.toContain('record the answer with RecordDecision');
    const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
    const recordDecision = (createDesignChatTools(pi, {} as DesignChatToolDeps, designRuleSetById('full')) as unknown as { name: string; description: string }[]).find((tool) => tool.name === 'RecordDecision')!;
    expect(recordDecision.description).toContain('kind "reference" with R<n>#<element> naming a row MapReference recorded, for an element the user decided in chat (an answer to an AskUserQuestion question with that reference records its own decision)');
  });

  it('waits for the reference its message is still writing, which the same baseline released', async () => {
    const folder = tempFolder();
    fs.writeFileSync(path.join(folder, 'inventory.json'), JSON.stringify(INVENTORY));
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => { finish = resolve; });
    const asked: string[] = [];
    const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
    const deps = {
      role: () => ({ designId: 'd', folder, parentSessionId: null, ruleSet: 'reduced', title: 't' }),
      enabled: () => true,
      referenceWritten: (id: string) => {
        asked.push(id);
        return writing;
      },
    } as unknown as DesignChatToolDeps;
    const tool = createMapReferenceTool(pi, deps) as unknown as { execute: (id: string, params: unknown) => Promise<{ details: MapReferenceDetails }> };
    const mapped = tool.execute('call-1', { reference: 'R1', rows: [{ element: 'Hero card', mapsTo: 'Card', status: 'mapped' }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await writeReference(folder, planReferences([image(PNG)], 1).planned[0]!, 'user-1');
    finish();
    expect((await mapped).details.rows).toEqual([{ element: 'Hero card', mapsTo: 'Card', status: 'mapped' }]);
    expect(asked).toEqual(['R1']);
  });
});
