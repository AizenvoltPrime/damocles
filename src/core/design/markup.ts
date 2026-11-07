// A preview's markup (PD-12, PD-40, PD-41; docs/invariants.md "Design mode"): what the shell sends is parsed as hostile, numbered
// F<n>, turned into the prompt text here, and saved by core alone (PD-26) as feedback/F<n>.png and feedback/F<n>.json.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  designMarkupView,
  parseDesignMarkupView,
  type DesignMarkupNote,
  FEEDBACK_ID,
  MARKUP_NAME,
  MAX_MARKUP_ELEMENT_CHARS,
  MAX_MARKUP_FACT_CHARS,
  MAX_MARKUP_FACTS,
  MAX_MARKUP_MARKS,
  MAX_MARKUP_PIN_TEXT,
  MAX_MARKUP_STROKE_ANCHORS,
  MAX_MARKUP_Y,
  type MarkupAnchor,
  type MarkupJson,
  type MarkupJsonInput,
  type MarkupMark,
  type MarkupPin,
} from '../../shared/design-markup';
import { SCREEN_FILE } from '../../shared/design-paths';
import { MAX_RENDER_IMAGE_SIDE, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH, pngSize } from '../../shared/design-render';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import { MAX_IMAGE_BASE64_LENGTH } from '../../shared/types/content';
import { DAMOCLES_DESIGN_MARKUP_ENTRY } from '../pi-session/session-store/constants';
import { readDesignFile } from './design-file-read';
import { writeJsonAtomic, writeTextAtomic } from './design-state';

export const FEEDBACK_DIR = 'feedback';
/** The PNG is one image block of the prompt, so its base64 fits one (MAX_IMAGE_BASE64_LENGTH, under 8 MiB of bytes). */
export const MAX_MARKUP_PNG_BASE64: number = MAX_IMAGE_BASE64_LENGTH;
const MAX_MARKUP_JSON_BYTES: number = 1024 * 1024;
const MAX_ZOOM = 16;
const MAX_FILE_CHARS = 200;
// control characters and line or paragraph separators, which an element name never holds
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PIN_REF = /^(F[1-9][0-9]{0,5})#pin([1-9][0-9]{0,2})$/;

/** What the shell sent breaks the markup contract; the message is for the log, never the user. */
export class MarkupInvalidError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(what: string): never {
  throw new MarkupInvalidError(what);
}

function name(value: unknown, what: string): string {
  if (typeof value !== 'string' || !MARKUP_NAME.test(value)) fail(`${what} is not a name`);
  return value;
}

function number(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${what} is out of range`);
  return value;
}

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || CONTROL.test(value)) fail(`${what} is not a bounded text`);
  return value;
}

function anchorOf(value: unknown): MarkupAnchor | null {
  if (value === null) return null;
  if (!isRecord(value) || !Array.isArray(value['facts']) || value['facts'].length > MAX_MARKUP_FACTS) fail('a pin anchor is malformed');
  return {
    element: text(value['element'], MAX_MARKUP_ELEMENT_CHARS, 'an anchor element'),
    facts: value['facts'].map((fact: unknown) => text(fact, MAX_MARKUP_FACT_CHARS, 'an anchor fact')),
  };
}

function markOf(value: unknown, width: number): MarkupMark {
  if (!isRecord(value)) fail('a mark is malformed');
  const x = (raw: unknown): number => number(raw, 0, width, 'a mark x');
  const y = (raw: unknown): number => number(raw, 0, MAX_MARKUP_Y, 'a mark y');
  if (value['type'] === 'pin') {
    const at = value['at'];
    if (!Array.isArray(at) || at.length !== 2) fail('a pin position is malformed');
    const kind = value['kind'];
    if (kind !== 'change' && kind !== 'note') fail('a pin kind is unknown');
    const pinText = value['text'];
    if (typeof pinText !== 'string' || pinText.length > MAX_MARKUP_PIN_TEXT) fail('a pin text is too long');
    const n = value['n'];
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_MARKUP_MARKS) fail('a pin number is out of range');
    if (!('anchor' in value)) fail('a pin has no anchor field');
    return { type: 'pin', n: n as number, kind, text: pinText, at: [x(at[0]), y(at[1])], anchor: anchorOf(value['anchor']) };
  }
  const type = value['type'];
  if (type !== 'pen' && type !== 'arrow' && type !== 'box') fail('a mark type is unknown');
  const bbox = value['bbox'];
  const anchors = value['anchors'];
  if (!Array.isArray(bbox) || bbox.length !== 4) fail('a stroke box is malformed');
  if (!Array.isArray(anchors) || anchors.length > MAX_MARKUP_STROKE_ANCHORS) fail('a stroke lists too many elements');
  const [left, top] = [x(bbox[0]), y(bbox[1])];
  const w = number(bbox[2], 0, width - left, 'a stroke width');
  const h = number(bbox[3], 0, MAX_MARKUP_Y - top, 'a stroke height');
  return { type, bbox: [left, top, w, h], anchors: anchors.map((anchor: unknown) => text(anchor, MAX_MARKUP_ELEMENT_CHARS, 'a stroke element')) };
}

/** The shell's markup, parsed as hostile into a fresh object of the contract's fields only; throws MarkupInvalidError. */
export function parseMarkupJson(value: unknown): MarkupJsonInput {
  if (!isRecord(value) || !isRecord(value['viewport']) || !Array.isArray(value['marks'])) fail('the markup is not an object');
  const file = value['file'];
  if (typeof file !== 'string' || file.length > MAX_FILE_CHARS || !SCREEN_FILE.test(file) || !isRelativeFilePath(file) || hasUnsafeWindowsSegment(file)) fail('the file is not a screen');
  const width = number(value['viewport']['width'], MIN_RENDER_WIDTH, MAX_RENDER_WIDTH, 'the width');
  if (!Number.isInteger(width)) fail('the width is not whole');
  const marks = value['marks'];
  if (marks.length === 0 || marks.length > MAX_MARKUP_MARKS) fail('the mark count is out of range');
  const parsed = marks.map((mark: unknown) => markOf(mark, width));
  const pins = parsed.filter((mark): mark is MarkupPin => mark.type === 'pin').map((pin) => pin.n);
  if (new Set(pins).size !== pins.length) fail('two pins share a number');
  return {
    screen: value['screen'] === null ? null : name(value['screen'], 'the screen'),
    file,
    viewport: { breakpoint: name(value['viewport']['breakpoint'], 'the breakpoint'), width },
    zoom: number(value['zoom'], Number.MIN_VALUE, MAX_ZOOM, 'the zoom'),
    pixelRatio: number(value['pixelRatio'], Number.MIN_VALUE, MAX_ZOOM, 'the pixel ratio'),
    state: name(value['state'], 'the state'),
    marks: parsed,
  };
}

/** The PNG's bytes once its base64, signature, IHDR and sides pass (PD-41); throws MarkupInvalidError. */
export function parseMarkupPng(base64: unknown): Buffer {
  if (typeof base64 !== 'string' || base64.length === 0 || base64.length > MAX_MARKUP_PNG_BASE64 || base64.length % 4 !== 0 || !BASE64.test(base64)) fail('the image is not bounded base64');
  const bytes = Buffer.from(base64, 'base64');
  let size: { width: number; height: number };
  try {
    size = pngSize(bytes);
  } catch {
    fail('the image is not a PNG');
  }
  if (size.width < 1 || size.height < 1 || size.width > MAX_RENDER_IMAGE_SIDE || size.height > MAX_RENDER_IMAGE_SIDE) fail(`the image is ${size.width} x ${size.height} px`);
  return bytes;
}

/** The user message's text: a header line, then one line per mark in order. Also the model's. */
export function markupPromptText(feedbackId: string, markup: MarkupJsonInput): string {
  const elements = (names: readonly string[]): string => (names.length > 0 ? names.join(', ') : 'no element');
  const lines = markup.marks.map((mark) => {
    if (mark.type !== 'pin') return `${mark.type === 'pen' ? 'Pen' : mark.type === 'arrow' ? 'Arrow' : 'Box'} over ${elements(mark.anchors)}`;
    const comment = mark.text.replace(/\s+/g, ' ').trim();
    return `Pin ${mark.n} (${mark.kind}) on ${mark.anchor?.element ?? 'no element'}${comment ? `: ${comment}` : ''}`;
  });
  return [`Markup ${feedbackId} on ${markup.file} at ${markup.viewport.breakpoint} · ${markup.viewport.width} · ${markup.state}:`, ...lines].join('\n');
}

export const feedbackImagePath = (feedbackId: string): string => `${FEEDBACK_DIR}/${feedbackId}.png`;
const feedbackJsonPath = (feedbackId: string): string => `${FEEDBACK_DIR}/${feedbackId}.json`;

const numberOf = (feedbackId: string): number => Number(FEEDBACK_ID.exec(feedbackId)?.[1] ?? 0);

/** The user entry each markup was sent as on `branch`, by its `damocles.design-markup` entry. */
export function markupEntriesOnBranch(branch: readonly unknown[]): Map<string, DesignMarkupNote> {
  const sent = new Map<string, DesignMarkupNote>();
  for (const entry of branch) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== DAMOCLES_DESIGN_MARKUP_ENTRY || !isRecord(entry['data'])) continue;
    const { userEntryId, feedbackId } = entry['data'];
    if (typeof userEntryId !== 'string' || typeof feedbackId !== 'string' || !FEEDBACK_ID.test(feedbackId)) continue;
    const markup = parseDesignMarkupView(entry['data']['markup']);
    sent.set(userEntryId, { feedbackId, ...(markup ? { markup } : {}) });
  }
  return sent;
}

export function markupEntryData(userEntryId: string, feedbackId: string, markup: MarkupJsonInput): Record<string, unknown> {
  return { userEntryId, feedbackId, markup: designMarkupView(markup) };
}

/** The next F<n>: past every feedback file in the folder, every markup on the branch and every one `reserved` holds. */
export async function nextFeedbackId(folder: string, branch: readonly unknown[], reserved: Iterable<string>): Promise<string> {
  let highest = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(path.join(folder, FEEDBACK_DIR));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  for (const file of names) {
    const match = /^(F[1-9][0-9]{0,5})\.(?:png|json)$/i.exec(file);
    if (match) highest = Math.max(highest, numberOf(match[1]!.toUpperCase()));
  }
  for (const feedbackId of [...[...markupEntriesOnBranch(branch).values()].map((sent) => sent.feedbackId), ...reserved]) highest = Math.max(highest, numberOf(feedbackId));
  return `F${highest + 1}`;
}

/** Writes feedback/F<n>.png, then feedback/F<n>.json, whose `image` names it. */
export async function writeMarkupFiles(folder: string, feedbackId: string, png: Uint8Array, markup: MarkupJsonInput): Promise<MarkupJson> {
  const json: MarkupJson = { ...markup, image: feedbackImagePath(feedbackId) };
  await writeTextAtomic(path.join(folder, FEEDBACK_DIR, `${feedbackId}.png`), png);
  await writeJsonAtomic(path.join(folder, FEEDBACK_DIR, `${feedbackId}.json`), json);
  return json;
}

/**
 * Why a RecordDecision source `ref` ('F<n>#pin<k>') is no change pin of design folder `folder`, or undefined when it is one.
 * The file is read through the confined design read (D74), so only core's own feedback/F<n>.json counts.
 */
export async function markupSourceRefusal(folder: string, ref: string): Promise<string | undefined> {
  const match = PIN_REF.exec(ref);
  if (!match) return `A markup source is F<n>#pin<k>, such as F1#pin1; ${JSON.stringify(ref.slice(0, 80))} is not one.`;
  const [, feedbackId, pin] = match;
  const read = await readDesignFile(folder, feedbackJsonPath(feedbackId!), MAX_MARKUP_JSON_BYTES);
  if (read.kind !== 'file') return `No markup ${feedbackId} is in this design.`;
  let markup: MarkupJsonInput;
  try {
    markup = parseMarkupJson(JSON.parse(read.bytes.toString('utf8')) as unknown);
  } catch (err) {
    if (err instanceof MarkupInvalidError || err instanceof SyntaxError) return `${feedbackJsonPath(feedbackId!)} cannot be read.`;
    throw err;
  }
  const found = markup.marks.find((mark): mark is MarkupPin => mark.type === 'pin' && mark.n === Number(pin));
  if (!found) return `Markup ${feedbackId} has no pin ${pin}.`;
  if (found.kind !== 'change') return `Pin ${pin} of ${feedbackId} is a note, and only a change pin becomes a decision.`;
  return undefined;
}
