// DesignCheck (PD-5, PD-14, PD-21, PD-52): the static rules over every screen against inventory.json, tokens.css and the
// decisions, the width rules over a screen's probe, and the journey gate, with no model call. Each rule's severity is fixed
// here; the model never chooses one. Every pattern over design text is linear, and so is the DOM work per screen.
import * as path from 'node:path';
import { parseHTML } from 'linkedom';
import { parse as parseYaml } from 'yaml';
import { designStateTokens } from '../../shared/design-paths';
import { MAX_PROBE_WIDTHS, MIN_RENDER_WIDTH } from '../../shared/design-render';
import type { DesignCheckIssue, DesignCheckSummary, DesignFidelity, DesignProbeResult } from '../../shared/types/design';
import { cssUrls, declarationsOf, scanCss, withoutCalls, type CssDeclaration } from './css-scan';
import { readDesignFile } from './design-file-read';
import { fileHash, listScreenFiles } from './design-files';
import { DESIGN_DOC_FILE, MAX_DESIGN_DOC_BYTES, MAX_DESIGN_SCREENS, MAX_SCREEN_BYTES, SCREENS_DIR } from './design-paths';
import { resolveDesignViewports, resolveViewportWidth, viewportPresetNames } from './design-preview';
import type { DesignInventory } from './inventory';
import { journeyFilesOf, journeyStanding, readJourneyFile, screenContentHash, type ScreenJourney } from './journey';
import type { DesignSkillRule, LoadedSkillHint } from './skills';

export type DesignCheckRule =
  | 'ds.component-known' | 'ds.variant-known' | 'ds.bind-known' | 'ds.decision-known' | 'ds.new-cites-decision'
  | 'tokens.color' | 'tokens.spacing' | 'tokens.radius' | 'tokens.unknown-var' | 'tokens.redefined'
  | 'screen.states' | 'screen.size' | 'design.frontmatter' | 'fidelity.static-no-scripts' | 'links.no-javascript' | 'net.no-external' | 'assets.local-only' | 'a11y.control-name'
  | 'layout.overflow' | 'ds.hidden-required' | 'journey.required';

/** Each rule's fixed severity (PD-52); a skill hint's rule takes the severity its hint declares. */
export const DESIGN_CHECK_SEVERITY: Readonly<Record<DesignCheckRule, 'error' | 'warning'>> = {
  'ds.component-known': 'error',
  'ds.variant-known': 'error',
  'ds.bind-known': 'error',
  'ds.decision-known': 'error',
  'ds.new-cites-decision': 'error',
  'tokens.color': 'error',
  'tokens.spacing': 'error',
  'tokens.radius': 'error',
  'tokens.unknown-var': 'error',
  'tokens.redefined': 'error',
  'screen.states': 'error',
  'screen.size': 'error',
  'design.frontmatter': 'error',
  'fidelity.static-no-scripts': 'error',
  'links.no-javascript': 'error',
  'net.no-external': 'error',
  'assets.local-only': 'error',
  'a11y.control-name': 'error',
  'layout.overflow': 'error',
  'ds.hidden-required': 'warning',
  'journey.required': 'error',
};

export interface DesignCheckInput {
  readonly folder: string;
  readonly inventory: DesignInventory;
  readonly tokenNames: readonly string[];
  readonly decisionIds: readonly string[];
  readonly fidelity: DesignFidelity | null;
  /** The hints of the skills loaded on the branch, each checked as its rule. */
  readonly skillHints: readonly LoadedSkillHint[];
  /** The journey gate's widths (PD-21), where the rule set gates journeys (FULL); it applies to an interactive design only. */
  readonly journeys?: { readonly widths: readonly number[] };
}

/** One screen as the check read it, for the manifest. */
export interface CheckedScreen {
  readonly id: string;
  /** Relative to the design folder. */
  readonly file: string;
  /** The SHA-256 of the screen file's bytes. */
  readonly contentHash: string;
  /** Its journey or waiver, where the journey gate applies. */
  readonly journey?: ScreenJourney;
}

export interface DesignCheckResult {
  readonly summary: DesignCheckSummary;
  readonly screens: readonly CheckedScreen[];
}

const NAMED_COLORS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX_COLOR = /#[0-9a-f]{3,8}\b/i;
const LENGTH_WORD = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|pt|vh|vw|ch)$/i;
const ZERO_LENGTH = /^-?(?:0+(?:\.0+)?|\.0+)[a-z]+$/i;
const VAR_CALL = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const VAR: ReadonlySet<string> = new Set(['var']);
const VAR_AND_URL: ReadonlySet<string> = new Set(['var', 'url']);
const VAR_AND_CLAMP: ReadonlySet<string> = new Set(['var', 'clamp']);

const COLOR_PROPERTIES = /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|border-image(?:-source)?|outline(?:-color)?|fill|stroke|stop-color|flood-color|lighting-color|box-shadow|text-shadow|text-decoration(?:-color)?|text-emphasis(?:-color)?|caret-color|accent-color|scrollbar-color|column-rule(?:-color)?|(?:backdrop-)?filter|mask(?:-image)?|-webkit-mask(?:-image)?|-webkit-text-stroke(?:-color)?|-webkit-text-fill-color)$/;
const SPACING_PROPERTIES = /^(?:margin|padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$|^(?:gap|row-gap|column-gap|top|right|bottom|left|inset(?:-(?:block|inline)(?:-(?:start|end))?)?)$/;
const RADIUS_PROPERTIES = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;
// SVG presentation attributes and the legacy bgcolor, which set a color outside any style
const COLOR_ATTRIBUTES = ['fill', 'stroke', 'stop-color', 'bgcolor'];
// a screen id, as the preview and a journey's files name it
const SCREEN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_ECHO_CHARS = 120;
// the issues one rule reports on one screen before the rest are counted in one more
const MAX_ISSUES_PER_RULE = 20;
const MAX_LABELLEDBY_REFS = 16;

/** A value from the design as issue text quotes it, cut to MAX_ECHO_CHARS characters. */
const echo = (value: string): string => (value.length > MAX_ECHO_CHARS ? `${value.slice(0, MAX_ECHO_CHARS)}…` : value);

const blank = (text: string | null | undefined): boolean => !/\S/.test(text ?? '');

const TEXT_NODE = 3;
const CDATA_NODE = 4;

/** The parts of linkedom's DOM the check reads. */
interface CheckNode {
  readonly nodeType: number;
  readonly textContent: string | null;
}

interface CheckElement extends CheckNode {
  readonly tagName: string;
  readonly attributes: ArrayLike<{ readonly name: string; readonly value: string }>;
  readonly parentElement: CheckElement | null;
  readonly childNodes: ArrayLike<CheckNode>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  matches(selector: string): boolean;
}

interface CheckDocument {
  readonly documentElement: CheckElement | null;
  querySelectorAll(selector: string): ArrayLike<CheckElement>;
}

// PD-21's interactive controls: a screen with none of these is waived from the journey gate (D90). Any script counts, since
// one can wire any element.
const INTERACTIVE_TAGS = new Set(['input', 'select', 'textarea', 'button', 'summary', 'details', 'script']);
// WAI-ARIA 1.2's widget roles, composite ones included, a superset of CONTROL_ROLES; a focusable separator is caught by [tabindex].
const WIDGET_ROLES = new Set([
  'button', 'checkbox', 'gridcell', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'progressbar', 'radio', 'scrollbar',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'tabpanel', 'textbox', 'treeitem',
  'combobox', 'grid', 'listbox', 'menu', 'menubar', 'radiogroup', 'tablist', 'tree', 'treegrid',
]);

function isInteractive(element: CheckElement, tag: string): boolean {
  if (INTERACTIVE_TAGS.has(tag) || element.hasAttribute('tabindex') || element.hasAttribute('contenteditable')) return true;
  if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) return true;
  if ((tag === 'audio' || tag === 'video') && element.hasAttribute('controls')) return true;
  if (Array.from(element.attributes).some((attribute) => attribute.name.toLowerCase().startsWith('on'))) return true;
  return (element.getAttribute('role') ?? '').toLowerCase().split(/\s+/).some((role) => WIDGET_ROLES.has(role));
}

const CONTROL_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'combobox', 'textbox', 'searchbox', 'slider', 'option', 'spinbutton']);
const RESOURCE_ATTRIBUTES = ['src', 'srcset', 'poster', 'data'];
const COLLECTION = 'table, ul, ol, [role="list"], [role="table"], [role="grid"]';
const ACTION = 'button, a[href], [role="button"], input[type="submit"], input[type="button"]';

/** What the check looks up per element, built once per screen so each lookup is constant time. */
interface ScreenIndex {
  readonly byId: ReadonlyMap<string, CheckElement>;
  /** The ids a `<label for>` with text names. */
  readonly labelled: ReadonlySet<string>;
  /** Elements whose text content is not blank. */
  readonly withText: ReadonlySet<CheckElement>;
  /** Elements with an image alt or an aria-label below them that is not blank. */
  readonly described: ReadonlySet<CheckElement>;
  /** Elements with an action (ACTION) below them. */
  readonly withAction: ReadonlySet<CheckElement>;
  /** Each element's nearest `<label>`, itself included. */
  readonly label: ReadonlyMap<CheckElement, CheckElement>;
  /** The elements of a `data-ds-state-only` block, the block included. */
  readonly stateOnly: ReadonlySet<CheckElement>;
}

/** `elements` is the screen's every element in document order, so a parent comes before its children. */
function indexScreen(elements: readonly CheckElement[]): ScreenIndex {
  const byId = new Map<string, CheckElement>();
  const label = new Map<CheckElement, CheckElement>();
  const stateOnly = new Set<CheckElement>();
  for (const element of elements) {
    const id = element.getAttribute('id');
    if (id !== null && !byId.has(id)) byId.set(id, element);
    const parent = element.parentElement;
    const nearest = element.tagName.toLowerCase() === 'label' ? element : parent ? label.get(parent) : undefined;
    if (nearest) label.set(element, nearest);
    if (element.hasAttribute('data-ds-state-only') || (parent !== null && stateOnly.has(parent))) stateOnly.add(element);
  }
  const withText = new Set<CheckElement>();
  const described = new Set<CheckElement>();
  const withAction = new Set<CheckElement>();
  // in reverse, each element's children are settled before it
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!;
    if (!withText.has(element) && Array.from(element.childNodes).some((node) => (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) && !blank(node.textContent))) withText.add(element);
    const parent = element.parentElement;
    if (parent === null) continue;
    if (withText.has(element)) withText.add(parent);
    if (described.has(element) || !blank(element.getAttribute('aria-label')) || (element.tagName.toLowerCase() === 'img' && !blank(element.getAttribute('alt')))) described.add(parent);
    if (withAction.has(element) || element.matches(ACTION)) withAction.add(parent);
  }
  const labelled = new Set<string>();
  for (const element of elements) {
    const target = element.tagName.toLowerCase() === 'label' && withText.has(element) ? element.getAttribute('for') : null;
    if (target !== null) labelled.add(target);
  }
  return { byId, labelled, withText, described, withAction, label, stateOnly };
}

/** Whether `aria-labelledby` names an element with text; only its first MAX_LABELLEDBY_REFS ids are looked up. */
function labelledByText(element: CheckElement, index: ScreenIndex): boolean {
  const refs = element.getAttribute('aria-labelledby');
  if (refs === null) return false;
  return refs.split(/\s+/).filter(Boolean).slice(0, MAX_LABELLEDBY_REFS).some((id) => {
    const target = index.byId.get(id);
    return target !== undefined && index.withText.has(target);
  });
}

/** `value` without its `var()`s, `url()`s and strings: what may still hold a literal. */
function literalText(value: string): string {
  return withoutCalls(value, VAR_AND_URL, true);
}

function hasLiteralColor(value: string): boolean {
  const text = literalText(value);
  if (HEX_COLOR.test(text) || COLOR_FUNCTION.test(text)) return true;
  return text.toLowerCase().split(/[^a-z]+/).some((word) => NAMED_COLORS.has(word));
}

/** A non-zero length literal outside `var()`, `url()` and strings; words are split first, so each test is anchored and linear. */
function hasLiteralLength(value: string): boolean {
  return literalText(value).split(/[^\w.%-]+/).some((word) => LENGTH_WORD.test(word) && !ZERO_LENGTH.test(word));
}

function isRemoteRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref.trim()) || ref.trim().startsWith('//');
}

/** Whether a link target runs a script as a browser reads it: tabs and line breaks dropped, leading controls and spaces trimmed. */
function isJavaScriptUrl(value: string): boolean {
  const text = value.replace(/[\t\n\r]/g, '');
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 0x20) start++;
  return text.slice(start, start + 'javascript:'.length).toLowerCase() === 'javascript:';
}

/** At most MAX_ISSUES_PER_RULE issues of one rule on one screen; the last one kept counts the rest in `more`. */
function capIssues(issues: readonly DesignCheckIssue[]): DesignCheckIssue[] {
  const counts = new Map<string, number>();
  const last = new Map<string, number>();
  const kept: DesignCheckIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.screen}\0${issue.rule}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > MAX_ISSUES_PER_RULE) continue;
    last.set(key, kept.length);
    kept.push(issue);
  }
  for (const [key, count] of counts) {
    if (count > MAX_ISSUES_PER_RULE) kept[last.get(key)!] = { ...kept[last.get(key)!]!, more: count - MAX_ISSUES_PER_RULE };
  }
  return kept;
}

/** Checks one design folder; reads screens/*.html, design.md, and nothing outside the folder. */
export async function runDesignCheck(input: DesignCheckInput): Promise<DesignCheckResult> {
  const errors: DesignCheckIssue[] = [];
  const warnings: DesignCheckIssue[] = [];
  const report = (rule: DesignCheckRule, screen: string, element: string, message: string): void => {
    const issue: DesignCheckIssue = { rule, severity: DESIGN_CHECK_SEVERITY[rule], screen, element, message };
    (issue.severity === 'error' ? errors : warnings).push(issue);
  };
  const hints = new Map<DesignSkillRule, LoadedSkillHint[]>();
  for (const hint of input.skillHints) hints.set(hint.rule, [...(hints.get(hint.rule) ?? []), hint]);
  const reportHint = (rule: DesignSkillRule, screen: string, element: string, message: string): void => {
    for (const hint of hints.get(rule) ?? []) {
      const issue: DesignCheckIssue = { rule, severity: hint.severity, screen, element, message: `${message} Hint from ${hint.skill}: "${hint.text}"`, skill: hint.skill, hint: hint.text };
      (issue.severity === 'error' ? errors : warnings).push(issue);
    }
  };
  let attributesChecked = 0;
  await checkFrontmatter(input, report);

  const files = await listScreenFiles(input.folder);
  if (files.length > MAX_DESIGN_SCREENS) report('screen.size', SCREENS_DIR, SCREENS_DIR, `A design holds at most ${MAX_DESIGN_SCREENS} screens; this one has ${files.length}.`);
  const checked: CheckedScreen[] = [];
  const tokens = new Set(input.tokenNames);
  const decisions = new Set(input.decisionIds);
  const components = new Map(input.inventory.components.map((component) => [component.name, component]));
  const types = new Map(input.inventory.types.map((type) => [type.name, new Set(type.fields)]));

  for (const file of files.slice(0, MAX_DESIGN_SCREENS)) {
    const fallbackId = path.posix.basename(file).replace(/\.html$/i, '');
    const read = await readDesignFile(input.folder, file, MAX_SCREEN_BYTES);
    if (read.kind !== 'file') {
      // gone since the listing
      if (read.kind === 'missing') continue;
      if (read.kind === 'outside') throw new Error(`${file} cannot be read: it is a link or has another hard link, which no screen may have.`);
      report('screen.size', fallbackId, file, 'The screen is larger than 2 MiB, the most a screen holds, so it was not checked.');
      checked.push({ id: fallbackId, file, contentHash: await fileHash(path.join(input.folder, ...file.split('/'))) });
      continue;
    }
    const { bytes } = read;
    const { document } = parseHTML(bytes.toString('utf8')) as unknown as { document: CheckDocument };
    const root = document.documentElement;
    const declaredId = root?.getAttribute('data-ds-screen')?.trim() ?? '';
    const screenId = SCREEN_ID.test(declaredId) ? declaredId : fallbackId;
    const at = (rule: DesignCheckRule, element: string, message: string): void => report(rule, screenId, element, message);
    const hintAt = (rule: DesignSkillRule, element: string, message: string): void => reportHint(rule, screenId, element, message);

    if (declaredId === '') at('screen.states', '<html>', 'The <html> element needs data-ds-screen with the screen id, such as S1.');
    else if (!SCREEN_ID.test(declaredId)) at('screen.states', '<html>', `data-ds-screen="${echo(declaredId)}" is not a screen id: use letters, digits, - and _, at most 64, starting with a letter or digit, such as S1.`);
    const states = new Set(designStateTokens(root?.getAttribute('data-ds-states')));
    if (!states.has('default')) at('screen.states', '<html>', 'data-ds-states on <html> must list the screen\'s states, default first, such as "default empty loading error".');

    const elements = Array.from(document.querySelectorAll('*'));
    const index = indexScreen(elements);
    const describe = (element: CheckElement): string => {
      const tag = element.tagName.toLowerCase();
      const id = element.getAttribute('id');
      const component = element.getAttribute('data-ds-component');
      return `<${tag}${id ? `#${echo(id)}` : ''}${component ? ` data-ds-component="${echo(component)}"` : ''}>`;
    };

    for (const element of elements) {
      const tag = element.tagName.toLowerCase();
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.startsWith('data-ds-')) attributesChecked++;
        if (attribute.name.startsWith('on') && input.fidelity === 'static') {
          at('fidelity.static-no-scripts', describe(element), `A static design runs no scripts; remove the ${echo(attribute.name)} handler.`);
        }
      }
      const stateOnly = element.getAttribute('data-ds-state-only');
      if (stateOnly !== null) {
        const shownIn = new Set(designStateTokens(stateOnly));
        if (shownIn.size === 0) at('screen.states', describe(element), 'data-ds-state-only names no state, so the block shows in none: list the states it shows in, such as data-ds-state-only="default no-results".');
        for (const state of shownIn) if (!states.has(state)) at('screen.states', describe(element), `data-ds-state-only names "${echo(state)}", a state <html> does not declare in data-ds-states.`);
      }

      const componentName = element.getAttribute('data-ds-component');
      const component = componentName !== null ? components.get(componentName) : undefined;
      if (componentName !== null && !component) at('ds.component-known', describe(element), `${echo(componentName)} is not a component in inventory.json. Use an inventory component, or mark new UI with data-ds-new citing a decision.`);
      const variant = element.getAttribute('data-ds-variant');
      if (variant !== null) {
        if (componentName === null) at('ds.variant-known', describe(element), 'data-ds-variant needs data-ds-component on the same element.');
        else if (component && !(component.variants ?? []).includes(variant)) at('ds.variant-known', describe(element), `${echo(componentName)} has no variant ${echo(variant)} in inventory.json.`);
      }
      const bind = element.getAttribute('data-ds-bind');
      if (bind !== null) {
        const [typeName = '', field] = bind.split('.', 2);
        const fields = types.get(typeName);
        if (!fields) at('ds.bind-known', describe(element), `${echo(typeName)} is not a type in inventory.json.`);
        else if (field !== undefined && !fields.has(field)) at('ds.bind-known', describe(element), `${echo(typeName)} has no field ${echo(field)} in inventory.json.`);
      }
      const decisionRef = element.getAttribute('data-ds-decision');
      if (decisionRef !== null) {
        for (const id of decisionRef.split(/\s+/).filter(Boolean)) if (!decisions.has(id)) at('ds.decision-known', describe(element), `${echo(id)} is not a decision of this design.`);
      }
      const newRef = element.getAttribute('data-ds-new');
      if (newRef !== null && !decisions.has(newRef.trim())) at('ds.new-cites-decision', describe(element), `data-ds-new must cite the decision that introduced this UI; "${echo(newRef)}" is not one.`);

      if (tag === 'script' && input.fidelity === 'static') at('fidelity.static-no-scripts', describe(element), 'A static design runs no scripts; remove the <script>.');
      checkReferences(element, tag, describe(element), at);
      for (const name of COLOR_ATTRIBUTES) {
        const value = element.getAttribute(name);
        if (value !== null && hasLiteralColor(value)) at('tokens.color', describe(element), `${name}="${echo(value)}" uses a color that is not a token; set it in a style with var(--token).`);
      }
      const style = element.getAttribute('style');
      if (style !== null) {
        const declarations = declarationsOf(style, 1);
        checkDeclarations(declarations, describe(element), tokens, at);
        if (hints.size > 0) checkSkillDeclarations(declarations, describe(element), hintAt);
      }
      if (tag === 'style') {
        const { declarations, imports } = scanCss(element.textContent ?? '');
        checkDeclarations(declarations, '<style>', tokens, at);
        if (hints.size > 0) checkSkillDeclarations(declarations, '<style>', hintAt);
        for (const url of imports) checkResourceRef(url, '<style>', at, true);
      }
      if (isControl(element, tag) && !hasAccessibleName(element, tag, index)) {
        at('a11y.control-name', describe(element), 'This control has no accessible name: give it text, aria-label, aria-labelledby, a <label>, or title.');
      }
    }
    if (hints.size > 0) checkSkillElements(elements, index, states, describe, hintAt);
    const contentHash = screenContentHash(bytes);
    const journey = input.journeys && input.fidelity === 'interactive' ? await gateJourney(input.folder, screenId, file, contentHash, elements, input.journeys.widths, at) : undefined;
    checked.push({ id: screenId, file, contentHash, ...(journey ? { journey } : {}) });
  }
  return {
    summary: { errors: capIssues(errors), warnings: capIssues(warnings), attributesChecked, tokensChecked: tokens.size, skillHints: input.skillHints.length, widths: [] },
    screens: checked,
  };
}

/**
 * The journey gate on one screen of an interactive design (PD-21): DesignCheck's waiver when it has no interactive control,
 * else `journey.required` unless its journey ran against these bytes and passed at every journey width.
 */
async function gateJourney(folder: string, screen: string, file: string, contentHash: string, elements: readonly CheckElement[], widths: readonly number[], at: (rule: DesignCheckRule, element: string, message: string) => void): Promise<ScreenJourney | undefined> {
  if (!elements.some((element) => isInteractive(element, element.tagName.toLowerCase()))) return { waiver: true };
  const files = journeyFilesOf(file);
  if (!files) {
    at('journey.required', file, `${file} has controls but cannot have a journey, since its file name is not a plain name; rename it screens/S<n>-<name>.html.`);
    return undefined;
  }
  const journey = await readJourneyFile(folder, files.journeyFile);
  const standing = journeyStanding(journey, contentHash, widths);
  const widthsText = `${widths.join(' and ')} px`;
  if (!standing.passes) {
    const message = {
      missing: `${screen} has controls but no journey. Run PreviewJourney on ${file}; it runs at the journey widths (${widthsText}).`,
      stale: `${screen} changed after its journey ran, so the journey no longer vouches for it. Run PreviewJourney on ${file} again.`,
      failed: `The journey of ${screen} failed. Fix the screen or the journey and run PreviewJourney on ${file} again.`,
      widths: `The journey of ${screen} did not pass at every journey width (${widthsText}). Run PreviewJourney on ${file} again.`,
    }[standing.reason];
    at('journey.required', file, message);
  }
  if (!journey) return undefined;
  return { file: files.journeyFile, spec: files.specFile, widths: journey.viewports.map((viewport) => viewport.width), passed: standing.passes, untested: [...journey.untested] };
}

const LABEL_EXEMPT_INPUTS = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const VIEWPORT_LENGTH = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:vw|vh|vmin|vmax|dvw|svw|lvw|dvh|svh|lvh)$/i;
const ABSOLUTE_LENGTH = /^(\d+(?:\.\d+)?)(px|rem|em)$/i;

/** The skill hints' element rules over one screen; each walks the screen's elements once. */
function checkSkillElements(
  elements: readonly CheckElement[],
  index: ScreenIndex,
  states: ReadonlySet<string>,
  describe: (element: CheckElement) => string,
  hintAt: (rule: DesignSkillRule, element: string, message: string) => void,
): void {
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (element.getAttribute('aria-hidden') === 'true') continue;
    if ((tag === 'input' && !LABEL_EXEMPT_INPUTS.has((element.getAttribute('type') ?? 'text').toLowerCase())) || tag === 'select' || tag === 'textarea') {
      const id = element.getAttribute('id');
      const label = index.label.get(element);
      const hasLabel = !blank(element.getAttribute('aria-label'))
        || labelledByText(element, index)
        || (id !== null && index.labelled.has(id))
        || (label !== undefined && index.withText.has(label));
      if (!hasLabel) hintAt('a11y.input-label', describe(element), `This ${tag} has no label: add a <label> for it, wrap it in one, or give it aria-label or aria-labelledby.`);
    }
    if (tag === 'img' && !element.hasAttribute('alt') && !/^(?:presentation|none)$/i.test((element.getAttribute('role') ?? '').trim())) {
      hintAt('a11y.img-alt', describe(element), 'This image has no alt attribute: describe a meaningful image, or set alt="" on a decorative one.');
    }
  }
  const blocks = (state: string): CheckElement[] => elements.filter((element) => designStateTokens(element.getAttribute('data-ds-state-only')).includes(state));
  const emptyBlocks = blocks('empty');
  const collection = elements.find((element) => !index.stateOnly.has(element) && element.matches(COLLECTION));
  if (collection && (!states.has('empty') || emptyBlocks.length === 0)) {
    hintAt('states.empty-declared', describe(collection), 'This screen shows a collection but has no empty state: declare "empty" in data-ds-states and add a data-ds-state-only="empty" block.');
  }
  for (const block of emptyBlocks) {
    if (!index.withAction.has(block)) hintAt('states.empty-action', describe(block), 'This empty state offers no action: add the button or link that tells the user what to do next.');
  }
  const bound = elements.find((element) => element.hasAttribute('data-ds-bind'));
  if (bound && (!states.has('loading') || blocks('loading').length === 0)) {
    hintAt('states.loading-declared', describe(bound), 'This screen shows bound data but has no loading state: declare "loading" in data-ds-states and add a data-ds-state-only="loading" block.');
  }
}

/** The skill hints' declaration rules; words are split first, so each test is anchored and linear. */
function checkSkillDeclarations(declarations: readonly CssDeclaration[], element: string, hintAt: (rule: DesignSkillRule, element: string, message: string) => void): void {
  for (const declaration of declarations) {
    const property = declaration.name.toLowerCase();
    const where = element === '<style>' ? `<style> ${echo(declaration.name)}: ${declaration.value.slice(0, 60)}` : element;
    // a clamp() bounds the type at both ends, so only a bare viewport unit is left to find
    if ((property === 'font-size' || property === 'font') && withoutCalls(declaration.value, VAR_AND_CLAMP).split(/[^\w.%-]+/).some((word) => VIEWPORT_LENGTH.test(word))) {
      hintAt('layout.viewport-font', where, `${echo(declaration.name)}: ${echo(declaration.value)} scales the type with the viewport.`);
    }
    if (property === 'width' || property === 'min-width') {
      const widest = withoutCalls(declaration.value, VAR).split(/[^\w.%-]+/).reduce((max, word) => {
        const match = ABSOLUTE_LENGTH.exec(word);
        return match ? Math.max(max, Number(match[1]) * (match[2]!.toLowerCase() === 'px' ? 1 : 16)) : max;
      }, 0);
      if (widest > MIN_RENDER_WIDTH) hintAt('layout.fixed-width', where, `${echo(declaration.name)}: ${echo(declaration.value)} is wider than the smallest screen (${MIN_RENDER_WIDTH} px).`);
    }
  }
}

/** A checked width: its CSS px, and its preset name or null for a width the design names by number. */
export interface CheckedWidth {
  readonly width: number;
  readonly breakpoint: string | null;
}

/**
 * The width rules (PD-14) over one screen's probe: `layout.overflow` at each checked width and for each sweep run no checked
 * width falls in, and `ds.hidden-required` for a bound element shown at one checked width and hidden at another.
 */
export function widthIssues(screen: string, probe: DesignProbeResult, widths: readonly CheckedWidth[]): DesignCheckIssue[] {
  const issues: DesignCheckIssue[] = [];
  const at = (rule: DesignCheckRule, width: number, element: string, message: string): void => {
    const breakpoint = widths.find((checked) => checked.width === width)?.breakpoint ?? null;
    issues.push({ rule, severity: DESIGN_CHECK_SEVERITY[rule], screen, element, message, width, ...(breakpoint !== null ? { breakpoint } : {}) });
  };
  for (const measured of probe.widths) {
    if (!measured.overflow) continue;
    const first = measured.overflowing[0];
    if (first) at('layout.overflow', measured.width, first.element, `${first.element} is ${first.width} px wide and overflows the ${measured.width} px viewport, which scrolls sideways to ${measured.scrollWidth} px.`);
    else at('layout.overflow', measured.width, '<html>', `The page is ${measured.scrollWidth} px wide at ${measured.width} px and scrolls sideways.`);
  }
  const runs: { from: number; to: number; scrollWidth: number }[] = [];
  for (const hit of probe.sweep?.overflowAt ?? []) {
    const last = runs[runs.length - 1];
    if (last && hit.width - last.to <= (probe.sweep?.step ?? 0)) last.to = hit.width;
    else runs.push({ from: hit.width, to: hit.width, scrollWidth: hit.scrollWidth });
  }
  for (const run of runs) {
    if (probe.widths.some((measured) => measured.width >= run.from && measured.width <= run.to)) continue;
    at('layout.overflow', run.from, '<html>', `The page scrolls sideways from ${run.from} to ${run.to} px (${run.scrollWidth} px wide at ${run.from} px), between the checked widths.`);
  }
  // Every width measures one document, so an element's index names it at each width.
  if (!probe.widths.every((measured) => measured.elements.length === probe.widths[0]?.elements.length)) return issues;
  const shownAt = new Map<number, number[]>();
  for (const measured of probe.widths) {
    measured.elements.forEach((element, index) => {
      if (element.bind !== null && element.visible) shownAt.set(index, [...(shownAt.get(index) ?? []), measured.width]);
    });
  }
  for (const measured of probe.widths) {
    measured.elements.forEach((element, index) => {
      const shown = shownAt.get(index);
      if (element.bind === null || element.visible || !shown) return;
      const name = `<${element.tag}${element.id ? `#${element.id}` : ''} data-ds-bind="${element.bind}">`;
      at('ds.hidden-required', measured.width, name, `${name} is hidden at ${measured.width} px but shown at ${shown.join(', ')} px; check the design means to hide this field there.`);
    });
  }
  return issues;
}

function checkDeclarations(declarations: readonly CssDeclaration[], element: string, tokens: ReadonlySet<string>, at: (rule: DesignCheckRule, element: string, message: string) => void): void {
  for (const declaration of declarations) {
    const property = declaration.name.toLowerCase();
    const where = element === '<style>' ? `<style> ${echo(declaration.name)}: ${declaration.value.slice(0, 60)}` : element;
    const written = `${echo(declaration.name)}: ${echo(declaration.value)}`;
    if (property.startsWith('--')) {
      // a screen may point a token at another one, never at a literal, which would get past the token rules where it is used
      if (tokens.has(declaration.name) && (hasLiteralColor(declaration.value) || hasLiteralLength(declaration.value))) {
        at('tokens.redefined', where, `${written} sets a token to a literal; a screen may only point a token at another one, such as ${echo(declaration.name)}: var(--other-token).`);
      }
    } else {
      if (COLOR_PROPERTIES.test(property) && hasLiteralColor(declaration.value)) at('tokens.color', where, `${written} uses a color that is not a token; use var(--token).`);
      if (SPACING_PROPERTIES.test(property) && hasLiteralLength(declaration.value)) at('tokens.spacing', where, `${written} uses a length that is not a spacing token; use var(--token) or calc() with one.`);
      if (RADIUS_PROPERTIES.test(property) && hasLiteralLength(declaration.value)) at('tokens.radius', where, `${written} uses a radius that is not a token; use var(--token).`);
    }
    for (const match of declaration.value.matchAll(VAR_CALL)) {
      if (!tokens.has(match[1]!)) at('tokens.unknown-var', where, `${echo(match[1]!)} is not a token in tokens.css.`);
    }
    for (const url of cssUrls(declaration.value)) checkResourceRef(url, where, at);
  }
}

/** A resource the page loads: never from the network, and only from ../assets/ (and ../tokens.css for a stylesheet). */
function checkResourceRef(ref: string, element: string, at: (rule: DesignCheckRule, element: string, message: string) => void, stylesheet = false): void {
  const value = ref.trim();
  if (value === '' || value.startsWith('#')) return;
  if (/^(?:https?:)?\/\//i.test(value)) {
    at('net.no-external', element, `${echo(value)} loads from the network; a design loads nothing from outside its folder.`);
    return;
  }
  if (isRemoteRef(value)) {
    at('assets.local-only', element, `${echo(value)} is not a file of the design; copy assets with ImportAsset and use ../assets/.`);
    return;
  }
  if (value.startsWith('../assets/') || (stylesheet && value === '../tokens.css')) return;
  at('assets.local-only', element, `${echo(value)} is not under ../assets/; copy assets with ImportAsset and use ../assets/.`);
}

function checkReferences(element: CheckElement, tag: string, description: string, at: (rule: DesignCheckRule, element: string, message: string) => void): void {
  for (const name of RESOURCE_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    const refs = name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '') : [value];
    for (const ref of refs) checkResourceRef(ref, description, at);
  }
  if (tag === 'link') {
    const href = element.getAttribute('href');
    if (href !== null) checkResourceRef(href, description, at, true);
  }
  for (const name of ['href', 'action', 'formaction', 'xlink:href']) {
    if (tag === 'link' && name === 'href') continue;
    const value = element.getAttribute(name);
    if (value === null) continue;
    if (/^(?:https?:)?\/\//i.test(value.trim())) at('net.no-external', description, `${echo(value)} leads out of the design; link only to its own screens.`);
    else if (isJavaScriptUrl(value)) at('links.no-javascript', description, `${echo(value)} runs a script. Use a <button> for an action, and link only to the design's own screens.`);
  }
}

function isControl(element: CheckElement, tag: string): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
  if (tag === 'a') return element.hasAttribute('href');
  if (tag === 'input') return (element.getAttribute('type') ?? 'text').toLowerCase() !== 'hidden';
  const role = element.getAttribute('role');
  return role !== null && CONTROL_ROLES.has(role.trim().toLowerCase());
}

/** Whether a control's text, labels or attributes give it a name, as accessibility trees compute it in the common cases. */
function hasAccessibleName(element: CheckElement, tag: string, index: ScreenIndex): boolean {
  if (!blank(element.getAttribute('aria-label')) || labelledByText(element, index)) return true;
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    if ((type === 'submit' || type === 'button' || type === 'reset') && !blank(element.getAttribute('value'))) return true;
    // a browser names a submit or reset input that has no value "Submit" or "Reset"; a button input it leaves unnamed
    if ((type === 'submit' || type === 'reset') && !element.hasAttribute('value')) return true;
    if (type === 'image' && !blank(element.getAttribute('alt'))) return true;
    const id = element.getAttribute('id');
    if (id && index.labelled.has(id)) return true;
    const label = index.label.get(element);
    if (label !== undefined && index.withText.has(label)) return true;
    if (!blank(element.getAttribute('placeholder'))) return true;
  } else if (index.withText.has(element) || index.described.has(element)) {
    return true;
  }
  return !blank(element.getAttribute('title'));
}

async function checkFrontmatter(input: DesignCheckInput, report: (rule: DesignCheckRule, screen: string, element: string, message: string) => void): Promise<void> {
  const problem = (message: string): void => report('design.frontmatter', DESIGN_DOC_FILE, 'frontmatter', message);
  const doc = await readDesignFile(input.folder, DESIGN_DOC_FILE, MAX_DESIGN_DOC_BYTES);
  if (doc.kind !== 'file') {
    problem({
      tooLarge: 'design.md is larger than 256 KiB.',
      outside: 'design.md cannot be read: it is a link or has another hard link. Write it as a plain file.',
      missing: 'Write design.md with frontmatter: app and viewports {primary, checked, journey}.',
    }[doc.kind]);
    return;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(doc.bytes.toString('utf8'));
  if (!match) {
    problem('design.md must start with --- frontmatter --- holding app and viewports.');
    return;
  }
  let data: unknown;
  try {
    data = parseYaml(match[1]!, { maxAliasCount: 0 });
  } catch (err) {
    problem(`The frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (typeof data !== 'object' || data === null) {
    problem('The frontmatter must be a mapping with app and viewports.');
    return;
  }
  const record = data as Record<string, unknown>;
  if (typeof record['app'] !== 'string' || record['app'].trim() === '') problem('app must name the stack in one line.');
  const viewports = record['viewports'];
  if (typeof viewports !== 'object' || viewports === null) {
    problem('viewports must be {primary, checked: [...], journey: [...]}.');
    return;
  }
  const v = viewports as Record<string, unknown>;
  // the preview, the width checks and the journeys resolve the same way, so every entry they leave out is reported here
  const { viewports: resolved, dropped } = resolveDesignViewports(input.inventory.breakpoints?.values ?? {}, v);
  const presetList = viewportPresetNames(resolved.breakpoints).join(', ');
  if (resolveViewportWidth(v['primary'], resolved.breakpoints) === undefined) problem(`viewports.primary must be a preset (${presetList}) or a width from 320 to 2560.`);
  for (const key of ['checked', 'journey'] as const) {
    const list = v[key];
    if (!Array.isArray(list) || (key === 'checked' && list.length === 0)) problem(`viewports.${key} must be a list of presets (${presetList}) or widths${key === 'checked' ? ', not empty' : ''}.`);
  }
  for (const drop of dropped) {
    if (drop.key === 'primary') continue;
    if (drop.reason === 'unresolved') problem(`viewports.${drop.key}: ${echo(JSON.stringify(drop.item) ?? String(drop.item))} is not a preset (${presetList}) or a width from 320 to 2560.`);
    else problem(`viewports.${drop.key} names more than ${MAX_PROBE_WIDTHS} widths, so ${String(drop.item)} px, past the ${MAX_PROBE_WIDTHS} smallest, is left out.`);
  }
}
