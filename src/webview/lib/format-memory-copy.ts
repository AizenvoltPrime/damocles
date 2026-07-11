import type { MemoryEntry } from '@shared/types/memory';

/**
 * Collapse embedded newlines (and the surrounding whitespace) in a SINGLE-LINE field to one space, so a
 * multi-line title or fact cannot break the line-oriented layout (a fact containing a blank line would
 * otherwise visually split the `Facts:` block; a newline in the title breaks the title/Type line
 * contract). Multi-line `content` is intentionally NOT normalized — it is a free-form block, printed
 * verbatim between blank-line separators. Leading/trailing whitespace is trimmed.
 */
function toSingleLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Serialize a memory record to deterministic plaintext for the clipboard copy button.
 *
 * Pure: never mutates the input and has no side effects. Absent or empty sections are
 * omitted entirely (no `Type: undefined`, no empty `Tags:` line for an empty array), so
 * a bare note yields just its content. Observations copy their FULL fact list, not the
 * 3-fact display truncation used in the panel. Single-line fields (title, facts) are
 * newline-normalized so multi-line values can't break the line-oriented layout; `content`
 * is printed verbatim.
 */
export function formatMemoryForCopy(memory: MemoryEntry): string {
  const sections: string[] = [];

  // Header block: title (when present — observations carry it) + Type line.
  const header: string[] = [];
  if (memory.title) {
    header.push(toSingleLine(memory.title));
  }
  if (memory.observationType) {
    header.push(`Type: ${memory.observationType}`);
  }
  if (header.length > 0) {
    sections.push(header.join('\n'));
  }

  // Content is always present; printed verbatim (may be a multi-line block).
  sections.push(memory.content);

  // Facts block: ALL facts as bullets, only when present and non-empty. Each fact is collapsed to a
  // single line so a fact with an embedded blank line can't fracture the block.
  if (memory.facts && memory.facts.length > 0) {
    const facts = ['Facts:', ...memory.facts.map((fact) => `- ${toSingleLine(fact)}`)];
    sections.push(facts.join('\n'));
  }

  // Trailer: Kind / Scope / Tags, each only when it yields a value.
  const trailer: string[] = [];
  if (memory.kind) {
    trailer.push(`Kind: ${memory.kind}`);
  }
  if (memory.scope) {
    trailer.push(`Scope: ${memory.scope}`);
  }
  const tags =
    memory.observationTags && memory.observationTags.length > 0
      ? memory.observationTags
      : memory.tags && memory.tags.length > 0
        ? memory.tags
        : null;
  if (tags) {
    trailer.push(`Tags: ${tags.join(', ')}`);
  }
  if (trailer.length > 0) {
    sections.push(trailer.join('\n'));
  }

  return sections.join('\n\n').trim();
}
