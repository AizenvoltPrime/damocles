import { createI18n } from 'vue-i18n';
import type { ShellLocale } from '../preload/shell-channels';
import { LOCALE_HOLD_BOUND_MS } from '../../shared/locale-hold';
import en from './locales/en.json';

export const shellI18n = createI18n({
  legacy: false,
  locale: 'en' satisfies ShellLocale,
  fallbackLocale: 'en' satisfies ShellLocale,
  messages: { en } as Partial<Record<ShellLocale, typeof en>>,
});

// English ships in the entry; any other language is its own lazy chunk.
const LOADERS: Readonly<Record<Exclude<ShellLocale, 'en'>, () => Promise<typeof en>>> = {
  el: () => import('./locales/el.json').then((catalog) => catalog.default),
};

const loaded = new Set<ShellLocale>(['en']);
const loads = new Map<ShellLocale, Promise<boolean>>();
let requested: ShellLocale = 'en';
// The latest applyShellLocale's switch while its catalog loads; deliveries behind createLocaleHold wait for it.
let pending: Promise<void> | undefined;

// The document's module map keeps a failed import (whatwg/html#6768), so its language is not tried again until another is asked for.
let failed: ShellLocale | undefined;

function normalizeLocale(locale: string): ShellLocale {
  return locale.split('-')[0] === 'el' ? 'el' : 'en';
}

function askFor(locale: string): ShellLocale {
  const target = normalizeLocale(locale);
  if (failed !== target) failed = undefined;
  return target;
}

/**
 * Loads `locale`'s shell catalog without showing it; false when its chunk fails to load, logged once: the language is tried
 * again only after another was asked for.
 */
export function loadShellLocale(locale: string): Promise<boolean> {
  const target = askFor(locale);
  if (loaded.has(target)) return Promise.resolve(true);
  if (failed === target) return Promise.resolve(false);
  const existing = loads.get(target);
  if (existing) return existing;
  const load = LOADERS[target as Exclude<ShellLocale, 'en'>]().then(
    (catalog) => {
      // Merged, not set: the overlay's settings messages (addSettingsMessages) may already sit under this locale.
      shellI18n.global.mergeLocaleMessage(target, catalog);
      loaded.add(target);
      return true;
    },
    (err: unknown) => {
      loads.delete(target);
      failed = target;
      console.error(`[i18n] the shell's ${target} catalog did not load, so the page keeps its language:`, err);
      return false;
    },
  );
  loads.set(target, load);
  return load;
}

// The page's language too: text-transform: uppercase drops Greek accents only under lang="el".
function showShellLocale(locale: ShellLocale): void {
  shellI18n.global.locale.value = locale;
  document.documentElement.lang = locale;
}

/**
 * Shows `locale` once its catalog has loaded, at once when it already has; of overlapping switches the last one asked for
 * wins. A catalog that fails to load is not shown, so the page keeps the language it renders in, and names it in its lang.
 */
export function applyShellLocale(locale: string): Promise<void> {
  const target = askFor(locale);
  requested = target;
  if (loaded.has(target) || failed === target) {
    pending = undefined;
    showShellLocale(loaded.has(target) ? target : shellI18n.global.locale.value);
    return Promise.resolve();
  }
  const shown: Promise<void> = loadShellLocale(target).then((ok) => {
    if (pending === shown) pending = undefined;
    if (requested === target) showShellLocale(ok ? target : shellI18n.global.locale.value);
  });
  pending = shown;
  return shown;
}


/** Another load a delivery waits for, besides the shell's switch; undefined when none is under way. */
export type LocaleGate = () => Promise<unknown> | undefined;

const shellSwitch: LocaleGate = () => pending;
// Loads a hold gave up on, so no later delivery waits for them again.
const overdue = new WeakSet<Promise<unknown>>();

function blocking(gates: readonly LocaleGate[]): Array<Promise<unknown>> {
  return gates.map((gate) => gate()).filter((load): load is Promise<unknown> => load !== undefined && !overdue.has(load));
}

/**
 * Runs each delivery in arrival order, holding it and every later one while a switch applyShellLocale started, or the load
 * its gate names, is loading, so what main sends after naming a language first renders in it. A load still running after
 * LOCALE_HOLD_BOUND_MS is logged and no longer waited for: the deliveries render in the language shown, and the switch
 * still applies once its catalog loads. The webview's createMessageDispatcher holds the same way.
 */
export function createLocaleHold(): (deliver: () => void, gate?: LocaleGate) => void {
  const held: Array<{ readonly deliver: () => void; readonly gates: readonly LocaleGate[] }> = [];
  let waiting = false;

  function wait(loads: Array<Promise<unknown>>): void {
    waiting = true;
    let bound: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      bound = setTimeout(() => {
        for (const load of loads) overdue.add(load);
        console.error(`[i18n] the ${requested} text did not load within ${LOCALE_HOLD_BOUND_MS} ms, so what waited for it renders in the language shown`);
        resolve();
      }, LOCALE_HOLD_BOUND_MS);
    });
    void Promise.race([Promise.allSettled(loads), expired]).then(() => {
      clearTimeout(bound);
      waiting = false;
      drain();
    });
  }

  function drain(): void {
    while (!waiting && held.length > 0) {
      const loads = blocking(held[0]!.gates);
      if (loads.length > 0) {
        wait(loads);
        return;
      }
      const { deliver } = held.shift()!;
      try {
        deliver();
      } catch (err) {
        // Rethrown apart, so a failing delivery does not strand the ones held behind it.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  return (deliver, gate) => {
    const gates = gate ? [shellSwitch, gate] : [shellSwitch];
    if (held.length === 0 && blocking(gates).length === 0) {
      deliver();
      return;
    }
    held.push({ deliver, gates });
    drain();
  };
}
