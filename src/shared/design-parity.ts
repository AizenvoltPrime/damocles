// DesignParity's result (PD-13, PD-14; docs/invariants.md "Design mode"), which core computes and the webview's card renders.
import type { LocalizedText } from './localized-text';

/** The 12 checks' ids, in the judge's order; `core/design/parity.ts` holds each one's question. */
export const DESIGN_PARITY_CHECK_IDS = [
  'layout.column_count_match',
  'layout.region_positions_match',
  'layout.hierarchy_preserved',
  'color.accent_color_match',
  'color.palette_consistency_match',
  'typography.font_family_match',
  'typography.heading_hierarchy_match',
  'content.text_labels_present',
  'content.all_sections_present',
  'components.repeated_pattern_count_match',
  'components.component_structure_match',
  'components.icon_motif_match',
] as const;

export type DesignParityCheckId = (typeof DESIGN_PARITY_CHECK_IDS)[number];

export const DESIGN_PARITY_CHECK_COUNT: number = DESIGN_PARITY_CHECK_IDS.length;

export type DesignParityStatus = 'verified' | 'needs_review' | 'needs_iteration' | 'failed';

export interface DesignParityFailedCheck {
  id: DesignParityCheckId;
  /** The check's short English label. */
  label: string;
  /** The judge's own words, one line of at most MAX_PARITY_REASON_CHARS. */
  reason: string;
}

export interface DesignParityWidth {
  width: number;
  /** The band the width falls in: the widest breakpoint at or below it, else 'base'. */
  breakpoint: string;
  /** Checks passed, 0 to DESIGN_PARITY_CHECK_COUNT. */
  passes: number;
  /** passes ÷ DESIGN_PARITY_CHECK_COUNT, computed in core. */
  score: number;
  status: DesignParityStatus;
  failed: DesignParityFailedCheck[];
}

/** One image of the result, in the order the result carries them. */
export interface DesignParityImage {
  width: number;
  kind: 'design' | 'app';
  /** The captured frame's height in CSS px, for the card's thumbnail box; absent from a result recorded before it. */
  cssHeight?: number;
}

export interface DesignParityDetails {
  /** The screen's id. */
  screen: string;
  /** The screen file, relative to the design folder. */
  file: string;
  url: string;
  /** Ascending. */
  widths: DesignParityWidth[];
  /** The images the result carries: per width the design then the app, or none for a model that reads no images. */
  images: DesignParityImage[];
}

/** The details of a refused DesignParity call: what is missing, for the user; the model reads the English text. */
export interface DesignParityRefusal {
  refusal: LocalizedText;
}

export const MAX_PARITY_REASON_CHARS = 300;

/** The judge sub-call's one output tool. */
export const PARITY_OUTPUT_TOOL = 'record_parity_checks';
