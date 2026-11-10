// A PreviewJourney's steps (PD-13, PD-45): their bounds and the one validation core runs on the model's arguments and desktop
// main runs again on what a core sends. Every pattern here is linear.
import { JOURNEY_KEYS, type JourneyKey, type JourneyStep, type JourneyTarget } from './types/design';

/** Steps per journey, asserts counted (open-codesign's preview.ts limit). */
export const MAX_JOURNEY_STEPS = 16;
export const MAX_JOURNEY_TARGET_CHARS = 200;
export const MAX_JOURNEY_VALUE_CHARS = 1000;
export const MAX_JOURNEY_UNTESTED = 16;
export const MAX_JOURNEY_UNTESTED_CHARS = 300;
export const MAX_JOURNEY_MESSAGE_CHARS = 400;
/** A width's DOM outline for a model that reads no images: the runner's answer bound (D85). */
export const MAX_JOURNEY_OUTLINE_CHARS: number = 64 * 1024;
/** Each step, an action's wait for its target included, ends within this many ms. */
export const JOURNEY_STEP_TIMEOUT_MS = 5000;

/** The ARIA roles a `{role, name}` target may name: Playwright's `getByRole` roles. */
export const JOURNEY_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code',
  'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document',
  'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup',
  'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
  'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer',
  'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

// A target never holds a control character; a value may hold a newline or a tab (a textarea's text).
// eslint-disable-next-line no-control-regex
const TARGET_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const VALUE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keysWithin = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

function targetText(value: unknown, what: string, problems: string[], at: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${at}: ${what} must be text.`);
    return undefined;
  }
  if (value.length > MAX_JOURNEY_TARGET_CHARS) problems.push(`${at}: ${what} is longer than ${MAX_JOURNEY_TARGET_CHARS} characters.`);
  else if (TARGET_CONTROL.test(value)) problems.push(`${at}: ${what} holds a control character.`);
  return value;
}

function valueText(value: unknown, what: string, problems: string[], at: string, empty: boolean): string | undefined {
  if (typeof value !== 'string' || (!empty && value === '')) {
    problems.push(`${at}: ${what} must be ${empty ? 'text' : 'text that is not empty'}.`);
    return undefined;
  }
  if (value.length > MAX_JOURNEY_VALUE_CHARS) problems.push(`${at}: ${what} is longer than ${MAX_JOURNEY_VALUE_CHARS} characters.`);
  else if (VALUE_CONTROL.test(value)) problems.push(`${at}: ${what} holds a control character.`);
  return value;
}

function parseTarget(raw: unknown, problems: string[], at: string): JourneyTarget | undefined {
  if (!isRecord(raw)) {
    problems.push(`${at}: target must be {role, name}, {label}, {placeholder} or {text}.`);
    return undefined;
  }
  const exact = raw['exact'];
  if (exact !== undefined && typeof exact !== 'boolean') {
    problems.push(`${at}: target.exact must be true or false.`);
    return undefined;
  }
  // absent means exact, so only exact: false travels; an app's parser before design.journeyScroll refuses the key
  const exactness = exact === false ? { exact } : {};
  const keys = Object.keys(raw).filter((key) => key !== 'exact').sort().join(',');
  if (keys === 'name,role') {
    const role = raw['role'];
    if (typeof role !== 'string' || !JOURNEY_ROLES.has(role)) {
      problems.push(`${at}: ${JSON.stringify(String(role)).slice(0, 80)} is not an ARIA role.`);
      return undefined;
    }
    const name = targetText(raw['name'], 'the name', problems, at);
    return name === undefined ? undefined : { role, name, ...exactness };
  }
  for (const key of ['label', 'placeholder', 'text'] as const) {
    if (keys !== key) continue;
    const text = targetText(raw[key], `the ${key}`, problems, at);
    if (text === undefined) return undefined;
    return key === 'label' ? { label: text, ...exactness } : key === 'placeholder' ? { placeholder: text, ...exactness } : { text, ...exactness };
  }
  problems.push(`${at}: target must be exactly one of {role, name}, {label}, {placeholder} or {text}, with an optional exact; never a CSS selector.`);
  return undefined;
}

function parseStep(raw: unknown, problems: string[], at: string): JourneyStep | undefined {
  if (!isRecord(raw)) {
    problems.push(`${at}: a step must be an object.`);
    return undefined;
  }
  const action = raw['action'];
  if (action === 'scroll') {
    if (!keysWithin(raw, ['action', 'target', 'to'])) problems.push(`${at}: scroll takes a target, to: "end", or both.`);
    const to = raw['to'];
    if (to !== undefined && to !== 'end') problems.push(`${at}: to must be "end".`);
    if (raw['target'] === undefined && to === undefined) problems.push(`${at}: scroll needs a target to scroll into view, to: "end", or both.`);
    const scrolled = raw['target'] === undefined ? undefined : parseTarget(raw['target'], problems, at);
    if (raw['target'] !== undefined && !scrolled) return undefined;
    return { action, ...(scrolled ? { target: scrolled } : {}), ...(to === 'end' ? { to } : {}) };
  }
  const target = parseTarget(raw['target'], problems, at);
  switch (action) {
    case 'click':
      if (!keysWithin(raw, ['action', 'target'])) problems.push(`${at}: click takes only a target.`);
      return target && { action, target };
    case 'fill':
    case 'select': {
      if (!keysWithin(raw, ['action', 'target', 'value'])) problems.push(`${at}: ${action} takes a target and a value.`);
      const value = valueText(raw['value'], 'value', problems, at, action === 'fill');
      return target && value !== undefined ? { action, target, value } : undefined;
    }
    case 'press': {
      if (!keysWithin(raw, ['action', 'target', 'key'])) problems.push(`${at}: press takes a target and a key.`);
      const key = raw['key'];
      if (typeof key !== 'string' || !(JOURNEY_KEYS as readonly string[]).includes(key)) {
        problems.push(`${at}: key must be one of ${JOURNEY_KEYS.join(', ')}.`);
        return undefined;
      }
      return target && { action, target, key: key as JourneyKey };
    }
    case 'assert': {
      if (!keysWithin(raw, ['action', 'target', 'expect'])) problems.push(`${at}: assert takes a target and expect.`);
      const expect = raw['expect'];
      if (!isRecord(expect) || Object.keys(expect).length !== 1) {
        problems.push(`${at}: expect must be exactly one of {visible}, {textContains} or {valueEquals}.`);
        return undefined;
      }
      if ('visible' in expect) {
        if (typeof expect['visible'] !== 'boolean') problems.push(`${at}: expect.visible must be true or false.`);
        return target && typeof expect['visible'] === 'boolean' ? { action, target, expect: { visible: expect['visible'] } } : undefined;
      }
      if ('textContains' in expect) {
        const text = valueText(expect['textContains'], 'expect.textContains', problems, at, false);
        return target && text !== undefined ? { action, target, expect: { textContains: text } } : undefined;
      }
      if ('valueEquals' in expect) {
        const value = valueText(expect['valueEquals'], 'expect.valueEquals', problems, at, true);
        return target && value !== undefined ? { action, target, expect: { valueEquals: value } } : undefined;
      }
      problems.push(`${at}: expect must be exactly one of {visible}, {textContains} or {valueEquals}.`);
      return undefined;
    }
    default:
      problems.push(`${at}: action must be fill, select, click, press, scroll or assert.`);
      return undefined;
  }
}

/**
 * The steps, or every problem found in them, in English for the model; nothing outside the format passes. `asserts: false`
 * (a render's steps, which only bring the page to a state) lets an action stand without an assert after it.
 */
export function parseJourneySteps(raw: unknown, options: { readonly asserts?: boolean } = {}): { readonly steps: JourneyStep[] } | { readonly problems: string[] } {
  if (!Array.isArray(raw) || raw.length === 0) return { problems: ['steps must be a list of at least one step.'] };
  if (raw.length > MAX_JOURNEY_STEPS) return { problems: [`A journey has at most ${MAX_JOURNEY_STEPS} steps, asserts counted; this one has ${raw.length}. Split it into shorter journeys, each from the screen as it loads, and report the rest as untested.`] };
  const problems: string[] = [];
  const steps = raw.map((step, index) => parseStep(step, problems, `step ${index + 1}`));
  if (options.asserts !== false) raw.forEach((step, index) => {
    const action = isRecord(step) ? step['action'] : undefined;
    const next = raw[index + 1];
    if (action !== 'assert' && (!isRecord(next) || next['action'] !== 'assert')) problems.push(`step ${index + 1}: every action must be followed by an assert of its outcome.`);
  });
  return problems.length > 0 ? { problems } : { steps: steps as JourneyStep[] };
}

/** One step as the format takes it, alone (no assert need follow it); undefined for anything outside the format. */
export function parseJourneyStep(raw: unknown): JourneyStep | undefined {
  const problems: string[] = [];
  const step = parseStep(raw, problems, 'step');
  return problems.length === 0 ? step : undefined;
}

/** The untested remainder, or why it does not fit its bounds. */
export function parseJourneyUntested(raw: unknown): { readonly untested: string[] } | { readonly problems: string[] } {
  if (!Array.isArray(raw)) return { problems: ['untested must be a list.'] };
  if (raw.length > MAX_JOURNEY_UNTESTED) return { problems: [`untested lists at most ${MAX_JOURNEY_UNTESTED} items.`] };
  const problems: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') problems.push(`untested ${index + 1} must be text.`);
    else if (item.length > MAX_JOURNEY_UNTESTED_CHARS) problems.push(`untested ${index + 1} is longer than ${MAX_JOURNEY_UNTESTED_CHARS} characters.`);
    else if (TARGET_CONTROL.test(item)) problems.push(`untested ${index + 1} holds a control character.`);
  });
  return problems.length > 0 ? { problems } : { untested: raw as string[] };
}

/** The first problem as one sentence for the model, with how many more there are. */
export function journeyProblemSentence(problems: readonly string[]): string {
  const first = problems[0] ?? 'steps are malformed.';
  return problems.length > 1 ? `${first} (${problems.length - 1} more problem${problems.length > 2 ? 's' : ''} after this one.)` : first;
}

/** Whether `steps` use what an app without `design.journeyScroll` refuses: a scroll step or a target with any `exact` key. */
export function journeyNeedsScrollFeature(steps: readonly JourneyStep[]): boolean {
  return steps.some((step) => step.action === 'scroll' || (step.target !== undefined && 'exact' in step.target));
}

/** The target as the model and the logs read it: `button "Save"`, `label "Name"`, `text ~"save"` for exact: false. */
export function describeJourneyTarget(target: JourneyTarget | undefined): string {
  if (!target) return 'the page';
  const mark = target.exact === false ? '~' : '';
  if ('role' in target) return `${target.role} ${mark}${JSON.stringify(target.name)}`;
  if ('label' in target) return `label ${mark}${JSON.stringify(target.label)}`;
  if ('placeholder' in target) return `placeholder ${mark}${JSON.stringify(target.placeholder)}`;
  return `text ${mark}${JSON.stringify(target.text)}`;
}
