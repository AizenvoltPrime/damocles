// DeclareTweaks and Keep (PD-13; docs/invariants.md "Design mode"): 2 to 5 controls whose stops are tokens.css tokens only,
// a control locked once a decision settled its property. The declaration lives in the tool result's details; nothing is written.
import { Type, type TSchema } from 'typebox';
import type { DeclareTweaksDetails, TweakControl, TweakLock, TweaksDeclaration } from '../../shared/types/design';
import {
  isTweakColor,
  MAX_TWEAK_CONTROLS,
  MAX_TWEAK_LABEL_CHARS,
  MAX_TWEAK_STOPS,
  MAX_TWEAK_VALUE_CHARS,
  MIN_TWEAK_CONTROLS,
  MIN_TWEAK_STOPS,
  TWEAK_ID,
  TWEAK_TOKEN_NAME,
} from '../../shared/design-tweaks';
import { TOOL_DECLARE_TWEAKS } from '../../shared/tool-names';
import { DAMOCLES_DESIGN_TWEAK_KEPT } from '../pi-session/session-store/constants';
import { currentDecisions, decisionsOnBranch } from './design-entries';

// control characters and line or paragraph separators, which a label never holds
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export const declareTweaksSchema: TSchema = Type.Object({
  controls: Type.Array(Type.Object({
    id: Type.String({ maxLength: 64, description: 'A short id, such as radius; RecordDecision names a kept tweak by it.' }),
    label: Type.String({ maxLength: MAX_TWEAK_LABEL_CHARS, description: 'What the user sees, such as "Corner radius".' }),
    property: Type.String({ maxLength: 122, description: 'The tokens.css token the stops set, such as --radius.' }),
    stops: Type.Array(Type.String({ maxLength: 122 }), { minItems: MIN_TWEAK_STOPS, maxItems: MAX_TWEAK_STOPS, description: 'tokens.css tokens the property can take, such as --radius-sm, --radius-md, --radius-lg.' }),
  }, { additionalProperties: false }), { minItems: MIN_TWEAK_CONTROLS, maxItems: MAX_TWEAK_CONTROLS }),
}, { additionalProperties: false });

export interface DeclareTweaksInput {
  readonly controls: readonly { readonly id: string; readonly label: string; readonly property: string; readonly stops: readonly string[] }[];
}

/** A kept tweak, as its `damocles-design-tweak-kept` entry records it. */
export interface TweakKept {
  readonly toolCallId: string;
  readonly tweakId: string;
  readonly label: string;
  readonly property: string;
  readonly value: string;
}

/** Thrown when DeclareTweaks refuses its input; the message lists every problem. */
export class TweaksRefusedError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function keptOf(entry: unknown): (TweakKept & { readonly userEntryId: string }) | undefined {
  if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== DAMOCLES_DESIGN_TWEAK_KEPT || !isRecord(entry['data'])) return undefined;
  const { userEntryId, toolCallId, tweakId, label, property, value } = entry['data'];
  if (typeof userEntryId !== 'string' || typeof toolCallId !== 'string' || typeof tweakId !== 'string' || typeof label !== 'string') return undefined;
  if (typeof property !== 'string' || !TWEAK_TOKEN_NAME.test(property) || typeof value !== 'string' || !TWEAK_TOKEN_NAME.test(value)) return undefined;
  return { userEntryId, toolCallId, tweakId, label, property, value };
}

/** The latest kept value of tweak `tweakId` on `branch`. */
export function latestKeptTweak(branch: readonly unknown[], tweakId: string): TweakKept | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const kept = keptOf(branch[index]);
    if (kept?.tweakId === tweakId) return kept;
  }
  return undefined;
}

export function tweakKeptEntryData(userEntryId: string, kept: TweakKept): Record<string, unknown> {
  return { userEntryId, toolCallId: kept.toolCallId, tweakId: kept.tweakId, label: kept.label, property: kept.property, value: kept.value };
}

/**
 * The properties current decisions on `branch` settled: a decision whose source is `{kind: 'tweak', ref: <tweakId>}` settles the property
 * of that tweak's latest kept entry, with its chosen value. A later decision on a property replaces an earlier one.
 */
export function tweakLocks(branch: readonly unknown[]): Map<string, TweakLock> {
  const locks = new Map<string, TweakLock>();
  for (const decision of currentDecisions(decisionsOnBranch(branch))) {
    if (decision.source.kind !== 'tweak') continue;
    const kept = latestKeptTweak(branch, decision.source.ref);
    if (kept) locks.set(kept.property, { decisionId: decision.id, value: decision.chosen });
  }
  return locks;
}

/** DeclareTweaks' controls once every id, label, property and stop passes; throws TweaksRefusedError listing every problem. */
export function declareTweaks(input: DeclareTweaksInput, tokens: ReadonlyMap<string, string>, branch: readonly unknown[]): DeclareTweaksDetails {
  const problems: string[] = [];
  if (tokens.size === 0) throw new TweaksRefusedError('tokens.css has no tokens yet; run ExtractTokens first.');
  if (input.controls.length < MIN_TWEAK_CONTROLS || input.controls.length > MAX_TWEAK_CONTROLS) problems.push(`Declare ${MIN_TWEAK_CONTROLS} to ${MAX_TWEAK_CONTROLS} controls.`);
  const ids = new Set<string>();
  const properties = new Set<string>();
  const locks = tweakLocks(branch);
  const controls: TweakControl[] = [];
  for (const control of input.controls) {
    const name = JSON.stringify(control.id.slice(0, 64));
    if (!TWEAK_ID.test(control.id)) problems.push(`${name} is not an id: use letters, digits, - and _.`);
    else if (ids.has(control.id)) problems.push(`Two controls are named ${name}.`);
    ids.add(control.id);
    const label = control.label.trim();
    if (label === '' || label.length > MAX_TWEAK_LABEL_CHARS || CONTROL.test(label)) problems.push(`${name} needs a label of 1 to ${MAX_TWEAK_LABEL_CHARS} characters on one line.`);
    if (!TWEAK_TOKEN_NAME.test(control.property) || !tokens.has(control.property)) problems.push(`${name}: ${control.property} is not a token in tokens.css.`);
    else if (properties.has(control.property)) problems.push(`Two controls set ${control.property}.`);
    properties.add(control.property);
    if (control.stops.length < MIN_TWEAK_STOPS || control.stops.length > MAX_TWEAK_STOPS) problems.push(`${name} needs ${MIN_TWEAK_STOPS} to ${MAX_TWEAK_STOPS} stops.`);
    if (new Set(control.stops).size !== control.stops.length) problems.push(`${name} lists a stop twice.`);
    for (const stop of control.stops) {
      if (!TWEAK_TOKEN_NAME.test(stop) || !tokens.has(stop)) problems.push(`${name}: the stop ${JSON.stringify(stop.slice(0, 122))} is not a token in tokens.css. Stops are existing tokens only.`);
      else if (stop === control.property) problems.push(`${name}: ${stop} cannot be a stop of itself.`);
    }
    const stops = control.stops.map((token) => ({ token, value: (tokens.get(token) ?? '').slice(0, MAX_TWEAK_VALUE_CHARS) }));
    controls.push({
      id: control.id,
      label,
      property: control.property,
      kind: stops.every((stop) => isTweakColor(stop.value)) ? 'swatch' : 'segment',
      stops,
      locked: locks.get(control.property) ?? null,
    });
  }
  if (problems.length > 0) throw new TweaksRefusedError(problems.join('\n'));
  return { controls };
}

function controlOf(value: unknown): TweakControl | undefined {
  if (!isRecord(value) || !Array.isArray(value['stops'])) return undefined;
  const { id, label, property, kind } = value;
  if (typeof id !== 'string' || !TWEAK_ID.test(id) || typeof label !== 'string' || typeof property !== 'string' || !TWEAK_TOKEN_NAME.test(property)) return undefined;
  const stops = value['stops'].flatMap((stop: unknown) => (isRecord(stop) && typeof stop['token'] === 'string' && TWEAK_TOKEN_NAME.test(stop['token']) && typeof stop['value'] === 'string' ? [{ token: stop['token'], value: stop['value'] }] : []));
  if (stops.length !== value['stops'].length) return undefined;
  return { id, label, property, kind: kind === 'swatch' ? 'swatch' : 'segment', stops, locked: null };
}

/** The latest non-error DeclareTweaks result on `branch`, its locks read from the branch now; null when there is none. */
export function tweaksOnBranch(branch: readonly unknown[]): TweaksDeclaration | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    const message = isRecord(entry) && entry['type'] === 'message' ? entry['message'] : undefined;
    if (!isRecord(message) || message['role'] !== 'toolResult' || message['toolName'] !== TOOL_DECLARE_TWEAKS || message['isError'] === true) continue;
    const details = message['details'];
    const toolCallId = message['toolCallId'];
    if (typeof toolCallId !== 'string' || !isRecord(details) || !Array.isArray(details['controls'])) return null;
    const controls = details['controls'].map(controlOf);
    if (controls.some((control) => control === undefined)) return null;
    const locks = tweakLocks(branch);
    return { toolCallId, controls: (controls as TweakControl[]).map((control) => ({ ...control, locked: locks.get(control.property) ?? null })) };
  }
  return null;
}

/** The kept tweak `value` of control `tweakId` makes, or why the latest declaration on `branch` refuses it. */
export function keepTweak(branch: readonly unknown[], tweakId: string, value: string): { readonly kept: TweakKept } | { readonly refused: 'noControl' | 'notAStop' | 'locked' } {
  const declaration = tweaksOnBranch(branch);
  const control = declaration?.controls.find((candidate) => candidate.id === tweakId);
  if (!declaration || !control) return { refused: 'noControl' };
  if (!control.stops.some((stop) => stop.token === value)) return { refused: 'notAStop' };
  if (control.locked) return { refused: 'locked' };
  return { kept: { toolCallId: declaration.toolCallId, tweakId, label: control.label, property: control.property, value } };
}

/** The user prompt a Keep sends, which the model reads too. */
export function keepPromptText(kept: TweakKept): string {
  return `Keep: ${kept.label} → ${kept.value}`;
}

/** Why a RecordDecision tweak source `ref` (a tweak id) with `chosen` is refused, or undefined when `chosen` is its latest kept value. */
export function tweakSourceRefusal(branch: readonly unknown[], ref: string, chosen: string): string | undefined {
  const kept = latestKeptTweak(branch, ref);
  if (!kept) return `No tweak ${JSON.stringify(ref.slice(0, 64))} was kept in this chat. A tweak source is the id of a control the user kept.`;
  if (kept.value !== chosen.trim()) return `The user kept ${kept.value} for ${kept.label}; a decision from that tweak chooses ${kept.value}, not ${JSON.stringify(chosen.slice(0, 122))}.`;
  return undefined;
}
