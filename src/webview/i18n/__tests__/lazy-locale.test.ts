// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, shallowRef } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { inGreek } from '../../../__mocks__/greek-locale';

// The paths i18n/index.ts imports the Greek catalogs from, resolved from this file.
const CORE_EL = '../../../../l10n/bundle.l10n.el.json';
const VIEW_EL = '../locales/el.json';
const TEXT = { message: 'Could not open file: {0}', args: ['notes.txt'] };

const loads = { core: 0, view: 0 };

/** Fresh i18n modules whose Greek catalogs count their loads, wait for `gate`, and fail when `fail` is set. */
async function freshI18n(options: { gate?: Promise<void>; fail?: boolean } = {}) {
  loads.core = 0;
  loads.view = 0;
  vi.resetModules();
  vi.doMock(CORE_EL, async (importOriginal: () => Promise<unknown>) => {
    loads.core += 1;
    await options.gate;
    if (options.fail) throw new Error('Failed to fetch dynamically imported module');
    return importOriginal();
  });
  vi.doMock(VIEW_EL, async (importOriginal: () => Promise<unknown>) => {
    loads.view += 1;
    await options.gate;
    return importOriginal();
  });
  const i18n = await import('@/i18n');
  const localized = await import('@/composables/useLocalizedText');
  return { ...i18n, ...localized };
}

afterEach(() => {
  vi.doUnmock(CORE_EL);
  vi.doUnmock(VIEW_EL);
  vi.restoreAllMocks();
  document.documentElement.lang = '';
});

describe('the Greek catalogs', () => {
  it('are not loaded for an English view', async () => {
    document.documentElement.lang = 'en';
    const { mountInInitialLocale, renderText } = await freshI18n();
    const mounted = vi.fn(() => renderText(TEXT));

    await mountInInitialLocale(mounted);

    expect(mounted).toHaveReturnedWith('Could not open file: notes.txt');
    expect(loads).toEqual({ core: 0, view: 0 });
  });

  it("load before a Greek view mounts, so its first render is Greek", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    document.documentElement.lang = 'el';
    const { mountInInitialLocale, renderText, i18n } = await freshI18n({ gate });
    const mounted = vi.fn(() => [i18n.global.locale.value, renderText(TEXT), i18n.global.t('common.error')]);

    const ready = mountInInitialLocale(mounted);
    await flushPromises();
    expect(mounted).not.toHaveBeenCalled();

    release();
    await ready;
    expect(mounted).toHaveReturnedWith(['el', inGreek(TEXT), 'Σφάλμα']);
    expect(loads).toEqual({ core: 1, view: 1 });
  });

  it('load on a runtime switch to Greek, which then re-renders a stored message already shown; English loads nothing', async () => {
    const { applyLocale, i18n, useLocalizedText } = await freshI18n();
    const stored = shallowRef(TEXT);
    const Shown = defineComponent({
      setup() {
        const { rt } = useLocalizedText();
        return () => h('p', rt(stored.value));
      },
    });
    const wrapper = mount(Shown, { global: { plugins: [i18n] } });
    expect(wrapper.text()).toBe('Could not open file: notes.txt');
    expect(loads).toEqual({ core: 0, view: 0 });

    await applyLocale('el');
    await nextTick();
    expect(wrapper.text()).toBe(inGreek(TEXT));

    await applyLocale('en');
    await nextTick();
    expect(wrapper.text()).toBe('Could not open file: notes.txt');
    await applyLocale('el');
    await nextTick();
    expect(wrapper.text()).toBe(inGreek(TEXT));
    expect(loads).toEqual({ core: 1, view: 1 });
    wrapper.unmount();
  });

  it('that fail to load are logged, and the view stays in English', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { applyLocale, i18n, renderText } = await freshI18n({ fail: true });

    await applyLocale('el');

    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]![0])).toContain('el');
    expect(i18n.global.locale.value).toBe('en');
    expect(document.documentElement.lang).not.toBe('el');
    expect(renderText(TEXT)).toBe('Could not open file: notes.txt');
    expect(i18n.global.t('common.error')).toBe('Error');
  });

  it('switch only to the language asked for last when two switches overlap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { applyLocale, i18n } = await freshI18n({ gate });

    const greek = applyLocale('el');
    const english = applyLocale('en');
    release();
    await Promise.all([greek, english]);

    expect(i18n.global.locale.value).toBe('en');
  });
});
