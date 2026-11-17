import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentPathOf, foldAliases, relocatedPath, type AliasSource } from '../aliases';

const root = path.resolve('/relocation-aliases');
const p = (...parts: string[]): string => path.join(root, ...parts);
const move = (seq: number, from: string, to: string, startedAt?: number): AliasSource => ({ seq, ...(startedAt !== undefined ? { startedAt } : {}), folders: [{ from, to }] });

// t1 and t2 are the relocations' starts; a path recorded at T0 predates both, at T12 lies between them, at T3 follows both.
const T0 = 100;
const T1 = 200;
const T12 = 250;
const T2 = 300;
const T3 = 400;

describe('foldAliases', () => {
  it('folds in seq order whatever order the journal lists the records in', () => {
    const aliases = foldAliases([move(2, p('b'), p('c'), T2), move(1, p('a'), p('b'), T1)]);
    expect(currentPathOf(aliases, p('a'), T0)).toBe(p('c'));
    expect(currentPathOf(aliases, p('a'))).toBe(p('c'));
  });

  it('ignores a move to the same folder', () => {
    expect(foldAliases([move(1, p('a'), p('a'), T1)]).moves).toEqual([]);
  });

  it('compares folders by folderKey', () => {
    const aliases = foldAliases([move(1, p('Proj'), p('moved'), T1)]);
    const spelled = process.platform === 'win32' ? p('proj') : p('Proj');
    expect(currentPathOf(aliases, spelled, T0)).toBe(p('moved'));
  });
});

describe('currentPathOf by record time', () => {
  it('chain A→B→C: A before both, B between them and C after them all lead to C', () => {
    const aliases = foldAliases([move(1, p('a'), p('b'), T1), move(2, p('b'), p('c'), T2)]);
    expect(currentPathOf(aliases, p('a'), T0)).toBe(p('c'));
    expect(currentPathOf(aliases, p('b'), T12)).toBe(p('c'));
    expect(currentPathOf(aliases, p('c'), T3)).toBe(p('c'));
    expect(currentPathOf(aliases, p('a'))).toBe(p('c'));
    expect(currentPathOf(aliases, p('b'))).toBe(p('c'));
  });

  it('move back A→B→A: A before both, B between them and A after them all lead to A', () => {
    const aliases = foldAliases([move(1, p('a'), p('b'), T1), move(2, p('b'), p('a'), T2)]);
    expect(currentPathOf(aliases, p('a'), T0)).toBe(p('a'));
    expect(currentPathOf(aliases, p('b'), T12)).toBe(p('a'));
    expect(currentPathOf(aliases, p('a'), T3)).toBe(p('a'));
    expect(currentPathOf(aliases, p('a'))).toBe(p('a'));
  });

  it('reuse A→B then C→A: the first project\'s A stays at B, the second\'s C and its later A are at A', () => {
    const aliases = foldAliases([move(1, p('a'), p('b'), T1), move(2, p('c'), p('a'), T2)]);
    expect(currentPathOf(aliases, p('a'), T0)).toBe(p('b'));
    expect(currentPathOf(aliases, p('c'), T0)).toBe(p('a'));
    expect(currentPathOf(aliases, p('a'), T3)).toBe(p('a'));
    // with no time every move applies in seq order
    expect(currentPathOf(aliases, p('a'))).toBe(p('b'));
  });

  it('plain re-add of A after A→B: what A recorded after the move stays at A', () => {
    const aliases = foldAliases([move(1, p('a'), p('b'), T1)]);
    expect(currentPathOf(aliases, p('a'), T12)).toBe(p('a'));
    expect(currentPathOf(aliases, p('a'), T1)).toBe(p('a'));
    expect(currentPathOf(aliases, p('a'), T0)).toBe(p('b'));
  });

  it('merge X→Y into a live Y, then locate Y→Z: X before both and Y before or between them lead to Z', () => {
    const aliases = foldAliases([move(1, p('x'), p('y'), T1), move(2, p('y'), p('z'), T2)]);
    expect(currentPathOf(aliases, p('x'), T0)).toBe(p('z'));
    expect(currentPathOf(aliases, p('y'), T0)).toBe(p('z'));
    expect(currentPathOf(aliases, p('y'), T12)).toBe(p('z'));
    expect(currentPathOf(aliases, p('y'), T3)).toBe(p('y'));
  });

  it('a record without startedAt moves every recorded time', () => {
    const aliases = foldAliases([move(1, p('a'), p('b'))]);
    expect(currentPathOf(aliases, p('a'), T0)).toBe(p('b'));
    expect(currentPathOf(aliases, p('a'), T3)).toBe(p('b'));
  });

  it('maps a folder exactly: a nested project is not moved with the folder holding it', () => {
    const aliases = foldAliases([move(1, p('old'), p('new'), T1)]);
    expect(currentPathOf(aliases, p('old', 'nested'), T0)).toBe(p('old', 'nested'));
  });
});

describe('relocatedPath', () => {
  const aliases = foldAliases([move(1, p('old'), p('new'), T1), move(2, p('old', 'nested'), p('elsewhere'), T2)]);

  it('re-roots a file under where its folder is now', () => {
    expect(relocatedPath(aliases, p('old', 'src', 'a.ts'))).toBe(p('new', 'src', 'a.ts'));
    expect(relocatedPath(aliases, p('old'))).toBe(p('new'));
  });

  it('takes the deepest moved folder holding the path within one relocation, and walks later relocations from there', () => {
    const one = foldAliases([{ seq: 1, startedAt: T1, folders: [{ from: p('old'), to: p('new') }, { from: p('old', 'nested'), to: p('elsewhere') }] }]);
    expect(relocatedPath(one, p('old', 'nested', 'b.ts'))).toBe(p('elsewhere', 'b.ts'));
    expect(relocatedPath(aliases, p('old', 'nested', 'b.ts'), T0)).toBe(p('new', 'nested', 'b.ts'));
  });

  it('is undefined for a path no moved folder holds, a sibling with a shared prefix included', () => {
    expect(relocatedPath(aliases, p('older', 'a.ts'))).toBeUndefined();
    expect(relocatedPath(aliases, p('new', 'a.ts'))).toBeUndefined();
  });

  it('applies only the moves that began after the record', () => {
    const reused = foldAliases([move(1, p('a'), p('b'), T1), move(2, p('c'), p('a'), T2)]);
    expect(relocatedPath(reused, p('a', 'f.ts'), T0)).toBe(p('b', 'f.ts'));
    expect(relocatedPath(reused, p('a', 'f.ts'), T3)).toBeUndefined();
    expect(relocatedPath(reused, p('c', 'f.ts'), T0)).toBe(p('a', 'f.ts'));
  });
});
