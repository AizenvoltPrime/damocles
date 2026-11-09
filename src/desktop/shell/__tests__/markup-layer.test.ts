// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { DesignFreeze, ShellDesignInfo, ShellDesignPreview, ShellEditorTab } from '../../preload/shell-channels';
import DesignPreviewTab from '../editor/DesignPreviewTab.vue';
import { PopoverContent } from '@/components/ui/popover';
import { addMark, dropTabMarkupSessions, markupSession, newMarkId } from '../editor/markup-session';
import { flattenMarkup } from '../editor/markup-flatten';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeShellApi, type FakeShellApi } from './fakes';

vi.mock('../editor/markup-flatten', () => ({
  flattenMarkup: vi.fn(async () => 'data:image/png;base64,RkxBVA=='),
  resolveMarkupColors: vi.fn(() => ({ design: 'rgb(183, 148, 246)', onDesign: 'rgb(3, 18, 28)', designText: 'rgb(196, 166, 248)', bg: 'rgb(0, 0, 0)' })),
}));

type DesignTab = ShellEditorTab & { designPreview: ShellDesignPreview };

const INFO: ShellDesignInfo = {
  breakpoints: [{ name: 'sm', width: 640 }, { name: 'md', width: 768 }, { name: 'lg', width: 1024 }, { name: 'xl', width: 1280 }, { name: '2xl', width: 1536 }],
  primary: 1280,
  checked: [390, 1280],
  journey: [],
  states: ['default', 'empty'],
  tweaks: null,
};

const S1 = 'screens/S1-contacts.html';
const S2 = 'screens/S2-contact.html';

// The fixture's contacts screen frozen at xl 1280, at 1:1; the layer shows it 640 shell px wide, so one shell px is 2 CSS px.
const FREEZE: DesignFreeze = {
  png: 'data:image/png;base64,iVBORw0KGgo=',
  imageWidth: 1280,
  imageHeight: 900,
  width: 1280,
  height: 900,
  breakpoint: 'xl',
  zoom: 1,
  pixelRatio: 1,
  scale: 1,
  state: 'default',
  screen: 'S1',
  file: S1,
  elements: [
    { element: 'main', rect: [0, 0, 1280, 900], facts: [] },
    { element: 'ui/Button', rect: [40, 80, 120, 36], facts: ['decision D1'] },
    { element: 'ui/Table', rect: [40, 140, 1200, 400], facts: ['variant compact'] },
    { element: 'td', rect: [40, 180, 300, 40], facts: ['bind Contact.name'] },
  ],
};
const DISPLAYED = { left: 0, top: 0, width: 640, height: 450 };

function designTab(preview: Partial<ShellDesignPreview> = {}): DesignTab {
  const designPreview: ShellDesignPreview = {
    designId: 'contacts-1a2b3c4d', relPath: S1, path: '/d/screens/S1-contacts.html',
    status: 'ready', info: INFO, width: 1280, state: 'default', provenance: false, canGoBack: false, canGoForward: false, ...preview,
  };
  return { id: 'd1', kind: 'designPreview', title: 'S1 · Contacts', displayPath: designPreview.path, dirty: false, readOnly: false, conflict: false, designPreview };
}

const mounted: VueWrapper[] = [];
function mountTab(api: FakeShellApi = fakeShellApi(), platform: 'win32' | 'darwin' = 'win32'): { wrapper: VueWrapper; api: FakeShellApi } {
  vi.mocked(api.designFreeze).mockResolvedValue(FREEZE);
  const wrapper = mount(DesignPreviewTab, { props: { api, tab: designTab(), platform }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, api };
}

async function freeze(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-testid="design-preview-markup"]').trigger('click');
  await flushPromises();
}

const canvas = (wrapper: VueWrapper) => wrapper.get('[data-testid="design-markup-canvas"]');
const pins = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="design-markup-pin"]');
const popover = (): DOMWrapper<HTMLElement> => new DOMWrapper(document.querySelector<HTMLElement>('[data-testid="design-markup-popover"]')!);
const sendButton = (wrapper: VueWrapper) => wrapper.get('[data-testid="design-markup-send"]');

/** A click of the canvas at shell px (x, y) of the displayed image. */
async function tap(wrapper: VueWrapper, x: number, y: number): Promise<void> {
  await canvas(wrapper).trigger('pointerdown', { button: 0, pointerId: 1, clientX: x, clientY: y });
  await canvas(wrapper).trigger('pointerup', { button: 0, pointerId: 1, clientX: x, clientY: y });
  await flushPromises();
}

async function drag(wrapper: VueWrapper, from: [number, number], to: [number, number], shiftKey = false): Promise<void> {
  await canvas(wrapper).trigger('pointerdown', { button: 0, pointerId: 2, clientX: from[0], clientY: from[1] });
  await canvas(wrapper).trigger('pointermove', { pointerId: 2, clientX: to[0], clientY: to[1], shiftKey });
  await canvas(wrapper).trigger('pointerup', { button: 0, pointerId: 2, clientX: to[0], clientY: to[1], shiftKey });
  await flushPromises();
}

async function chooseTool(wrapper: VueWrapper, tool: string): Promise<void> {
  const item = wrapper.get(`[data-testid="design-markup-tool"][data-tool="${tool}"]`);
  await item.trigger('mousedown');
  await item.trigger('click');
}

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLImageElement.prototype.decode = () => Promise.resolve();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const box = this.dataset.testid === 'design-markup-canvas' || this.dataset.testid === 'design-markup-layer' ? DISPLAYED : { left: 0, top: 0, width: 0, height: 0 };
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect;
  });
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  dropTabMarkupSessions('d1');
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(flattenMarkup).mockClear();
});

describe('markup on a frozen preview', () => {
  it('freezes the live view and swaps toolbar row 2 for the markup tools, the chip, Exit and Send', async () => {
    const { wrapper, api } = mountTab();
    await freeze(wrapper);

    expect(api.designFreeze).toHaveBeenCalledWith('d1');
    expect(wrapper.get<HTMLImageElement>('[data-testid="design-markup-image"]').element.src).toBe(FREEZE.png);
    expect(wrapper.findAll('[data-testid="design-markup-tool"]').map((item) => item.attributes('data-tool'))).toEqual(['pen', 'arrow', 'box', 'pin']);
    expect(wrapper.get('[data-testid="design-markup-tool"][data-tool="pin"]').attributes('data-state')).toBe('on');
    expect(wrapper.get('[data-testid="design-markup-chip"]').text()).toBe('Frozen at xl · 1280 · default');
    expect(sendButton(wrapper).text()).toBe('Send to designer (0)');
    expect(sendButton(wrapper).attributes('aria-disabled')).toBe('true');
    expect(wrapper.find('[data-testid="design-preview-screenshot"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="design-preview-fit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="design-preview-handle"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="design-preview-frame"]').attributes('data-markup')).toBe('true');
  });

  it('drops a pin on a table row anchored to ui/Table, opens its popover, and keeps its text and kind', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);

    // (350, 100) shell px is (700, 200) CSS px: inside the table, outside its first cell.
    await tap(wrapper, 350, 100);
    expect(pins(wrapper)).toHaveLength(1);
    expect(pins(wrapper)[0]!.attributes('data-element')).toBe('ui/Table');
    expect(pins(wrapper)[0]!.attributes('aria-label')).toBe('Pin 1, Change, on ui/Table');
    expect(popover().get('[data-testid="design-markup-anchor"]').text()).toBe('ui/Table');
    // Kept inside the layer, since the chat's native view covers the shell beside the preview.
    expect(wrapper.findComponent(PopoverContent).props('collisionBoundary')).toBe(wrapper.get('[data-testid="design-markup-layer"]').element);
    expect(sendButton(wrapper).text()).toBe('Send to designer (1)');
    expect(wrapper.get('[data-testid="design-markup-announcement"]').text()).toBe('Pin 1 added on ui/Table');

    await popover().get('textarea').setValue('Make the rows denser');
    const note = popover().get('[data-testid="design-markup-kind-option"][data-kind="note"]');
    await note.trigger('mousedown');
    await note.trigger('click');
    expect(pins(wrapper)[0]!.attributes('data-kind')).toBe('note');
    expect(markupSession('d1', S1)!.marks[0]).toMatchObject({ type: 'pin', kind: 'note', text: 'Make the rows denser', at: [700, 200], anchor: { element: 'ui/Table', facts: ['variant compact'] } });
  });

  it('anchors a pin on nested elements to the smallest', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await tap(wrapper, 50, 100);
    expect(pins(wrapper)[0]!.attributes('data-element')).toBe('td');
  });

  it('opens a pin\'s popover beside the pin on the side that holds it, right first', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    // 640 shell px wide: the popover with its gaps and the pin's half reaches 316 px from the pin's center.
    await tap(wrapper, 50, 100);
    expect(wrapper.findComponent(PopoverContent).props('side')).toBe('right');
    document.querySelector<HTMLElement>('[data-testid="design-markup-done"]')!.click();
    await tap(wrapper, 350, 100);
    expect(wrapper.findAllComponents(PopoverContent).at(-1)!.props('side')).toBe('left');
  });

  it('opens a pin\'s popover below the pin when neither side holds it, and follows the layer as it narrows', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await tap(wrapper, 320, 100);
    const content = wrapper.findComponent(PopoverContent);
    expect(content.props('side')).toBe('right');

    // The base breakpoint's 390 px frame: 195 px of room on each side of a centered pin.
    const canvasObserver = FakeResizeObserver.instances.find((observer) => observer.observed.includes(canvas(wrapper).element))!;
    (canvasObserver.callback as (entries: unknown[]) => void)([{ contentRect: { width: 390 } }]);
    await nextTick();
    expect(content.props('side')).toBe('bottom');
    // A layer narrower than the popover narrows it to what reka finds the layer leaves.
    expect(popover().classes()).toContain('max-w-(--reka-popover-content-available-width)');
  });

  it('draws a box that lists the elements it covers, and drops a drag too small to mean anything', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await chooseTool(wrapper, 'box');
    expect(canvas(wrapper).attributes('data-tool')).toBe('box');

    await drag(wrapper, [10, 10], [12, 12]);
    expect(markupSession('d1', S1)!.marks).toHaveLength(0);

    // (40, 60) to (360, 140) CSS px holds the button whole and only touches the table's top edge.
    await drag(wrapper, [20, 30], [180, 70]);
    expect(wrapper.findAll('[data-testid="design-markup-stroke"][data-type="box"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="design-markup-announcement"]').text()).toBe('Box added');
  });

  it('places a pin with Enter on the canvas, moves the focused pin with the arrow keys and removes it with Delete', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await canvas(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(markupSession('d1', S1)!.marks[0]).toMatchObject({ type: 'pin', at: [640, 450] });
    document.querySelector<HTMLElement>('[data-testid="design-markup-done"]')!.click();
    await flushPromises();

    const pin = pins(wrapper)[0]!;
    await pin.trigger('keydown', { key: 'ArrowRight' });
    await pin.trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    expect(markupSession('d1', S1)!.marks[0]).toMatchObject({ at: [644, 474] });
    // A run of moves is one undo step.
    expect(markupSession('d1', S1)!.undo).toHaveLength(2);

    await pin.trigger('keydown', { key: 'Delete' });
    await flushPromises();
    expect(pins(wrapper)).toHaveLength(0);
    expect(wrapper.get('[data-testid="design-markup-announcement"]').text()).toBe('Pin 1 deleted');
  });

  it('undoes with the button and Ctrl+Z, and Clear is undoable', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    await chooseTool(wrapper, 'arrow');
    await drag(wrapper, [100, 300], [300, 300]);
    expect(markupSession('d1', S1)!.marks.map((mark) => mark.type)).toEqual(['pin', 'arrow']);

    await wrapper.get('[data-testid="design-markup-clear"]').trigger('click');
    expect(markupSession('d1', S1)!.marks).toHaveLength(0);
    await wrapper.get('[data-testid="design-markup-undo"]').trigger('click');
    expect(markupSession('d1', S1)!.marks).toHaveLength(2);

    await canvas(wrapper).trigger('keydown', { key: 'z', ctrlKey: true });
    expect(markupSession('d1', S1)!.marks.map((mark) => mark.type)).toEqual(['pin']);
    await flushPromises();
    expect(wrapper.get('[data-testid="design-markup-announcement"]').text()).toBe('Undone');
  });

  it('reads Ctrl+Z by its letter on a Latin layout and by its place on a Greek one', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    for (let index = 0; index < 3; index++) addMark(markupSession('d1', S1)!, { id: newMarkId(), type: 'box', points: [[0, 0], [10, 10]] });
    // Greek: the Z key reads ζ
    await canvas(wrapper).trigger('keydown', { key: 'ζ', code: 'KeyZ', ctrlKey: true });
    expect(markupSession('d1', S1)!.marks).toHaveLength(2);
    // AZERTY: Z sits where QWERTY has W, and the key in Z's place reads w
    await canvas(wrapper).trigger('keydown', { key: 'z', code: 'KeyW', ctrlKey: true });
    expect(markupSession('d1', S1)!.marks).toHaveLength(1);
    await canvas(wrapper).trigger('keydown', { key: 'w', code: 'KeyZ', ctrlKey: true });
    expect(markupSession('d1', S1)!.marks).toHaveLength(1);
  });

  it('says the same message again when it repeats', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    for (let index = 0; index < 2; index++) addMark(markupSession('d1', S1)!, { id: newMarkId(), type: 'box', points: [[0, 0], [10, 10]] });
    const region = wrapper.get('[data-testid="design-markup-announcement"]').element;
    const said: string[] = [];
    const observer = new MutationObserver(() => said.push(region.textContent ?? ''));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    await canvas(wrapper).trigger('keydown', { key: 'z', ctrlKey: true });
    await flushPromises();
    await canvas(wrapper).trigger('keydown', { key: 'z', ctrlKey: true });
    await flushPromises();
    observer.disconnect();
    expect(said.filter((text) => text === 'Undone')).toHaveLength(2);
  });

  it('gives focus to the canvas when Ctrl+Z takes away the focused pin', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    document.querySelector<HTMLElement>('[data-testid="design-markup-done"]')!.click();
    await flushPromises();
    const pin = pins(wrapper)[0]!;
    (pin.element as HTMLElement).focus();
    await pin.trigger('keydown', { key: 'z', ctrlKey: true });
    await flushPromises();
    expect(pins(wrapper)).toHaveLength(0);
    expect(document.activeElement).toBe(canvas(wrapper).element);
  });

  it('sends the flattened capture and the markup JSON, then clears the marks and exits', async () => {
    const { wrapper, api } = mountTab();
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    await popover().get('textarea').setValue('Denser rows');
    await chooseTool(wrapper, 'box');
    await drag(wrapper, [20, 30], [180, 70]);

    await sendButton(wrapper).trigger('click');
    await flushPromises();

    expect(flattenMarkup).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'd1' }), 640, expect.any(Object));
    expect(api.designMarkupSend).toHaveBeenCalledWith({
      tabId: 'd1',
      png: 'data:image/png;base64,RkxBVA==',
      json: {
        screen: 'S1', file: 'screens/S1-contacts.html', viewport: { breakpoint: 'xl', width: 1280 }, zoom: 1, pixelRatio: 1, state: 'default',
        marks: [
          { type: 'pin', n: 1, kind: 'change', text: 'Denser rows', at: [700, 200], anchor: { element: 'ui/Table', facts: ['variant compact'] } },
          { type: 'box', bbox: [40, 60, 320, 80], anchors: ['ui/Button'] },
        ],
      },
    });
    // main ends markup itself once the send is accepted
    expect(api.designMarkupExit).not.toHaveBeenCalled();
    expect(markupSession('d1', S1)).toBeUndefined();
    expect(wrapper.find('[data-testid="design-markup-canvas"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="design-preview-markup-count"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="design-markup-announcement"]').text()).toBe('Sent to the design chat as F1');
    expect(document.activeElement).toBe(wrapper.get('[data-testid="design-preview-markup"]').element);
  });

  it('keeps the marks and says so when the send fails', async () => {
    const { wrapper, api } = mountTab();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.designMarkupSend).mockRejectedValueOnce(new Error("Error invoking remote method 'damocles:shell:design:markupSend': Error: busy"));
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    await sendButton(wrapper).trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="design-markup-notice"]').text()).toBe("Couldn't send the markup. Your marks are kept.");
    expect(markupSession('d1', S1)!.marks).toHaveLength(1);
    expect(api.designMarkupExit).not.toHaveBeenCalled();
    expect(sendButton(wrapper).attributes('aria-disabled')).toBeUndefined();
  });

  it('keeps the marks through Exit, and reopening returns to the frozen width without a new capture', async () => {
    const api = fakeShellApi();
    const { wrapper } = mountTab(api);
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    document.querySelector<HTMLElement>('[data-testid="design-markup-done"]')!.click();
    await wrapper.get('[data-testid="design-markup-exit"]').trigger('click');
    await flushPromises();

    expect(api.designMarkupExit).toHaveBeenCalledWith('d1');
    expect(wrapper.find('[data-testid="design-markup-canvas"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="design-preview-markup-count"]').text()).toBe('1');
    expect(document.activeElement).toBe(wrapper.get('[data-testid="design-preview-markup"]').element);
    expect(wrapper.get('[data-testid="design-preview-markup"]').attributes('aria-label')).toBe('Markup, 1 mark waiting');

    // The tab moved to another width meanwhile; reopening takes it back to 1280 before markup shows again.
    wrapper.unmount();
    mounted.splice(0);
    const moved = mount(DesignPreviewTab, { props: { api, tab: designTab({ width: 900 }), platform: 'win32' }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(moved);
    vi.mocked(api.designFreeze).mockClear();
    await moved.get('[data-testid="design-preview-markup"]').trigger('click');
    expect(api.setDesignPreview).toHaveBeenCalledWith({ tabId: 'd1', width: 1280 });
    expect(api.designMarkupEnter).not.toHaveBeenCalled();
    // Main refuses nothing mid-glide here, but the layer waits for the frame to reach the frozen width.
    const frame = moved.get('[data-testid="design-preview-frame"]').element;
    frame.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'width' }));
    await flushPromises();

    expect(api.designMarkupEnter).toHaveBeenCalledWith('d1');
    expect(api.designFreeze).not.toHaveBeenCalled();
    expect(moved.findAll('[data-testid="design-markup-pin"]')).toHaveLength(1);
  });

  it('drops a capture with no marks on Exit, so the next Markup freezes again', async () => {
    const { wrapper, api } = mountTab();
    await freeze(wrapper);
    await wrapper.get('[data-testid="design-markup-exit"]').trigger('click');
    await flushPromises();
    expect(markupSession('d1', S1)).toBeUndefined();
    await freeze(wrapper);
    expect(api.designFreeze).toHaveBeenCalledTimes(2);
  });

  it('keeps each screen\'s marks with that screen: another screen freezes anew, and Back reopens the first screen\'s marks', async () => {
    const { wrapper, api } = mountTab();
    const markupButton = () => wrapper.get('[data-testid="design-preview-markup"]');
    const closePopover = async (): Promise<void> => {
      document.querySelector<HTMLElement>('[data-testid="design-markup-done"]')!.click();
      await flushPromises();
    };
    const exit = async (): Promise<void> => {
      await wrapper.get('[data-testid="design-markup-exit"]').trigger('click');
      await flushPromises();
    };
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    await closePopover();
    await exit();

    // A link took the tab to S2: its Markup freezes S2, and S1's mark waits only in the title.
    await wrapper.setProps({ tab: designTab({ relPath: S2 }) });
    expect(wrapper.find('[data-testid="design-preview-markup-count"]').exists()).toBe(false);
    expect(markupButton().attributes('title')).toBe('Freeze the preview and mark it up for the designer\nMarks also waiting on S1-contacts.html');
    vi.mocked(api.designFreeze).mockClear().mockResolvedValue({ ...FREEZE, screen: 'S2', file: S2 });
    await freeze(wrapper);
    expect(api.designFreeze).toHaveBeenCalledWith('d1');
    expect(api.designMarkupEnter).not.toHaveBeenCalled();
    expect(pins(wrapper)).toHaveLength(0);
    await exit();
    // An empty capture goes on Exit, and only S2's.
    expect(markupSession('d1', S2)).toBeUndefined();
    expect(markupSession('d1', S1)!.marks).toHaveLength(1);

    await freeze(wrapper);
    await tap(wrapper, 100, 300);
    await closePopover();
    await exit();

    // Back on S1, Markup reopens S1's capture and its mark, and Send leaves S2's marks waiting.
    await wrapper.setProps({ tab: designTab() });
    expect(wrapper.get('[data-testid="design-preview-markup-count"]').text()).toBe('1');
    expect(markupButton().attributes('title')).toBe('Freeze the preview and mark it up for the designer\nMarks also waiting on S2-contact.html');
    vi.mocked(api.designFreeze).mockClear();
    await freeze(wrapper);
    expect(api.designMarkupEnter).toHaveBeenCalledWith('d1');
    expect(api.designFreeze).not.toHaveBeenCalled();
    expect(pins(wrapper)).toHaveLength(1);
    expect(pins(wrapper)[0]!.attributes('data-element')).toBe('ui/Table');

    await sendButton(wrapper).trigger('click');
    await flushPromises();
    expect(api.designMarkupSend).toHaveBeenCalledWith(expect.objectContaining({ json: expect.objectContaining({ file: S1 }) }));
    expect(markupSession('d1', S1)).toBeUndefined();
    expect(markupSession('d1', S2)!.marks).toHaveLength(1);
  });

  it('refuses a mark past the cap and says why', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    const session = markupSession('d1', S1)!;
    for (let index = 0; index < 64; index++) addMark(session, { id: newMarkId(), type: 'box', points: [[0, 0], [10, 10]] });
    await flushPromises();
    await canvas(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(markupSession('d1', S1)!.marks).toHaveLength(64);
    expect(wrapper.get('[data-testid="design-markup-notice"]').text()).toBe('Markup holds at most 64 marks');
  });

  it('shows the freeze failure and stays in the live view', async () => {
    const { wrapper, api } = mountTab();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.designFreeze).mockRejectedValueOnce(new Error('glide'));
    await freeze(wrapper);
    expect(wrapper.get('[data-testid="design-preview-markup-status"]').text()).toBe("Couldn't freeze the preview");
    expect(wrapper.find('[data-testid="design-markup-canvas"]').exists()).toBe(false);
  });

  it('turns markup off in main again when the capture cannot be shown', async () => {
    const { wrapper, api } = mountTab();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    HTMLImageElement.prototype.decode = () => Promise.reject(new Error('EncodingError'));
    await freeze(wrapper);
    expect(api.designMarkupExit).toHaveBeenCalledWith('d1');
    expect(markupSession('d1', S1)).toBeUndefined();
    expect(wrapper.get('[data-testid="design-preview-markup-status"]').text()).toBe("Couldn't freeze the preview");
  });

  it('focuses the selected tool once the markup tools have swapped in, even after the outgoing row\'s exit', async () => {
    const api = fakeShellApi();
    vi.mocked(api.designFreeze).mockResolvedValue(FREEZE);
    const wrapper = mount(DesignPreviewTab, { props: { api, tab: designTab(), platform: 'win32' }, global: { plugins: [shellI18n], stubs: { transition: false } }, attachTo: document.body });
    mounted.push(wrapper);
    const button = wrapper.get('[data-testid="design-preview-markup"]');
    (button.element as HTMLElement).focus();
    await button.trigger('click');
    // aria-disabled while it freezes, so it keeps focus
    expect(button.attributes('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button.element);
    await flushPromises();
    await vi.waitFor(() => expect(document.activeElement).toBe(wrapper.get('[data-testid="design-markup-tool"][data-tool="pin"]').element));
  });

  it('moves a dragged pin to where it was dropped as one undo step, and the click that ends the drag toggles nothing', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    document.querySelector<HTMLElement>('[data-testid="design-markup-done"]')!.click();
    await flushPromises();
    const pin = pins(wrapper)[0]!;
    await pin.trigger('pointerdown', { button: 0, pointerId: 5, clientX: 350, clientY: 100 });
    await pin.trigger('pointermove', { pointerId: 5, clientX: 50, clientY: 100 });
    expect(wrapper.get('[data-testid="design-markup-snap"]').attributes('data-element')).toBe('td');
    await pin.trigger('pointerup', { pointerId: 5, clientX: 50, clientY: 100 });
    await pin.trigger('click');
    await flushPromises();
    expect(markupSession('d1', S1)!.marks[0]).toMatchObject({ at: [100, 200], anchor: { element: 'td' } });
    expect(markupSession('d1', S1)!.undo).toHaveLength(2);
    expect(document.querySelector('[data-testid="design-markup-popover"]')).toBeNull();
    // the next click opens it
    await pin.trigger('click');
    await flushPromises();
    expect(document.querySelector('[data-testid="design-markup-popover"]')).not.toBeNull();
  });

  it('puts a pin back where its mark is when its drag is cancelled or loses capture', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    document.querySelector<HTMLElement>('[data-testid="design-markup-done"]')!.click();
    await flushPromises();
    for (const end of ['pointercancel', 'lostpointercapture']) {
      const pin = pins(wrapper)[0]!;
      await pin.trigger('pointerdown', { button: 0, pointerId: 6, clientX: 350, clientY: 100 });
      await pin.trigger('pointermove', { pointerId: 6, clientX: 50, clientY: 300 });
      expect(canvas(wrapper).classes()).toContain('cursor-grabbing');
      await pin.trigger(end, { pointerId: 6 });
      expect(canvas(wrapper).classes()).not.toContain('cursor-grabbing');
      expect(pin.classes()).not.toContain('cursor-grabbing');
      // a later release of that pointer moves nothing
      await pin.trigger('pointerup', { pointerId: 6, clientX: 50, clientY: 300 });
      expect(markupSession('d1', S1)!.marks[0]).toMatchObject({ at: [700, 200], anchor: { element: 'ui/Table' } });
      expect(markupSession('d1', S1)!.undo).toHaveLength(1);
    }
  });

  it('ends a pin drag when Ctrl+Z changes the marks under it', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    document.querySelector<HTMLElement>('[data-testid="design-markup-done"]')!.click();
    await flushPromises();
    const pin = pins(wrapper)[0]!;
    await pin.trigger('pointerdown', { button: 0, pointerId: 7, clientX: 350, clientY: 100 });
    await pin.trigger('pointermove', { pointerId: 7, clientX: 50, clientY: 300 });
    expect(canvas(wrapper).classes()).toContain('cursor-grabbing');
    await canvas(wrapper).trigger('keydown', { key: 'z', ctrlKey: true });
    await flushPromises();
    expect(pins(wrapper)).toHaveLength(0);
    expect(canvas(wrapper).classes()).not.toContain('cursor-grabbing');
  });

  it('draws a pen stroke from the kept points and commits it once on release', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await chooseTool(wrapper, 'pen');
    const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await canvas(wrapper).trigger('pointerdown', { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
    for (const [x, y] of [[20, 12], [30, 18], [40, 30]]) {
      await canvas(wrapper).trigger('pointermove', { pointerId: 3, clientX: x, clientY: y });
      await frame();
    }
    expect(wrapper.get('[data-testid="design-markup-draft"]').attributes('d')).toMatch(/^M20 20 /);
    await canvas(wrapper).trigger('pointerup', { button: 0, pointerId: 3, clientX: 40, clientY: 30 });
    await flushPromises();
    expect(markupSession('d1', S1)!.marks).toEqual([expect.objectContaining({ type: 'pen', points: [[20, 20], [40, 24], [60, 36], [80, 60]] })]);
    expect(wrapper.find('[data-testid="design-markup-draft"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="design-markup-stroke"]').attributes('data-type')).toBe('pen');
    expect(wrapper.get('[data-testid="design-markup-announcement"]').text()).toBe('Pen stroke added');
  });

  it('counts a long comment in the app\'s language', async () => {
    const { wrapper } = mountTab();
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    await popover().get('textarea').setValue('x'.repeat(3600));
    expect(document.querySelector('[data-testid="design-markup-text-count"]')).toBeNull();
    await popover().get('textarea').setValue('x'.repeat(3601));
    expect(popover().get('[data-testid="design-markup-text-count"]').text()).toBe('3,601 / 4,000');
    shellI18n.global.locale.value = 'el';
    await nextTick();
    expect(popover().get('[data-testid="design-markup-text-count"]').text()).toBe('3.601 / 4.000');
  });

  it('reads Undo as Cmd+Z on macOS', async () => {
    const { wrapper } = mountTab(fakeShellApi(), 'darwin');
    await freeze(wrapper);
    await tap(wrapper, 350, 100);
    document.querySelector<HTMLElement>('[data-testid="design-markup-done"]')!.click();
    await nextTick();
    expect(wrapper.get('[data-testid="design-markup-undo"]').attributes('title')).toBe('Undo (⌘Z)');
    await canvas(wrapper).trigger('keydown', { key: 'z', ctrlKey: true });
    expect(markupSession('d1', S1)!.marks).toHaveLength(1);
    await canvas(wrapper).trigger('keydown', { key: 'z', metaKey: true });
    expect(markupSession('d1', S1)!.marks).toHaveLength(0);
  });
});
