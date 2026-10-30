// @vitest-environment happy-dom
// docs/invariants.md "Localized text": the dispatcher handles each message in the language in effect when the host sent it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { englishText as english, type LocalizedText } from '@shared/localized-text';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { createMessageDispatcher } from '../index';
import type { HandlerContext, HandlerRegistry } from '../types';
import { inGreek } from '../../../../__mocks__/greek-locale';

const toasts = vi.hoisted(() => [] as string[]);
vi.mock('vue-sonner', () => {
  const show = (text: string): void => void toasts.push(text);
  return { toast: Object.assign(show, { info: show, success: show, warning: show, error: show }) };
});

// The paths i18n/index.ts imports the Greek catalogs from, resolved from this file.
const CORE_EL = '../../../../../l10n/bundle.l10n.el.json';
const VIEW_EL = '../../../i18n/locales/el.json';

const loads = { core: 0 };

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** A page's dispatcher whose handlers run over fresh i18n modules, whose Greek catalogs wait for `gate` and fail when `fail` is set. */
async function freshPage(options: { gate?: Promise<void>; fail?: boolean } = {}) {
  loads.core = 0;
  vi.resetModules();
  vi.doMock(CORE_EL, async (importOriginal: () => Promise<unknown>) => {
    loads.core += 1;
    await options.gate;
    if (options.fail) throw new Error('Failed to fetch dynamically imported module');
    return importOriginal();
  });
  vi.doMock(VIEW_EL, async (importOriginal: () => Promise<unknown>) => {
    await options.gate;
    return importOriginal();
  });
  const { createUIHandlers } = await import('../handlers/ui-handlers');
  const { i18n } = await import('@/i18n');
  setActivePinia(createPinia());
  const context = { stores: { streamingStore: useStreamingStore() } } as unknown as HandlerContext;
  const dispatch = createMessageDispatcher(createUIHandlers() as HandlerRegistry, context, () => undefined);
  return { dispatch, i18n };
}

const switchTo = (locale: string): ExtensionToWebviewMessage => ({ type: 'languageChange', locale });
const notice = (message: LocalizedText): ExtensionToWebviewMessage => ({ type: 'notification', notificationType: 'info', message });
const fileText = (name: string): LocalizedText => ({ message: 'Could not open file: {0}', args: [name] });

const BLOCKED: LocalizedText = { message: 'Your prompt was blocked by a hook.' };
const [A, B, C, D] = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(fileText) as [LocalizedText, LocalizedText, LocalizedText, LocalizedText];

// The first fresh import transforms the handlers' module graph, which can outlast a test's default timeout on a loaded run.
beforeAll(async () => {
  await freshPage();
}, 60_000);

beforeEach(() => {
  toasts.length = 0;
});

afterEach(() => {
  vi.doUnmock(CORE_EL);
  vi.doUnmock(VIEW_EL);
  vi.restoreAllMocks();
  document.documentElement.lang = '';
});

describe('a page whose language changes while its catalogs load', () => {
  it('renders a notification that arrives right after a languageChange to el in Greek', async () => {
    const load = deferred();
    const { dispatch } = await freshPage({ gate: load.promise });

    dispatch(switchTo('el'));
    dispatch(notice(BLOCKED));
    expect(toasts).toEqual([]);

    load.release();
    await dispatch.settled();
    expect(toasts).toEqual([inGreek(BLOCKED)]);
  });

  it('handles the messages held behind the switch in arrival order, before one that arrives after the load', async () => {
    const load = deferred();
    const { dispatch } = await freshPage({ gate: load.promise });

    dispatch(switchTo('el'));
    dispatch(notice(A));
    dispatch(notice(B));
    dispatch(notice(C));
    expect(toasts).toEqual([]);

    load.release();
    await dispatch.settled();
    dispatch(notice(D));
    expect(toasts).toEqual([A, B, C, D].map(inGreek));
  });

  it('handles each message synchronously when no load is pending', async () => {
    const { dispatch } = await freshPage();

    dispatch(switchTo('en'));
    dispatch(notice(A));
    expect(toasts).toEqual([english(A)]);

    dispatch(switchTo('el'));
    await dispatch.settled();
    toasts.length = 0;

    dispatch(switchTo('en'));
    dispatch(notice(B));
    dispatch(switchTo('el'));
    dispatch(notice(C));
    expect(toasts).toEqual([english(B), inGreek(C)]);
    expect(loads.core).toBe(1);
  });

  it('handles the held messages in English when the Greek catalogs fail to load', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = deferred();
    const { dispatch, i18n } = await freshPage({ gate: load.promise, fail: true });

    dispatch(switchTo('el'));
    dispatch(notice(A));
    dispatch(notice(B));
    expect(toasts).toEqual([]);

    load.release();
    await dispatch.settled();
    expect(toasts).toEqual([english(A), english(B)]);
    expect(i18n.global.locale.value).toBe('en');
    expect(logged).toHaveBeenCalledOnce();
  });

  it('queues a second switch behind a pending one, so each message renders in the language switched to before it', async () => {
    const load = deferred();
    const { dispatch, i18n } = await freshPage({ gate: load.promise });

    dispatch(switchTo('el'));
    dispatch(notice(A));
    dispatch(switchTo('en'));
    dispatch(notice(B));
    dispatch(switchTo('el'));
    dispatch(notice(C));
    expect(toasts).toEqual([]);

    load.release();
    await dispatch.settled();
    expect(toasts).toEqual([inGreek(A), english(B), inGreek(C)]);
    expect(i18n.global.locale.value).toBe('el');
    expect(loads.core).toBe(1);
  });
});
