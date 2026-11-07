import type { LocalizedText } from '../localized-text';

export type DesignRuleSetId = 'full' | 'reduced';

export type DesignDecisionSourceKind = 'question' | 'chat' | 'markup' | 'tweak' | 'reference' | 'brief';

/** Where a decision record sits in a tool result's `details` (an answered AskUserQuestion in a design chat, or RecordDecision). */
export const DESIGN_DECISIONS_DETAIL_KEY = 'designDecisions';

export const DESIGN_CHAT_TITLE_PREFIX = 'Design · ';

/** A design chat's name: the prefix and its design's title, StartDesign's `title`. */
export function designChatName(designTitle: string): string {
  return `${DESIGN_CHAT_TITLE_PREFIX}${designTitle}`;
}

export interface DesignDecisionView {
  id: string;
  title: string;
  chosen: string;
  rejected: string[];
  source: { kind: DesignDecisionSourceKind; ref: string };
  supersedes?: string;
}

export interface DesignCheckIssue {
  rule: string;
  severity: 'error' | 'warning';
  screen: string;
  element: string;
  message: string;
  /** The quoted text of the skill hint whose rule raised it. */
  hint?: string;
  /** The design skill whose hint raised it. */
  skill?: string;
  /** CSS px, for an issue found at a width (FULL); absent for a static one. */
  width?: number;
  /** The width's preset (`base`, `sm`, ...), absent for a width the sweep found between presets or one with no preset. */
  breakpoint?: string;
  /** Issues of this rule on this screen past the per-rule cap, which the list leaves out; set on the last one listed. */
  more?: number;
}

/** How many issues `issues` stands for, those a capped rule left out included. */
export function issueCount(issues: readonly Pick<DesignCheckIssue, 'more'>[]): number {
  return issues.reduce((count, issue) => count + 1 + (issue.more ?? 0), 0);
}

export interface DesignCheckSummary {
  errors: DesignCheckIssue[];
  warnings: DesignCheckIssue[];
  attributesChecked: number;
  tokensChecked: number;
  /** The skill hints checked: those of the skills loaded on the branch. */
  skillHints: number;
  /** The checked widths in CSS px, ascending; empty for a static check (REDUCED). The overflow sweep is not counted. */
  widths: number[];
  /** The rule set has width checks, but they did not run (no app renders this design), and why. */
  widthChecks?: { skipped: LocalizedText };
}

/** DesignScreenshot's details. Its images follow `screens` in order, each screen's widths ascending; none when `outline`. */
export interface DesignScreenshotDetails {
  screens: { screen: string; file: string; contentHash: string; widths: { breakpoint: string | null; width: number; cssHeight: number }[] }[];
  /** The model reads no images, so it got the probe outline as text and the result holds no image. */
  outline: boolean;
}

/**
 * A journey step's element (PD-45), matched exactly as Playwright's `getByRole(role, {name, exact: true})`, `getByLabel`,
 * `getByPlaceholder` and `getByText` with `exact: true` match it; never a CSS or `data-ds` selector.
 */
export type JourneyTarget =
  | { readonly role: string; readonly name: string }
  | { readonly label: string }
  | { readonly placeholder: string }
  | { readonly text: string };

export type JourneyAction = 'fill' | 'select' | 'click' | 'press' | 'assert';

/** The keys a `press` step may name (Playwright's key names). */
export const JOURNEY_KEYS = ['Enter', 'Escape', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
export type JourneyKey = (typeof JOURNEY_KEYS)[number];

/** An assert's one expectation: shown or hidden, its text contains, or its form value equals. */
export type JourneyExpect = { readonly visible: boolean } | { readonly textContains: string } | { readonly valueEquals: string };

/**
 * One step of a journey: `value` on fill and select only, `key` on press only, `expect` on assert only. A journey has at most
 * MAX_JOURNEY_STEPS steps, asserts counted, and every action is followed by an assert.
 */
export interface JourneyStep {
  readonly action: JourneyAction;
  readonly target: JourneyTarget;
  readonly value?: string;
  readonly key?: JourneyKey;
  readonly expect?: JourneyExpect;
}

/**
 * Why a step failed. hidden: no visible element matched at that width (`hiddenAt` names it); ambiguous: more than one did;
 * covered: another element would take the click; notEditable: fill on no text field, select on no `<select>`; noOption: no
 * option has that value or label; expectation: the assert's expectation did not hold within the step's 5 s; error: the page
 * failed the step otherwise.
 */
export const JOURNEY_FAILURES = ['hidden', 'ambiguous', 'covered', 'notEditable', 'noOption', 'expectation', 'error'] as const;
export type JourneyFailure = (typeof JOURNEY_FAILURES)[number];

export interface JourneyStepResult {
  readonly ok: boolean;
  /** CSS px: the width at which the step's target was hidden or absent (`failure: 'hidden'`). */
  readonly hiddenAt?: number;
  readonly failure?: JourneyFailure;
  /** English, for the model; at most 400 characters. */
  readonly message?: string;
}

export interface JourneyWidthResult {
  readonly width: number;
  readonly passed: boolean;
  /** One per step run, in order: a failed run ends at its failed step, and the steps after it did not run. */
  readonly steps: readonly JourneyStepResult[];
}

/** A journey width: CSS px, and its preset (`base`, a breakpoint name) or null for a width the design names by number. */
export interface JourneyViewport {
  readonly breakpoint: string | null;
  readonly width: number;
}

/** `screens/<screen file stem>.journey.json`, which core alone writes (PD-26), beside its `.journey.spec.ts`. */
export interface JourneyFile {
  readonly schemaVersion: 1;
  /** The screen's id (`data-ds-screen`, else its file stem). */
  readonly screen: string;
  /** The screen file, relative to the design folder: `screens/S1-contacts.html`. */
  readonly file: string;
  /** design.md's `viewports.journey`, ascending. */
  readonly viewports: readonly JourneyViewport[];
  /** A state the screen declares, `default` when it declares none. */
  readonly state: string;
  /** The SHA-256 of the screen file's bytes the run loaded; another hash makes the journey stale (PD-21). */
  readonly contentHash: string;
  readonly steps: readonly JourneyStep[];
  /** One per viewport, in the same order. */
  readonly results: readonly JourneyWidthResult[];
  /** What the journey leaves untested, in the designer's words. */
  readonly untested: readonly string[];
  /** Every result passed. */
  readonly passed: boolean;
  readonly ranAt: string;
}

/** PreviewJourney's arguments. */
export interface PreviewJourneyArgs {
  /** The screen file, relative to the design folder: `screens/S1-contacts.html`. */
  readonly screen: string;
  /** A state the screen declares; `default` when omitted. */
  readonly state?: string;
  readonly steps: readonly JourneyStep[];
  readonly untested: readonly string[];
}

/** PreviewJourney's details; the card renders from these and the call's id alone, and Replay in preview names the call. */
export interface PreviewJourneyDetails {
  /** The screen's id. */
  readonly screen: string;
  readonly relPath: string;
  /** Relative to the design folder: `screens/S1-contacts.journey.json` and `screens/S1-contacts.journey.spec.ts`. */
  readonly journeyFile: string;
  readonly specFile: string;
  readonly viewports: readonly JourneyViewport[];
  readonly state: string;
  readonly steps: readonly JourneyStep[];
  /** One per viewport, in the same order. */
  readonly results: readonly JourneyWidthResult[];
  readonly untested: readonly string[];
  readonly passed: boolean;
  readonly contentHash: string;
  /** The model reads no images, so the result's text also holds a DOM outline of each width's page where its run ended. */
  readonly outline: boolean;
}

/** `design.journey`'s answer: one run per width, ascending, each in a fresh page. */
export interface DesignJourneyRun {
  readonly widths: readonly (JourneyWidthResult & {
    /** A DOM outline of the page where the run ended, at most 64 KiB; only when the request asked for one. */
    readonly outline?: string;
  })[];
  /** The pages' console errors, uncaught exceptions included. */
  readonly consoleErrors: readonly string[];
}

/** A screen's journey as a finished version records it (manifest, version record, design result). */
export type DesignJourneyRecord =
  | {
    readonly screen: string;
    /** Relative to the design folder: the journey's JSON and its Playwright spec. */
    readonly file: string;
    readonly spec: string;
    /** CSS px, ascending. */
    readonly widths: readonly number[];
    readonly passed: boolean;
    readonly untested: readonly string[];
  }
  /** DesignCheck found no interactive control on the screen, so it needs no journey (PD-21). */
  | { readonly screen: string; readonly waiver: true };

/** LoadDesignSkill's details; the skills a branch's results list are the loaded ones, whose hints DesignCheck adds. */
export interface LoadDesignSkillDetails {
  skills: { name: string; title: string; hints: number }[];
}

export type DesignStatus = 'draft' | 'finished';
export type DesignFidelity = 'static' | 'interactive';

/** A design chat's own state; `designState.design`. */
export interface DesignChatStateView {
  designId: string;
  title: string;
  folder: string;
  parentSessionId: string | null;
  /** The main chat's current title, read at each publish; null while it has none or is not listed. */
  parentTitle: string | null;
  status: DesignStatus;
  version: number | null;
  fidelity: DesignFidelity | null;
  decisions: DesignDecisionView[];
  ruleSet: DesignRuleSetId;
  /** `damocles.design.enabled`; false: the chat refuses sends. */
  enabled: boolean;
  /** `link.json` names another session as the current design chat. */
  superseded: boolean;
  /** The session `link.json` names as the current design chat when this one is superseded, else null. */
  supersededBy: string | null;
}

/** A parent's own link; `designState.link`. */
export interface DesignLinkStateView {
  designId: string;
  title: string;
  folder: string;
  designSessionId: string | null;
  status: DesignStatus;
  version: number | null;
  /**
   * The entry id of the branch's latest result card of this design when nothing answered it yet: no message follows it on the
   * branch and it did not pause the parent. Its Continue shows while the chat is idle. Absent from a core that predates it.
   */
  awaitingContinue?: string | null;
}

export interface DesignResultDecision {
  id: string;
  title: string;
  chosen: string;
}

/** One change from a version to the next: a screen by its id, or a decision the later version added. */
export type DesignChange =
  | { kind: 'screenAdded' | 'screenChanged' | 'screenRemoved'; screen: string }
  | { kind: 'decisionAdded'; id: string; title: string; chosen: string };

/** The `damocles-design-result` entry's details; the card renders from these alone. */
export interface DesignResultView {
  designId: string;
  version: number;
  folder: string;
  title: string;
  screens: string[];
  decisions: DesignResultDecision[];
  check: { errors: 0; warnings: DesignCheckIssue[] };
  /** Each screen's journey or waiver; empty for a static design and on REDUCED. */
  journeys: DesignJourneyRecord[];
  previousVersion: number | null;
  /** What changed since `previousVersion`, from the two versions' records; empty for the first. */
  changes: DesignChange[];
  /** Only on a card the version pause appended (PD-29): the version the latest plan approval recorded, 0 for none. No run started with it. */
  versionPause?: { fromVersion: number };
}

/** Where `ExitPlanMode`'s result `details` record the design version its plan was approved against (PD-16), on every outcome. */
export const DESIGN_VERSION_DETAIL_KEY = 'designVersion';

/** `details[DESIGN_VERSION_DETAIL_KEY]`: the latest version of the parent's own design delivered on its branch, or null for none. */
export interface DesignVersionStamp {
  designId: string;
  version: number;
}

/** The plan approval's linked design: the version the approval records, as its card on the branch describes it. */
export interface PlanApprovalDesignLink {
  designId: string;
  title: string;
  folder: string;
  version: number;
  screens: number;
  decisions: number;
  warnings: DesignCheckIssue[];
  /** Null for a version with no journey (D90). */
  journeysPassed: boolean | null;
}

/** The answer to the version pause: update the plan and re-approve it, or finish the approved version first. */
export type DesignVersionChoice = 'replan' | 'finishFirst';

/** The answer to FinishDesign's approval prompt: make the version, keep the designer working on a note, or end its turn. */
export type DesignApprovalChoice = 'approve' | 'changes' | 'stop';

/** A screen the approval prompt can open: `file` is relative to the design folder (what openDesignPreview's relPath takes). */
export interface DesignApprovalScreen {
  id: string;
  file: string;
}

/** FinishDesign's result details when the user's answer to the approval prompt made no version. */
export type FinishDesignUnapprovedDetails =
  | { designId: string; approval: 'changesRequested'; feedback: string }
  | { designId: string; approval: 'stopped' }
  | { designId: string; approval: 'cancelled' };

/** The `damocles-design-brief` entry's details. */
export interface DesignBriefView {
  briefId: string;
  text: string;
  reopened: boolean;
}

export interface DesignFileInfo {
  /** Relative to the design folder, forward slashes. */
  path: string;
  bytes: number;
}

export type DesignInventoryCategoryKey = 'components' | 'tokens' | 'breakpoints' | 'types' | 'screens';

export interface StartDesignDetails {
  designId: string;
  folder: string;
  designSessionId: string;
  reopened: boolean;
  title: string;
}

/** The refs one Inventory category lists at most; `count` stays the full number. */
export const MAX_INVENTORY_REFS = 200;

export interface InventoryDetails {
  categories: { key: DesignInventoryCategoryKey; count: number; refs: string[] }[];
}

export interface ExtractTokensDetails {
  count: number;
  groups: Record<string, number>;
  breakpoints: { source: string; values: Record<string, number> };
  fonts: string[];
}

// The parsers below read a tool result's details as a card gets them: a record an earlier build wrote, or a hand-edited
// session, may lack any field, and a card shows its bare row rather than throw.
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

export function parseExtractTokensDetails(value: unknown): ExtractTokensDetails | undefined {
  if (!isObject(value) || !isFiniteNumber(value['count']) || !isObject(value['groups']) || !isStringArray(value['fonts'])) return undefined;
  const breakpoints = value['breakpoints'];
  if (!isObject(breakpoints) || typeof breakpoints['source'] !== 'string' || !isObject(breakpoints['values'])) return undefined;
  if (!Object.values(value['groups']).every(isFiniteNumber) || !Object.values(breakpoints['values']).every(isFiniteNumber)) return undefined;
  return value as unknown as ExtractTokensDetails;
}

const isCheckIssue = (value: unknown): value is DesignCheckIssue => isObject(value)
  && typeof value['rule'] === 'string' && typeof value['screen'] === 'string' && typeof value['element'] === 'string' && typeof value['message'] === 'string'
  && (value['width'] === undefined || isFiniteNumber(value['width'])) && (value['more'] === undefined || isFiniteNumber(value['more']));

export function parseDesignCheckSummary(value: unknown): DesignCheckSummary | undefined {
  if (!isObject(value) || !Array.isArray(value['errors']) || !Array.isArray(value['warnings'])) return undefined;
  if (!value['errors'].every(isCheckIssue) || !value['warnings'].every(isCheckIssue)) return undefined;
  if (!isFiniteNumber(value['attributesChecked']) || !isFiniteNumber(value['tokensChecked']) || !isFiniteNumber(value['skillHints'])) return undefined;
  if (!Array.isArray(value['widths']) || !value['widths'].every(isFiniteNumber)) return undefined;
  return value as unknown as DesignCheckSummary;
}

export function parseFinishDesignUnapprovedDetails(value: unknown): FinishDesignUnapprovedDetails | undefined {
  if (!isObject(value) || typeof value['designId'] !== 'string') return undefined;
  const approval = value['approval'];
  if (approval === 'changesRequested') return typeof value['feedback'] === 'string' ? { designId: value['designId'], approval, feedback: value['feedback'] } : undefined;
  return approval === 'stopped' || approval === 'cancelled' ? { designId: value['designId'], approval } : undefined;
}

export function parseDesignScreenshotDetails(value: unknown): DesignScreenshotDetails | undefined {
  if (!isObject(value) || typeof value['outline'] !== 'boolean' || !Array.isArray(value['screens'])) return undefined;
  const widthOk = (width: unknown): boolean => isObject(width) && isFiniteNumber(width['width']) && isFiniteNumber(width['cssHeight'])
    && (width['breakpoint'] === null || typeof width['breakpoint'] === 'string');
  const screenOk = (screen: unknown): boolean => isObject(screen) && typeof screen['screen'] === 'string' && Array.isArray(screen['widths']) && screen['widths'].every(widthOk);
  return value['screens'].every(screenOk) ? (value as unknown as DesignScreenshotDetails) : undefined;
}

export function parseInventoryDetails(value: unknown): InventoryDetails | undefined {
  if (!isObject(value) || !Array.isArray(value['categories'])) return undefined;
  const categoryOk = (category: unknown): boolean => isObject(category) && typeof category['key'] === 'string' && isFiniteNumber(category['count']) && isStringArray(category['refs']);
  return value['categories'].every(categoryOk) ? (value as unknown as InventoryDetails) : undefined;
}

export interface ImportAssetDetails {
  asset: string;
  bytes: number;
}

export type FinishDesignDelivery = 'live' | 'queued' | 'notified' | 'no-parent';

export interface FinishDesignDetails {
  designId: string;
  version: number;
  reused: boolean;
  delivery: FinishDesignDelivery;
  check: { errors: 0; warnings: DesignCheckIssue[] };
  /** As the version records them. */
  journeys: DesignJourneyRecord[];
}

/** A design breakpoint: inventory.json's name and its width in CSS px. */
export interface DesignBreakpoint {
  readonly name: string;
  readonly width: number;
}

/** A screen as the desktop preview tab reads it (`design.info`): the design's widths and the screen's declared states. */
export interface DesignPreviewInfo {
  /** The screen's absolute path on the machine of the core that holds the design. */
  readonly path: string;
  /** `<html data-ds-screen>`, and the screen's `<title>`; null when absent. */
  readonly screenId: string | null;
  readonly title: string | null;
  /** Ascending by width. */
  readonly breakpoints: readonly DesignBreakpoint[];
  /** CSS px; design.md's `viewports.primary`, resolved. */
  readonly primary: number;
  readonly checked: readonly number[];
  readonly journey: readonly number[];
  /** `<html data-ds-states>`, in order; empty when the screen declares none. */
  readonly states: readonly string[];
  /** The latest DeclareTweaks on the design chat's branch, its locks read now; null for none, absent from a core that predates tweaks. */
  readonly tweaks?: TweaksDeclaration | null;
}

/** `swatch`: every stop's value is a CSS color, so the panel shows color swatches; `segment` otherwise. */
export type TweakControlKind = 'swatch' | 'segment';

export interface TweakStop {
  /** A tokens.css token, such as `--radius-lg`. */
  readonly token: string;
  /** Its value in tokens.css, for the swatch or the label. */
  readonly value: string;
}

/** The decision that settled a control's property, and the token it chose. */
export interface TweakLock {
  readonly decisionId: string;
  readonly value: string;
}

export interface TweakControl {
  readonly id: string;
  readonly label: string;
  /** The tokens.css token the stops set, such as `--radius`. */
  readonly property: string;
  readonly kind: TweakControlKind;
  readonly stops: readonly TweakStop[];
  readonly locked: TweakLock | null;
}

export interface TweaksDeclaration {
  /** The DeclareTweaks call that declared them. */
  readonly toolCallId: string;
  readonly controls: readonly TweakControl[];
}

/** DeclareTweaks' result details; the locks as they were when it ran. */
export interface DeclareTweaksDetails {
  readonly controls: readonly TweakControl[];
}

export type ReferenceRowStatus = 'mapped' | 'needsDecision' | 'out';

/** One element of a reference image and what it maps onto: an inventory component, a token or a type field (PD-13). */
export interface ReferenceRow {
  readonly element: string;
  readonly mapsTo: string | null;
  readonly status: ReferenceRowStatus;
}

export interface MapReferenceDetails {
  /** `R<n>`. */
  readonly reference: string;
  /** The image's path in the design folder, such as `references/R1.png`. */
  readonly image: string;
  readonly rows: readonly ReferenceRow[];
}

/** An image of a user message that core saved as a design reference (PD-40). */
export interface DesignReferenceNote {
  /** `R<n>`. */
  readonly id: string;
  /** Its path in the design folder, such as `references/R1.png`. */
  readonly image: string;
  /** Which of the message's image blocks it is, counting every image block in content order from 0. */
  readonly imageIndex: number;
}

/** A design file as the preview reads it (`design.read`): its bytes and the fidelity it is served with (PD-30). */
export interface DesignPreviewFile {
  readonly bytes: Uint8Array;
  readonly fidelity: DesignFidelity | null;
}

/** A PNG capture of a design screen, base64; sized under PD-41 (longest side at most 1950 px). */
export interface DesignPreviewImage {
  mimeType: 'image/png';
  data: string;
  /** Device pixels. */
  width: number;
  height: number;
}

/** A `data-ds` element as a probe saw it at one width, in CSS px of the page. */
export interface DesignProbeElement {
  readonly tag: string;
  readonly id: string | null;
  readonly component: string | null;
  readonly variant: string | null;
  readonly bind: string | null;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly visible: boolean;
}

/** An outermost element whose right edge passes the viewport's: `element` describes it, `width` is its width in CSS px. */
export interface DesignOverflowingElement {
  readonly element: string;
  readonly width: number;
}

/** One width of `design.probe`, measured in a viewport as tall as the content (at most 4000 CSS px). */
export interface DesignProbeWidth {
  readonly width: number;
  readonly contentHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  /** scrollWidth > clientWidth. */
  readonly overflow: boolean;
  readonly overflowing: readonly DesignOverflowingElement[];
  readonly elements: readonly DesignProbeElement[];
}

export interface DesignProbeSweep {
  readonly from: number;
  readonly to: number;
  readonly step: number;
  readonly overflowAt: readonly { readonly width: number; readonly scrollWidth: number }[];
}

export interface DesignProbeResult {
  readonly widths: readonly DesignProbeWidth[];
  /** The page's console errors during the run, uncaught exceptions included. */
  readonly consoleErrors: readonly string[];
  readonly sweep?: DesignProbeSweep;
}

/** `design.capture`: a PNG of the frame W × min(900, content height) CSS px at `scale` device px per CSS px (PD-41). */
export interface DesignCapture {
  readonly png: Uint8Array;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly contentHeight: number;
  readonly scale: number;
}
