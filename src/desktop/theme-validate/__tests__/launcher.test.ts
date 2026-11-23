// The validator's launcher: its exit code is the contract the store's CI reads (0 accepted, 1 refused, 2 anything else).
import { describe, expect, it, vi } from 'vitest';
import { exitCodeOf, launch, type LauncherDeps } from '../launcher';

const ACCEPTED = JSON.stringify({ ok: true, sha256: 'a'.repeat(64), bytes: 10, entry: {} });
const REFUSED = JSON.stringify({ ok: false, sha256: 'a'.repeat(64), bytes: 10, errors: ['x'] });

function deps(overrides: Partial<LauncherDeps> = {}): LauncherDeps & { readonly outs: string[]; readonly errs: string[]; readonly removed: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  const removed: string[] = [];
  return {
    outs, errs, removed,
    binary: () => '/checkout/electron',
    makeWork: () => '/tmp/work',
    removeWork: (dir) => {
      removed.push(dir);
    },
    runHost: async () => ({ code: 0, signal: null, stdout: ACCEPTED }),
    out: (text) => {
      outs.push(text);
    },
    err: (text) => {
      errs.push(text);
    },
    ...overrides,
  };
}

describe('exitCodeOf', () => {
  it('is the host\'s 0 or 1 only when the verdict it printed says the same', () => {
    expect(exitCodeOf(0, ACCEPTED)).toBe(0);
    expect(exitCodeOf(1, REFUSED)).toBe(1);
    expect(exitCodeOf(0, REFUSED)).toBe(2);
    expect(exitCodeOf(1, ACCEPTED)).toBe(2);
  });

  it('is 2 for an exit that printed no verdict, such as an Electron that could not start, and for any other code or a signal', () => {
    expect(exitCodeOf(1, '')).toBe(2);
    expect(exitCodeOf(1, 'not json')).toBe(2);
    expect(exitCodeOf(0, 'null')).toBe(2);
    expect(exitCodeOf(2, REFUSED)).toBe(2);
    expect(exitCodeOf(134, '')).toBe(2);
    expect(exitCodeOf(null, ACCEPTED)).toBe(2);
  });
});

describe('launch', () => {
  it('starts the host on the arguments and its own work folder, prints the verdict and removes the folder', async () => {
    const runHost = vi.fn(async () => ({ code: 1, signal: null, stdout: REFUSED }));
    const used = deps({ runHost });
    expect(await launch(['dusk.damocles-theme', '--thumbs', 'out'], '/dist/theme-validate/host.js', used)).toBe(1);
    expect(runHost).toHaveBeenCalledWith('/checkout/electron', ['/dist/theme-validate/host.js', 'dusk.damocles-theme', '--thumbs', 'out', '--work', '/tmp/work']);
    expect(used.outs).toEqual([REFUSED]);
    expect(used.removed).toEqual(['/tmp/work']);
  });

  it('exits 2, with the reason on stderr and nothing on stdout, when the checkout has no Electron', async () => {
    const runHost = vi.fn();
    const used = deps({
      binary: () => {
        throw new Error('Electron is not installed in this checkout; run `npx install-electron` first');
      },
      runHost,
    });
    expect(await launch(['dusk.damocles-theme'], 'host.js', used)).toBe(2);
    expect(runHost).not.toHaveBeenCalled();
    expect(used.outs).toEqual([]);
    expect(used.errs.join('')).toContain('Electron is not installed in this checkout');
  });

  it('exits 2 when the work folder cannot be made or the host cannot start', async () => {
    expect(await launch([], 'host.js', deps({
      makeWork: () => {
        throw new Error('ENOSPC');
      },
    }))).toBe(2);
    const used = deps({ runHost: async () => Promise.reject(new Error('spawn EACCES')) });
    expect(await launch([], 'host.js', used)).toBe(2);
    expect(used.removed).toEqual(['/tmp/work']);
  });

  it('exits 2, and keeps stdout for verdicts, when Electron exits 1 without one', async () => {
    const used = deps({ runHost: async () => ({ code: 1, signal: null, stdout: 'Gtk-WARNING: cannot open display' }) });
    expect(await launch([], 'host.js', used)).toBe(2);
    expect(used.outs).toEqual([]);
    expect(used.errs.join('')).toContain('without printing a verdict');
    const killed = deps({ runHost: async () => ({ code: null, signal: 'SIGKILL', stdout: '' }) });
    expect(await launch([], 'host.js', killed)).toBe(2);
    expect(killed.errs.join('')).toContain('SIGKILL');
  });

  it('keeps an accepted verdict\'s exit code when its work folder cannot be removed', async () => {
    const used = deps({
      removeWork: () => {
        throw new Error('EBUSY');
      },
    });
    expect(await launch([], 'host.js', used)).toBe(0);
    expect(used.outs).toEqual([ACCEPTED]);
    expect(used.errs.join('')).toContain('could not remove /tmp/work: EBUSY');
  });
});
