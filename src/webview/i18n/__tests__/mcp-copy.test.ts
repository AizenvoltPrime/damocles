import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import el from '../locales/el.json';

/**
 * The MCP half of the locale files, checked as data rather than through a rendered component.
 *
 * A key present in one locale and missing from the other renders as its own dotted path, and a
 * translated string is only reachable through the component that happens to use it. Reading the JSON
 * covers the strings no test mounts.
 */

type Tree = { [key: string]: string | Tree };

/** Every leaf under `mcp`, keyed by its dotted path. */
function mcpStrings(bundle: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: Tree, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof value === 'string') out.set(path, value);
      else walk(value, path);
    }
  };
  walk((bundle as { mcp: Tree }).mcp, '');
  return out;
}

const EN = mcpStrings(en);
const EL = mcpStrings(el);

describe('MCP locale copy', () => {
  it('carries the same key set in both locales', () => {
    expect([...EL.keys()].sort()).toEqual([...EN.keys()].sort());
  });

  it.each([['en', EN], ['el', EL]] as const)('has no em dash anywhere in %s', (_locale, strings) => {
    const offenders = [...strings].filter(([, value]) => value.includes('\u2014')).map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  it('names the source ids the way the source ids are spelled', () => {
    // `claude-local` and `damocles-local` both put the tool first. A key that flipped the word order
    // for one of them made the pair read as two different concepts.
    expect(EN.has('fromClaudeLocal')).toBe(true);
    expect(EN.has('fromDamoclesLocal')).toBe(true);
    expect(EN.has('fromLocalDamocles')).toBe(false);
  });

  it('has the leak warning as a title plus an instruction, interpolating the path once', () => {
    expect(EN.get('localMcpUnignoredTitle')).toBeTruthy();
    for (const strings of [EN, EL]) {
      const body = strings.get('localMcpUnignored')!;
      expect(body.match(/\{line\}/g)).toHaveLength(1);
      // The path arrives through the interpolation, so neither locale restates it as a literal.
      expect(body).not.toContain('.damocles/mcp.local.json');
      expect(body).toContain('.gitignore');
    }
  });

  it('names what the reload button re-reads', () => {
    for (const strings of [EN, EL]) {
      expect(strings.get('reloadConfigTitle')).toContain('~/.claude.json');
    }
  });

  it('uses one Greek word for "server" across the two shadowing messages', () => {
    // Both can appear in the same dialog, three lines apart, about the same thing.
    expect(EL.get('form.errors.nameShadowedByProject')).toContain('διακομιστής');
    expect(EL.get('form.writeErrors.nameShadowed')).toContain('διακομιστής');
    expect(EL.get('form.errors.nameShadowedByProject')).not.toContain(' server ');
  });

  it('keeps every interpolation placeholder identical between the two locales', () => {
    // A placeholder dropped in translation renders the sentence with the fact missing and no error.
    const placeholders = (value: string): string[] => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

    const mismatched = [...EN]
      .filter(([key, value]) => String(placeholders(value)) !== String(placeholders(EL.get(key) ?? '')))
      .map(([key]) => key);

    expect(mismatched).toEqual([]);
  });
});
