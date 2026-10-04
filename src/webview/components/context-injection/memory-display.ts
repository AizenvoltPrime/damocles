import type { MemoryScope } from '@shared/types/memory';

const SCOPE_BADGE_CLASS: Record<MemoryScope, string> = {
  session: 'border-info/40 text-(--d-info-text)',
  project: 'border-primary/40 text-(--d-accent-text)',
  global: 'border-success/40 text-(--d-success-text)',
};

export function scopeBadgeClass(scope: MemoryScope): string {
  return SCOPE_BADGE_CLASS[scope];
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

const LABEL_MAX = 60;

/** A one-line name for a memory, used in accessible names where the full text would be too long. */
export function memoryLabel(title: string | null, text: string): string {
  // Cut by code point so a surrogate pair is never split; 4x code units always hold 2x whole code points.
  const source = Array.from((title ?? text).slice(0, LABEL_MAX * 4)).slice(0, LABEL_MAX * 2).join('').replace(/\s+/g, ' ').trim();
  const chars = Array.from(source);
  return chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX - 1).join('')}…` : source;
}
