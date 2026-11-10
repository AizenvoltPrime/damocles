// A journey's steps driven through CDP (PD-13, PD-45; docs/invariants.md "Design mode" D91): a {role, name} or exact {label}
// target is found in Chromium's accessibility tree, a {placeholder}, {text} or inexact {label} target in the DOM as
// Playwright's getByPlaceholder, getByText and getByLabel read it; input is trusted CDP events with real hit-testing; every
// read of the page runs in an isolated world.
// The design renderer's offscreen pages and the replay in a live preview view run the same code. Every answer is page-influenced
// and parsed as hostile.
import { describeJourneyTarget, JOURNEY_STEP_TIMEOUT_MS, MAX_JOURNEY_MESSAGE_CHARS } from '../../../shared/design-journey';
import type { JourneyFailure, JourneyKey, JourneyStep, JourneyStepResult, JourneyTarget } from '../../../shared/types/design';
import { visibleText } from '../../../shared/visible-text';

/** The CDP methods a journey uses; nothing else is ever sent. */
export type JourneyCdpMethod =
  | 'DOM.getDocument' | 'DOM.describeNode' | 'DOM.resolveNode' | 'DOM.scrollIntoViewIfNeeded' | 'DOM.getContentQuads' | 'DOM.focus'
  | 'Accessibility.queryAXTree' | 'Page.getFrameTree' | 'Page.createIsolatedWorld'
  | 'Runtime.evaluate' | 'Runtime.callFunctionOn' | 'Runtime.releaseObjectGroup'
  | 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText';

/** A page's debugger as a journey drives it; each answer is the page's, so it is checked before use. */
export interface JourneyCdp {
  send(method: JourneyCdpMethod, params: Record<string, unknown>): Promise<unknown>;
}

export interface JourneyRunOptions {
  /** CSS px; the width a hidden target is reported at. */
  readonly width: number;
  readonly signal: AbortSignal;
  readonly stepTimeoutMs?: number;
  readonly pollMs?: number;
  /** The replay: each target is outlined from the isolated world before its step acts, which then waits this long. */
  readonly highlight?: { readonly pauseMs: number };
  /** A step started (`result` undefined) or ended. */
  readonly onStep?: (index: number, result: JourneyStepResult | undefined) => void;
  /** Runs after each action that passed, before the next step looks at the page (a render settles it). */
  readonly afterAction?: () => Promise<void>;
}

const WORLD_NAME = 'damocles-journey';
const OBJECT_GROUP = 'damocles-journey';
const POLL_MS = 100;
// a page with more matches than this has no single target anyway
const MAX_AX_NODES = 64;
const MAX_QUOTED_CHARS = 120;
/** The attribute of the replay's outline element, which main's user sheet styles (design-previews.ts). */
export const JOURNEY_HIGHLIGHT_ATTRIBUTE = 'data-damocles-replay';

// Chromium's accessibility tree names a few ARIA roles by their ARIA 1.3 synonym or the role they map to.
const AX_ROLE: Readonly<Record<string, string>> = { img: 'image', presentation: 'none', directory: 'list' };

// Delete is fill's own, for an empty value; a step names only JOURNEY_KEYS.
const KEYS: Readonly<Record<JourneyKey | 'Delete', { readonly key: string; readonly code: string; readonly keyCode: number; readonly text?: string }>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
};

/** The page answered outside what CDP sends. */
class MalformedAnswer extends Error {
  constructor(method: string) {
    super(`The page answered ${method} with something unexpected`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isNodeId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const quoted = (text: string): string => JSON.stringify(visibleText(text.slice(0, MAX_QUOTED_CHARS)));
const cut = (text: string): string => (text.length > MAX_JOURNEY_MESSAGE_CHARS ? `${text.slice(0, MAX_JOURNEY_MESSAGE_CHARS - 1)}…` : text);

async function answerOf(cdp: JourneyCdp, method: JourneyCdpMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await cdp.send(method, params);
  if (!isRecord(answer)) throw new MalformedAnswer(method);
  return answer;
}

// Element functions run with `this` the target, in the journey's isolated world, so no page script reaches their globals.
const VISIBLE_FN = `function() {
  if (!(this instanceof Element)) return false;
  const box = this.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && this.checkVisibility({ visibilityProperty: true });
}`;
const HIT_FN = `function(x, y) {
  const hit = document.elementFromPoint(x, y);
  return hit !== null && (hit === this || this.contains(hit));
}`;
const FILL_KIND_FN = `function() {
  if (this.disabled || this.readOnly) return 'no';
  if (this instanceof HTMLTextAreaElement) return 'text';
  if (this instanceof HTMLInputElement) {
    if (['date', 'time', 'datetime-local', 'month', 'week'].includes(this.type)) return 'set';
    return ['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color', 'hidden'].includes(this.type) ? 'no' : 'text';
  }
  return this instanceof HTMLElement && this.isContentEditable ? 'text' : 'no';
}`;
const SELECT_ALL_FN = `function() {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) { this.select(); return; }
  const range = document.createRange();
  range.selectNodeContents(this);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}`;
// select, and a date or time field, take their value from this world, then tell the page as its own input would
const SET_VALUE_FN = `function(value) {
  this.value = value;
  if (this.value !== value) return false;
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;
const SELECT_FN = `function(value) {
  if (!(this instanceof HTMLSelectElement) || this.multiple || this.disabled) return 'notEditable';
  const options = Array.from(this.options);
  const option = options.find((candidate) => candidate.value === value) ?? options.find((candidate) => candidate.label === value);
  if (!option || option.disabled) return 'noOption';
  this.value = option.value;
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
}`;
const TEXT_FN = `function(expected) {
  const text = (this.textContent ?? '').replace(/\\s+/g, ' ').trim();
  return [text.includes(expected.replace(/\\s+/g, ' ').trim()), text.slice(0, ${MAX_QUOTED_CHARS})];
}`;
const VALUE_FN = `function() {
  return 'value' in this && (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement) ? String(this.value).slice(0, 2000) : null;
}`;
const HIGHLIGHT_FN = `function() {
  const box = this.getBoundingClientRect();
  let mark = document.querySelector('[${JOURNEY_HIGHLIGHT_ATTRIBUTE}]');
  if (!mark) {
    mark = document.createElement('div');
    mark.setAttribute('${JOURNEY_HIGHLIGHT_ATTRIBUTE}', '');
    mark.setAttribute('aria-hidden', 'true');
    document.documentElement.append(mark);
  }
  mark.style.left = (box.left - 4) + 'px';
  mark.style.top = (box.top - 4) + 'px';
  mark.style.width = (box.width + 8) + 'px';
  mark.style.height = (box.height + 8) + 'px';
}`;

// Playwright's text matching: `exact` compares the whitespace-normalized text whole, else a case-insensitive substring of it.
const matcherSource = (wanted: string, exact: boolean): string => `const wanted = ${JSON.stringify(wanted)}.replace(/\\s+/g, ' ').trim()${exact ? '' : '.toLowerCase()'};
  const matches = (value) => { const text = String(value ?? '').replace(/\\s+/g, ' ').trim(); return ${exact ? 'text === wanted' : 'text.toLowerCase().includes(wanted)'}; };`;

// Playwright's getByPlaceholder, getByText and (inexact) getByLabel; for text the deepest element whose text matches is the one
// found. Answers the element when exactly one matches, else how many do.
function findScript(target: { readonly placeholder: string; readonly exact?: boolean } | { readonly text: string; readonly exact?: boolean } | { readonly label: string; readonly exact?: boolean }): string {
  const exact = target.exact !== false;
  if ('placeholder' in target) {
    return `(() => {
  ${matcherSource(target.placeholder, exact)}
  const found = Array.from(document.querySelectorAll('[placeholder]')).filter((element) => matches(element.getAttribute('placeholder')));
  return found.length === 1 ? found[0] : found.length;
})()`;
  }
  if ('label' in target) {
    // a <label>, aria-labelledby or aria-label names the element, as the accessibility tree's name sources the exact query keeps
    return `(() => {
  ${matcherSource(target.label, exact)}
  const found = new Set();
  let scanned = 0;
  for (const element of document.querySelectorAll('[aria-label], [aria-labelledby], input, select, textarea, button, meter, output, progress')) {
    if (++scanned > 20000) break;
    const texts = [element.getAttribute('aria-label')];
    for (const id of (element.getAttribute('aria-labelledby') ?? '').split(/\\s+/).filter(Boolean).slice(0, 16)) texts.push(document.getElementById(id)?.textContent);
    if (element.labels) for (const label of element.labels) texts.push(label.textContent);
    if (texts.some((text) => text != null && matches(text))) found.add(element);
  }
  return found.size === 1 ? [...found][0] : found.size;
})()`;
  }
  return `(() => {
  ${matcherSource(target.text, exact)}
  const skipped = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE']);
  const found = [];
  let scanned = 0;
  for (const element of (document.body ?? document.documentElement).querySelectorAll('*')) {
    if (++scanned > 20000) break;
    if (skipped.has(element.tagName) || element.closest('template, script, style, noscript') !== null) continue;
    if (!matches(element.textContent)) continue;
    if (Array.from(element.children).some((child) => matches(child.textContent))) continue;
    found.push(element);
  }
  return found.length === 1 ? found[0] : found.length;
})()`;
}

/**
 * The box a wheel over `element` scrolls, as Playwright's mouse.wheel chains it: the nearest of the element and its ancestors
 * (across shadow roots) that scrolls on its own and has more content than it shows, else the page's scrolling box; with no
 * element, the page's. Answers [top, scrollable height, visible height].
 */
export const SCROLL_POSITION = `(element) => {
  const page = document.scrollingElement ?? document.documentElement;
  let box = element;
  while (box && box !== document.body && box !== document.documentElement) {
    const overflow = getComputedStyle(box).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && box.scrollHeight > box.clientHeight) break;
    const root = box.getRootNode();
    box = box.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  const scrolled = box && box !== document.body && box !== document.documentElement ? box : page;
  return [scrolled.scrollTop, scrolled.scrollHeight, scrolled.clientHeight];
}`;
const SCROLL_FN = `function() { return (${SCROLL_POSITION})(this); }`;
const PAGE_SCROLL = `(${SCROLL_POSITION})(null)`;
const VIEWPORT_CENTER = '[Math.round(innerWidth / 2), Math.round(innerHeight / 2)]';
const FOCUS_FN = 'function() { if (typeof this.focus === "function") this.focus(); }';
const WHEEL_DELTA = 100_000;
const MAX_WHEELS = 8;
const WHEEL_SETTLE_POLLS = 10;

interface World {
  readonly context: number;
}

async function isolatedWorld(cdp: JourneyCdp): Promise<World> {
  const tree = await answerOf(cdp, 'Page.getFrameTree', {});
  const frame = isRecord(tree['frameTree']) && isRecord(tree['frameTree']['frame']) ? tree['frameTree']['frame']['id'] : undefined;
  if (typeof frame !== 'string') throw new MalformedAnswer('Page.getFrameTree');
  const world = await answerOf(cdp, 'Page.createIsolatedWorld', { frameId: frame, worldName: WORLD_NAME, grantUniveralAccess: false });
  if (!isNodeId(world['executionContextId'])) throw new MalformedAnswer('Page.createIsolatedWorld');
  return { context: world['executionContextId'] };
}

// tooMany: an inexact role query listed more nodes of the role than it reads, so a match may lie past them
type Located = { readonly kind: 'one'; readonly node: number } | { readonly kind: 'none' } | { readonly kind: 'many'; readonly count: number } | { readonly kind: 'tooMany'; readonly role: string };

const located = (ids: readonly number[]): Located => (ids.length === 1 ? { kind: 'one', node: ids[0]! } : ids.length === 0 ? { kind: 'none' } : { kind: 'many', count: ids.length });

// A label names the element it labels: a <label>, aria-labelledby or aria-label is the source that won its name, as
// Playwright's getByLabel matches; a name from its own text, a title or a placeholder is no label.
function namedByLabel(node: Record<string, unknown>): boolean {
  const name = node['name'];
  const sources = isRecord(name) && Array.isArray(name['sources']) ? name['sources'] : [];
  const winner = sources.find((source: unknown) => isRecord(source) && source['superseded'] !== true && isRecord(source['value']) && typeof source['value']['value'] === 'string' && source['value']['value'] !== '');
  if (!isRecord(winner)) return false;
  return winner['type'] === 'relatedElement' || (winner['type'] === 'attribute' && (winner['attribute'] === 'aria-label' || winner['attribute'] === 'aria-labelledby'));
}

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

async function locate(cdp: JourneyCdp, target: JourneyTarget, world: World): Promise<Located> {
  const exact = target.exact !== false;
  if ('role' in target || ('label' in target && exact)) {
    const document = await answerOf(cdp, 'DOM.getDocument', { depth: 0 });
    const root = isRecord(document['root']) ? document['root']['backendNodeId'] : undefined;
    if (!isNodeId(root)) throw new MalformedAnswer('DOM.getDocument');
    // an inexact name queries the role alone and keeps the names that contain it, as getByRole with exact: false does
    const role = 'role' in target ? { role: AX_ROLE[target.role] ?? target.role } : {};
    const query = 'role' in target ? (exact ? { ...role, accessibleName: target.name } : role) : { accessibleName: target.label };
    const answer = await answerOf(cdp, 'Accessibility.queryAXTree', { backendNodeId: root, ...query });
    if (!Array.isArray(answer['nodes'])) throw new MalformedAnswer('Accessibility.queryAXTree');
    const wanted = 'role' in target ? normalized(target.name) : '';
    const ids = new Set<number>();
    // an inexact role query lists every node of the role, so it reads more of them than an exact one needs
    const read = exact ? MAX_AX_NODES : MAX_AX_NODES * 16;
    if (!exact && 'role' in target && answer['nodes'].length > read) return { kind: 'tooMany', role: target.role };
    for (const node of answer['nodes'].slice(0, read)) {
      if (!isRecord(node) || node['ignored'] === true || !isNodeId(node['backendDOMNodeId'])) continue;
      if ('label' in target && !namedByLabel(node)) continue;
      if (!exact) {
        const name = isRecord(node['name']) ? node['name']['value'] : undefined;
        if (typeof name !== 'string' || !normalized(name).includes(wanted)) continue;
      }
      ids.add(node['backendDOMNodeId']);
    }
    return located([...ids]);
  }
  const answer = await answerOf(cdp, 'Runtime.evaluate', { expression: findScript(target), contextId: world.context, objectGroup: OBJECT_GROUP, returnByValue: false });
  const result = answer['result'];
  if (answer['exceptionDetails'] !== undefined || !isRecord(result)) throw new MalformedAnswer('Runtime.evaluate');
  if (result['type'] === 'number') {
    const count = result['value'];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new MalformedAnswer('Runtime.evaluate');
    return count === 0 ? { kind: 'none' } : { kind: 'many', count };
  }
  if (result['subtype'] !== 'node' || typeof result['objectId'] !== 'string') throw new MalformedAnswer('Runtime.evaluate');
  const described = await answerOf(cdp, 'DOM.describeNode', { objectId: result['objectId'] });
  const node = isRecord(described['node']) ? described['node']['backendNodeId'] : undefined;
  if (!isNodeId(node)) throw new MalformedAnswer('DOM.describeNode');
  return { kind: 'one', node };
}

async function call(cdp: JourneyCdp, world: World, node: number, fn: string, args: readonly unknown[] = []): Promise<unknown> {
  const resolved = await answerOf(cdp, 'DOM.resolveNode', { backendNodeId: node, executionContextId: world.context, objectGroup: OBJECT_GROUP });
  const objectId = isRecord(resolved['object']) ? resolved['object']['objectId'] : undefined;
  if (typeof objectId !== 'string') throw new MalformedAnswer('DOM.resolveNode');
  const answer = await answerOf(cdp, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true });
  if (answer['exceptionDetails'] !== undefined || !isRecord(answer['result'])) throw new Error('The page threw in the step');
  return answer['result']['value'];
}

// DOM.getContentQuads answers in the page's CSS px at any page zoom, the space of elementFromPoint and Input.dispatchMouseEvent
// (a replay at zoom below 1 passes in e2e/desktop/design-journey.spec.ts), so the point needs no conversion.
async function clickPoint(cdp: JourneyCdp, node: number): Promise<{ x: number; y: number } | undefined> {
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node });
  const answer = await answerOf(cdp, 'DOM.getContentQuads', { backendNodeId: node });
  const quad = Array.isArray(answer['quads']) ? answer['quads'][0] : undefined;
  if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  return { x: xs.reduce((a, b) => a + b) / 4, y: ys.reduce((a, b) => a + b) / 4 };
}

async function pressKey(cdp: JourneyCdp, name: JourneyKey | 'Delete'): Promise<void> {
  const key = KEYS[name];
  const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: key.text !== undefined ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text !== undefined ? { text: key.text, unmodifiedText: key.text } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(signal.reason);
    return;
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
});

/** `work`, or the signal's reason once it aborts first; a page that never answers cannot hold its caller. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

interface Pending {
  readonly failure: JourneyFailure;
  readonly message: string;
}

// One look at the page: the step's target as the step needs it, or why not yet. Nothing here acts on the page.
type Look = { readonly ready: true; readonly node: number; readonly world: World; readonly point?: { x: number; y: number } } | { readonly ready: false; readonly pending: Pending; readonly passed?: true };

async function look(cdp: JourneyCdp, step: JourneyStep, width: number): Promise<Look> {
  const world = await isolatedWorld(cdp);
  const where = describeJourneyTarget(step.target);
  const found = await locate(cdp, step.target!, world);
  const hiddenExpected = step.action === 'assert' && step.expect !== undefined && 'visible' in step.expect && !step.expect.visible;
  if (found.kind === 'many') return { ready: false, pending: { failure: 'ambiguous', message: `${found.count} elements match ${where} at ${width} px; a target must name exactly one.` } };
  if (found.kind === 'tooMany') return { ready: false, pending: { failure: 'ambiguous', message: `Too many ${found.role} elements at ${width} px to search for ${where}; use an exact name.` } };
  if (found.kind === 'none') {
    if (hiddenExpected) return { ready: false, passed: true, pending: { failure: 'expectation', message: '' } };
    return { ready: false, pending: { failure: 'hidden', message: `No visible element matches ${where} at ${width} px.` } };
  }
  const visible = (await call(cdp, world, found.node, VISIBLE_FN)) === true;
  if (hiddenExpected) {
    return visible ? { ready: false, pending: { failure: 'expectation', message: `${where} is still visible at ${width} px.` } } : { ready: false, passed: true, pending: { failure: 'expectation', message: '' } };
  }
  if (!visible) return { ready: false, pending: { failure: 'hidden', message: `${where} is hidden at ${width} px.` } };
  if (step.action !== 'click') return { ready: true, node: found.node, world };
  const point = await clickPoint(cdp, found.node);
  if (!point) return { ready: false, pending: { failure: 'hidden', message: `${where} has no box to click at ${width} px.` } };
  if ((await call(cdp, world, found.node, HIT_FN, [point.x, point.y])) !== true) return { ready: false, pending: { failure: 'covered', message: `Another element covers ${where} at ${width} px, so it would take the click.` } };
  return { ready: true, node: found.node, world, point };
}

// An assert's expectation on the found element; undefined when it holds.
async function unmet(cdp: JourneyCdp, step: JourneyStep, node: number, world: World): Promise<Pending | undefined> {
  const where = describeJourneyTarget(step.target);
  const expect = step.expect!;
  if ('visible' in expect) return undefined;
  if ('textContains' in expect) {
    const answer = await call(cdp, world, node, TEXT_FN, [expect.textContains]);
    if (!Array.isArray(answer) || typeof answer[0] !== 'boolean' || typeof answer[1] !== 'string') throw new MalformedAnswer('Runtime.callFunctionOn');
    return answer[0] ? undefined : { failure: 'expectation', message: `The text of ${where} does not contain ${quoted(expect.textContains)}; it reads ${quoted(answer[1])}.` };
  }
  const value = await call(cdp, world, node, VALUE_FN);
  if (value !== null && typeof value !== 'string') throw new MalformedAnswer('Runtime.callFunctionOn');
  if (value === null) return { failure: 'expectation', message: `${where} is no input, textarea or select, so it has no value.` };
  return value === expect.valueEquals ? undefined : { failure: 'expectation', message: `The value of ${where} is ${quoted(value)}, not ${quoted(expect.valueEquals)}.` };
}

async function evaluateIn(cdp: JourneyCdp, world: World, expression: string): Promise<unknown> {
  const answer = await answerOf(cdp, 'Runtime.evaluate', { expression, contextId: world.context, returnByValue: true });
  if (answer['exceptionDetails'] !== undefined || !isRecord(answer['result'])) throw new MalformedAnswer('Runtime.evaluate');
  return answer['result']['value'];
}

function scrollPosition(value: unknown): { readonly top: number; readonly height: number; readonly visible: number } {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) throw new MalformedAnswer('Runtime.callFunctionOn');
  return { top: value[0] as number, height: value[1] as number, visible: value[2] as number };
}

// Playwright's mouse.wheel over the target, else the viewport's center, until the box reached the end it had before the wheel;
// content an IntersectionObserver adds there is the next batch, which the step's assert waits for.
async function wheelToEnd(cdp: JourneyCdp, world: World, node: number | undefined, where: string, signal: AbortSignal): Promise<Pending | undefined> {
  let point: { x: number; y: number } | undefined;
  if (node !== undefined) point = await clickPoint(cdp, node);
  else {
    const center = await evaluateIn(cdp, world, VIEWPORT_CENTER);
    if (Array.isArray(center) && center.length === 2 && center.every((item) => typeof item === 'number' && Number.isFinite(item))) point = { x: center[0] as number, y: center[1] as number };
  }
  if (!point) return { failure: 'hidden', message: `${where} has no box to scroll.` };
  const position = async () => scrollPosition(node !== undefined ? await call(cdp, world, node, SCROLL_FN) : await evaluateIn(cdp, world, PAGE_SCROLL));
  const start = await position();
  const end = start.height - start.visible - 1;
  for (let wheel = 0; wheel < MAX_WHEELS; wheel++) {
    let last = await position();
    if (last.top >= end) return undefined;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: WHEEL_DELTA, button: 'none', buttons: 0 });
    // a wheel may scroll smoothly, so the position is read until it stops moving
    for (let poll = 0; poll < WHEEL_SETTLE_POLLS; poll++) {
      await sleep(POLL_MS / 2, signal);
      const now = await position();
      if (now.top === last.top && now.top !== start.top) break;
      last = now;
    }
  }
  return (await position()).top >= end ? undefined : { failure: 'error', message: `${where} did not scroll to its end.` };
}

async function act(cdp: JourneyCdp, step: JourneyStep, ready: Extract<Look, { ready: true }>, signal: AbortSignal): Promise<Pending | undefined> {
  const where = describeJourneyTarget(step.target);
  const { node, world } = ready;
  switch (step.action) {
    case 'click': {
      const { x, y } = ready.point!;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      return undefined;
    }
    case 'fill': {
      const kind = await call(cdp, world, node, FILL_KIND_FN);
      if (kind === 'set') return (await call(cdp, world, node, SET_VALUE_FN, [step.value])) === true ? undefined : { failure: 'notEditable', message: `${where} does not take the value ${quoted(step.value!)}.` };
      if (kind !== 'text') return { failure: 'notEditable', message: `${where} is not an enabled text field, so fill cannot type into it.` };
      await cdp.send('DOM.focus', { backendNodeId: node });
      await call(cdp, world, node, SELECT_ALL_FN);
      if (step.value === '') await pressKey(cdp, 'Delete');
      else await cdp.send('Input.insertText', { text: step.value });
      return undefined;
    }
    case 'select': {
      const outcome = await call(cdp, world, node, SELECT_FN, [step.value]);
      if (outcome === 'ok') return undefined;
      if (outcome === 'noOption') return { failure: 'noOption', message: `${where} has no enabled option with the value or label ${quoted(step.value!)}.` };
      return { failure: 'notEditable', message: `${where} is not an enabled single-choice <select>.` };
    }
    case 'press':
      // locator.press: element.focus(), which leaves the focus where it was on an element that takes none, then the key goes
      // to the focused element or the body
      await call(cdp, world, node, FOCUS_FN);
      await pressKey(cdp, step.key!);
      return undefined;
    case 'scroll':
      await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node });
      return step.to === 'end' ? wheelToEnd(cdp, world, node, where, signal) : undefined;
    case 'assert':
      return undefined;
  }
}

// A scroll with no target wheels the page itself, with nothing to look for first.
async function scrollPage(cdp: JourneyCdp, options: JourneyRunOptions): Promise<Pending | undefined> {
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP });
  return wheelToEnd(cdp, await isolatedWorld(cdp), undefined, 'The page', options.signal);
}

/** Runs the steps in order on the page `cdp` drives; the first failure ends the run, and its result is the last. */
export async function runJourney(cdp: JourneyCdp, steps: readonly JourneyStep[], options: JourneyRunOptions): Promise<{ readonly passed: boolean; readonly steps: JourneyStepResult[] }> {
  const results: JourneyStepResult[] = [];
  for (const [index, step] of steps.entries()) {
    options.onStep?.(index, undefined);
    const result = await runStep(cdp, step, options);
    results.push(result);
    options.onStep?.(index, result);
    if (!result.ok) break;
  }
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP });
  return { passed: results.length === steps.length && results.every((result) => result.ok), steps: results };
}

const errorText = (err: unknown): string => `The page failed the step: ${err instanceof Error ? err.message : String(err)}`;

// Looks are retried until the step's deadline, since the page may still be changing; an action is sent at most once.
async function runStep(cdp: JourneyCdp, step: JourneyStep, options: JourneyRunOptions): Promise<JourneyStepResult> {
  const deadline = Date.now() + (options.stepTimeoutMs ?? JOURNEY_STEP_TIMEOUT_MS);
  const failed = (pending: Pending): JourneyStepResult => ({ ok: false, failure: pending.failure, message: cut(pending.message), ...(pending.failure === 'hidden' ? { hiddenAt: options.width } : {}) });
  let highlighted = false;
  const highlight = async (seen: Extract<Look, { ready: true }>): Promise<void> => {
    if (!options.highlight || highlighted) return;
    highlighted = true;
    await call(cdp, seen.world, seen.node, HIGHLIGHT_FN);
    await sleep(options.highlight.pauseMs, options.signal);
  };
  const done = async (refused: Pending | undefined): Promise<JourneyStepResult> => {
    if (refused) return failed(refused);
    await options.afterAction?.();
    return { ok: true };
  };
  if (step.action === 'scroll' && !step.target) {
    try {
      return await done(await scrollPage(cdp, options));
    } catch (err) {
      if (options.signal.aborted) throw options.signal.reason;
      return failed({ failure: 'error', message: errorText(err) });
    }
  }
  for (;;) {
    options.signal.throwIfAborted();
    let pending: Pending | undefined;
    let ready: Extract<Look, { ready: true }> | undefined;
    try {
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP });
      const seen = await look(cdp, step, options.width);
      if (!seen.ready) {
        if (seen.passed) return { ok: true };
        pending = seen.pending;
      } else if (step.action === 'assert') {
        await highlight(seen);
        pending = await unmet(cdp, step, seen.node, seen.world);
        if (!pending) return { ok: true };
      } else {
        ready = seen;
      }
    } catch (err) {
      // a navigation or a DOM change between two calls: the next look starts over
      if (options.signal.aborted) throw options.signal.reason;
      pending = { failure: 'error', message: errorText(err) };
    }
    if (ready) {
      try {
        await highlight(ready);
        return await done(await act(cdp, step, ready, options.signal));
      } catch (err) {
        if (options.signal.aborted) throw options.signal.reason;
        return failed({ failure: 'error', message: errorText(err) });
      }
    }
    if (Date.now() >= deadline) return failed(pending!);
    await sleep(options.pollMs ?? POLL_MS, options.signal);
  }
}
