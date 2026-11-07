// Branch readers for design mode (PD-23). Pure: they take parsed entries, possibly untrusted, and validate every field.
import { isSafeAgentPathId } from '../../shared/agent-path-id';
import { TOOL_ASK_USER_QUESTION, TOOL_EXIT_PLAN_MODE, TOOL_FINISH_DESIGN, TOOL_RECORD_DECISION } from '../../shared/tool-names';
import {
  DESIGN_DECISIONS_DETAIL_KEY,
  DESIGN_VERSION_DETAIL_KEY,
  type DesignDecisionSourceKind,
  type DesignDecisionView,
  type DesignResultView,
  type DesignRuleSetId,
  type DesignVersionChoice,
  type DesignVersionStamp,
  type PlanApprovalDesignLink,
} from '../../shared/types/design';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { PLAN_VERSION_DETAIL_KEY } from '../../shared/types/session';
import {
  DAMOCLES_DESIGN_BRIEF,
  DAMOCLES_DESIGN_ENTRY,
  DAMOCLES_DESIGN_LINK_ENTRY,
  DAMOCLES_DESIGN_MARKUP_ENTRY,
  DAMOCLES_DESIGN_REFERENCES_ENTRY,
  DAMOCLES_DESIGN_RESULT,
  DAMOCLES_DESIGN_TWEAK_KEPT,
  DAMOCLES_DESIGN_VERSION_CHOICE,
  DAMOCLES_ORIGINAL_INPUT_ENTRY,
} from '../pi-session/session-store/constants';
import { designFolderOf } from './design-paths';

/** A design chat's role entry; `folder` is always derived from `designId`, never read from the file. */
export interface DesignRole {
  readonly designId: string;
  readonly folder: string;
  readonly parentSessionId: string | null;
  readonly ruleSet: DesignRuleSetId;
  /** StartDesign's title for the design, which the design chat's name repeats. */
  readonly title: string;
}

/** A parent's link entry; `folder` is always derived from `designId`. */
export interface DesignLink {
  readonly designId: string;
  readonly folder: string;
  readonly parentSessionId: string;
  readonly title: string;
}

const titleOf = (value: unknown, designId: string): string => (typeof value === 'string' && value.trim() !== '' ? value.slice(0, MAX_TITLE_CHARS) : designId);

/** A design's title is at most this long. */
export const MAX_TITLE_CHARS = 200;

/** A decision as its tool result's details record it. */
export interface DesignDecisionRecord extends DesignDecisionView {
  readonly v: 1;
  readonly files: string[];
}

/** Every decision field is at most this long. */
export const MAX_DECISION_FIELD_CHARS = 4000;

const SOURCE_KINDS: ReadonlySet<string> = new Set<DesignDecisionSourceKind>(['question', 'chat', 'markup', 'tweak', 'reference', 'brief']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function customData(entry: unknown, customType: string): Record<string, unknown> | undefined {
  if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== customType) return undefined;
  const data = entry['data'];
  return isRecord(data) && data['v'] === 1 ? data : undefined;
}

function roleOf(entry: unknown): DesignRole | undefined {
  const data = customData(entry, DAMOCLES_DESIGN_ENTRY);
  if (!data) return undefined;
  const { designId, parentSessionId, ruleSet, title } = data;
  if (typeof designId !== 'string' || !isSafeAgentPathId(designId)) return undefined;
  if (parentSessionId !== null && (typeof parentSessionId !== 'string' || !isSafeAgentPathId(parentSessionId))) return undefined;
  if (ruleSet !== 'full' && ruleSet !== 'reduced') return undefined;
  return { designId, folder: designFolderOf(designId), parentSessionId, ruleSet, title: titleOf(title, designId) };
}

function linkOf(entry: unknown): DesignLink | undefined {
  const data = customData(entry, DAMOCLES_DESIGN_LINK_ENTRY);
  if (!data) return undefined;
  const { designId, parentSessionId, title } = data;
  if (typeof designId !== 'string' || !isSafeAgentPathId(designId)) return undefined;
  if (typeof parentSessionId !== 'string' || !isSafeAgentPathId(parentSessionId)) return undefined;
  return { designId, folder: designFolderOf(designId), parentSessionId, title: titleOf(title, designId) };
}

/**
 * The design role a session's entries record: the latest role entry decides, and one that does not parse gives none, so a chat
 * fails closed rather than falling back to an earlier design. Core appends a later role entry only into a design fork's file.
 */
export function designRoleOf(entries: readonly unknown[]): DesignRole | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isRecord(entry) && entry['type'] === 'custom' && entry['customType'] === DAMOCLES_DESIGN_ENTRY) return roleOf(entry);
  }
  return undefined;
}

/** Whether `entries` hold a role entry at all, readable or not. */
export function hasDesignRoleEntry(entries: readonly unknown[]): boolean {
  return entries.some((entry) => isRecord(entry) && entry['type'] === 'custom' && entry['customType'] === DAMOCLES_DESIGN_ENTRY);
}

/** The role entry's data as core appends it. */
export function designRoleEntryData(role: DesignRole): Record<string, unknown> {
  return { v: 1, designId: role.designId, folder: role.folder, parentSessionId: role.parentSessionId, ruleSet: role.ruleSet, title: role.title };
}

/** The link entry's data as core appends it. */
export function designLinkEntryData(link: DesignLink): Record<string, unknown> {
  return { v: 1, designId: link.designId, folder: link.folder, parentSessionId: link.parentSessionId, title: link.title };
}

/** The latest link on `branch` that `sessionId` made itself; a fork's inherited link is inert (PD-37). */
export function ownDesignLink(branch: readonly unknown[], sessionId: string): DesignLink | undefined {
  return ownDesignLinkAt(branch, sessionId)?.link;
}

// `index` is the design's first link on the branch: a conversation rewind's new chat re-links the design it carries (D70),
// and the plan approvals before that re-link still follow the design's start.
function ownDesignLinkAt(branch: readonly unknown[], sessionId: string): { readonly link: DesignLink; readonly index: number } | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const link = linkOf(branch[i]);
    if (!link || link.parentSessionId !== sessionId) continue;
    const index = branch.findIndex((entry) => linkOf(entry)?.designId === link.designId);
    return { link, index };
  }
  return undefined;
}

/** Whether `branch` holds a link entry of design `designId`, whichever chat made it. */
export function designLinkedOn(branch: readonly unknown[], designId: string): boolean {
  return branch.some((entry) => linkOf(entry)?.designId === designId);
}

/** The latest link on `branch` another session made: a fork inherited it from its source (PD-37). */
export function inheritedDesignLink(branch: readonly unknown[], sessionId: string): DesignLink | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const link = linkOf(branch[i]);
    if (link && link.parentSessionId !== sessionId) return link;
  }
  return undefined;
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_DECISION_FIELD_CHARS;
}

function decisionOf(value: unknown): DesignDecisionRecord | undefined {
  if (!isRecord(value) || value['v'] !== 1) return undefined;
  const { id, title, chosen, rejected, source, files, supersedes } = value;
  if (typeof id !== 'string' || !/^D[1-9][0-9]{0,5}$/.test(id)) return undefined;
  if (!boundedString(title) || !boundedString(chosen)) return undefined;
  if (!Array.isArray(rejected) || !rejected.every(boundedString)) return undefined;
  if (!Array.isArray(files) || !files.every(boundedString)) return undefined;
  if (!isRecord(source) || typeof source['kind'] !== 'string' || !SOURCE_KINDS.has(source['kind']) || !boundedString(source['ref'])) return undefined;
  if (supersedes !== undefined && (typeof supersedes !== 'string' || !/^D[1-9][0-9]{0,5}$/.test(supersedes))) return undefined;
  return {
    v: 1,
    id,
    title,
    chosen,
    rejected: [...rejected],
    source: { kind: source['kind'] as DesignDecisionSourceKind, ref: source['ref'] },
    files: [...files],
    ...(supersedes !== undefined ? { supersedes } : {}),
  };
}

/** The decisions a tool result's details carry, or none. */
export function decisionsInDetails(details: unknown): DesignDecisionRecord[] {
  if (!isRecord(details)) return [];
  const list = details[DESIGN_DECISIONS_DETAIL_KEY];
  if (!Array.isArray(list)) return [];
  return list.flatMap((value) => decisionOf(value) ?? []);
}

/**
 * The decisions on `branch` in branch order: the successful AskUserQuestion and RecordDecision results that carry
 * them, as `planVersionOnBranch` reads ExitPlanMode's stamp. `branch` runs from the root, so a rewind or a fork
 * keeps exactly the decisions its own branch holds.
 */
export function decisionsOnBranch(branch: readonly unknown[]): DesignDecisionRecord[] {
  const decisions: DesignDecisionRecord[] = [];
  for (const entry of branch) {
    if (!isRecord(entry) || entry['type'] !== 'message') continue;
    const message = entry['message'];
    if (!isRecord(message) || message['role'] !== 'toolResult' || message['isError'] === true) continue;
    if (message['toolName'] !== TOOL_ASK_USER_QUESTION && message['toolName'] !== TOOL_RECORD_DECISION) continue;
    decisions.push(...decisionsInDetails(message['details']));
  }
  return decisions;
}

/**
 * The highest version of design `designId` a successful FinishDesign result on `branch` handed over. A fork's own design has a
 * new id, so the versions it inherited from its source's branch do not count.
 */
export function finishedDesignVersion(branch: readonly unknown[], designId: string): number | undefined {
  let finished: number | undefined;
  for (const entry of branch) {
    if (!isRecord(entry) || entry['type'] !== 'message') continue;
    const message = entry['message'];
    if (!isRecord(message) || message['role'] !== 'toolResult' || message['isError'] === true || message['toolName'] !== TOOL_FINISH_DESIGN) continue;
    const details = message['details'];
    if (!isRecord(details) || details['designId'] !== designId || !isVersion(details['version'])) continue;
    if (finished === undefined || details['version'] > finished) finished = details['version'];
  }
  return finished;
}

function customMessageDetails(entry: unknown, customType: string): Record<string, unknown> | undefined {
  if (!isRecord(entry) || entry['type'] !== 'custom_message' || entry['customType'] !== customType) return undefined;
  const details = entry['details'];
  return isRecord(details) ? details : undefined;
}

/** The key D holds for a delivered version. */
export function deliveredResultKey(designId: string, version: number): string {
  return `${designId}#${version}`;
}

/** D: the `(designId, version)` results already appended to `branch` (PD-27). */
export function deliveredDesignResults(branch: readonly unknown[]): Set<string> {
  const delivered = new Set<string>();
  for (const entry of branch) {
    const details = customMessageDetails(entry, DAMOCLES_DESIGN_RESULT);
    if (details && typeof details['designId'] === 'string' && typeof details['version'] === 'number') {
      delivered.add(deliveredResultKey(details['designId'], details['version']));
    }
  }
  return delivered;
}

const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;

/** The details of the latest result card of design `designId` on `branch`, the highest version delivered there. */
export function latestDesignResult(branch: readonly unknown[], designId: string): DesignResultView | undefined {
  let latest: DesignResultView | undefined;
  for (const entry of branch) {
    const details = customMessageDetails(entry, DAMOCLES_DESIGN_RESULT);
    if (!details || details['designId'] !== designId || !isVersion(details['version'])) continue;
    if (!latest || details['version'] > latest.version) latest = details as unknown as DesignResultView;
  }
  return latest;
}

/**
 * The entry id of the latest result card of design `designId` on `branch` while nothing answered it: no user or assistant
 * message follows it and it did not pause the parent (PD-20, PD-29); else null.
 */
export function resultAwaitingContinue(branch: readonly unknown[], designId: string): string | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!isRecord(entry)) continue;
    if (entry['type'] === 'message' && isRecord(entry['message']) && (entry['message']['role'] === 'user' || entry['message']['role'] === 'assistant')) return null;
    const details = customMessageDetails(entry, DAMOCLES_DESIGN_RESULT);
    if (!details || details['designId'] !== designId) continue;
    return details['versionPause'] === undefined && typeof entry['id'] === 'string' ? entry['id'] : null;
  }
  return null;
}

/** What `ExitPlanMode` records under `DESIGN_VERSION_DETAIL_KEY` now: the latest version of the own link's design delivered on `branch`. */
export function designVersionStamp(branch: readonly unknown[], sessionId: string): DesignVersionStamp | null {
  const link = ownDesignLink(branch, sessionId);
  const latest = link ? latestDesignResult(branch, link.designId) : undefined;
  return link && latest ? { designId: link.designId, version: latest.version } : null;
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The plan approval's linked design: the card of the version `designVersionStamp` records; undefined without one. */
export function planApprovalDesignLink(branch: readonly unknown[], sessionId: string): PlanApprovalDesignLink | undefined {
  const link = ownDesignLink(branch, sessionId);
  const view = link ? latestDesignResult(branch, link.designId) : undefined;
  if (!link || !view) return undefined;
  const check: unknown = view.check;
  return {
    designId: link.designId,
    title: typeof view.title === 'string' ? view.title : link.title,
    folder: link.folder,
    version: view.version,
    screens: listOf(view.screens).length,
    decisions: listOf(view.decisions).length,
    warnings: listOf(isRecord(check) ? check['warnings'] : undefined) as PlanApprovalDesignLink['warnings'],
    journeysPassed: journeysPassedOf(view.journeys),
  };
}

// True when every screen's journey passed or was waived, null for a version with none (a static design, REDUCED).
function journeysPassedOf(value: unknown): boolean | null {
  const journeys = listOf(value);
  if (journeys.length === 0) return null;
  return journeys.every((journey) => isRecord(journey) && (journey['waiver'] === true || journey['passed'] === true));
}

function stampOf(value: unknown): DesignVersionStamp | null {
  if (!isRecord(value) || typeof value['designId'] !== 'string' || !isSafeAgentPathId(value['designId']) || !isVersion(value['version'])) return null;
  return { designId: value['designId'], version: value['version'] };
}

/** An approved plan on a branch: where its `ExitPlanMode` result sits, and the design version it recorded. */
export interface DesignApproval {
  readonly index: number;
  readonly stamp: DesignVersionStamp | null;
}

/**
 * The latest approved `ExitPlanMode` on `branch` and the design version it recorded (PD-16), read as `planVersionOnBranch` reads
 * the plan version: a successful result with a stamped plan version. A denied, stopped or not-in-plan-mode call approved nothing.
 */
export function approvedDesignVersion(branch: readonly unknown[]): DesignApproval | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!isRecord(entry) || entry['type'] !== 'message') continue;
    const message = entry['message'];
    if (!isRecord(message) || message['role'] !== 'toolResult' || message['toolName'] !== TOOL_EXIT_PLAN_MODE || message['isError'] === true) continue;
    const details = message['details'];
    if (!isRecord(details) || typeof details[PLAN_VERSION_DETAIL_KEY] !== 'number') continue;
    return { index: i, stamp: stampOf(details[DESIGN_VERSION_DETAIL_KEY]) };
  }
  return undefined;
}

/**
 * The design version the latest plan approval after the own link recorded (0: none, or another design's), or undefined when no
 * approval follows the link, so a new version is an ordinary delivery (PD-51).
 */
export function approvedVersionAfterLink(branch: readonly unknown[], sessionId: string): { readonly designId: string; readonly fromVersion: number } | undefined {
  const own = ownDesignLinkAt(branch, sessionId);
  const approval = approvedDesignVersion(branch);
  if (!own || !approval || approval.index < own.index) return undefined;
  return { designId: own.link.designId, fromVersion: approval.stamp?.designId === own.link.designId ? approval.stamp.version : 0 };
}

/** A version pause (PD-29): design `toVersion` arrived after the plan was approved against `fromVersion`. */
export interface DesignVersionPause {
  readonly designId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

/** Whether `branch` holds the answer to the version pause of design `designId` at `toVersion`. */
export function versionChoiceMade(branch: readonly unknown[], designId: string, toVersion: number): boolean {
  return branch.some((entry) => {
    const data = customData(entry, DAMOCLES_DESIGN_VERSION_CHOICE);
    return data !== undefined && data['designId'] === designId && data['toVersion'] === toVersion;
  });
}

/** The choice entry's data as core appends it. */
export function versionChoiceEntryData(pause: DesignVersionPause, choice: DesignVersionChoice): Record<string, unknown> {
  return { v: 1, designId: pause.designId, fromVersion: pause.fromVersion, toVersion: pause.toVersion, choice };
}

/**
 * The version pause `branch` still owes an answer: the latest card of the own link's design was appended by the pause, has no
 * choice entry, and is still newer than the latest approval after the link. Undefined when there is nothing to ask.
 */
export function unansweredVersionPause(branch: readonly unknown[], sessionId: string): DesignVersionPause | undefined {
  const approved = approvedVersionAfterLink(branch, sessionId);
  if (!approved) return undefined;
  const latest = latestDesignResult(branch, approved.designId);
  if (!latest || !isRecord(latest.versionPause) || latest.version <= approved.fromVersion) return undefined;
  if (versionChoiceMade(branch, approved.designId, latest.version)) return undefined;
  return { designId: approved.designId, fromVersion: approved.fromVersion, toVersion: latest.version };
}

/** The brief ids already appended to `branch`. */
export function deliveredBriefs(branch: readonly unknown[]): Set<string> {
  const delivered = new Set<string>();
  for (const entry of branch) {
    const details = customMessageDetails(entry, DAMOCLES_DESIGN_BRIEF);
    if (details && typeof details['briefId'] === 'string') delivered.add(details['briefId']);
  }
  return delivered;
}

function userText(message: Record<string, unknown>): string {
  const content = message['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : '')).join('\n');
}

const collapseSpace = (text: string): string => text.replace(/\s+/g, ' ').trim();

// The entries naming a user message core composed (a markup's, a Keep's), one whose text core extended (a references note), and the typed text.
const COMPOSED_PROMPT_ENTRIES: ReadonlySet<string> = new Set([DAMOCLES_DESIGN_MARKUP_ENTRY, DAMOCLES_DESIGN_TWEAK_KEPT]);
const REFERENCE_ENTRIES: ReadonlySet<string> = new Set([DAMOCLES_DESIGN_REFERENCES_ENTRY]);
const ORIGINAL_INPUT_ENTRIES: ReadonlySet<string> = new Set([DAMOCLES_ORIGINAL_INPUT_ENTRY]);

function userEntryIdOf(entry: unknown, customTypes: ReadonlySet<string>): string | undefined {
  if (!isRecord(entry) || entry['type'] !== 'custom' || typeof entry['customType'] !== 'string' || !customTypes.has(entry['customType'])) return undefined;
  const data = entry['data'];
  return isRecord(data) && typeof data['userEntryId'] === 'string' ? data['userEntryId'] : undefined;
}

/**
 * Whether text the user typed in a message on `branch` contains `quote`, spaces collapsed (a `chat` decision source). A prompt
 * core composed (a markup, a Keep) is none of the user's text, and a message core extended (a references note, an expanded
 * command) counts with the text its original-input entry records.
 */
export function userMessageQuoted(branch: readonly unknown[], quote: string): boolean {
  const wanted = collapseSpace(quote);
  if (wanted === '') return false;
  const composed = new Set(branch.flatMap((entry) => userEntryIdOf(entry, COMPOSED_PROMPT_ENTRIES) ?? []));
  const extended = new Set(branch.flatMap((entry) => userEntryIdOf(entry, REFERENCE_ENTRIES) ?? []));
  const typed = new Map<string, string>();
  for (const entry of branch) {
    const id = userEntryIdOf(entry, ORIGINAL_INPUT_ENTRIES);
    const original = isRecord(entry) && isRecord(entry['data']) ? entry['data']['original'] : undefined;
    if (id !== undefined && typeof original === 'string') typed.set(id, original);
  }
  return branch.some((entry) => {
    if (!isRecord(entry) || entry['type'] !== 'message' || typeof entry['id'] !== 'string' || composed.has(entry['id'])) return false;
    const message = entry['message'];
    if (!isRecord(message) || message['role'] !== 'user') return false;
    const text = typed.get(entry['id']) ?? (extended.has(entry['id']) ? '' : userText(message));
    return collapseSpace(text).includes(wanted);
  });
}

/**
 * The webview message a delivered design entry posts: `designResult` for a result, `designBrief` for a brief; undefined for
 * any other entry. `replayed` marks the history replay's posts.
 */
export function designEntryMessage(entry: unknown, replayed: boolean): Extract<ExtensionToWebviewMessage, { type: 'designResult' | 'designBrief' }> | undefined {
  if (!isRecord(entry) || entry['type'] !== 'custom_message' || typeof entry['id'] !== 'string') return undefined;
  const details = entry['details'];
  if (!isRecord(details)) return undefined;
  const flag = replayed ? { replayed: true as const } : {};
  if (entry['customType'] === DAMOCLES_DESIGN_RESULT && typeof details['designId'] === 'string' && typeof details['version'] === 'number') {
    return { type: 'designResult', entryId: entry['id'], result: details as unknown as DesignResultView, ...flag };
  }
  if (entry['customType'] === DAMOCLES_DESIGN_BRIEF && typeof details['briefId'] === 'string' && typeof details['text'] === 'string') {
    return { type: 'designBrief', entryId: entry['id'], brief: { briefId: details['briefId'], text: details['text'], reopened: details['reopened'] === true }, ...flag };
  }
  return undefined;
}
