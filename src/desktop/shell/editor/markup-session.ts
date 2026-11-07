import { markRaw, shallowReactive } from 'vue';
import { MAX_MARKUP_MARKS, type MarkupJsonInput, type MarkupMark } from '../../../shared/design-markup';
import type { DesignFreeze } from '../../preload/shell-channels';
import { shapeBox, strokeAnchors, type MarkupElement, type MarkupPoint } from './markup';

// A preview tab's markup in shell memory (PD-12): the frozen capture and its marks, kept across Exit and chat switches
// until Send, Clear with an Exit, or the tab's real close (onDesignPreviewClosed).

export type MarkupTool = 'pen' | 'arrow' | 'box' | 'pin';
export type PinKind = 'change' | 'note';

export interface PinDraft {
  readonly id: number;
  readonly type: 'pin';
  readonly kind: PinKind;
  readonly text: string;
  readonly at: MarkupPoint;
  readonly anchor: MarkupElement | null;
}

// pen: the kept path; arrow: [tail, head]; box: [start corner, end corner]
export interface StrokeDraft {
  readonly id: number;
  readonly type: 'pen' | 'arrow' | 'box';
  readonly points: readonly MarkupPoint[];
}

export type MarkDraft = PinDraft | StrokeDraft;

export interface MarkupSession {
  readonly tabId: string;
  readonly freeze: DesignFreeze;
  // replaced, never mutated in place: each undo snapshot keeps the marks as they were, and the session is shallowly reactive
  marks: readonly MarkDraft[];
  undo: readonly (readonly MarkDraft[])[];
  tool: MarkupTool;
  // markup is showing for the tab (main keeps its view hidden)
  active: boolean;
}

const sessions = shallowReactive(new Map<string, MarkupSession>());
let nextId = 1;

export function markupSession(tabId: string): MarkupSession | undefined {
  return sessions.get(tabId);
}

export function startMarkupSession(tabId: string, freeze: DesignFreeze): MarkupSession {
  const session = shallowReactive<MarkupSession>({ tabId, freeze: markRaw(freeze), marks: [], undo: [], tool: 'pin', active: true });
  sessions.set(tabId, session);
  return session;
}

export function dropMarkupSession(tabId: string): void {
  sessions.delete(tabId);
}

export function newMarkId(): number {
  return nextId++;
}

export function setMarkupTool(session: MarkupSession, tool: MarkupTool): void {
  session.tool = tool;
}

/** Replaces the marks as one undo step. */
export function commitMarks(session: MarkupSession, marks: readonly MarkDraft[]): void {
  session.undo = [...session.undo, session.marks];
  session.marks = marks;
}

/** Adds a mark as one undo step; false at the cap, which adds nothing. */
export function addMark(session: MarkupSession, mark: MarkDraft): boolean {
  if (session.marks.length >= MAX_MARKUP_MARKS) return false;
  commitMarks(session, [...session.marks, mark]);
  return true;
}

/** Replaces one mark; `step` makes it an undo step (a text edit is not one). */
export function replaceMark(session: MarkupSession, mark: MarkDraft, step: boolean): void {
  const marks = session.marks.map((candidate) => (candidate.id === mark.id ? mark : candidate));
  if (step) commitMarks(session, marks);
  else session.marks = marks;
}

export function removeMark(session: MarkupSession, id: number): void {
  commitMarks(session, session.marks.filter((mark) => mark.id !== id));
}

export function undoMarks(session: MarkupSession): boolean {
  const previous = session.undo.at(-1);
  if (previous === undefined) return false;
  session.undo = session.undo.slice(0, -1);
  session.marks = previous;
  return true;
}

/** Pins numbered 1..k in mark order, as the JSON and the flattened image number them. */
export function pinNumbers(marks: readonly MarkDraft[]): Map<number, number> {
  const numbers = new Map<number, number>();
  for (const mark of marks) if (mark.type === 'pin') numbers.set(mark.id, numbers.size + 1);
  return numbers;
}

/** feedback/F<n>.json as the shell sends it; core validates it and adds `image`. */
export function markupJson(session: MarkupSession): MarkupJsonInput {
  const { freeze } = session;
  const numbers = pinNumbers(session.marks);
  const marks = session.marks.map((mark): MarkupMark => {
    if (mark.type === 'pin') {
      return {
        type: 'pin', n: numbers.get(mark.id)!, kind: mark.kind, text: mark.text, at: [mark.at[0], mark.at[1]],
        anchor: mark.anchor ? { element: mark.anchor.element, facts: [...mark.anchor.facts] } : null,
      };
    }
    const [x, y, w, h] = shapeBox(mark.points);
    return { type: mark.type, bbox: [x, y, w, h], anchors: strokeAnchors([x, y, w, h], freeze.elements) };
  });
  return {
    screen: freeze.screen, file: freeze.file, viewport: { breakpoint: freeze.breakpoint, width: freeze.width },
    zoom: freeze.zoom, pixelRatio: freeze.pixelRatio, state: freeze.state, marks,
  };
}
