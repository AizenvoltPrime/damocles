// Branch readers for design mode (PD-23). Pure: they take parsed entries, possibly untrusted, and validate every field.
import { isSafeAgentPathId } from '../../shared/agent-path-id';
import { TOOL_ASK_USER_QUESTION, TOOL_EXIT_PLAN_MODE, TOOL_FINISH_DESIGN, TOOL_RECORD_DECISION } from '../../shared/tool-names';
import {
  DESIGN_DECISIONS_DETAIL_KEY,
  DESIGN_VERSION_DETAIL_KEY,
  type DecisionCheckUnavailable,
  type DesignDecisionConflict,
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
  DAMOCLES_DESIGN_DECISION,
  DAMOCLES_DESIGN_DECISION_CHECK,
  DAMOCLES_DESIGN_ENTRY,
  DAMOCLES_DESIGN_LINK_ENTRY,
  DAMOCLES_DESIGN_MARKUP_ENTRY,
  DAMOCLES_DESIGN_REFERENCES_ENTRY,
  DAMOCLES_DESIGN_RESULT,
  DAMOCLES_DESIGN_SUBAGENT_ANSWER,
  DAMOCLES_DESIGN_TWEAK_KEPT,
  DAMOCLES_DESIGN_VERSION_CHOICE,
  DAMOCLES_ORIGINAL_INPUT_ENTRY,
  DAMOCLES_STEER_ENTRY,
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

/** A decision as its entry, or an earlier build's tool result details, records it; never with `supersedes`. */
export interface DesignDecisionRecord extends DesignDecisionView {
  readonly v: 1;
  readonly files: string[];
  /** The design chat's subagent whose AskUserQuestion answer recorded it; absent for the designer's own. */
  readonly agentId?: string;
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

const DECISION_ID = /^D[1-9][0-9]{0,5}$/;
const isDecisionId = (value: unknown): value is string => typeof value === 'string' && DECISION_ID.test(value);
const isDecisionIdList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_DECISION_REFS && value.every(isDecisionId);

/** A decision names at most this many others in `replaces` or `stillHolds`, and stores at most this many flags. */
export const MAX_DECISION_REFS = 64;

/** A conflict flag's reason is cut to this many characters. */
export const MAX_CONFLICT_REASON_CHARS = 200;

const UNCHECKED_REASONS: ReadonlySet<string> = new Set<DecisionCheckUnavailable>(['noModel', 'unreachable', 'rejected', 'unanswered', 'stopped']);

function conflictOf(value: unknown): DesignDecisionConflict | undefined {
  if (!isRecord(value) || !isDecisionId(value['id']) || (value['kind'] !== 'contradicts' && value['kind'] !== 'restates')) return undefined;
  if (typeof value['reason'] !== 'string' || value['reason'].length > MAX_CONFLICT_REASON_CHARS) return undefined;
  return { id: value['id'], kind: value['kind'], reason: value['reason'] };
}

function decisionOf(value: unknown): DesignDecisionRecord | undefined {
  if (!isRecord(value) || value['v'] !== 1) return undefined;
  const { id, title, chosen, rejected, source, reference, files, supersedes, replaces, stillHolds, conflicts, conflictCheck, uncheckedReason, agentId } = value;
  if (!isDecisionId(id)) return undefined;
  if (!boundedString(title) || !boundedString(chosen)) return undefined;
  if (!Array.isArray(rejected) || !rejected.every(boundedString)) return undefined;
  if (!Array.isArray(files) || !files.every(boundedString)) return undefined;
  if (!isRecord(source) || typeof source['kind'] !== 'string' || !SOURCE_KINDS.has(source['kind']) || !boundedString(source['ref'])) return undefined;
  if (reference !== undefined && !boundedString(reference)) return undefined;
  if (supersedes !== undefined && !isDecisionId(supersedes)) return undefined;
  if ((replaces !== undefined && !isDecisionIdList(replaces)) || (stillHolds !== undefined && !isDecisionIdList(stillHolds))) return undefined;
  if (conflicts !== undefined && (!Array.isArray(conflicts) || conflicts.length > MAX_DECISION_REFS)) return undefined;
  const flags = conflicts === undefined ? undefined : conflicts.map(conflictOf);
  if (flags?.some((flag) => flag === undefined)) return undefined;
  if (conflictCheck !== undefined && conflictCheck !== 'checked' && conflictCheck !== 'unchecked') return undefined;
  if (uncheckedReason !== undefined && (typeof uncheckedReason !== 'string' || !UNCHECKED_REASONS.has(uncheckedReason))) return undefined;
  if (agentId !== undefined && (typeof agentId !== 'string' || !isSafeAgentPathId(agentId))) return undefined;
  // an earlier build superseded the latest decision of the same title; it reads as replacing it
  const replaced = replaces ?? (supersedes !== undefined ? [supersedes] : undefined);
  return {
    v: 1,
    id,
    title,
    chosen,
    rejected: [...rejected],
    source: { kind: source['kind'] as DesignDecisionSourceKind, ref: source['ref'] },
    ...(reference !== undefined ? { reference } : {}),
    files: [...files],
    ...(replaced && replaced.length > 0 ? { replaces: [...replaced] } : {}),
    ...(stillHolds && stillHolds.length > 0 ? { stillHolds: [...stillHolds] } : {}),
    ...(flags && flags.length > 0 ? { conflicts: flags as DesignDecisionConflict[] } : {}),
    ...(conflictCheck !== undefined ? { conflictCheck } : {}),
    ...(conflictCheck === 'unchecked' && uncheckedReason !== undefined ? { uncheckedReason: uncheckedReason as DecisionCheckUnavailable } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

/** The decisions a tool result's details carry, or none. */
export function decisionsInDetails(details: unknown): DesignDecisionRecord[] {
  if (!isRecord(details)) return [];
  const list = details[DESIGN_DECISIONS_DETAIL_KEY];
  if (!Array.isArray(list)) return [];
  return list.flatMap((value) => decisionOf(value) ?? []);
}

/** A decision as a view shows it: the record without its version and files. */
export function decisionView(record: DesignDecisionRecord): DesignDecisionView {
  const { v: _v, files: _files, agentId: _agentId, ...view } = record;
  return view;
}

/** The decision entry's data as core appends it. */
export function decisionEntryData(record: DesignDecisionRecord): Record<string, unknown> {
  return { ...record, v: 1 };
}

/** A later conflict check of decision `id` (FinishDesign's): it now counts as checked, with the flags a question decision stores. */
export function decisionCheckEntryData(id: string, conflicts: readonly DesignDecisionConflict[]): Record<string, unknown> {
  return { v: 1, id, conflictCheck: 'checked', ...(conflicts.length > 0 ? { conflicts: [...conflicts] } : {}) };
}

function decisionCheckOf(entry: unknown): { readonly id: string; readonly conflicts: DesignDecisionConflict[] } | undefined {
  const data = customData(entry, DAMOCLES_DESIGN_DECISION_CHECK);
  if (!data || !isDecisionId(data['id']) || data['conflictCheck'] !== 'checked') return undefined;
  const raw = data['conflicts'];
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > MAX_DECISION_REFS)) return undefined;
  const flags = (raw ?? []).map(conflictOf);
  return flags.every((flag) => flag !== undefined) ? { id: data['id'], conflicts: flags as DesignDecisionConflict[] } : undefined;
}

/**
 * The decisions on `branch` in branch order: the decision entries core appends (D99), then the decisions in the details of
 * successful AskUserQuestion and RecordDecision results, which sessions written before those entries hold. A decision is
 * its id, and its entry wins over the same id in details. A check entry marks its decision checked. `branch` runs from the
 * root, so a rewind or a fork keeps exactly the decisions its own branch holds.
 */
export function decisionsOnBranch(branch: readonly unknown[]): DesignDecisionRecord[] {
  const entered = new Set<string>();
  for (const entry of branch) {
    const data = customData(entry, DAMOCLES_DESIGN_DECISION);
    const record = data ? decisionOf(data) : undefined;
    if (record) entered.add(record.id);
  }
  const decisions = new Map<string, DesignDecisionRecord>();
  for (const entry of branch) {
    const data = customData(entry, DAMOCLES_DESIGN_DECISION);
    if (data) {
      const record = decisionOf(data);
      if (record && !decisions.has(record.id)) decisions.set(record.id, record);
      continue;
    }
    const check = decisionCheckOf(entry);
    if (check) {
      const held = decisions.get(check.id);
      if (held) {
        const checked: DesignDecisionRecord = { ...held, conflictCheck: 'checked', conflicts: check.conflicts };
        delete checked.uncheckedReason;
        if (check.conflicts.length === 0) delete checked.conflicts;
        decisions.set(check.id, checked);
      }
      continue;
    }
    if (!isRecord(entry) || entry['type'] !== 'message') continue;
    const message = entry['message'];
    if (!isRecord(message) || message['role'] !== 'toolResult' || message['isError'] === true) continue;
    if (message['toolName'] !== TOOL_ASK_USER_QUESTION && message['toolName'] !== TOOL_RECORD_DECISION) continue;
    for (const record of decisionsInDetails(message['details'])) {
      // a legacy session numbered a decision by its count, so a later one of the same id replaced the earlier record
      if (!entered.has(record.id)) {
        decisions.delete(record.id);
        decisions.set(record.id, record);
      }
    }
  }
  return [...decisions.values()];
}

/** Which decision replaced each replaced one: the latest that names it in `replaces`. */
export function replacedBy(all: readonly DesignDecisionRecord[]): Map<string, string> {
  const by = new Map<string, string>();
  for (const decision of all) for (const id of decision.replaces ?? []) by.set(id, decision.id);
  return by;
}

/**
 * The decisions no other decision replaced, in branch order. Two of them may still conflict: an answer's flag is stored and blocks
 * FinishDesign until a later decision resolves it, and that a replacement restates what still holds is guidance, not a check.
 */
export function currentDecisions(all: readonly DesignDecisionRecord[]): DesignDecisionRecord[] {
  const replaced = replacedBy(all);
  return all.filter((decision) => !replaced.has(decision.id));
}

/**
 * The flags of `decision` still active: it is current, and so is the decision each flag names. DesignCheck reports these, and the
 * design chat's published state carries only these.
 */
export function activeConflicts(decision: Pick<DesignDecisionRecord, 'id' | 'conflicts'>, current: ReadonlySet<string>): DesignDecisionConflict[] {
  if (!current.has(decision.id)) return [];
  return (decision.conflicts ?? []).filter((flag) => current.has(flag.id));
}

/** The id the next decision takes: one past the highest on `all`. */
export function nextDecisionId(all: readonly DesignDecisionRecord[]): string {
  return `D${all.reduce((max, decision) => Math.max(max, Number(decision.id.slice(1))), 0) + 1}`;
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
 * The option labels an answer chose, and the text the user typed after them. The answer is the selected labels joined with
 * ", ", then any typed text, so a label may hold a comma: the whole answer is matched against each label first, then labels
 * are read off its start in turn.
 */
export function answerParts(answer: string, labels: readonly string[], multiSelect: boolean): { readonly chosen: Set<string>; readonly typed: string } {
  const text = answer.trim();
  const whole = labels.find((label) => label.trim() === text);
  if (whole !== undefined) return { chosen: new Set([whole]), typed: '' };
  const longestFirst = [...labels].filter((label) => label !== '').sort((a, b) => b.length - a.length);
  const chosen = new Set<string>();
  let at = 0;
  while (at < text.length) {
    const label = longestFirst.find((candidate) => text.startsWith(candidate, at) && (at + candidate.length === text.length || text.startsWith(', ', at + candidate.length)));
    if (label === undefined) break;
    chosen.add(label);
    at = Math.min(text.length, at + label.length + 2);
    if (!multiSelect) break;
  }
  return { chosen, typed: text.slice(at).trim() };
}

function toolResultText(message: Record<string, unknown>): string {
  const content = message['content'];
  if (!Array.isArray(content)) return '';
  return content.map((block) => (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : '')).join('');
}

/** What the user typed and noted answering a design chat subagent's question, as its entry on the design chat's branch holds it. */
export interface SubagentAnswer {
  readonly agentId: string;
  readonly question: string;
  readonly typed: string;
  readonly notes?: string;
}

/** The subagent answer entry's data as core appends it. */
export function subagentAnswerEntryData(answer: SubagentAnswer): Record<string, unknown> {
  return { v: 1, agentId: answer.agentId, question: answer.question, typed: answer.typed, ...(answer.notes !== undefined ? { notes: answer.notes } : {}) };
}

function subagentAnswerOf(entry: unknown): SubagentAnswer | undefined {
  const data = customData(entry, DAMOCLES_DESIGN_SUBAGENT_ANSWER);
  if (!data) return undefined;
  const { agentId, question, typed, notes } = data;
  if (typeof agentId !== 'string' || !isSafeAgentPathId(agentId) || !boundedString(question) || !boundedString(typed)) return undefined;
  if (notes !== undefined && !boundedString(notes)) return undefined;
  return { agentId, question, typed, ...(notes !== undefined ? { notes } : {}) };
}

// What the user typed into an AskUserQuestion result: each answer's text past its chosen labels, and each note.
function typedAnswers(message: Record<string, unknown>): string[] {
  let output: unknown;
  try {
    output = JSON.parse(toolResultText(message)) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(output) || !isRecord(output['answers']) || !Array.isArray(output['questions'])) return [];
  const answers = output['answers'];
  const typed: string[] = [];
  for (const question of output['questions']) {
    if (!isRecord(question) || typeof question['question'] !== 'string') continue;
    const answer = answers[question['question']];
    if (typeof answer !== 'string') continue;
    const labels = Array.isArray(question['options']) ? question['options'].flatMap((option) => (isRecord(option) && typeof option['label'] === 'string' ? [option['label']] : [])) : [];
    typed.push(answerParts(answer, labels, question['multiSelect'] === true).typed);
  }
  const annotations = output['annotations'];
  if (isRecord(annotations)) {
    for (const annotation of Object.values(annotations)) if (isRecord(annotation) && typeof annotation['notes'] === 'string') typed.push(annotation['notes']);
  }
  return typed;
}

/**
 * Whether text the user wrote on `branch` contains `quote`, spaces collapsed (a `chat` decision source): a message they typed,
 * the typed part of an AskUserQuestion answer and its notes, the same of a subagent's question (its subagent answer entry), a
 * FinishDesign change note, or a steer they sent a subagent. A prompt core composed (a markup, a Keep) is none of the user's
 * text, and a message core extended (a references note, an expanded command) counts with the text its original-input entry
 * records. The designer's own SteerSubagent input is no `damocles-steer` entry, and a subagent's result is its own words.
 */
export function userAuthoredQuoted(branch: readonly unknown[], quote: string): boolean {
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
  const quotes = (text: string): boolean => collapseSpace(text).includes(wanted);
  return branch.some((entry) => {
    if (!isRecord(entry)) return false;
    if (entry['type'] === 'custom' && entry['customType'] === DAMOCLES_STEER_ENTRY) {
      const data = entry['data'];
      return isRecord(data) && typeof data['message'] === 'string' && quotes(data['message']);
    }
    const answer = subagentAnswerOf(entry);
    if (answer) return quotes(answer.typed) || (answer.notes !== undefined && quotes(answer.notes));
    if (entry['type'] !== 'message' || typeof entry['id'] !== 'string' || composed.has(entry['id'])) return false;
    const message = entry['message'];
    if (!isRecord(message)) return false;
    if (message['role'] === 'toolResult' && message['toolName'] === TOOL_ASK_USER_QUESTION && message['isError'] !== true) return typedAnswers(message).some(quotes);
    if (message['role'] === 'toolResult' && message['toolName'] === TOOL_FINISH_DESIGN) {
      const details = message['details'];
      return isRecord(details) && details['approval'] === 'changesRequested' && typeof details['feedback'] === 'string' && quotes(details['feedback']);
    }
    if (message['role'] !== 'user') return false;
    return quotes(typed.get(entry['id']) ?? (extended.has(entry['id']) ? '' : userText(message)));
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
