// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { convertToHsb, normalizeColor } from 'reka-ui';
import { canonicalHexColor, type HexColor } from '@shared/hex-color';
import { ColorPicker } from '@/components/ui/color-picker';

const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const CANONICAL = /^#[0-9a-f]{8}$/;
const hex = (text: string): HexColor => canonicalHexColor(text)!;

// reka's slider thumb learns its index a render after mounting, so a key before then moves nothing.
async function picker(modelValue: string): Promise<VueWrapper> {
  const wrapper = mount(ColorPicker, {
    props: {
      modelValue: hex(modelValue),
      areaLabel: 'Area name',
      areaThumbLabel: 'Sat and bri',
      hueLabel: 'Hue name',
      opacityLabel: 'Opacity name',
      hexLabel: 'Hex name',
      previewLabel: 'Preview name',
      areaValueText: (saturation: number, brightness: number) => `S ${saturation} B ${brightness}`,
      hueValueText: (degrees: number) => `${degrees} deg`,
      opacityValueText: (percent: number) => `${percent} pct`,
    },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const slider = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`)!;
const areaThumb = (): HTMLElement => slider('Sat and bri');
const hexInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>('input[aria-label="Hex name"]')!;
const key = (target: Element, type: 'keydown' | 'keyup', name: string, init: KeyboardEventInit = {}): void => {
  target.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init }));
};
async function press(target: HTMLElement, name: string, init: KeyboardEventInit = {}): Promise<void> {
  target.focus();
  key(target, 'keydown', name, init);
  key(target, 'keyup', name, init);
  await flushPromises();
}
const drafts = (wrapper: VueWrapper): unknown[] => (wrapper.emitted('update:modelValue') ?? []).map(([value]) => value);
const commits = (wrapper: VueWrapper): unknown[] => (wrapper.emitted('commit') ?? []).map(([value]) => value);
const hueOf = (value: unknown): number => convertToHsb(normalizeColor(String(value))).h;

async function typeHex(text: string): Promise<void> {
  const input = hexInput();
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

async function enterHex(text: string): Promise<void> {
  await typeHex(text);
  await press(hexInput(), 'Enter');
}

describe('ColorPicker', () => {
  it('names every control and its value from its props, with none of reka-ui\'s English role descriptions', async () => {
    await picker('#ff0000ff');
    expect(areaThumb().getAttribute('aria-valuetext')).toBe('S 100 B 100');
    expect(slider('Hue name').getAttribute('aria-valuetext')).toBe('0 deg');
    expect(slider('Opacity name').getAttribute('aria-valuetext')).toBe('100 pct');
    expect(hexInput().value).toBe('#ff0000');
    expect(document.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Preview name');
    expect(document.querySelector('[aria-roledescription]')).toBeNull();
  });

  it('names the area\'s group and gives its pointer surface no unnamed application role', async () => {
    await picker('#ff0000ff');
    const group = areaThumb().closest('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('Area name');
    expect(document.querySelector('[role="application"]')).toBeNull();
  });

  it('moves brightness and saturation by arrow key, as a draft, and commits on keyup', async () => {
    const wrapper = await picker('#ff000080');
    const area = areaThumb();
    area.focus();
    key(area, 'keydown', 'ArrowDown');
    await flushPromises();
    expect(drafts(wrapper)).toEqual(['#fc000080']);
    expect(commits(wrapper)).toEqual([]);
    key(area, 'keyup', 'ArrowDown');
    expect(commits(wrapper)).toEqual(['#fc000080']);
    await press(area, 'ArrowLeft');
    expect(area.getAttribute('aria-valuetext')).toBe('S 99 B 99');
    expect(commits(wrapper)).toHaveLength(2);
    expect(commits(wrapper).every((value) => CANONICAL.test(String(value)))).toBe(true);
  });

  it('takes the area\'s saturation to its ends with Home and End, as the sliders do', async () => {
    const wrapper = await picker('#ff8080ff');
    await press(areaThumb(), 'Home');
    expect(areaThumb().getAttribute('aria-valuetext')).toBe('S 0 B 100');
    await press(areaThumb(), 'End');
    expect(areaThumb().getAttribute('aria-valuetext')).toBe('S 100 B 100');
    expect(commits(wrapper)).toEqual(['#ffffffff', '#ff0000ff']);
  });

  it('keeps a hue picked on a gray when the area moves, and paints the area in that hue', async () => {
    const wrapper = await picker('#808080ff');
    await press(slider('Hue name'), 'PageUp');
    await press(slider('Hue name'), 'PageUp');
    expect(slider('Hue name').getAttribute('aria-valuetext')).toBe('20 deg');
    expect(document.querySelector<HTMLElement>('[data-color-area]')!.style.backgroundColor).toBe('rgb(255, 85, 0)');
    await press(areaThumb(), 'ArrowRight', { shiftKey: true });
    expect(slider('Hue name').getAttribute('aria-valuetext')).toBe('20 deg');
    expect(areaThumb().getAttribute('aria-valuetext')).toBe('S 10 B 50');
    expect(Math.abs(hueOf(commits(wrapper).at(-1)) - 20)).toBeLessThan(3);
  });

  it('keeps saturation at black, through the area and a hex blur, so brightness comes back in the same color', async () => {
    const wrapper = await picker('#ff0000ff');
    for (let index = 0; index < 10; index++) await press(areaThumb(), 'PageDown');
    expect(areaThumb().getAttribute('aria-valuetext')).toBe('S 100 B 0');
    hexInput().focus();
    hexInput().dispatchEvent(new FocusEvent('blur'));
    await flushPromises();
    await press(areaThumb(), 'ArrowUp');
    expect(areaThumb().getAttribute('aria-valuetext')).toBe('S 100 B 1');
    expect(commits(wrapper).at(-1)).toBe('#030000ff');
    await enterHex('#000000');
    expect(areaThumb().getAttribute('aria-valuetext')).toBe('S 100 B 0');
  });

  it('commits nothing and keeps the hue when the hex field loses focus with its text unchanged', async () => {
    const wrapper = await picker('#808080ff');
    await press(slider('Hue name'), 'PageUp');
    const before = commits(wrapper).length;
    await typeHex('#808080');
    hexInput().dispatchEvent(new FocusEvent('blur'));
    await flushPromises();
    expect(commits(wrapper)).toHaveLength(before);
    expect(slider('Hue name').getAttribute('aria-valuetext')).toBe('10 deg');
  });

  it('commits a held key\'s repeats once, with the last value', async () => {
    const wrapper = await picker('#ff0000ff');
    const hue = slider('Hue name');
    hue.focus();
    for (let index = 0; index < 3; index++) {
      key(hue, 'keydown', 'ArrowRight');
      await flushPromises();
    }
    expect(hue.getAttribute('aria-valuetext')).toBe('3 deg');
    expect(commits(wrapper)).toEqual([]);
    key(hue, 'keyup', 'ArrowRight');
    expect(commits(wrapper)).toEqual([drafts(wrapper).at(-1)]);
    expect(commits(wrapper)[0]).toMatch(CANONICAL);
  });

  it('commits a held key\'s moves when the window loses focus before its keyup, and later moves commit again', async () => {
    const wrapper = await picker('#ff0000ff');
    const hue = slider('Hue name');
    hue.focus();
    key(hue, 'keydown', 'ArrowRight');
    await flushPromises();
    window.dispatchEvent(new Event('blur'));
    expect(commits(wrapper)).toEqual(['#ff0400ff']);
    const area = document.querySelector<HTMLElement>('[data-color-area]')!;
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 100 }));
    Object.assign(area, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
    area.dispatchEvent(new PointerEvent('pointerdown', { clientX: 50, clientY: 50, bubbles: true, cancelable: true }));
    area.dispatchEvent(new PointerEvent('pointerup', { clientX: 50, clientY: 50, bubbles: true }));
    await flushPromises();
    expect(commits(wrapper)).toHaveLength(2);
  });

  it('commits a held key\'s moves when focus leaves the picker before its keyup', async () => {
    const wrapper = await picker('#ff0000ff');
    const outside = document.createElement('button');
    document.body.append(outside);
    const hue = slider('Hue name');
    hue.focus();
    key(hue, 'keydown', 'ArrowRight');
    await flushPromises();
    hue.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    expect(commits(wrapper)).toEqual(['#ff0400ff']);
  });

  it('sets opacity from the keyboard and keeps full opacity as eight digits', async () => {
    const wrapper = await picker('#00ff00ff');
    await press(slider('Opacity name'), 'Home');
    expect(commits(wrapper)).toEqual(['#00ff0000']);
    await press(slider('Opacity name'), 'End');
    expect(commits(wrapper)).toEqual(['#00ff0000', '#00ff00ff']);
  });

  it('commits a typed hex on Enter, in canonical form, with six digits meaning full opacity', async () => {
    const wrapper = await picker('#ff0000ff');
    await typeHex('#00FF0080');
    expect(commits(wrapper)).toEqual([]);
    await press(hexInput(), 'Enter');
    expect(commits(wrapper)).toEqual(['#00ff0080']);
    expect(hexInput().value).toBe('#00ff0080');
    expect(slider('Opacity name').getAttribute('aria-valuetext')).toBe('50 pct');
    await typeHex('0000ff');
    hexInput().dispatchEvent(new FocusEvent('blur'));
    await flushPromises();
    expect(commits(wrapper)).toEqual(['#00ff0080', '#0000ffff']);
    expect(hexInput().value).toBe('#0000ff');
  });

  it('takes pasted hex with surrounding spaces whole', async () => {
    const wrapper = await picker('#ff0000ff');
    await enterHex('  #00808099  ');
    expect(commits(wrapper)).toEqual(['#00808099']);
  });

  it('steps the sliders from a typed hex close to the current color, never from the value before it', async () => {
    const wrapper = await picker('#ff0000ff');
    await enterHex('#ff0a00fc');
    expect(slider('Hue name').getAttribute('aria-valuetext')).toBe('2 deg');
    await press(slider('Hue name'), 'ArrowRight');
    expect(slider('Hue name').getAttribute('aria-valuetext')).toBe('3 deg');
    await press(slider('Opacity name'), 'ArrowLeft');
    expect(slider('Opacity name').getAttribute('aria-valuetext')).toBe('98 pct');
    expect(commits(wrapper).at(-1)).toBe('#ff0d00fa');
  });

  it('refuses a hex that is not six or eight digits and puts the current color back', async () => {
    const wrapper = await picker('#ff0000ff');
    for (const text of ['#abc', 'rgb(0, 0, 255)', '#00ff00f', 'red']) {
      await enterHex(text);
      expect(hexInput().value).toBe('#ff0000');
    }
    expect(commits(wrapper)).toEqual([]);
    expect(drafts(wrapper)).toEqual([]);
  });

  it('commits nothing a blur would after Escape, typed hex included, until the next key', async () => {
    const wrapper = await picker('#ff0000ff');
    await typeHex('#00ff00');
    key(hexInput(), 'keydown', 'Escape');
    hexInput().dispatchEvent(new FocusEvent('blur'));
    await flushPromises();
    expect(commits(wrapper)).toEqual([]);
    expect(drafts(wrapper)).toEqual([]);
    await enterHex('#0000ff');
    expect(commits(wrapper)).toEqual(['#0000ffff']);
  });

  it('follows a modelValue set from outside without committing it, and commits a return to the old value', async () => {
    const wrapper = await picker('#ff0000ff');
    await wrapper.setProps({ modelValue: hex('#0000ffff') });
    await flushPromises();
    expect(hexInput().value).toBe('#0000ff');
    expect(slider('Hue name').getAttribute('aria-valuetext')).toBe('240 deg');
    expect(commits(wrapper)).toEqual([]);
    await enterHex('#ff0000');
    expect(commits(wrapper)).toEqual(['#ff0000ff']);
  });

  it('writes drafts while the area is dragged and commits once, on release', async () => {
    const wrapper = await picker('#ff0000ff');
    const area = document.querySelector<HTMLElement>('[data-color-area]')!;
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 100 }));
    Object.assign(area, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
    area.dispatchEvent(new PointerEvent('pointerdown', { clientX: 50, clientY: 50, bubbles: true, cancelable: true }));
    await flushPromises();
    area.dispatchEvent(new PointerEvent('pointermove', { clientX: 25, clientY: 25, bubbles: true }));
    await flushPromises();
    expect(drafts(wrapper)).toHaveLength(2);
    expect(commits(wrapper)).toEqual([]);
    area.dispatchEvent(new PointerEvent('pointerup', { clientX: 25, clientY: 25, bubbles: true }));
    await flushPromises();
    expect(commits(wrapper)).toEqual(['#bf8f8fff']);
    expect(drafts(wrapper).at(-1)).toBe('#bf8f8fff');
  });
});
