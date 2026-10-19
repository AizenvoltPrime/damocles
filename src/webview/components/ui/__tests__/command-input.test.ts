// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { stackLayout } from './list-layout';

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock('@/composables/usePlatformKey', () => ({
  get isMac() {
    return platform.mac;
  },
}));

const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.restoreAllMocks();
  platform.mac = false;
  document.body.innerHTML = '';
});

const VALUES = ['alpha', 'beta', 'gamma'];

/** A filtered Command as ExtensionUiDialog (one pick) and StatsMultiSelect (`multiple`) build it. */
function commandList(multiple = false): { picked: unknown[] } {
  const picked: unknown[] = [];
  const host = defineComponent({
    setup: () => () => h(Command, {
      multiple,
      modelValue: multiple ? [] : '',
      'onUpdate:modelValue': (value: unknown) => picked.push(value),
    }, () => [
      h(CommandInput, { placeholder: 'Filter' }),
      h(CommandList, () => h(CommandGroup, () => VALUES.map((value) => h(CommandItem, { key: value, value }, () => value)))),
    ]),
  });
  mounted.push(mount(host, { attachTo: document.body }));
  return { picked };
}

const input = () => document.querySelector<HTMLInputElement>('input')!;
const highlighted = () => document.querySelector('[data-highlighted]')?.textContent?.trim();

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  input().dispatchEvent(event);
  await flushPromises();
  return event;
}

describe.each([false, true])('CommandInput keys (multiple: %s)', (multiple) => {
  it('leaves Home and End, with or without Shift, to the text field and keeps the highlighted row', async () => {
    commandList(multiple);
    await flushPromises();
    expect(highlighted()).toBe('alpha');
    await press('ArrowDown');
    expect(highlighted()).toBe('beta');

    for (const init of [{}, { shiftKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }]) {
      for (const key of ['Home', 'End']) {
        const event = await press(key, init);
        expect(event.defaultPrevented, `${key} ${JSON.stringify(init)}`).toBe(false);
        expect(highlighted(), `${key} ${JSON.stringify(init)}`).toBe('beta');
      }
    }
    expect(document.activeElement).toBe(input());
  });

  it('moves to the first and last row on Ctrl+Home and Ctrl+End, also with Alt, as VS Code’s quickInput.first and quickInput.last do', async () => {
    commandList(multiple);
    await flushPromises();
    expect(highlighted()).toBe('alpha');

    expect((await press('End', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(highlighted()).toBe('gamma');
    await press('Home', { ctrlKey: true });
    expect(highlighted()).toBe('alpha');
    await press('End', { ctrlKey: true, altKey: true });
    expect(highlighted()).toBe('gamma');
    await press('Home', { ctrlKey: true, altKey: true });
    expect(highlighted()).toBe('alpha');
    expect(document.activeElement).toBe(input());
  });

  it('takes Cmd+Ctrl+Home as the chord only on macOS', async () => {
    commandList(multiple);
    await flushPromises();
    expect(highlighted()).toBe('alpha');
    expect((await press('End', { ctrlKey: true, metaKey: true })).defaultPrevented).toBe(false);
    expect(highlighted()).toBe('alpha');

    platform.mac = true;
    await press('End', { ctrlKey: true, metaKey: true });
    expect(highlighted()).toBe('gamma');
  });

  it('still moves with the arrow keys and picks the highlighted row on Enter', async () => {
    const { picked } = commandList(multiple);
    await flushPromises();
    expect(highlighted()).toBe('alpha');
    expect((await press('ArrowDown')).defaultPrevented).toBe(true);
    await press('ArrowDown');
    expect(highlighted()).toBe('gamma');
    expect((await press('ArrowUp')).defaultPrevented).toBe(true);
    expect(highlighted()).toBe('beta');
    await press('Enter');
    expect(picked.at(-1)).toEqual(multiple ? ['beta'] : 'beta');
  });

  it('pages with PageDown and PageUp as VS Code’s quickInput.pageNext and quickInput.pagePrevious do, stopping at either end', async () => {
    const { picked, list } = pagedList(multiple, [{ values: ROWS }], 100);
    await flushPromises();
    expect(highlighted()).toBe('row 0');

    const steps: Array<[string, string, number]> = [
      ['PageDown', 'row 4', 0],
      ['PageDown', 'row 9', 100],
      ['PageDown', 'row 14', 200],
      ['PageDown', 'row 19', 300],
      ['PageDown', 'row 19', 300],
      ['PageUp', 'row 15', 300],
      ['PageUp', 'row 10', 200],
      ['PageUp', 'row 5', 100],
      ['PageUp', 'row 0', 0],
      ['PageUp', 'row 0', 0],
    ];
    for (const [key, row, scrollTop] of steps) {
      expect((await press(key)).defaultPrevented, key).toBe(true);
      expect([highlighted(), list.scrollTop], `${key} to ${row}`).toEqual([row, scrollTop]);
      expect(highlightedInView(100), `${key} to ${row}`).toBe(true);
    }
    expect(document.activeElement).toBe(input());
    expect(picked).toEqual([]);
  });

  it('counts only the rows the scroll area shows whole, and pages on from a row the arrows reached', async () => {
    const { picked, list } = pagedList(multiple, [{ values: ROWS }], 110);
    await flushPromises();
    await press('ArrowDown');
    await press('PageDown');
    expect([highlighted(), list.scrollTop]).toEqual(['row 4', 0]);
    await press('ArrowDown');
    expect(highlighted()).toBe('row 5');
    await press('PageDown');
    expect([highlighted(), list.scrollTop]).toEqual(['row 10', 110]);
    expect(highlightedInView(110)).toBe(true);
    await press('PageUp');
    expect([highlighted(), list.scrollTop]).toEqual(['row 6', 110]);
    await press('PageUp');
    expect([highlighted(), list.scrollTop]).toEqual(['row 0', 0]);
    await press('ArrowUp');
    expect(highlighted()).toBe('row 0');
    await press('PageDown');
    await press('Enter');
    expect(picked.at(-1)).toEqual(multiple ? ['row 4'] : 'row 4');
  });

  it('pages over group headings, shows a group’s heading when PageUp lands on its first row, and pages through filtered rows', async () => {
    const beans = Array.from({ length: 10 }, (_, index) => `bean ${index}`);
    const { list } = pagedList(multiple, [{ heading: 'Fruit', values: ['apple', 'apricot', 'avocado'] }, { heading: 'Veg', values: beans }], 100);
    await flushPromises();
    expect(highlighted()).toBe('apple');
    await press('PageDown');
    expect([highlighted(), list.scrollTop]).toEqual(['avocado', 0]);
    await press('PageDown');
    expect([highlighted(), list.scrollTop]).toEqual(['bean 4', 100]);
    await press('PageUp');
    expect([highlighted(), list.scrollTop]).toEqual(['bean 0', 80]);
    await press('PageUp');
    expect([highlighted(), list.scrollTop]).toEqual(['apple', 0]);

    input().value = 'bean';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(highlighted()).toBe('bean 0');
    for (const [row, scrollTop] of [['bean 3', 0], ['bean 8', 100], ['bean 9', 120], ['bean 9', 120]] as const) {
      await press('PageDown');
      expect([highlighted(), list.scrollTop]).toEqual([row, scrollTop]);
    }
  });

  it('leaves Shift+PageDown to the text field and takes PageDown with Ctrl or Alt, and with Cmd only on macOS', async () => {
    pagedList(multiple, [{ values: ROWS }], 100);
    await flushPromises();
    expect((await press('PageDown', { shiftKey: true })).defaultPrevented).toBe(false);
    expect(highlighted()).toBe('row 0');
    await press('PageDown', { ctrlKey: true });
    expect(highlighted()).toBe('row 4');
    await press('PageDown', { altKey: true });
    expect(highlighted()).toBe('row 9');
    await press('PageUp', { ctrlKey: true, altKey: true });
    expect(highlighted()).toBe('row 5');
    expect((await press('PageDown', { metaKey: true })).defaultPrevented).toBe(false);
    expect(highlighted()).toBe('row 5');

    platform.mac = true;
    await press('PageDown', { metaKey: true });
    expect(highlighted()).toBe('row 9');
  });
});

const ROWS = Array.from({ length: 20 }, (_, index) => `row ${index}`);

/** A Command whose list scrolls `viewPx` of its rows (20 px each, a heading as tall), laid out by `stackLayout`. */
function pagedList(multiple: boolean, groups: Array<{ heading?: string; values: string[] }>, viewPx: number): { picked: unknown[]; list: HTMLElement } {
  const picked: unknown[] = [];
  const host = defineComponent({
    setup: () => () => h(Command, {
      multiple,
      modelValue: multiple ? [] : '',
      'onUpdate:modelValue': (value: unknown) => picked.push(value),
    }, () => [
      h(CommandInput, { placeholder: 'Filter' }),
      h(CommandList, () => groups.map((group, index) => h(CommandGroup, { key: index, ...(group.heading ? { heading: group.heading } : {}) }, () => group.values.map((value) => h(CommandItem, { key: value, value }, () => value))))),
    ]),
  });
  mounted.push(mount(host, { attachTo: document.body }));
  const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
  stackLayout(list, { viewPx, rowPx: 20, headingPx: 20 });
  return { picked, list };
}

function highlightedInView(viewPx: number): boolean {
  const rect = document.querySelector('[data-highlighted]')!.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= viewPx;
}
