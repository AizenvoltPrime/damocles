// Damocles prepends the live IDE selection / opened-file as a leading `<ide_…>` block
// (IdeContextManager.buildContentBlocks). pi merges adjacent text blocks on persist, so on a
// text-only message it survives as ONE block — `<ide_…>…</ide_…>\n<actual message>` — while on an
// image message it stays a standalone leading text block. Both reduce to "strip a leading wrapper":
// non-greedy to the first close tag, plus the joining newline. It is model-only context the user
// never typed, so it is dropped from the displayed transcript on replay; the stored entry keeps it
// intact for rewind. Anchored at start only, so a `</ide_…>` a user actually typed mid-message stays.
const IDE_CONTEXT_PREFIX = /^<ide_(?:opened_file|selection)>[\s\S]*?<\/ide_(?:opened_file|selection)>\n?/;

export function stripIdeContext(text: string): string {
  return text.replace(IDE_CONTEXT_PREFIX, '');
}
