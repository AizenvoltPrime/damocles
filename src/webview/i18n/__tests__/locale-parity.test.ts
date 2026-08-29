import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import el from '../locales/el.json';

/**
 * Both locale bundles checked as data rather than through a rendered component.
 *
 * A key present in one locale and missing from the other renders as its own dotted path, and a
 * translated string is only reachable through the component that happens to use it. Reading the JSON
 * covers every string, including the ones no test mounts.
 */

type Tree = { [key: string]: string | Tree };

/** Every leaf in the bundle, keyed by its dotted path, so a failure names the key. */
function flatten(bundle: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: Tree, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof value === 'string') out.set(path, value);
      else walk(value, path);
    }
  };
  walk(bundle as Tree, '');
  return out;
}

const EN = flatten(en);
const EL = flatten(el);

describe('locale parity', () => {
  it('carries the same key set in both locales', () => {
    const missingFromEl = [...EN.keys()].filter((key) => !EL.has(key));
    const missingFromEn = [...EL.keys()].filter((key) => !EN.has(key));

    expect({ missingFromEl, missingFromEn }).toEqual({ missingFromEl: [], missingFromEn: [] });
  });

  it('keeps every interpolation placeholder identical between the two locales', () => {
    // A placeholder dropped in translation renders the sentence with the fact missing and no error.
    const placeholders = (value: string): string[] => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

    const mismatched = [...EN]
      .filter(([key, value]) => String(placeholders(value)) !== String(placeholders(EL.get(key) ?? '')))
      .map(([key]) => key);

    expect(mismatched).toEqual([]);
  });

  it.each([['en', EN], ['el', EL]] as const)('has no em dash anywhere in %s', (_locale, strings) => {
    const offenders = [...strings].filter(([, value]) => value.includes('\u2014')).map(([key]) => key);

    expect(offenders).toEqual([]);
  });
});

describe('tool status copy', () => {
  it('names an unrecorded outcome the same way on the card and in the overlay', () => {
    // The card and the overlay are two views of one call, one click apart, so one wording each.
    expect(EN.get('toolCall.outcomeUnrecorded')).toBeTruthy();
    expect(EL.get('toolCall.outcomeUnrecorded')).toBeTruthy();
    expect(EN.get('toolOverlay.statusUnrecorded')).toBe(EN.get('toolCall.outcomeUnrecorded'));
    expect(EL.get('toolOverlay.statusUnrecorded')).toBe(EL.get('toolCall.outcomeUnrecorded'));
  });
});

describe('MCP copy', () => {
  it('names the source ids the way the source ids are spelled', () => {
    // `claude-local` and `damocles-local` both put the tool first. A key that flipped the word order
    // for one of them made the pair read as two different concepts.
    expect(EN.has('mcp.fromClaudeLocal')).toBe(true);
    expect(EN.has('mcp.fromDamoclesLocal')).toBe(true);
    expect(EN.has('mcp.fromLocalDamocles')).toBe(false);
  });

  it('has the leak warning as a title plus an instruction, interpolating the path once', () => {
    expect(EN.get('mcp.localMcpUnignoredTitle')).toBeTruthy();
    for (const strings of [EN, EL]) {
      const body = strings.get('mcp.localMcpUnignored')!;
      expect(body.match(/\{line\}/g)).toHaveLength(1);
      // The path arrives through the interpolation, so neither locale restates it as a literal.
      expect(body).not.toContain('.damocles/mcp.local.json');
      expect(body).toContain('.gitignore');
    }
  });

  it('names what the reload button re-reads', () => {
    for (const strings of [EN, EL]) {
      expect(strings.get('mcp.reloadConfigTitle')).toContain('~/.claude.json');
    }
  });

  it('uses one Greek word for "server" across the two shadowing messages', () => {
    // Both can appear in the same dialog, three lines apart, about the same thing.
    expect(EL.get('mcp.form.errors.nameShadowedByProject')).toContain('διακομιστής');
    expect(EL.get('mcp.form.writeErrors.nameShadowed')).toContain('διακομιστής');
    expect(EL.get('mcp.form.errors.nameShadowedByProject')).not.toContain(' server ');
  });
});
