/*!
 * The parity judge's 12 checks and status thresholds (PARITY_CHECKS, parityStatus) are adapted from open-codesign
 * (https://github.com/OpenCoworkAI/open-codesign, packages/core/src/tools/verify-ui-kit-visual-parity.ts:
 * STANDARD_VISUAL_PARITY_CHECKS, visualParityStatusFromChecks), used under the MIT License. The questions and
 * thresholds are theirs; the labels are Damocles'.
 *
 * MIT License
 *
 * Copyright (c) 2026 OpenCoworkAI Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { oneLine } from '../pi-session/untrusted-text';
import {
  DESIGN_PARITY_CHECK_COUNT,
  DESIGN_PARITY_CHECK_IDS,
  MAX_PARITY_REASON_CHARS,
  type DesignParityCheckId,
  type DesignParityStatus,
  type DesignParityWidth,
} from '../../shared/design-parity';

export { PARITY_OUTPUT_TOOL } from '../../shared/design-parity';

export interface ParityCheck {
  readonly dimension: 'layout' | 'color' | 'typography' | 'content' | 'components';
  readonly question: string;
  readonly label: string;
}

export const PARITY_CHECKS: Readonly<Record<DesignParityCheckId, ParityCheck>> = {
  'layout.column_count_match': {
    dimension: 'layout',
    question: 'Does the candidate have the same number of major columns / regions as the source?',
    label: 'Column count',
  },
  'layout.region_positions_match': {
    dimension: 'layout',
    question: 'Are major regions (header / sidebar / main / right rail / footer) in the same positions as the source?',
    label: 'Region positions',
  },
  'layout.hierarchy_preserved': {
    dimension: 'layout',
    question: 'Is the visual hierarchy (heading > subhead > body > footer) preserved?',
    label: 'Visual hierarchy',
  },
  'color.accent_color_match': {
    dimension: 'color',
    question: 'Is the primary accent color visually equivalent to the source (same hue family, similar saturation)?',
    label: 'Accent color',
  },
  'color.palette_consistency_match': {
    dimension: 'color',
    question: 'Does the overall palette feel match the source (warm/cool, saturated/muted, contrast level)?',
    label: 'Palette',
  },
  'typography.font_family_match': {
    dimension: 'typography',
    question: 'Does the font family character (serif / sans / mono) match the source for each text role?',
    label: 'Font family',
  },
  'typography.heading_hierarchy_match': {
    dimension: 'typography',
    question: 'Are heading weights and sizes stepped similarly (H1 vs body vs caption)?',
    label: 'Heading scale',
  },
  'content.text_labels_present': {
    dimension: 'content',
    question: 'Are all visible text labels from the source present in the candidate (nav items, headings, button text)?',
    label: 'Text labels',
  },
  'content.all_sections_present': {
    dimension: 'content',
    question: 'Are all distinct sections from the source present in the candidate (not just one missing region)?',
    label: 'Sections',
  },
  'components.repeated_pattern_count_match': {
    dimension: 'components',
    question: 'Does the candidate have approximately the same count of repeated patterns (cards / list items / nav links) as the source?',
    label: 'Repeated patterns',
  },
  'components.component_structure_match': {
    dimension: 'components',
    question: 'Do repeated components have the same internal anatomy (header + body + footer pieces)?',
    label: 'Component anatomy',
  },
  'components.icon_motif_match': {
    dimension: 'components',
    question: 'Are icons / glyphs in the same style (line vs filled, monochrome vs colored)?',
    label: 'Icon style',
  },
};

/** open-codesign's thresholds over passes ÷ total. */
export function parityStatus(passes: number, total: number): DesignParityStatus {
  if (total === 0) return 'failed';
  const ratio = passes / total;
  if (ratio === 1) return 'verified';
  if (ratio >= 0.85) return 'needs_review';
  if (ratio >= 0.6) return 'needs_iteration';
  return 'failed';
}

const verdictSchema = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    reason: { type: 'string', description: 'One short sentence on what you saw.' },
  },
  required: ['pass', 'reason'],
  additionalProperties: false,
};

/** The judge's output: one verdict per check id, exactly the 12. */
export const PARITY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    checks: {
      type: 'object',
      properties: Object.fromEntries(DESIGN_PARITY_CHECK_IDS.map((id) => [id, verdictSchema])),
      required: [...DESIGN_PARITY_CHECK_IDS],
      additionalProperties: false,
    },
  },
  required: ['checks'],
  additionalProperties: false,
};

export const PARITY_SYSTEM_PROMPT: string = [
  "You compare a screen's design with its implementation.",
  'Image 1 is the design (the source). Image 2 is the running app (the candidate), at the same viewport width. Both show the top of the page.',
  'Answer each of these 12 checks with pass true or false and one short sentence on what you saw. Judge only what the images show.',
  ...DESIGN_PARITY_CHECK_IDS.map((id) => `- ${id}: ${PARITY_CHECKS[id].question}`),
].join('\n');

/** One check's verdict, as the judge returned it. */
export interface ParityVerdict {
  readonly pass: boolean;
  readonly reason: string;
}

/** The judge's answer reduced to the 12 verdicts, or undefined when it does not hold exactly the 12 ids each with a boolean; any other field is never read. */
export function parseParityVerdicts(value: unknown): ReadonlyMap<DesignParityCheckId, ParityVerdict> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const checks = (value as Record<string, unknown>)['checks'];
  if (typeof checks !== 'object' || checks === null || Array.isArray(checks)) return undefined;
  const keys = Object.keys(checks);
  if (keys.length !== DESIGN_PARITY_CHECK_COUNT || !keys.every((key) => (DESIGN_PARITY_CHECK_IDS as readonly string[]).includes(key))) return undefined;
  const verdicts = new Map<DesignParityCheckId, ParityVerdict>();
  for (const id of DESIGN_PARITY_CHECK_IDS) {
    const verdict = (checks as Record<string, unknown>)[id];
    if (typeof verdict !== 'object' || verdict === null) return undefined;
    const { pass, reason } = verdict as Record<string, unknown>;
    if (typeof pass !== 'boolean') return undefined;
    verdicts.set(id, { pass, reason: typeof reason === 'string' ? oneLine(reason, MAX_PARITY_REASON_CHARS) ?? '' : '' });
  }
  return verdicts;
}

/** One width's result, computed from the verdicts alone: passes, passes ÷ 12 and open-codesign's status. */
export function parityWidth(width: number, breakpoint: string, verdicts: ReadonlyMap<DesignParityCheckId, ParityVerdict>): DesignParityWidth {
  const passes = DESIGN_PARITY_CHECK_IDS.filter((id) => verdicts.get(id)?.pass === true).length;
  return {
    width,
    breakpoint,
    passes,
    score: passes / DESIGN_PARITY_CHECK_COUNT,
    status: parityStatus(passes, DESIGN_PARITY_CHECK_COUNT),
    failed: DESIGN_PARITY_CHECK_IDS.filter((id) => verdicts.get(id)?.pass !== true).map((id) => ({ id, label: PARITY_CHECKS[id].label, reason: verdicts.get(id)?.reason ?? '' })),
  };
}
