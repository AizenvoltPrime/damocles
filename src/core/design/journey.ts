// A screen's journey (PD-13, PD-21, PD-45): PreviewJourney's argument schema, the core-owned `screens/<stem>.journey.json`
// beside its Playwright spec, and whether a journey still vouches for its screen. The steps' validation is shared with desktop
// main (src/shared/design-journey.ts), which runs it again on what a core sends.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { Type, type TSchema } from 'typebox';
import { JOURNEY_FAILURES, JOURNEY_KEYS, type JourneyFile, type JourneyStep, type JourneyStepResult, type JourneyWidthResult } from '../../shared/types/design';
import { DESIGN_NAME, SCREEN_FILE } from '../../shared/design-paths';
import { TOOL_PREVIEW_JOURNEY } from '../../shared/tool-names';
import { MAX_JOURNEY_MESSAGE_CHARS, MAX_JOURNEY_STEPS, MAX_JOURNEY_TARGET_CHARS, MAX_JOURNEY_UNTESTED, MAX_JOURNEY_UNTESTED_CHARS, MAX_JOURNEY_VALUE_CHARS, parseJourneySteps, parseJourneyUntested } from '../../shared/design-journey';
import { log } from '../logger';
import { readDesignFile } from './design-file-read';
import { SCREENS_DIR } from './design-paths';
import { writeJsonAtomic, writeTextAtomic } from './design-state';

const MAX_JOURNEY_FILE_BYTES = 256 * 1024;
// a journey file's name is its screen file's stem, so it is one plain segment that ends in .journey.json (PD-26)
const STEM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const targetText = (what: string) => Type.String({ minLength: 1, maxLength: MAX_JOURNEY_TARGET_CHARS, description: what });

/** PreviewJourney's arguments as the model sees them; `parseJourneySteps` decides what passes. */
export const previewJourneySchema: TSchema = Type.Object({
  screen: Type.String({ maxLength: 400, description: 'The screen file, relative to the design folder, such as screens/S1-contacts.html.' }),
  state: Type.Optional(Type.String({ maxLength: 64, description: 'A state the screen declares in data-ds-states; default when omitted.' })),
  steps: Type.Array(Type.Object({
    action: Type.Union([Type.Literal('fill'), Type.Literal('select'), Type.Literal('click'), Type.Literal('press'), Type.Literal('assert')]),
    target: Type.Union([
      Type.Object({ role: Type.String({ description: 'An ARIA role, such as button, link, textbox, dialog, list or heading.' }), name: targetText('The accessible name, exactly.') }, { additionalProperties: false }),
      Type.Object({ label: targetText('The text of the control\'s <label>, aria-label or aria-labelledby, exactly.') }, { additionalProperties: false }),
      Type.Object({ placeholder: targetText('The placeholder attribute, exactly.') }, { additionalProperties: false }),
      Type.Object({ text: targetText('The element\'s whole visible text, exactly (whitespace collapsed).') }, { additionalProperties: false }),
    ]),
    value: Type.Optional(Type.String({ maxLength: MAX_JOURNEY_VALUE_CHARS, description: 'fill: the text typed in place of the field\'s; select: the option\'s value or label.' })),
    key: Type.Optional(Type.Union(JOURNEY_KEYS.map((key) => Type.Literal(key)), { description: 'press only.' })),
    expect: Type.Optional(Type.Union([
      Type.Object({ visible: Type.Boolean() }, { additionalProperties: false }),
      Type.Object({ textContains: Type.String({ minLength: 1, maxLength: MAX_JOURNEY_VALUE_CHARS }) }, { additionalProperties: false }),
      Type.Object({ valueEquals: Type.String({ maxLength: MAX_JOURNEY_VALUE_CHARS }) }, { additionalProperties: false }),
    ], { description: 'assert only: exactly one expectation.' })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_JOURNEY_STEPS, description: `At most ${MAX_JOURNEY_STEPS} steps, asserts counted; every action is followed by an assert.` }),
  untested: Type.Array(Type.String({ minLength: 1, maxLength: MAX_JOURNEY_UNTESTED_CHARS }), { maxItems: MAX_JOURNEY_UNTESTED, description: 'What this journey leaves untested, in a few words each.' }),
}, { additionalProperties: false });

/** A screen's journey as manifest.json records it (PD-21): the journey's files and outcome, or DesignCheck's waiver. */
export type ScreenJourney =
  | { readonly file: string; readonly spec: string; readonly widths: readonly number[]; readonly passed: boolean; readonly untested: readonly string[] }
  | { readonly waiver: true };

/** The journey's files for screen file `relPath` (`screens/S1-contacts.html`), or undefined when its stem is not a plain name. */
export function journeyFilesOf(relPath: string): { readonly journeyFile: string; readonly specFile: string } | undefined {
  const stem = SCREEN_FILE.exec(relPath)?.[1];
  if (stem === undefined || !STEM.test(stem)) return undefined;
  return { journeyFile: `${SCREENS_DIR}/${stem}.journey.json`, specFile: `${SCREENS_DIR}/${stem}.journey.spec.ts` };
}

/** The SHA-256 of a screen file's bytes, which a journey records and the gate compares (PD-21). */
export function screenContentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isWidth = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

function stepResultOf(value: unknown): JourneyStepResult | undefined {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return undefined;
  const { hiddenAt, failure, message } = value;
  if (hiddenAt !== undefined && !isWidth(hiddenAt)) return undefined;
  if (failure !== undefined && !(JOURNEY_FAILURES as readonly unknown[]).includes(failure)) return undefined;
  if (message !== undefined && (typeof message !== 'string' || message.length > MAX_JOURNEY_MESSAGE_CHARS)) return undefined;
  return value as unknown as JourneyStepResult;
}

function widthResultOf(value: unknown, steps: number): JourneyWidthResult | undefined {
  if (!isRecord(value) || !isWidth(value['width']) || typeof value['passed'] !== 'boolean' || !Array.isArray(value['steps']) || value['steps'].length > steps) return undefined;
  return value['steps'].every((step) => stepResultOf(step) !== undefined) ? value as unknown as JourneyWidthResult : undefined;
}

/** A journey file's content, or undefined when it is not one. */
export function parseJourneyFile(value: unknown): JourneyFile | undefined {
  if (!isRecord(value) || value['schemaVersion'] !== 1) return undefined;
  const { screen, file, viewports, state, contentHash, steps, results, untested, passed, ranAt } = value;
  if (typeof screen !== 'string' || typeof file !== 'string' || typeof state !== 'string' || typeof contentHash !== 'string' || typeof passed !== 'boolean' || typeof ranAt !== 'string') return undefined;
  if (!Array.isArray(viewports) || !viewports.every((viewport) => isRecord(viewport) && isWidth(viewport['width']) && (viewport['breakpoint'] === null || typeof viewport['breakpoint'] === 'string'))) return undefined;
  const parsedSteps = parseJourneySteps(steps);
  if (!('steps' in parsedSteps) || !('untested' in parseJourneyUntested(untested))) return undefined;
  if (!Array.isArray(results) || results.length !== viewports.length || !results.every((result) => widthResultOf(result, parsedSteps.steps.length) !== undefined)) return undefined;
  return value as unknown as JourneyFile;
}

/** The journey file `relFile` of design folder `folder`; undefined when there is none or it does not parse. */
export async function readJourneyFile(folder: string, relFile: string): Promise<JourneyFile | undefined> {
  const read = await readDesignFile(folder, relFile, MAX_JOURNEY_FILE_BYTES);
  if (read.kind !== 'file') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(read.bytes.toString('utf8'));
  } catch (err) {
    log('[Journey] %s of %s is not JSON, so the screen has no journey: %O', relFile, folder, err);
    return undefined;
  }
  const journey = parseJourneyFile(value);
  if (!journey) log('[Journey] %s of %s is not a journey, so the screen has no journey', relFile, folder);
  return journey;
}

/** Writes the journey and its spec; core alone writes either (PD-26). */
export async function writeJourneyFiles(folder: string, files: { readonly journeyFile: string; readonly specFile: string }, journey: JourneyFile, spec: string): Promise<void> {
  await writeJsonAtomic(path.join(folder, ...files.journeyFile.split('/')), journey);
  await writeTextAtomic(path.join(folder, ...files.specFile.split('/')), spec);
}

/**
 * Whether `journey` vouches for its screen now (PD-21): run against the screen's current bytes and passed at every one of
 * `widths`. The reason names what the designer must do otherwise.
 */
export function journeyStanding(journey: JourneyFile | undefined, screenHash: string, widths: readonly number[]): { readonly passes: true } | { readonly passes: false; readonly reason: 'missing' | 'stale' | 'failed' | 'widths' } {
  if (!journey) return { passes: false, reason: 'missing' };
  if (journey.contentHash !== screenHash) return { passes: false, reason: 'stale' };
  const passedAt = new Set(journey.results.filter((result) => result.passed && result.steps.length === journey.steps.length && result.steps.every((step) => step.ok)).map((result) => result.width));
  if (widths.every((width) => passedAt.has(width))) return { passes: true };
  return { passes: false, reason: journey.passed ? 'widths' : 'failed' };
}

/**
 * The journey PreviewJourney call `toolCallId` ran, as its result on `branch` records it, for a replay (D93); never what a
 * webview sends. Undefined when the branch holds no such result or it does not parse.
 */
export function journeyOnBranch(branch: readonly unknown[], toolCallId: string): { readonly relPath: string; readonly state: string; readonly steps: readonly JourneyStep[] } | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    const message = isRecord(entry) && entry['type'] === 'message' ? entry['message'] : undefined;
    if (!isRecord(message) || message['role'] !== 'toolResult' || message['toolCallId'] !== toolCallId || message['toolName'] !== TOOL_PREVIEW_JOURNEY) continue;
    const details = message['details'];
    if (!isRecord(details)) return undefined;
    const { relPath, state } = details;
    const steps = parseJourneySteps(details['steps']);
    if (typeof relPath !== 'string' || journeyFilesOf(relPath) === undefined || typeof state !== 'string' || !DESIGN_NAME.test(state) || !('steps' in steps)) return undefined;
    return { relPath, state, steps: steps.steps };
  }
  return undefined;
}
