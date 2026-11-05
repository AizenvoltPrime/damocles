// One matching rule for a typed folder's listing, applied by the host's scan and by main's cache alike.

// Characters of a listing's name prefix; the wire refuses a longer one.
export const MAX_NAME_PREFIX_LENGTH = 255;

const foldUnit = (unit: string): string => (unit === 'ς' ? 'σ' : unit.toLowerCase());

// Each UTF-16 unit is folded on its own, Greek final sigma as sigma, so a name that matches a prefix matches every shorter
// one, which main's cache relies on, and the match spans exactly [0, prefix.length).
export function namePrefixMatches(name: string, prefix: string): boolean {
  if (name.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (name[i] !== prefix[i] && foldUnit(name[i]!) !== foldUnit(prefix[i]!)) return false;
  }
  return true;
}
