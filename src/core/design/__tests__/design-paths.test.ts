import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAMOCLES_DESIGNS_DIR, planFileIdSuffix, planFileStem, computePlanFilePath } from '../../paths';
import { designFolderOf, designScreenOf, designsFolderAllowsWrite, designStateDirOf, forkDesignId, isDesignerFile, isDesignerRelative, newDesignId } from '../design-paths';
import { designStateTokens, MAX_DESIGN_ID_CHARS } from '../../../shared/design-paths';

describe('designStateTokens', () => {
  it('splits a state list on ASCII whitespace, as HTML token lists and CSS ~= do', () => {
    expect(designStateTokens('default no-results')).toEqual(['default', 'no-results']);
    expect(designStateTokens('  default   empty\tloading\nerror\r\fdone ')).toEqual(['default', 'empty', 'loading', 'error', 'done']);
    expect(designStateTokens('')).toEqual([]);
    expect(designStateTokens(' \t\n')).toEqual([]);
    expect(designStateTokens(null)).toEqual([]);
  });

  it('keeps a non-ASCII space inside a token, since neither HTML nor CSS splits on it', () => {
    expect(designStateTokens('default\u00a0empty')).toEqual(['default\u00a0empty']);
  });
});

describe('design paths', () => {
  it('names a design folder like its parent\'s plan file (PD-3)', () => {
    const id = newDesignId('session-1', 'Add a contacts page');
    expect(id).toBe(planFileStem('session-1', 'Add a contacts page'));
    expect(computePlanFilePath('session-1', 'Add a contacts page')).toBe(path.join(path.dirname(computePlanFilePath('x', 'y')), `${id}.md`));
    expect(designFolderOf(id)).toBe(path.join(DAMOCLES_DESIGNS_DIR, id));
    expect(designStateDirOf(id)).toBe(path.join(DAMOCLES_DESIGNS_DIR, '.state', id));
  });

  it('gives a fork its own id from the inherited one and the fork\'s session (PD-37)', () => {
    expect(forkDesignId('contacts-abcd1234', 'fork-session')).toBe(`contacts-abcd1234-f${planFileIdSuffix('fork-session')}`);
  });

  it('replaces a fork\'s own suffix when it is forked again, so nested forks never outgrow the wire\'s design id', () => {
    const base = newDesignId('session-1', 'x'.repeat(80));
    let designId = base;
    for (let level = 1; level <= 10; level++) {
      const next = forkDesignId(designId, `fork-session-${level}`);
      expect(next).toBe(`${base}-f${planFileIdSuffix(`fork-session-${level}`)}`);
      expect(next).not.toBe(designId);
      designId = next;
    }
    expect(forkDesignId(designId, 'fork-session-1')).toBe(forkDesignId(base, 'fork-session-1'));
    const long = forkDesignId('a'.repeat(MAX_DESIGN_ID_CHARS), 'fork-session');
    expect(long).toHaveLength(MAX_DESIGN_ID_CHARS);
    expect(designFolderOf(long)).toBe(path.join(DAMOCLES_DESIGNS_DIR, long));
  });

  it('refuses any id that is not one safe path segment of at most MAX_DESIGN_ID_CHARS before it becomes a path', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '.state', '', 'C:x', '-x', 'a'.repeat(MAX_DESIGN_ID_CHARS + 1)]) {
      expect(() => designFolderOf(bad)).toThrow();
      expect(() => designStateDirOf(bad)).toThrow();
    }
    expect(designFolderOf('a'.repeat(MAX_DESIGN_ID_CHARS))).toBe(path.join(DAMOCLES_DESIGNS_DIR, 'a'.repeat(MAX_DESIGN_ID_CHARS)));
  });

  it('allows the designer only design.md, screens/<name>.html and files under variants/ (D65)', () => {
    for (const designer of ['design.md', 'screens/S1-contacts.html', 'variants/S1-a.html', 'variants/a/b.png']) {
      expect(isDesignerRelative(designer)).toBe(true);
    }
    for (const owned of ['manifest.json', 'decisions.md', 'inventory.json', 'tokens.css', 'assets/inter.woff2', 'references/R1.png', 'feedback/F1.json', 'screens/S1.journey.json', 'screens/S1.journey.spec.ts', 'notes/manifest.json', 'notes.txt', 'screens/a/b.html', 'screens/x.css', 'screens/.html', 'variants']) {
      expect(isDesignerRelative(owned)).toBe(false);
    }
  });

  it('folds ASCII case alone, on every platform, and refuses a name Windows resolves elsewhere', () => {
    for (const variant of ['Design.MD', 'SCREENS/S1.HTML', 'Variants/x.png']) expect(isDesignerRelative(variant)).toBe(true);
    // APFS folds `ſ` to `s`, NTFS strips a trailing dot or space, and `:` opens a stream.
    for (const alias of ['deſign.md', 'ſcreens/S1.html', 'variantſ/x.png', 'design.md.', 'design.md ', 'screens/S1.html.', 'variants/CON', 'variants/lpt1.png', 'design.md:x', 'variants/a:b']) {
      expect(isDesignerRelative(alias)).toBe(false);
    }
    const folder = designFolderOf('contacts-abcd1234');
    expect(isDesignerFile(folder, path.join(folder, 'Design.MD'))).toBe(true);
    expect(isDesignerFile(folder, path.join(folder, 'Manifest.JSON'))).toBe(false);
    expect(isDesignerFile(folder, path.join(folder, 'ASSETS', 'x.png'))).toBe(false);
    expect(isDesignerFile(folder, path.join(folder, '..', 'other-12345678', 'design.md'))).toBe(false);
  });

  it('lets any chat write below the designs folder only a designer file of a design folder (D65)', () => {
    const folder = designFolderOf('contacts-abcd1234');
    expect(designsFolderAllowsWrite(path.join(folder, 'design.md'))).toBe(true);
    expect(designsFolderAllowsWrite(path.join(folder, 'variants', 'a', 'b.png'))).toBe(true);
    expect(designsFolderAllowsWrite(path.join(DAMOCLES_DESIGNS_DIR, '..', 'plans', 'x.md'))).toBe(true);
    for (const refused of [
      path.join(folder, 'decisions.md'),
      path.join(folder, 'manifest.json'),
      path.join(folder, 'screens', 'S1.journey.json'),
      path.join(DAMOCLES_DESIGNS_DIR, '.state', 'contacts-abcd1234', 'link.json'),
      path.join(DAMOCLES_DESIGNS_DIR, '.state', 'design.md'),
      path.join(DAMOCLES_DESIGNS_DIR, 'design.md'),
      DAMOCLES_DESIGNS_DIR,
    ]) {
      expect(designsFolderAllowsWrite(refused)).toBe(false);
    }
  });
});

describe('designScreenOf', () => {
  it('names the design and screen of a screens/<name>.html below the designs folder, and nothing else', () => {
    const at = (...segments: string[]) => path.join(DAMOCLES_DESIGNS_DIR, ...segments);
    expect(designScreenOf(at('contacts-abcd1234', 'screens', 'S1-home.html'))).toEqual({ designId: 'contacts-abcd1234', relPath: 'screens/S1-home.html' });
    expect(designScreenOf(at('contacts-abcd1234', 'screens', 'S1.HTML'))).toEqual({ designId: 'contacts-abcd1234', relPath: 'screens/S1.HTML' });
    expect(designScreenOf(at('contacts-abcd1234', 'design.md'))).toBeUndefined();
    expect(designScreenOf(at('contacts-abcd1234', 'variants', 'a.html'))).toBeUndefined();
    expect(designScreenOf(at('contacts-abcd1234', 'screens', 'nested', 'a.html'))).toBeUndefined();
    expect(designScreenOf(at('.state', 'screens', 'a.html'))).toBeUndefined();
    expect(designScreenOf(at('screens', 'a.html'))).toBeUndefined();
    expect(designScreenOf(path.join(path.dirname(DAMOCLES_DESIGNS_DIR), 'other', 'd', 'screens', 'a.html'))).toBeUndefined();
  });
});
