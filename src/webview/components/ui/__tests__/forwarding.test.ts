// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, nextTick } from 'vue';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import SelectHost from './fixtures/SelectHost.vue';

/**
 * These wrappers forward props through `definedProps`, a type-driven change to generated
 * pass-through components. This pins the behaviour that matters: defaults still apply when a prop
 * is omitted, explicit values still win, and a selected value still reaches the bound handler.
 */

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

function track<T extends { unmount: () => void }>(w: T): T {
  mounted.push(w);
  return w;
}

describe('Button prop forwarding', () => {
  it("falls back to the component's own `as` default when the prop is omitted", () => {
    const wrapper = track(mount(Button, { slots: { default: 'Go' } }));
    expect(wrapper.element.tagName).toBe('BUTTON');
    expect(wrapper.text()).toBe('Go');
  });

  it('honours an explicit `as`', () => {
    const wrapper = track(mount(Button, { props: { as: 'a' }, slots: { default: 'Go' } }));
    expect(wrapper.element.tagName).toBe('A');
  });

  it('still applies variant classes alongside the forwarded props', () => {
    const wrapper = track(mount(Button, { props: { variant: 'outline' }, slots: { default: 'x' } }));
    expect(wrapper.classes().join(' ')).toContain('border');
  });
});

describe('Switch prop forwarding', () => {
  it('renders unchecked when `checked` is omitted', () => {
    const wrapper = track(mount(Switch));
    expect(wrapper.attributes('data-state')).toBe('unchecked');
  });

  it('renders checked when `checked` is passed', () => {
    const wrapper = track(mount(Switch, { props: { checked: true } }));
    expect(wrapper.attributes('data-state')).toBe('checked');
  });

  it('emits update:checked on click', async () => {
    const wrapper = track(mount(Switch, { props: { checked: false } }));
    await wrapper.trigger('click');
    expect(wrapper.emitted('update:checked')).toEqual([[true]]);
  });

  it('does not emit when disabled', async () => {
    const wrapper = track(mount(Switch, { props: { checked: false, disabled: true } }));
    await wrapper.trigger('click');
    expect(wrapper.emitted('update:checked')).toBeUndefined();
  });
});

describe('Checkbox prop forwarding', () => {
  it('reflects the checked prop and emits a boolean on click', async () => {
    const wrapper = track(mount(Checkbox, { props: { checked: false, id: 'agree' } }));
    expect(wrapper.attributes('id')).toBe('agree');
    await wrapper.trigger('click');
    expect(wrapper.emitted('update:checked')).toEqual([[true]]);
  });
});

describe('Select item forwarding', () => {
  const Host = defineComponent({
    setup() {
      const picked = ref('a');
      const seen = ref<string[]>([]);
      const onPick = (value: string) => {
        seen.value.push(value);
        picked.value = value;
      };
      return { picked, seen, onPick };
    },
    render() {
      return h(
        Select,
        { modelValue: this.picked, 'onUpdate:modelValue': this.onPick },
        () => [
          h(SelectTrigger, () => h(SelectValue, { placeholder: 'pick' })),
          h(SelectContent, () => [
            h(SelectItem, { value: 'a' }, () => 'Alpha'),
            h(SelectItem, { value: 'b' }, () => 'Beta'),
          ]),
        ],
      );
    },
  });

  it('opens and renders every item, so the required `value` still reaches SelectItem', async () => {
    const wrapper = track(mount(Host, { attachTo: document.body }));
    await wrapper.get('[role="combobox"]').trigger('pointerdown', { button: 0, ctrlKey: false });
    await nextTick();
    await nextTick();

    const options = document.querySelectorAll('[role="option"]');
    expect(Array.from(options).map(o => o.textContent?.trim())).toEqual(['Alpha', 'Beta']);
    expect(Array.from(options).map(o => o.getAttribute('data-state'))).toEqual(['checked', 'unchecked']);
  });
});

describe('Select value binding in a compiled template', () => {
  it('delivers the selected value to a handler bound with @update:model-value', async () => {
    const wrapper = track(mount(SelectHost, { attachTo: document.body }));

    wrapper.findComponent(Select).vm.$emit('update:modelValue', 'b');
    await nextTick();

    expect(wrapper.vm.seen).toEqual(['b']);
    expect(wrapper.vm.picked).toBe('b');
  });
});
