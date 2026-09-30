import type { InjectionTier } from '@shared/types/context-injection';
import type { MemoryKind, MemoryScope } from '@shared/types/memory';
import { truncateToChars } from '../token-estimate';

export const RENDER_LIMITS = {
  fullChars: 1500,
  observationChars: 1200,
  observationFacts: 8,
  factChars: 200,
  observationFiles: 4,
  compactChars: 200,
} as const;

/**
 * Every tag name emitted into the injection message: this renderer's, the profile's sections and the
 * Compass status line. Stored text may not open or close any of them.
 */
export const EMITTED_TAG_NAMES = [
  'damocles_memory',
  'damocles_compass',
  'user_profile',
  'memory_updates',
  'observation',
  'compact',
  'memory',
  'title',
  'facts',
  'project',
  'global',
  'static',
  'dynamic',
] as const;

// Fixed-string alternation anchored on `<`: linear time.
const EMITTED_TAG_PATTERN = new RegExp(`<(/?)(${EMITTED_TAG_NAMES.join('|')})`, 'gi');
const ZERO_WIDTH_JOINER = '\u200D';

/** Break any opening or closing form of an emitted tag name inside stored text. */
export function neutralizeTags(text: string): string {
  return text.replace(EMITTED_TAG_PATTERN, `<${ZERO_WIDTH_JOINER}$1$2`);
}

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/[\r\n]+/g, ' ');
}

export interface RenderableMemory {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  title: string | null;
  content: string;
  facts: readonly string[];
  files: readonly string[];
  observationType: string | null;
  isStale: boolean;
  isPinned: boolean;
  isForgotten?: boolean;
}

export function truncationMarker(id: string): string {
  return `…[truncated: GetMemoryDetails ${id}]`;
}

function clip(text: string, maxChars: number, id: string): { text: string; truncated: boolean } {
  const cut = truncateToChars(text, maxChars);
  if (cut.length === text.length) return { text, truncated: false };
  return { text: cut + truncationMarker(id), truncated: true };
}

function attributes(pairs: Array<[string, string | null | false]>): string {
  return pairs
    .filter((p): p is [string, string] => typeof p[1] === 'string' && p[1].length > 0)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
}

/** Whole content (and facts and files for an observation), clipped to the full-tier limits. */
export function renderFull(m: RenderableMemory, maxChars?: number): { text: string; truncated: boolean } {
  if (m.kind === 'observation') return renderObservation(m, maxChars ?? RENDER_LIMITS.observationChars);
  const body = clip(m.content, maxChars ?? RENDER_LIMITS.fullChars, m.id);
  const attrs = attributes([
    ['id', m.id],
    ['kind', m.kind],
    ['scope', m.scope],
    ['pinned', m.isPinned && 'true'],
    ['forgotten', m.isForgotten === true && 'true'],
  ]);
  return { text: `<memory${attrs}>${neutralizeTags(body.text)}</memory>`, truncated: body.truncated };
}

function renderObservation(m: RenderableMemory, maxChars: number): { text: string; truncated: boolean } {
  const files = m.files.slice(0, RENDER_LIMITS.observationFiles).join(', ');
  const attrs = attributes([
    ['id', m.id],
    ['type', m.observationType],
    ['scope', m.scope],
    ['stale', m.isStale && 'true'],
    ['pinned', m.isPinned && 'true'],
    ['forgotten', m.isForgotten === true && 'true'],
    ['files', files],
  ]);
  const body = clip(m.content, maxChars, m.id);
  let truncated = body.truncated;
  const lines = [`<observation${attrs}>`];
  if (m.title) lines.push(`<title>${neutralizeTags(m.title)}</title>`);
  lines.push(neutralizeTags(body.text));
  if (m.facts.length > 0) {
    lines.push('<facts>');
    for (const fact of m.facts.slice(0, RENDER_LIMITS.observationFacts)) {
      const clipped = clip(fact, RENDER_LIMITS.factChars, m.id);
      truncated ||= clipped.truncated;
      lines.push(`- ${neutralizeTags(clipped.text)}`);
    }
    if (m.facts.length > RENDER_LIMITS.observationFacts) {
      truncated = true;
      lines.push(`- ${truncationMarker(m.id)}`);
    }
    lines.push('</facts>');
  }
  lines.push('</observation>');
  return { text: lines.join('\n'), truncated };
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function compactPreview(text: string): string {
  const source = singleLine(text);
  const cut = truncateToChars(source, RENDER_LIMITS.compactChars);
  return cut.length < source.length ? `${cut}…` : cut;
}

/** One line: id, scope and kind, then the first 200 chars (an observation's title when it has one). */
export function renderCompactLine(m: RenderableMemory): string {
  const text = compactPreview(m.kind === 'observation' && m.title ? m.title : m.content);
  const stale = m.isStale ? ' [stale]' : '';
  return `- [${m.id}] (${m.scope} ${m.kind})${stale} ${neutralizeTags(text)}`;
}

export type NoticeRender =
  | { kind: 'forgotten'; id: string; byUser: boolean }
  | { kind: 'edited'; id: string; text: string }
  | { kind: 'superseded'; id: string; replacementId: string; text: string | null };

/** Every notice is one line, so stored text cannot forge a notice line of its own. */
export function renderNotice(n: NoticeRender): string {
  const id = neutralizeTags(singleLine(n.id));
  switch (n.kind) {
    case 'forgotten':
      return n.byUser
        ? `- [${id}] was forgotten by the user. Disregard it.`
        : `- [${id}] was retired from memory and may be out of date.`;
    case 'edited':
      return `- [${id}] was edited: ${neutralizeTags(singleLine(n.text))}`;
    case 'superseded': {
      const replacementId = neutralizeTags(singleLine(n.replacementId));
      return n.text === null
        ? `- [${id}] was superseded by [${replacementId}], which is already in context.`
        : `- [${id}] was superseded by [${replacementId}]: ${neutralizeTags(singleLine(n.text))}`;
    }
  }
}

/**
 * The content a notice carries, sized like the tier it is tracked at: the full tier's clip, or a
 * compact line's preview. A notice never carries an observation's title, facts or files.
 */
export function noticeText(m: RenderableMemory, tier: InjectionTier): { text: string; truncated: boolean } {
  if (tier === 'compact') return { text: compactPreview(m.content), truncated: false };
  return clip(m.content, m.kind === 'observation' ? RENDER_LIMITS.observationChars : RENDER_LIMITS.fullChars, m.id);
}

export function renderMemoryBlock(parts: { full: readonly string[]; compact: readonly string[]; notices: readonly string[] }): string {
  if (parts.full.length === 0 && parts.compact.length === 0 && parts.notices.length === 0) return '';
  const lines = ['<damocles_memory>', ...parts.full];
  if (parts.compact.length > 0) lines.push('<compact>', ...parts.compact, '</compact>');
  if (parts.notices.length > 0) lines.push('<memory_updates>', ...parts.notices, '</memory_updates>');
  lines.push('</damocles_memory>');
  return lines.join('\n');
}

export function joinInjectionParts(parts: readonly string[]): string {
  return parts.filter(p => p.length > 0).join('\n\n');
}
