import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
// @ts-expect-error -- plain .mjs helper, no types
import { RELEASE_TARGETS, MIN_VSIX_BYTES } from '../release-targets.mjs';

/**
 * `scripts/release-targets.mjs` and `.github/workflows/release.yml` describe the same release matrix,
 * and the workflow cannot import the module (Actions resolves `strategy.matrix` before any JS runs).
 * Drift is otherwise silent and only shows up as a released artifact missing its ripgrep binary, so
 * this is the seam that reports it.
 */

const workflow = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');

/** The `target`/`rgPkg`/`rgBin` triples from the workflow's package matrix. */
function matrixTargets(): Record<string, { rgPkg: string; rgBin: string }> {
  const found: Record<string, { rgPkg: string; rgBin: string }> = {};
  const blocks = workflow.split(/^\s*- target:\s*/m).slice(1);
  for (const block of blocks) {
    const target = block.split('\n')[0]!.trim();
    const rgPkg = /^\s*rgPkg:\s*(\S+)/m.exec(block)?.[1];
    const rgBin = /^\s*rgBin:\s*(\S+)/m.exec(block)?.[1];
    if (rgPkg && rgBin) found[target] = { rgPkg, rgBin };
  }
  return found;
}

describe('release-targets.mjs mirrors the release workflow matrix', () => {
  it('parses a non-empty matrix (guards the parser itself from silently matching nothing)', () => {
    expect(Object.keys(matrixTargets()).length).toBeGreaterThanOrEqual(7);
  });

  it('covers exactly the same targets', () => {
    expect(Object.keys(matrixTargets()).sort()).toEqual(Object.keys(RELEASE_TARGETS).sort());
  });

  it('agrees on every ripgrep package and binary name', () => {
    for (const [target, spec] of Object.entries(matrixTargets())) {
      expect({ target, ...spec }).toEqual({ target, rgPkg: RELEASE_TARGETS[target].rgPkg, rgBin: RELEASE_TARGETS[target].rgBin });
    }
  });

  it('agrees on the suspiciously-small VSIX floor', () => {
    const floor = /-lt\s+(\d+)\s*\]/.exec(workflow)?.[1];
    expect(floor).toBeDefined();
    expect(Number(floor)).toBe(MIN_VSIX_BYTES);
  });

  it('marks every musl target as one the release workflow builds in a container', () => {
    // The local builder refuses a musl target on a glibc distro; CI achieves the same by running
    // those legs in node:24-alpine. If a target stopped being containerised, the two would diverge.
    for (const [target, spec] of Object.entries(RELEASE_TARGETS as Record<string, { libc?: string }>)) {
      if (spec.libc !== 'musl') continue;
      const block = workflow.split(/^\s*- target:\s*/m).find((b) => b.startsWith(target));
      expect(block, `${target} missing from the workflow matrix`).toBeDefined();
      expect(block).toMatch(/alpineContainer:\s*true/);
    }
  });
});
