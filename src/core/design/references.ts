// References (PD-13, PD-40; docs/invariants.md "Design mode"): an image the user attached from outside Damocles in a design
// chat, saved by core alone (PD-26) as references/R<n>.<ext> and R<n>.json once its turn has a baseline, and MapReference's
// mapping of its elements onto the inventory, tokens and type fields.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Type, type TSchema } from 'typebox';
import type { UserContentBlock } from '../../shared/types/content';
import type { DesignReferenceNote, MapReferenceDetails, ReferenceRow, ReferenceRowStatus } from '../../shared/types/design';
import { TWEAK_TOKEN_NAME } from '../../shared/design-tweaks';
import { DAMOCLES_DESIGN_REFERENCES_ENTRY } from '../pi-session/session-store/constants';
import { readDesignFile } from './design-file-read';
import { REFERENCES_DIR } from './design-paths';
import { writeJsonAtomic, writeTextAtomic } from './design-state';
import type { DesignInventory } from './inventory';

/** At most this many images of one message are saved, R1 to R<MAX_REFERENCES> per design, each at most MAX_REFERENCE_BYTES. */
export const MAX_REFERENCES_PER_MESSAGE = 4;
export const MAX_REFERENCES = 32;
export const MAX_REFERENCE_BYTES: number = 4 * 1024 * 1024;
export const MAX_REFERENCE_ROWS = 64;
export const MAX_REFERENCE_ELEMENT_CHARS = 120;
const MAX_MAPS_TO_CHARS = 200;
const MAX_REFERENCE_JSON_BYTES: number = 256 * 1024;
const REFERENCE_ID = /^R([1-9][0-9]{0,5})$/;
const REFERENCE_FILE = /^R([1-9][0-9]{0,5})\.(?:png|jpg|gif|webp|json)$/i;
// control characters and line or paragraph separators, which an element name never holds
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const STATUSES: readonly ReferenceRowStatus[] = ['mapped', 'needsDecision', 'out'];

export type ReferenceImageType = 'png' | 'jpg' | 'gif' | 'webp';

/** A reference image's type by its bytes' signature, never by the block's declared type; undefined for any other bytes. */
export function referenceImageType(bytes: Uint8Array): ReferenceImageType | undefined {
  const ascii = (start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).toString('latin1');
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 8) === 'PNG\r\n\x1a\n') return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return undefined;
}

/** An image core will save as a reference once its message commits. */
export interface PlannedReference extends DesignReferenceNote {
  readonly bytes: Buffer;
}

/** The file R<n>.json holds. */
export interface ReferenceFile {
  readonly schemaVersion: 1;
  readonly image: string;
  readonly userEntryId: string;
  readonly sha256: string;
  readonly mapping?: readonly ReferenceRow[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const numberOf = (id: string): number => Number(REFERENCE_ID.exec(id)?.[1] ?? 0);
const jsonPath = (id: string): string => `${REFERENCES_DIR}/${id}.json`;

function notesOf(value: unknown): DesignReferenceNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes = value.flatMap((note: unknown) => (isRecord(note) && typeof note['id'] === 'string' && REFERENCE_ID.test(note['id']) && typeof note['image'] === 'string' && Number.isInteger(note['imageIndex'])
    ? [{ id: note['id'], image: note['image'], imageIndex: note['imageIndex'] as number }]
    : []));
  return notes.length === value.length ? notes : undefined;
}

/** The references each user entry of `branch` saved, by its `damocles.design-references` entry. */
export function referencesOnBranch(branch: readonly unknown[]): Map<string, DesignReferenceNote[]> {
  const saved = new Map<string, DesignReferenceNote[]>();
  for (const entry of branch) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== DAMOCLES_DESIGN_REFERENCES_ENTRY || !isRecord(entry['data'])) continue;
    const { userEntryId } = entry['data'];
    const notes = notesOf(entry['data']['references']);
    if (typeof userEntryId === 'string' && notes) saved.set(userEntryId, notes);
  }
  return saved;
}

export function referencesEntryData(userEntryId: string, references: readonly DesignReferenceNote[]): Record<string, unknown> {
  return { userEntryId, references: references.map(({ id, image, imageIndex }) => ({ id, image, imageIndex })) };
}

/** The next R<n>: past every references file in the folder, every reference on the branch and every one `reserved` holds. */
export async function nextReferenceNumber(folder: string, branch: readonly unknown[], reserved: Iterable<string>): Promise<number> {
  let highest = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(path.join(folder, REFERENCES_DIR));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  for (const name of names) {
    const match = REFERENCE_FILE.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  for (const notes of referencesOnBranch(branch).values()) for (const note of notes) highest = Math.max(highest, numberOf(note.id));
  for (const id of reserved) highest = Math.max(highest, numberOf(id));
  return highest + 1;
}

/**
 * The images of a design chat message that become references (PD-40): its image blocks without the preview's origin marker,
 * at most MAX_REFERENCES_PER_MESSAGE, numbered from `first` up to R<MAX_REFERENCES>, each a known image of at most
 * MAX_REFERENCE_BYTES. `skipped` counts the outside images left out.
 */
export function planReferences(blocks: readonly UserContentBlock[], first: number): { readonly planned: PlannedReference[]; readonly skipped: number } {
  const planned: PlannedReference[] = [];
  let skipped = 0;
  let imageIndex = -1;
  for (const block of blocks) {
    if (block.type !== 'image') continue;
    imageIndex++;
    if (block.origin === 'designPreview') continue;
    const n = first + planned.length;
    const bytes = Buffer.from(block.source.data, 'base64');
    const type = referenceImageType(bytes);
    if (planned.length >= MAX_REFERENCES_PER_MESSAGE || n > MAX_REFERENCES || bytes.length > MAX_REFERENCE_BYTES || type === undefined) {
      skipped++;
      continue;
    }
    planned.push({ id: `R${n}`, image: `${REFERENCES_DIR}/R${n}.${type}`, imageIndex, bytes });
  }
  return { planned, skipped };
}

/** The line the model reads after the user's text, naming each saved image's reference in the order the images came. */
export function referencesPromptNote(planned: readonly DesignReferenceNote[]): string {
  return `[Damocles saved the attached ${planned.length === 1 ? 'image' : 'images'} as ${planned.map((reference) => `${reference.id} (${reference.image})`).join(', ')}. Map ${planned.length === 1 ? 'it' : 'them'} with MapReference.]`;
}

/** Writes the image, then R<n>.json naming it, so a json always names a written image. */
export async function writeReference(folder: string, reference: PlannedReference, userEntryId: string): Promise<ReferenceFile> {
  const file: ReferenceFile = { schemaVersion: 1, image: reference.image, userEntryId, sha256: createHash('sha256').update(reference.bytes).digest('hex') };
  await writeTextAtomic(path.join(folder, ...reference.image.split('/')), reference.bytes);
  await writeJsonAtomic(path.join(folder, REFERENCES_DIR, `${reference.id}.json`), file);
  return file;
}

function rowOf(value: unknown): ReferenceRow | undefined {
  if (!isRecord(value)) return undefined;
  const { element, mapsTo, status } = value;
  if (typeof element !== 'string' || !STATUSES.includes(status as ReferenceRowStatus) || (mapsTo !== null && typeof mapsTo !== 'string')) return undefined;
  return { element, mapsTo, status: status as ReferenceRowStatus };
}

/** R<n>.json of design folder `folder`, through the confined read (D74); undefined when it is missing or not core's shape. */
export async function readReference(folder: string, id: string): Promise<ReferenceFile | undefined> {
  if (!REFERENCE_ID.test(id)) return undefined;
  const read = await readDesignFile(folder, jsonPath(id), MAX_REFERENCE_JSON_BYTES);
  if (read.kind !== 'file') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(read.bytes.toString('utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
  if (!isRecord(value) || value['schemaVersion'] !== 1 || typeof value['image'] !== 'string' || typeof value['userEntryId'] !== 'string' || typeof value['sha256'] !== 'string') return undefined;
  const mapping = value['mapping'] === undefined ? undefined : Array.isArray(value['mapping']) ? value['mapping'].map(rowOf) : [undefined];
  if (mapping?.some((row) => row === undefined)) return undefined;
  return { schemaVersion: 1, image: value['image'], userEntryId: value['userEntryId'], sha256: value['sha256'], ...(mapping ? { mapping: mapping as ReferenceRow[] } : {}) };
}

export const mapReferenceSchema: TSchema = Type.Object({
  reference: Type.String({ maxLength: 8, description: 'The reference, such as R1.' }),
  rows: Type.Array(Type.Object({
    element: Type.String({ maxLength: MAX_REFERENCE_ELEMENT_CHARS, description: 'An element of the image, such as "Hero card".' }),
    mapsTo: Type.Optional(Type.String({ maxLength: MAX_MAPS_TO_CHARS, description: 'An inventory component (Button), a tokens.css token (--radius-lg) or a type field (Contact.email).' })),
    status: Type.Union([Type.Literal('mapped'), Type.Literal('needsDecision'), Type.Literal('out')]),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_REFERENCE_ROWS }),
}, { additionalProperties: false });

export interface MapReferenceInput {
  readonly reference: string;
  readonly rows: readonly { readonly element: string; readonly mapsTo?: string; readonly status: ReferenceRowStatus }[];
}

/** Thrown when MapReference refuses its input; the message lists every problem. */
export class ReferenceRefusedError extends Error {}

/** Why `mapsTo` names nothing the app has, or undefined when it names a component, a token or a type field. */
function missingTarget(mapsTo: string, inventory: DesignInventory, tokens: readonly string[]): string | undefined {
  if (mapsTo.startsWith('--')) return TWEAK_TOKEN_NAME.test(mapsTo) && tokens.includes(mapsTo) ? undefined : `${mapsTo} is not a token in tokens.css`;
  const dot = mapsTo.indexOf('.');
  if (dot !== -1) {
    const [typeName, field] = [mapsTo.slice(0, dot), mapsTo.slice(dot + 1)];
    const type = inventory.types.find((candidate) => candidate.name === typeName);
    if (!type) return `${typeName} is not a type in inventory.json`;
    return type.fields.includes(field) ? undefined : `${typeName} has no field ${field} in inventory.json`;
  }
  return inventory.components.some((component) => component.name === mapsTo) ? undefined : `${mapsTo} is not a component in inventory.json`;
}

/**
 * MapReference: every row names an element once; a row's mapsTo must name an inventory component, a tokens.css token or a type
 * field, `mapped` needs one, and a row without one is `needsDecision` or `out`. Writes the mapping into R<n>.json.
 */
export async function mapReference(folder: string, input: MapReferenceInput, inventory: DesignInventory, tokens: readonly string[]): Promise<MapReferenceDetails> {
  const reference = await readReference(folder, input.reference);
  if (!reference) throw new ReferenceRefusedError(`No reference ${JSON.stringify(input.reference.slice(0, 8))} is in this design. References are the images the user attached, R1, R2, ...`);
  const problems: string[] = [];
  if (input.rows.length === 0 || input.rows.length > MAX_REFERENCE_ROWS) problems.push(`Map 1 to ${MAX_REFERENCE_ROWS} elements.`);
  const elements = new Set<string>();
  const rows: ReferenceRow[] = [];
  for (const row of input.rows) {
    const element = row.element.trim();
    const name = JSON.stringify(element.slice(0, MAX_REFERENCE_ELEMENT_CHARS));
    if (element === '' || element.length > MAX_REFERENCE_ELEMENT_CHARS || CONTROL.test(element)) problems.push(`${name}: an element is named in 1 to ${MAX_REFERENCE_ELEMENT_CHARS} characters on one line.`);
    else if (elements.has(element)) problems.push(`${name} is listed twice.`);
    elements.add(element);
    const mapsTo = row.mapsTo?.trim() ?? '';
    if (mapsTo === '') {
      if (row.status === 'mapped') problems.push(`${name} is mapped but names nothing it maps to.`);
    } else {
      const missing = missingTarget(mapsTo, inventory, tokens);
      if (missing) problems.push(`${name}: ${missing}. Map it onto what the app has, or mark it needsDecision (ask the user) or out (not taken).`);
    }
    rows.push({ element, mapsTo: mapsTo === '' ? null : mapsTo, status: row.status });
  }
  if (problems.length > 0) throw new ReferenceRefusedError(problems.join('\n'));
  await writeJsonAtomic(path.join(folder, REFERENCES_DIR, `${input.reference}.json`), { ...reference, mapping: rows });
  return { reference: input.reference, image: reference.image, rows };
}

/** A reference row's ref, 'R<n>#<element>', is at most this long: the longest id, '#' and the longest element. */
export const MAX_REFERENCE_ROW_REF_CHARS: number = 8 + MAX_REFERENCE_ELEMENT_CHARS;

function referenceRowParts(ref: string): { readonly id: string; readonly element: string } | undefined {
  const hash = ref.indexOf('#');
  const id = hash === -1 ? '' : ref.slice(0, hash);
  const element = hash === -1 ? '' : ref.slice(hash + 1);
  return REFERENCE_ID.test(id) && element !== '' ? { id, element } : undefined;
}

/** Why `ref` is not of the form 'R<n>#<element>', split at the first '#', or undefined when it is. */
export function referenceRowFormatRefusal(ref: string): string | undefined {
  return referenceRowParts(ref) ? undefined : `A reference is R<n>#<element>, such as R1#Hero card; ${JSON.stringify(ref.slice(0, 80))} is not one.`;
}

/** Why `ref` ('R<n>#<element>', a RecordDecision reference source or a question's reference) names no mapping row of design folder `folder`, or undefined. */
export async function referenceSourceRefusal(folder: string, ref: string): Promise<string | undefined> {
  const parts = referenceRowParts(ref);
  if (!parts) return referenceRowFormatRefusal(ref);
  const { id, element } = parts;
  const reference = await readReference(folder, id);
  if (!reference) return `No reference ${id} is in this design.`;
  if (!reference.mapping?.some((row) => row.element === element)) return `${id} has no mapping row ${JSON.stringify(element.slice(0, MAX_REFERENCE_ELEMENT_CHARS))}; map it with MapReference first.`;
  return undefined;
}
