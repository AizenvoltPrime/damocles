// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { TweaksDeclaration } from '../../../shared/types/design';
import type { DamoclesShellApi, ShellDesignInfo, ShellDesignPreview, ShellEditorTab } from '../../preload/shell-channels';
import DesignPreviewTab from '../editor/DesignPreviewTab.vue';
import TweaksPanel from '../editor/TweaksPanel.vue';
import { dropTweaksSession, tweaksSession } from '../editor/tweaks-session';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeShellApi } from './fakes';

const DECLARATION: TweaksDeclaration = {
  toolCallId: 'call-tweaks-1',
  controls: [
    { id: 'radius', label: 'Radius', property: '--radius', kind: 'segment', stops: [{ token: '--radius-sm', value: '0.25rem' }, { token: '--radius-md', value: '0.375rem' }, { token: '--radius-lg', value: '0.5rem' }], locked: null },
    { id: 'accent', label: 'Accent', property: '--color-primary', kind: 'swatch', stops: [{ token: '--color-blue', value: '#2563eb' }, { token: '--color-violet', value: '#7c5cff' }], locked: null },
    { id: 'density', label: 'Density', property: '--spacing', kind: 'segment', stops: [{ token: '--spacing-tight', value: '0.2rem' }, { token: '--spacing-loose', value: '0.3rem' }], locked: { decisionId: 'D3', value: '--spacing-tight' } },
  ],
};

const mounted: VueWrapper[] = [];
function mountPanel(applied: Record<string, string> = {}, paused = false): { wrapper: VueWrapper; api: DamoclesShellApi } {
  const api = fakeShellApi();
  const wrapper = mount(TweaksPanel, { props: { api, tabId: 'd1', declaration: DECLARATION, applied, paused }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, api };
}

const control = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-testid="design-tweak"][data-tweak="${id}"]`);
const stop = (wrapper: VueWrapper, token: string) => wrapper.get(`[data-testid="design-tweak-stop"][data-token="${token}"]`);
const keepButton = (wrapper: VueWrapper) => wrapper.get('[data-testid="design-tweaks-keep"]');
const resetButton = (wrapper: VueWrapper) => wrapper.get('[data-testid="design-tweaks-reset"]');

async function press(wrapper: VueWrapper, token: string): Promise<void> {
  await stop(wrapper, token).trigger('mousedown');
  await stop(wrapper, token).trigger('click');
  await flushPromises();
}

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  dropTweaksSession('d1');
  document.documentElement.removeAttribute('data-reduced-motion');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Tweaks column', () => {
  it('shows each control with its token stops: a segment of short names, swatches with accessible names', () => {
    const { wrapper } = mountPanel();
    expect(wrapper.findAll('[data-testid="design-tweak"]').map((item) => item.attributes('data-tweak'))).toEqual(['radius', 'accent', 'density']);
    const radius = control(wrapper, 'radius');
    expect(radius.get('[data-testid="design-tweak-stops"]').attributes('data-kind')).toBe('segment');
    expect(radius.findAll('[data-testid="design-tweak-stop"]').map((item) => item.text())).toEqual(['sm', 'md', 'lg']);
    expect(stop(wrapper, '--radius-lg').attributes('aria-label')).toBe('Radius: lg, 0.5rem');
    expect(control(wrapper, 'accent').get('[data-testid="design-tweak-stops"]').attributes('data-kind')).toBe('swatch');
    expect(stop(wrapper, '--color-violet').attributes('aria-label')).toBe('Accent: color-violet, #7c5cff');
    expect(stop(wrapper, '--color-violet').text()).toBe('');
    // Nothing is applied yet, so no stop is pressed and neither Reset nor Keep has anything to do.
    expect(control(wrapper, 'radius').findAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(resetButton(wrapper).attributes('aria-disabled')).toBe('true');
    expect(keepButton(wrapper).attributes('aria-disabled')).toBe('true');
  });

  it('shows a locked control with a lock and its decision id, its decided stop pressed and no stop changeable', async () => {
    const { wrapper, api } = mountPanel();
    const density = control(wrapper, 'density');
    expect(density.attributes('data-locked')).toBe('true');
    // a screen reader reads the sentence once; the visible id is hidden from it
    expect(density.get('[data-testid="design-tweak-lock"] .sr-only').text()).toBe('Locked by decision D3');
    expect(density.get('[data-testid="design-tweak-lock"] [aria-hidden="true"]:not(svg)').text()).toBe('D3');
    expect(density.get('[data-testid="design-tweak-lock"]').attributes('title')).toBe('Settled by decision D3');
    expect(stop(wrapper, '--spacing-tight').attributes('aria-pressed')).toBe('true');
    for (const item of density.findAll('[data-testid="design-tweak-stop"]')) expect(item.attributes('disabled')).toBeDefined();
    await press(wrapper, '--spacing-loose');
    expect(api.designTweakApply).not.toHaveBeenCalled();
  });

  it('applies a picked stop on the live view through main, pressed at once', async () => {
    const { wrapper, api } = mountPanel();
    await press(wrapper, '--radius-lg');
    expect(api.designTweakApply).toHaveBeenCalledWith({ tabId: 'd1', property: '--radius', token: '--radius-lg' });
    expect(stop(wrapper, '--radius-lg').attributes('aria-pressed')).toBe('true');
  });

  it('gives a refused pick back and says so', async () => {
    const { wrapper, api } = mountPanel();
    vi.mocked(api.designTweakApply).mockRejectedValueOnce(new Error('refused'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await press(wrapper, '--radius-lg');
    expect(stop(wrapper, '--radius-lg').attributes('aria-pressed')).toBe('false');
    expect(wrapper.get('[data-testid="design-tweaks-notice"]').text()).toBe("Couldn't apply Radius to the preview.");
  });

  it('resets every applied tweak through main, keeping focus on Reset while main works', async () => {
    const { wrapper, api } = mountPanel({ '--radius': '--radius-lg' });
    expect(stop(wrapper, '--radius-lg').attributes('aria-pressed')).toBe('true');
    let done!: () => void;
    vi.mocked(api.designTweakReset).mockImplementationOnce(() => new Promise<void>((resolve) => { done = resolve; }));
    (resetButton(wrapper).element as HTMLElement).focus();
    await resetButton(wrapper).trigger('click');
    expect(resetButton(wrapper).attributes('aria-disabled')).toBe('true');
    expect(resetButton(wrapper).attributes('disabled')).toBeUndefined();
    expect(document.activeElement).toBe(resetButton(wrapper).element);
    await resetButton(wrapper).trigger('click');
    expect(api.designTweakReset).toHaveBeenCalledOnce();
    done();
    await flushPromises();
    expect(api.designTweakReset).toHaveBeenCalledWith('d1');
    expect(wrapper.emitted('announce')).toEqual([['Tweaks removed from the preview']]);
  });

  it('keeps each changed control as its own design.tweak, in declaration order, and not again once kept', async () => {
    const { wrapper, api } = mountPanel({ '--color-primary': '--color-violet', '--radius': '--radius-lg' });
    expect(keepButton(wrapper).text()).toBe('Keep 2');
    expect(keepButton(wrapper).attributes('title')).toBe('Send to the designer: Radius → --radius-lg, Accent → --color-violet');
    await keepButton(wrapper).trigger('click');
    await flushPromises();
    expect(vi.mocked(api.designTweakKeep).mock.calls).toEqual([
      [{ tabId: 'd1', tweakId: 'radius', value: '--radius-lg' }],
      [{ tabId: 'd1', tweakId: 'accent', value: '--color-violet' }],
    ]);
    expect(wrapper.emitted('announce')).toEqual([['Sent to the designer: Radius → --radius-lg, Accent → --color-violet']]);
    expect(keepButton(wrapper).attributes('aria-disabled')).toBe('true');
    expect(control(wrapper, 'radius').get('[data-testid="design-tweak-value"]').text()).toBe('0.5rem');
  });

  it('stops at a refused Keep and leaves that control and the rest to send again', async () => {
    const { wrapper, api } = mountPanel({ '--color-primary': '--color-violet', '--radius': '--radius-lg' });
    vi.mocked(api.designTweakKeep).mockRejectedValueOnce(new Error('refused'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await keepButton(wrapper).trigger('click');
    await flushPromises();
    expect(api.designTweakKeep).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="design-tweaks-notice"]').text()).toBe("Couldn't send Keep for Radius.");
    expect(keepButton(wrapper).text()).toBe('Keep 2');
  });

  it('sends a kept control again only at another stop, and forgets kept values for a new declaration', async () => {
    const { wrapper, api } = mountPanel({ '--radius': '--radius-lg' });
    await keepButton(wrapper).trigger('click');
    await flushPromises();
    expect(keepButton(wrapper).attributes('aria-disabled')).toBe('true');
    await wrapper.setProps({ applied: { '--radius': '--radius-sm' } });
    expect(keepButton(wrapper).attributes('aria-disabled')).toBeUndefined();
    await wrapper.setProps({ applied: { '--radius': '--radius-lg' } });
    expect(keepButton(wrapper).attributes('aria-disabled')).toBe('true');
    await wrapper.setProps({ declaration: { ...DECLARATION, toolCallId: 'call-tweaks-2' } });
    expect(keepButton(wrapper).attributes('aria-disabled')).toBeUndefined();
    expect(api.designTweakKeep).toHaveBeenCalledTimes(1);
  });

  it('pauses while markup is on: nothing is changeable', async () => {
    const { wrapper, api } = mountPanel({ '--radius': '--radius-lg' }, true);
    expect(wrapper.get('[data-testid="design-tweaks"]').attributes('data-paused')).toBe('true');
    expect(stop(wrapper, '--radius-sm').attributes('disabled')).toBeDefined();
    expect(resetButton(wrapper).attributes('aria-disabled')).toBe('true');
    expect(keepButton(wrapper).attributes('aria-disabled')).toBe('true');
    await press(wrapper, '--radius-sm');
    await resetButton(wrapper).trigger('click');
    await keepButton(wrapper).trigger('click');
    expect(api.designTweakApply).not.toHaveBeenCalled();
    expect(api.designTweakReset).not.toHaveBeenCalled();
    expect(api.designTweakKeep).not.toHaveBeenCalled();
  });
});

type DesignTab = ShellEditorTab & { designPreview: ShellDesignPreview };
const INFO: ShellDesignInfo = { breakpoints: [{ name: 'xl', width: 1280 }], primary: 1280, checked: [1280], journey: [], states: [], tweaks: DECLARATION };
function designTab(preview: Partial<ShellDesignPreview> = {}): DesignTab {
  const designPreview: ShellDesignPreview = {
    designId: 'contacts-1a2b3c4d', relPath: 'screens/S1-contacts.html', path: '/home/u/.damocles/designs/contacts-1a2b3c4d/screens/S1-contacts.html',
    status: 'ready', info: INFO, width: 1280, state: 'default', provenance: false, canGoBack: false, canGoForward: false, ...preview,
  };
  return { id: 'd1', kind: 'designPreview', title: 'S1 · Contacts', displayPath: designPreview.path, dirty: false, readOnly: false, conflict: false, designPreview };
}
function mountTab(tab: DesignTab = designTab(), transitions = false): { wrapper: VueWrapper; api: DamoclesShellApi } {
  const api = fakeShellApi();
  const stubs = transitions ? { transition: false } : {};
  const wrapper = mount(DesignPreviewTab, { props: { api, tab, platform: 'win32' }, global: { plugins: [shellI18n], stubs }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, api };
}

describe('Tweaks in the preview tab', () => {
  it('offers Tweaks only when the design declared them', () => {
    expect(mountTab(designTab({ info: { ...INFO, tweaks: null } })).wrapper.find('[data-testid="design-preview-tweaks"]').exists()).toBe(false);
    expect(mountTab().wrapper.find('[data-testid="design-preview-tweaks"]').exists()).toBe(true);
  });

  it('opens the column beside the stage, which shrinks, so main moves the view out of its way', async () => {
    let left = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.dataset['testid'] === 'design-preview-frame' ? { left, top: 80, right: left + 640, bottom: 680, width: 640, height: 600 } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
    });
    const { wrapper, api } = mountTab();
    expect(api.reportDesignPreviewBounds).toHaveBeenLastCalledWith(expect.objectContaining({ x: 100, width: 640 }));

    const button = wrapper.get('[data-testid="design-preview-tweaks"]');
    expect(button.attributes('aria-pressed')).toBe('false');
    await button.trigger('click');
    expect(button.attributes('aria-pressed')).toBe('true');
    const panel = wrapper.get('[data-testid="design-tweaks"]');
    const stage = wrapper.get('[data-testid="design-preview-stage"]').element;
    // Beside the stage in its row, never inside it, where the native view lies.
    expect(stage.parentElement!.contains(panel.element)).toBe(true);
    expect(stage.contains(panel.element)).toBe(false);

    // The stage shrank and the frame moved with its size unchanged: the stage's resize still reports the new place.
    left = 40;
    const bounds = FakeResizeObserver.instances.find((instance) => instance.observed.includes(stage) && instance.observed.length > 1)!;
    bounds.callback();
    expect(api.reportDesignPreviewBounds).toHaveBeenLastCalledWith(expect.objectContaining({ x: 40, width: 640 }));

    await wrapper.get('[data-testid="design-tweaks-close"]').trigger('click');
    await nextTick();
    expect(tweaksSession('d1')?.open).toBe(false);
    // the Tweaks button takes focus back from the column's close button
    expect(document.activeElement).toBe(button.element);
  });

  it('zooms the column in, and under reduced motion it appears with no animation', async () => {
    const animated = mountTab(designTab(), true).wrapper;
    await animated.get('[data-testid="design-preview-tweaks"]').trigger('click');
    expect(animated.get('[data-testid="design-tweaks"]').classes()).toContain('animate-[d-zoom_.26s_var(--ease-out)]');
    animated.unmount();
    mounted.splice(mounted.indexOf(animated), 1);
    dropTweaksSession('d1');

    document.documentElement.setAttribute('data-reduced-motion', '');
    const still = mountTab(designTab(), true).wrapper;
    await still.get('[data-testid="design-preview-tweaks"]').trigger('click');
    expect(still.get('[data-testid="design-tweaks"]').classes().some((name) => name.startsWith('animate-'))).toBe(false);
  });

  it('pauses the column while a freeze captures, so no tweak lands in the capture', async () => {
    const { wrapper, api } = mountTab();
    await wrapper.get('[data-testid="design-preview-tweaks"]').trigger('click');
    vi.mocked(api.designFreeze).mockImplementationOnce(() => new Promise(() => undefined));
    await wrapper.get('[data-testid="design-preview-markup"]').trigger('click');
    expect(wrapper.get('[data-testid="design-tweaks"]').attributes('data-paused')).toBe('true');
  });

  it('holds Markup while a tweak is applied, since its capture would show what the files lack', async () => {
    const { wrapper, api } = mountTab(designTab({ tweaks: { '--radius': '--radius-lg' } }));
    const markup = wrapper.get('[data-testid="design-preview-markup"]');
    expect(markup.attributes('aria-disabled')).toBe('true');
    await markup.trigger('click');
    expect(api.designFreeze).not.toHaveBeenCalled();
    expect(markup.attributes('title')).toBe("Reset the tweaks before marking up: the designer's files do not have them");
    expect(wrapper.get('[data-testid="design-preview-tweaks-count"]').text()).toBe('11 tweak applied');
  });
});
