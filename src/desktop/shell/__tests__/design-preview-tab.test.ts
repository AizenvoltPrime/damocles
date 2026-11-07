// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { JourneyStep } from '../../../shared/types/design';
import type { DamoclesShellApi, DesignReplayProgress, ShellDesignInfo, ShellDesignPreview, ShellEditorTab } from '../../preload/shell-channels';
import DesignPreviewTab from '../editor/DesignPreviewTab.vue';
import EditorPane from '../editor/EditorPane.vue';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, FakeResizeObserver, fakeShellApi, STATE, type FakeShellApi } from './fakes';

type DesignTab = ShellEditorTab & { designPreview: ShellDesignPreview };

// The fixture design-app: Tailwind 4's breakpoints, primary xl 1280.
const INFO: ShellDesignInfo = {
  breakpoints: [{ name: 'sm', width: 640 }, { name: 'md', width: 768 }, { name: 'lg', width: 1024 }, { name: 'xl', width: 1280 }, { name: '2xl', width: 1536 }],
  primary: 1280,
  checked: [390, 640, 768, 1024, 1280, 1536],
  journey: [390, 1280],
  states: ['default', 'empty', 'error'],
  tweaks: null,
};

function designTab(preview: Partial<ShellDesignPreview> = {}): DesignTab {
  const designPreview: ShellDesignPreview = {
    designId: 'contacts-1a2b3c4d', relPath: 'screens/S1-contacts.html', path: '/home/u/.damocles/designs/contacts-1a2b3c4d/screens/S1-contacts.html',
    status: 'ready', info: INFO, width: 1280, state: 'default', provenance: false, ...preview,
  };
  return { id: 'd1', kind: 'designPreview', title: 'S1 · Contacts', displayPath: designPreview.path, dirty: false, readOnly: false, conflict: false, designPreview };
}

const mounted: VueWrapper[] = [];
function mountTab(tab: DesignTab = designTab(), overrides: Parameters<typeof fakeShellApi>[1] = {}): { wrapper: VueWrapper; api: DamoclesShellApi } {
  const api = fakeShellApi([], overrides);
  const wrapper = mount(DesignPreviewTab, { props: { api, tab, platform: 'win32' }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, api };
}

// Gives the stage a size: its room is the size less 2rem a side, 1rem on top and 2.75rem below (16 px rem).
async function sizeStage(wrapper: VueWrapper, room: { width: number; height: number }): Promise<void> {
  const stage = wrapper.get('[data-testid="design-preview-stage"]').element;
  const observer = FakeResizeObserver.instances.find((instance) => instance.observed.includes(stage))!;
  (observer.callback as (entries: unknown[]) => void)([{ contentRect: { width: room.width + 64, height: room.height + 60 } }]);
  await nextTick();
}

const readoutOf = (wrapper: VueWrapper): string => wrapper.get('[data-testid="design-preview-readout"]').text();
const handle = (wrapper: VueWrapper) => wrapper.get('[data-testid="design-preview-handle"]');
const preset = (wrapper: VueWrapper, name: string) => wrapper.get(`[data-testid="design-preview-preset"][data-preset="${name}"]`);
const frameGlides = (wrapper: VueWrapper): boolean => wrapper.get('[data-testid="design-preview-frame"]').classes().includes('design-frame-glide');

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.documentElement.removeAttribute('data-reduced-motion');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the design preview tab', () => {
  it('opens at the primary width with its preset pressed, outlined as the band and marked with the design dot', async () => {
    const { wrapper } = mountTab();
    await sizeStage(wrapper, { width: 780, height: 600 });

    const presets = wrapper.findAll('[data-testid="design-preview-preset"]');
    expect(presets.map((item) => item.text())).toEqual(['base', 'sm', 'md', 'lg', 'xl', '2xl']);
    expect(preset(wrapper, 'xl').attributes('aria-pressed')).toBe('true');
    expect(preset(wrapper, 'xl').attributes('data-band')).toBe('true');
    expect(preset(wrapper, 'xl').find('[data-testid="design-preview-primary-dot"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="design-preview-primary-dot"]')).toHaveLength(1);
    expect(readoutOf(wrapper)).toBe('xl · 1280 px · 61%');
    expect(wrapper.get<HTMLInputElement>('[data-testid="design-preview-width"]').element.value).toBe('1280');
  });

  it('reads md · 900 px after typing 900, outlines md without pressing it, and keeps the width on Enter', async () => {
    const { wrapper, api } = mountTab();
    await sizeStage(wrapper, { width: 640, height: 600 });

    const field = wrapper.get<HTMLInputElement>('[data-testid="design-preview-width"]');
    await field.setValue('900');
    expect(readoutOf(wrapper)).toBe('md · 900 px · 71%');
    expect(preset(wrapper, 'md').attributes('data-band')).toBe('true');
    expect(preset(wrapper, 'md').attributes('aria-pressed')).toBe('false');
    expect(frameGlides(wrapper)).toBe(false);
    expect(api.setDesignPreview).not.toHaveBeenCalled();

    await field.trigger('keydown', { key: 'Enter' });
    expect(api.setDesignPreview).toHaveBeenCalledWith({ tabId: 'd1', width: 900 });
  });

  it('clamps a typed width to 320..2560 when it is kept', async () => {
    const { wrapper, api } = mountTab();
    const field = wrapper.get<HTMLInputElement>('[data-testid="design-preview-width"]');
    await field.setValue('9000');
    await field.trigger('keydown', { key: 'Enter' });
    expect(field.element.value).toBe('2560');
    expect(api.setDesignPreview).toHaveBeenLastCalledWith({ tabId: 'd1', width: 2560 });
  });

  it('lists only the states the screen declares, and none when it declares none', async () => {
    const declared = mountTab().wrapper;
    expect(declared.findAll('[data-testid="design-preview-state"]').map((item) => item.text())).toEqual(['default', 'empty', 'error']);

    const none = mountTab(designTab({ info: { ...INFO, states: [] } })).wrapper;
    expect(none.find('[data-testid="design-preview-states"]').exists()).toBe(false);
  });

  it('sends a state, the provenance switch and Open in browser to main', async () => {
    const { wrapper, api } = mountTab();
    await wrapper.get('[data-testid="design-preview-state"][data-state-name="empty"]').trigger('mousedown');
    await wrapper.get('[data-testid="design-preview-state"][data-state-name="empty"]').trigger('click');
    expect(api.setDesignPreview).toHaveBeenCalledWith({ tabId: 'd1', state: 'empty' });

    await wrapper.get('[data-testid="design-preview-provenance"]').trigger('click');
    expect(api.setDesignPreview).toHaveBeenCalledWith({ tabId: 'd1', provenance: true });

    await wrapper.get('[data-testid="design-preview-browser"]').trigger('click');
    expect(api.designPreviewAction).toHaveBeenCalledWith({ tabId: 'd1', action: 'openInBrowser' });
  });

  it('takes a screenshot through main, disabled while it captures, then flashes the frame and says where it went', async () => {
    const { wrapper, api } = mountTab();
    await sizeStage(wrapper, { width: 780, height: 600 });
    let resolveCapture!: () => void;
    vi.mocked(api.designPreviewAction).mockImplementationOnce(() => new Promise<void>((resolve) => { resolveCapture = resolve; }));
    const button = wrapper.get('[data-testid="design-preview-screenshot"]');

    await button.trigger('click');
    expect(api.designPreviewAction).toHaveBeenCalledWith({ tabId: 'd1', action: 'screenshot' });
    // aria-disabled, not disabled, so the button keeps focus while main captures; a second click asks nothing
    expect(button.attributes('aria-disabled')).toBe('true');
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.attributes('aria-busy')).toBe('true');
    await button.trigger('click');
    expect(api.designPreviewAction).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-testid="design-preview-flash"]').exists()).toBe(false);

    resolveCapture();
    await flushPromises();
    expect(button.attributes('aria-disabled')).toBeUndefined();
    const flash = wrapper.get('[data-testid="design-preview-flash"]');
    expect(flash.classes().join(' ')).toContain('animate-[d-flash');
    // It rings exactly the frame.
    expect(flash.attributes('style')).toBe(wrapper.get('[data-testid="design-preview-frame"]').attributes('style'));
    expect(wrapper.get('[data-testid="design-preview-screenshot-status"]').text()).toBe('Screenshot added to the design chat.');
  });

  it('says a failed screenshot in the toolbar and logs the reason main gave', async () => {
    const { wrapper, api } = mountTab();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.designPreviewAction).mockRejectedValueOnce(new Error('The design chat is not open'));

    await wrapper.get('[data-testid="design-preview-screenshot"]').trigger('click');
    await flushPromises();

    const status = wrapper.get('[data-testid="design-preview-screenshot-status"]');
    expect(status.attributes('role')).toBe('status');
    expect(status.text()).toBe('The screenshot failed.');
    expect(wrapper.find('[data-testid="design-preview-flash"]').exists()).toBe(false);
    expect(error).toHaveBeenCalledWith('[design preview] the screenshot failed', expect.any(Error));
  });

  it('offers no screenshot until the preview is ready', async () => {
    const { wrapper, api } = mountTab(designTab({ status: 'loading' }));
    const button = wrapper.get('[data-testid="design-preview-screenshot"]');
    expect(button.attributes('aria-disabled')).toBe('true');
    await button.trigger('click');
    expect(api.designPreviewAction).not.toHaveBeenCalled();
  });

  it('logs a change main refuses instead of leaving the rejection unhandled', async () => {
    const { wrapper, api } = mountTab();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.setDesignPreview).mockRejectedValueOnce(new Error('Unknown design tab'));
    await wrapper.get('[data-testid="design-preview-provenance"]').trigger('click');
    await flushPromises();
    expect(error).toHaveBeenCalledWith('[design preview] main refused the change', expect.any(Error));
  });

  it('names its control groups, labels the width field and makes the handle a vertical separator with its value', () => {
    const { wrapper } = mountTab();
    // groups, not toolbars: their text field and toggle groups keep their own arrow keys
    expect(wrapper.find('[role="toolbar"]').exists()).toBe(false);
    for (const [testid, label] of [['design-preview-width-toolbar', 'Preview width'], ['design-preview-view-toolbar', 'Preview view']]) {
      expect(wrapper.get(`[data-testid="${testid}"]`).attributes()).toMatchObject({ role: 'group', 'aria-label': label });
    }
    const field = wrapper.get('[data-testid="design-preview-width"]');
    expect(wrapper.get(`label[for="${field.attributes('id')}"]`).text()).toBe('Preview width in CSS px, 320 to 2560');
    expect(handle(wrapper).attributes()).toMatchObject({
      role: 'separator', 'aria-orientation': 'vertical', 'aria-valuenow': '1280', 'aria-valuemin': '320', 'aria-valuemax': '2560', tabindex: '0',
    });
    expect(wrapper.get('[data-testid="design-preview-sandbox"]').text()).toBe('sandboxed · network off');
    expect(wrapper.get('[data-testid="design-preview-path"]').text()).toBe('screens/S1-contacts.html');
  });

  it('steps the width 1 px with an arrow key and 10 px with Shift on the handle', async () => {
    const { wrapper, api } = mountTab();
    await handle(wrapper).trigger('keydown', { key: 'ArrowRight' });
    expect(handle(wrapper).attributes('aria-valuenow')).toBe('1281');
    await handle(wrapper).trigger('keydown', { key: 'ArrowLeft', shiftKey: true });
    expect(handle(wrapper).attributes('aria-valuenow')).toBe('1271');
    expect(api.setDesignPreview).toHaveBeenLastCalledWith({ tabId: 'd1', width: 1271 });
    expect(frameGlides(wrapper)).toBe(false);
  });

  it('turns a 10 px edge drag at 50% zoom into 40 px of width, without the glide', async () => {
    const { wrapper, api } = mountTab();
    await sizeStage(wrapper, { width: 640, height: 600 });
    expect(readoutOf(wrapper)).toBe('xl · 1280 px · 50%');

    await handle(wrapper).trigger('pointerdown', { button: 0, pointerId: 1, clientX: 100 });
    await handle(wrapper).trigger('pointermove', { pointerId: 1, clientX: 110 });
    await handle(wrapper).trigger('pointerup', { pointerId: 1, clientX: 110 });

    expect(handle(wrapper).attributes('aria-valuenow')).toBe('1320');
    expect(api.setDesignPreview).toHaveBeenCalledWith({ tabId: 'd1', width: 1320 });
    expect(frameGlides(wrapper)).toBe(false);
  });

  it('ends the glide when the width transition is cancelled', async () => {
    const { wrapper } = mountTab();
    await sizeStage(wrapper, { width: 1000, height: 600 });
    await preset(wrapper, 'md').trigger('click');
    expect(frameGlides(wrapper)).toBe(true);
    const cancel = new Event('transitioncancel') as TransitionEvent;
    Object.defineProperty(cancel, 'propertyName', { value: 'width' });
    wrapper.get('[data-testid="design-preview-frame"]').element.dispatchEvent(cancel);
    await nextTick();
    expect(frameGlides(wrapper)).toBe(false);
    expect(wrapper.get('[data-testid="design-preview-markup"]').attributes('aria-disabled')).toBeUndefined();
  });

  it('keeps a long drag that ends at exactly 0 px of change from the start', async () => {
    const { wrapper, api } = mountTab(designTab({ width: 640 }));
    await sizeStage(wrapper, { width: 1000, height: 600 });
    await handle(wrapper).trigger('pointerdown', { button: 0, pointerId: 1, clientX: 500 });
    // 2 × −320 px at 100% is −640 px: a target of exactly 0, which the frame shows clamped to 320
    await handle(wrapper).trigger('pointermove', { pointerId: 1, clientX: 180 });
    await handle(wrapper).trigger('pointerup', { pointerId: 1, clientX: 180 });
    expect(api.setDesignPreview).toHaveBeenLastCalledWith({ tabId: 'd1', width: 320 });
  });

  it('says in the frame that the pane is too narrow for the width, instead of showing an empty frame', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.dataset['testid'] === 'design-preview-frame' ? { left: 0, top: 0, right: 60, bottom: 400, width: 60, height: 400 } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
    });
    const { wrapper, api } = mountTab(designTab({ width: 2560 }));
    await nextTick();
    expect(api.reportDesignPreviewBounds).toHaveBeenLastCalledWith(null);
    const status = wrapper.get('[data-testid="design-preview-status"]');
    expect(status.attributes('data-status')).toBe('tooNarrow');
    expect(status.text()).toBe('The pane is too narrow to show 2560 px. Widen it or choose a smaller width.');
  });

  it('glides the frame to a preset and stops gliding when the width transition ends', async () => {
    const { wrapper, api } = mountTab();
    await sizeStage(wrapper, { width: 1000, height: 600 });
    await preset(wrapper, 'md').trigger('click');

    expect(api.setDesignPreview).toHaveBeenCalledWith({ tabId: 'd1', width: 768 });
    expect(frameGlides(wrapper)).toBe(true);
    const frame = wrapper.get('[data-testid="design-preview-frame"]').element;
    const end = new Event('transitionend') as TransitionEvent;
    Object.defineProperty(end, 'propertyName', { value: 'width' });
    frame.dispatchEvent(end);
    await nextTick();
    expect(frameGlides(wrapper)).toBe(false);
  });

  it('moves nothing under reduced motion: a preset jumps', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    const { wrapper } = mountTab();
    await sizeStage(wrapper, { width: 1000, height: 600 });
    await preset(wrapper, 'md').trigger('click');
    expect(handle(wrapper).attributes('aria-valuenow')).toBe('768');
    expect(frameGlides(wrapper)).toBe(false);
  });

  it('fits the width to the room the pane has', async () => {
    const { wrapper, api } = mountTab();
    await sizeStage(wrapper, { width: 781, height: 600 });
    await wrapper.get('[data-testid="design-preview-fit"]').trigger('click');
    expect(readoutOf(wrapper)).toBe('md · 781 px · 100%');
    expect(api.setDesignPreview).toHaveBeenCalledWith({ tabId: 'd1', width: 781 });
  });

  it('reports the frame and the zoom that makes the page as wide as the width, and nothing once unmounted', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.dataset['testid'] === 'design-preview-frame' ? { left: 100, top: 80, right: 740, bottom: 680, width: 640, height: 600 } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
    });
    const { wrapper, api } = mountTab();
    expect(api.reportDesignPreviewBounds).toHaveBeenLastCalledWith({ tabId: 'd1', x: 100, y: 80, width: 640, height: 600, radius: 0, zoom: 0.5 });

    // A width that leaves the frame's size alone (a zoomed frame) still reports its new zoom.
    await handle(wrapper).trigger('keydown', { key: 'End' });
    await nextTick();
    expect(api.reportDesignPreviewBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 640, zoom: 0.25 }));

    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    expect(api.reportDesignPreviewBounds).toHaveBeenLastCalledWith(null);
  });

  it('shows each status in the frame, the last frame dimmed while reconnecting, fetched once per frame id', async () => {
    for (const status of ['loading', 'updateServer', 'failed'] as const) {
      const { wrapper } = mountTab(designTab({ status }));
      expect(wrapper.get('[data-testid="design-preview-status"]').attributes('data-status')).toBe(status);
    }
    expect(mountTab(designTab({ status: 'updateServer' })).wrapper.get('[data-testid="design-preview-status"]').text())
      .toBe('Update the Damocles server on this host to preview designs.');

    const designLastFrame = vi.fn(async () => 'data:image/jpeg;base64,AAAA');
    const { wrapper: reconnecting, api } = mountTab(designTab({ status: 'reconnecting', lastFrameId: 3 }), { designLastFrame });
    await flushPromises();
    expect(reconnecting.get('[data-testid="design-preview-status"]').text()).toBe('Reconnecting…');
    expect(reconnecting.get('[data-testid="design-preview-last-frame"]').attributes('src')).toBe('data:image/jpeg;base64,AAAA');
    expect(api.designLastFrame).toHaveBeenCalledExactlyOnceWith('d1');
    // a publish with the same frame id fetches nothing again; the connection back drops the frame
    await reconnecting.setProps({ tab: designTab({ status: 'reconnecting', lastFrameId: 3, width: 900 }) });
    expect(designLastFrame).toHaveBeenCalledOnce();
    await reconnecting.setProps({ tab: designTab({ status: 'loading' }) });
    expect(reconnecting.find('[data-testid="design-preview-last-frame"]').exists()).toBe(false);
    expect(mountTab().wrapper.find('[data-testid="design-preview-status"]').exists()).toBe(false);
  });

  it('follows main\'s width, and says the readout in Greek units unchanged', async () => {
    const { wrapper } = mountTab();
    await sizeStage(wrapper, { width: 780, height: 600 });
    await wrapper.setProps({ tab: designTab({ width: 390 }) });
    expect(handle(wrapper).attributes('aria-valuenow')).toBe('390');
    expect(preset(wrapper, 'base').attributes('aria-pressed')).toBe('true');
    shellI18n.global.locale.value = 'el';
    await nextTick();
    expect(wrapper.get('[data-testid="design-preview-sandbox"]').text()).toBe('απομονωμένο · χωρίς δίκτυο');
    expect(readoutOf(wrapper)).toBe('base · 390 px · 100%');
  });
});

describe('the editor pane holding a design preview', () => {
  it('shows the preview without breadcrumbs, and its @ mentions the tab, whose file main names', async () => {
    const tab = designTab();
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs: [tab], activeTabId: tab.id })) });
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const wrapper = mount(EditorPane, { props: { api, state: STATE }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm }, stubs: { PaneGrip: true } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find('[data-testid="design-preview-tab"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="editor-breadcrumbs"]').exists()).toBe(false);
    const mention = wrapper.get('[data-testid="editor-mention"]');
    expect(mention.attributes('disabled')).toBeUndefined();
    await mention.trigger('click');
    expect(api.mentionTab).toHaveBeenCalledWith('d1');
  });

  it('keeps @ off until main read the screen and knows its path', async () => {
    const { info: _info, ...loading } = designTab({ status: 'loading' }).designPreview;
    const tab: DesignTab = { ...designTab(), designPreview: loading };
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs: [tab], activeTabId: tab.id })) });
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const wrapper = mount(EditorPane, { props: { api, state: STATE }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm }, stubs: { PaneGrip: true } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.get('[data-testid="editor-mention"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="design-preview-presets"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="design-preview-status"]').text()).toBe('Loading preview…');
  });
});

describe('the journey replay strip', () => {
  const STEPS: JourneyStep[] = [
    { action: 'click', target: { role: 'button', name: 'Add contact' } },
    { action: 'assert', target: { role: 'dialog', name: 'New contact' }, expect: { visible: true } },
    { action: 'press', target: { label: 'Name' }, key: 'Escape' },
    { action: 'assert', target: { role: 'dialog', name: 'New contact' }, expect: { visible: false } },
  ];
  const progress = (update: Partial<DesignReplayProgress> = {}): DesignReplayProgress => ({ tabId: 'd1', steps: STEPS, active: null, results: [], done: false, reducedMotion: false, ...update });
  const strip = (wrapper: VueWrapper) => wrapper.find('[data-testid="design-preview-replay"]');
  const dots = (wrapper: VueWrapper): string[] => wrapper.findAll('[data-testid="design-preview-replay-dot"]').map((dot) => dot.attributes('data-state')!);

  it('takes the readout\'s place while main replays this tab, showing the active step and each result', async () => {
    const { wrapper, api } = mountTab();
    const fake = api as FakeShellApi;
    await sizeStage(wrapper, { width: 780, height: 600 });

    fake.designReplay(progress({ tabId: 'other' }));
    await nextTick();
    expect(strip(wrapper).exists()).toBe(false);

    fake.designReplay(progress({ active: 2, results: [{ ok: true }, { ok: true }] }));
    await nextTick();
    expect(strip(wrapper).attributes('data-outcome')).toBe('running');
    expect(wrapper.get('[data-testid="design-preview-replay-status"]').text()).toBe('Replaying · step 3 of 4');
    expect(wrapper.get('[data-testid="design-preview-replay-step"]').text()).toBe('Press Escape in field “Name”');
    expect(dots(wrapper)).toEqual(['pass', 'pass', 'active', 'pending']);
    expect(wrapper.findAll('[data-testid="design-preview-replay-dot"]')[0]!.classes().join(' ')).toContain('d-badge-pop');
    expect(wrapper.find('[data-testid="design-preview-sandbox"]').exists()).toBe(true);
  });

  it('ends on the failed step, then clears and gives the readout back', async () => {
    vi.useFakeTimers();
    try {
      const { wrapper, api } = mountTab();
      const fake = api as FakeShellApi;
      fake.designReplay(progress({ results: [{ ok: true }, { ok: true }, { ok: true }, { ok: false, failure: 'expectation' }], done: true }));
      await nextTick();

      expect(strip(wrapper).attributes('data-outcome')).toBe('failed');
      expect(wrapper.get('[data-testid="design-preview-replay-status"]').text()).toBe('Replay failed at step 4');
      expect(wrapper.get('[data-testid="design-preview-replay-step"]').text()).toBe('dialog “New contact” is hidden');
      expect(dots(wrapper)).toEqual(['pass', 'pass', 'pass', 'fail']);

      await vi.advanceTimersByTimeAsync(4000);
      await flushPromises();
      expect(strip(wrapper).exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a reduced-motion replay\'s results at once, with nothing animated', async () => {
    const { wrapper, api } = mountTab();
    (api as FakeShellApi).designReplay(progress({ results: STEPS.map(() => ({ ok: true })), done: true, reducedMotion: true }));
    await nextTick();

    expect(wrapper.get('[data-testid="design-preview-replay-status"]').text()).toBe('Replay passed · 4/4');
    expect(dots(wrapper)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(wrapper.html()).not.toContain('d-badge-pop');
  });

  it('stops listening when the tab closes', () => {
    const unsubscribe = vi.fn();
    const api = fakeShellApi([], { onDesignReplay: vi.fn(() => unsubscribe) });
    const wrapper = mount(DesignPreviewTab, { props: { api, tab: designTab(), platform: 'win32' }, global: { plugins: [shellI18n] }, attachTo: document.body });

    expect(api.onDesignReplay).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
