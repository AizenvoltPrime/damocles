// A preview's markup (PD-12, PD-41; docs/invariants.md "Design mode"): drawn by the shell on a frozen capture, saved by core
// as feedback/F<n>.json beside feedback/F<n>.png. Coordinates are viewport CSS px at the frozen width.
import { DESIGN_NAME } from './design-paths';

export const MAX_MARKUP_MARKS = 64;
export const MAX_MARKUP_PIN_TEXT = 4000;
export const MAX_MARKUP_ELEMENT_CHARS = 200;
export const MAX_MARKUP_FACTS = 8;
export const MAX_MARKUP_FACT_CHARS = 200;
export const MAX_MARKUP_STROKE_ANCHORS = 64;
/** A mark's y is at most this many CSS px; x is at most the frozen width. */
export const MAX_MARKUP_Y = 20_000;
/** A screen, state or breakpoint name, as main keeps them from design.info. */
export const MARKUP_NAME: RegExp = DESIGN_NAME;
/** The markup JSON main sends core, as JSON text: 64 marks of 4000 characters with their elements fit well within it. */
export const MAX_MARKUP_JSON_CHARS: number = 1024 * 1024;

export type MarkupPinKind = 'change' | 'note';
export type MarkupStrokeType = 'pen' | 'arrow' | 'box';

export interface MarkupAnchor {
  readonly element: string;
  readonly facts: readonly string[];
}

export interface MarkupPin {
  readonly type: 'pin';
  /** 1-based, unique among the pins. */
  readonly n: number;
  readonly kind: MarkupPinKind;
  readonly text: string;
  readonly at: readonly [number, number];
  readonly anchor: MarkupAnchor | null;
}

export interface MarkupStroke {
  readonly type: MarkupStrokeType;
  readonly bbox: readonly [number, number, number, number];
  readonly anchors: readonly string[];
}

export type MarkupMark = MarkupPin | MarkupStroke;

/** feedback/F<n>.json. */
export interface MarkupJson {
  readonly screen: string | null;
  /** `screens/<name>.html` */
  readonly file: string;
  readonly viewport: { readonly breakpoint: string; readonly width: number };
  readonly zoom: number;
  readonly pixelRatio: number;
  readonly state: string;
  /** `feedback/F<n>.png` */
  readonly image: string;
  readonly marks: readonly MarkupMark[];
}

/** What the shell sends; core fills `image`. */
export type MarkupJsonInput = Omit<MarkupJson, 'image'>;

/** A mark as the transcript's markup card lists it: a pin's element is null when it was dropped on no element. */
export type DesignMarkupViewMark =
  | { readonly type: 'pin'; readonly n: number; readonly kind: MarkupPinKind; readonly element: string | null; readonly text: string }
  | { readonly type: MarkupStrokeType; readonly elements: readonly string[] };

/** A sent markup as its transcript card shows it: where it was drawn, and each mark in order. */
export interface DesignMarkupView {
  readonly file: string;
  readonly breakpoint: string;
  readonly width: number;
  readonly state: string;
  readonly marks: readonly DesignMarkupViewMark[];
}

/** A user message that is a preview's markup: its F<n>, and its marks, absent from a message an earlier build sent. */
export interface DesignMarkupNote {
  readonly feedbackId: string;
  readonly markup?: DesignMarkupView;
}

export function designMarkupView(markup: MarkupJsonInput): DesignMarkupView {
  return {
    file: markup.file,
    breakpoint: markup.viewport.breakpoint,
    width: markup.viewport.width,
    state: markup.state,
    marks: markup.marks.map((mark): DesignMarkupViewMark => (mark.type === 'pin'
      ? { type: 'pin', n: mark.n, kind: mark.kind, element: mark.anchor?.element ?? null, text: mark.text }
      : { type: mark.type, elements: [...mark.anchors] })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function viewMarkOf(value: unknown): DesignMarkupViewMark | undefined {
  if (!isRecord(value)) return undefined;
  if (value['type'] === 'pin') {
    const { n, kind, element, text } = value;
    if (typeof n !== 'number' || (kind !== 'change' && kind !== 'note') || (element !== null && typeof element !== 'string') || typeof text !== 'string') return undefined;
    return { type: 'pin', n, kind, element, text };
  }
  const { type, elements } = value;
  if ((type !== 'pen' && type !== 'arrow' && type !== 'box') || !Array.isArray(elements) || !elements.every((item) => typeof item === 'string')) return undefined;
  return { type, elements: elements as string[] };
}

/** A markup view read back from a session entry, which an earlier build wrote without one; undefined when it does not parse. */
export function parseDesignMarkupView(value: unknown): DesignMarkupView | undefined {
  if (!isRecord(value) || !Array.isArray(value['marks'])) return undefined;
  const { file, breakpoint, width, state } = value;
  if (typeof file !== 'string' || typeof breakpoint !== 'string' || typeof width !== 'number' || typeof state !== 'string') return undefined;
  const marks = value['marks'].map(viewMarkOf);
  return marks.every((mark) => mark !== undefined) ? { file, breakpoint, width, state, marks: marks as DesignMarkupViewMark[] } : undefined;
}

/** `F<n>` */
export const FEEDBACK_ID: RegExp = /^F([1-9][0-9]{0,5})$/;
