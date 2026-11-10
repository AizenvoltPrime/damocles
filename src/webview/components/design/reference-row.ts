/** A reference row 'R<n>#<element>' split at its first '#'; undefined when nothing precedes the '#'. */
export function referenceRowParts(ref: string): { reference: string; element: string } | undefined {
  const split = ref.indexOf('#');
  return split > 0 ? { reference: ref.slice(0, split), element: ref.slice(split + 1) } : undefined;
}
