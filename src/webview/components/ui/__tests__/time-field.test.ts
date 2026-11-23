// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { TimeField } from '@/components/ui/time-field';

// The time field (reka TimeFieldRoot): a time typed one segment at a time, written as "HH:mm" when focus leaves the field or on
// Enter, in the hour cycle and language its props name.

const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

async function field(props: { modelValue: string; locale?: string; hourCycle: 12 | 24 }): Promise<VueWrapper> {
  const wrapper = mount(TimeField, { props, attrs: { 'aria-label': 'Starts at' }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const segment = (part: string): HTMLElement => document.querySelector<HTMLElement>(`[data-reka-time-field-segment="${part}"]`)!;
const shown = (): string => [...document.querySelectorAll('[data-reka-time-field-segment]')].map((element) => element.textContent!.trim() || ' ').join('');
const parts = (): (string | null)[] => [...document.querySelectorAll('[data-reka-time-field-segment]')].map((element) => element.getAttribute('data-reka-time-field-segment'));
async function type(part: string, ...keys: string[]): Promise<void> {
  const target = segment(part);
  target.focus();
  for (const key of keys) target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
}
async function leave(): Promise<void> {
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  await flushPromises();
}
const commits = (wrapper: VueWrapper): unknown[] => (wrapper.emitted('commit') ?? []).map(([value]) => value);

describe('TimeField', () => {
  it('is a named group of an hour and a minute segment on a 24-hour clock, with no day period', async () => {
    const wrapper = await field({ modelValue: '07:05', locale: 'en', hourCycle: 24 });
    expect(wrapper.attributes('role')).toBe('group');
    expect(wrapper.attributes('aria-label')).toBe('Starts at');
    expect(shown()).toBe('07:05');
    expect(parts()).toEqual(['hour', 'literal', 'minute']);
    expect(segment('dayPeriod')).toBeNull();
    expect(segment('hour').getAttribute('contenteditable')).toBe('true');
  });

  it('shows a 12-hour clock with the day period in the language it is given', async () => {
    await field({ modelValue: '19:00', locale: 'en', hourCycle: 12 });
    expect(segment('hour').textContent!.trim()).toBe('7');
    expect(segment('dayPeriod').textContent!.trim()).toBe('PM');
    document.body.innerHTML = '';
    await field({ modelValue: '19:00', locale: 'el', hourCycle: 12 });
    expect(segment('hour').textContent!.trim()).toBe('7');
    expect(segment('dayPeriod').textContent!.trim()).toBe('μ.μ.');
    expect(segment('dayPeriod').getAttribute('aria-valuetext')).toBe('μ.μ.');
  });

  it('writes nothing while the segments are typed, and the typed time once when focus leaves the field', async () => {
    const wrapper = await field({ modelValue: '07:00', locale: 'en', hourCycle: 24 });
    await type('hour', '2', '1');
    await type('minute', '3', '0');
    expect(shown()).toBe('21:30');
    expect(commits(wrapper)).toEqual([]);
    await leave();
    expect(commits(wrapper)).toEqual(['21:30']);
  });

  it('does not write when focus moves from one segment to the other', async () => {
    const wrapper = await field({ modelValue: '07:00', locale: 'en', hourCycle: 24 });
    await type('hour', '0', '9');
    segment('minute').focus();
    await flushPromises();
    expect(commits(wrapper)).toEqual([]);
  });

  it('writes on Enter', async () => {
    const wrapper = await field({ modelValue: '07:00', locale: 'en', hourCycle: 24 });
    await type('minute', '4', '5');
    await type('minute', 'Enter');
    expect(commits(wrapper)).toEqual(['07:45']);
  });

  it('keeps the afternoon of a time in a language whose day period is not AM or PM', async () => {
    const wrapper = await field({ modelValue: '19:00', locale: 'el', hourCycle: 12 });
    await type('minute', '1', '5');
    await type('minute', 'Enter');
    expect(commits(wrapper)).toEqual(['19:15']);
  });

  it('writes a 12-hour entry as the 24-hour time it means', async () => {
    const wrapper = await field({ modelValue: '07:00', locale: 'el', hourCycle: 12 });
    await type('hour', '9');
    await type('dayPeriod', 'p');
    await type('dayPeriod', 'Enter');
    expect(commits(wrapper)).toEqual(['21:00']);
  });

  it('steps a segment with the arrow keys and writes the result on blur only', async () => {
    const wrapper = await field({ modelValue: '07:00', locale: 'en', hourCycle: 24 });
    await type('hour', 'ArrowUp', 'ArrowUp');
    expect(commits(wrapper)).toEqual([]);
    await leave();
    expect(commits(wrapper)).toEqual(['09:00']);
  });

  it('writes nothing for an entry with an empty segment, and shows the time it had again', async () => {
    const wrapper = await field({ modelValue: '07:30', locale: 'en', hourCycle: 24 });
    await type('minute', 'Backspace', 'Backspace');
    expect(shown()).not.toBe('07:30');
    await type('minute', 'Enter');
    expect(commits(wrapper)).toEqual([]);
    expect(shown()).toBe('07:30');
    await type('hour', 'Backspace', 'Backspace');
    await leave();
    expect(commits(wrapper)).toEqual([]);
    expect(shown()).toBe('07:30');
  });

  it('writes nothing when the time was not changed', async () => {
    const wrapper = await field({ modelValue: '07:30', locale: 'en', hourCycle: 24 });
    segment('hour').focus();
    await leave();
    expect(commits(wrapper)).toEqual([]);
  });

  it('shows the value its owner gives next, which a typed draft does not outlive', async () => {
    const wrapper = await field({ modelValue: '07:30', locale: 'en', hourCycle: 24 });
    await type('hour', '1', '1');
    await wrapper.setProps({ modelValue: '08:15' });
    await flushPromises();
    expect(shown()).toBe('08:15');
  });
});
