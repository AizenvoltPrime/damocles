// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mirrorVsCodeReduceMotion, prefersReducedMotion } from '../reducedMotion';

const osQuery = { matches: false };
const matchMedia = vi.fn(() => osQuery);

afterEach(() => {
  osQuery.matches = false;
  document.documentElement.removeAttribute('data-reduced-motion');
  document.body.classList.remove('vscode-reduce-motion');
  vi.unstubAllGlobals();
});

describe('prefersReducedMotion', () => {
  it('reads the host attribute and the OS query, querying the OS once and its answer live', () => {
    vi.stubGlobal('matchMedia', matchMedia);
    expect(prefersReducedMotion()).toBe(false);
    osQuery.matches = true;
    expect(prefersReducedMotion()).toBe(true);
    osQuery.matches = false;
    document.documentElement.setAttribute('data-reduced-motion', '');
    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledTimes(1);
  });
});

describe('mirrorVsCodeReduceMotion', () => {
  it("follows VS Code's vscode-reduce-motion body class with data-reduced-motion", async () => {
    document.body.classList.add('vscode-reduce-motion');
    mirrorVsCodeReduceMotion();
    expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true);

    document.body.classList.remove('vscode-reduce-motion');
    await Promise.resolve();
    expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false);

    document.body.classList.add('vscode-reduce-motion');
    await Promise.resolve();
    expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true);
  });
});
