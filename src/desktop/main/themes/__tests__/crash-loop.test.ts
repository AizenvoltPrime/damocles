import { describe, expect, it } from 'vitest';
import { systemTheme } from '../../../../shared/themes/system-theme';
import { resolveShown } from '../appearance';
import { CRASH_LOOP_LIMIT, CRASH_LOOP_WINDOW_MS, ThemeCrashLoop } from '../crash-loop';

// Guards the Linux path of the crash-loop switch, where Electron ignores forcefullyCrashRenderer for sandboxed renderers.
describe('theme crash loop', () => {
  it('switches on the second crash within a minute while a custom look shows, once', () => {
    expect(CRASH_LOOP_LIMIT).toBe(2);
    const loop = new ThemeCrashLoop();
    expect(loop.crashed(1_000, true)).toBe(false);
    expect(loop.crashed(1_000 + CRASH_LOOP_WINDOW_MS - 1, true)).toBe(true);
    expect(loop.crashed(1_000 + CRASH_LOOP_WINDOW_MS, true)).toBe(false);
  });

  it('counts nothing under the built-in look, and forgets a crash older than the window', () => {
    const loop = new ThemeCrashLoop();
    expect(loop.crashed(0, false)).toBe(false);
    expect(loop.crashed(10, true)).toBe(false);
    expect(loop.crashed(10 + CRASH_LOOP_WINDOW_MS, true)).toBe(false);
    expect(loop.crashed(20 + CRASH_LOOP_WINDOW_MS, true)).toBe(true);
  });

  // Main counts a crash while `!shown.builtin`; System colors is derived, so a crash under it must reach safe start too.
  it('counts crashes under System colors, and none under the Damocles look that safe start then shows', () => {
    const system = { status: 'ok', id: 'damocles-system', builtin: true, theme: systemTheme({ accent: '#e81123' }) } as const;
    const inputs = { forcedColors: false, mode: 'system', osKind: 'dark', preferred: { dark: 'damocles-system', light: 'damocles-system' }, theme: (id: string) => (id === system.id ? system : undefined) } as const;
    const loop = new ThemeCrashLoop();
    expect(loop.crashed(0, !resolveShown(inputs).builtin)).toBe(false);
    expect(loop.crashed(1, !resolveShown(inputs).builtin)).toBe(true);

    const safe = new ThemeCrashLoop();
    expect(safe.crashed(0, !resolveShown({ ...inputs, safeStart: 'crashLoop' }).builtin)).toBe(false);
    expect(safe.crashed(1, !resolveShown({ ...inputs, safeStart: 'crashLoop' }).builtin)).toBe(false);
  });

  it('starts over after Use my theme', () => {
    const loop = new ThemeCrashLoop();
    loop.crashed(0, true);
    expect(loop.crashed(1, true)).toBe(true);
    loop.reset();
    expect(loop.crashed(2, true)).toBe(false);
    expect(loop.crashed(3, true)).toBe(true);
  });
});
