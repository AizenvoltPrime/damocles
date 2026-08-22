// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import FormPrompt from '../FormPrompt.vue';
import { useFormStore } from '@/stores/useFormStore';
import { i18n } from '@/i18n';
import type { FormSchema } from '@shared/types/forms';
import { firstEmit } from '@/__tests__/helpers';

function withForm(schema: FormSchema) {
  useFormStore().setForm({ toolUseId: 't1', form: schema });
}

function mountPrompt() {
  return mount(FormPrompt, { props: { visible: true }, attachTo: document.body, global: { plugins: [i18n] } });
}

const submitButton = (wrapper: ReturnType<typeof mountPrompt>) =>
  wrapper.findAll('button').find((b) => b.text() === 'Submit')!;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  document.body.innerHTML = '';
});

describe('FormPrompt — submission', () => {
  it('submits the entered values when Enter is pressed in a text field', async () => {
    withForm({ fields: [{ id: 'name', label: 'Name', type: 'text', selector: '#name' }] });
    const wrapper = mountPrompt();
    await wrapper.vm.$nextTick();
    const input = wrapper.get('#form-field-name');
    await input.setValue('Alexios');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('submit')).toBeTruthy();
    expect(firstEmit(wrapper.emitted('submit'), 'submit')).toEqual({ name: 'Alexios' });
  });

  it('submits when the Submit button is clicked (Enter mirrors this exactly)', async () => {
    withForm({ fields: [{ id: 'name', label: 'Name', type: 'text', selector: '#name' }] });
    const wrapper = mountPrompt();
    await wrapper.vm.$nextTick();
    await wrapper.get('#form-field-name').setValue('X');
    await submitButton(wrapper).trigger('click');
    expect(firstEmit(wrapper.emitted('submit'), 'submit')).toEqual({ name: 'X' });
  });

  it('does NOT submit on Enter inside a textarea (newline preserved)', async () => {
    withForm({ fields: [{ id: 'msg', label: 'Msg', type: 'textarea', selector: '#msg' }] });
    const wrapper = mountPrompt();
    await wrapper.vm.$nextTick();
    await wrapper.get('#form-field-msg').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('submit')).toBeFalsy();
  });

  it('does NOT submit on Enter with an empty required field, and surfaces the error', async () => {
    withForm({ fields: [{ id: 'name', label: 'Name', type: 'text', selector: '#name', required: true }] });
    const wrapper = mountPrompt();
    await wrapper.vm.$nextTick();
    await wrapper.get('#form-field-name').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('submit')).toBeFalsy();
    expect(wrapper.text()).toContain('This field is required.');
  });

  it('ignores Enter while an IME composition is in progress', async () => {
    withForm({ fields: [{ id: 'name', label: 'Name', type: 'text', selector: '#name' }] });
    const wrapper = mountPrompt();
    await wrapper.vm.$nextTick();
    const input = wrapper.get('#form-field-name');
    await input.setValue('x');
    await input.trigger('keydown', { key: 'Enter', isComposing: true });
    expect(wrapper.emitted('submit')).toBeFalsy();
  });

  it('cancels on Escape from within the form', async () => {
    withForm({ fields: [{ id: 'name', label: 'Name', type: 'text', selector: '#name' }] });
    const wrapper = mountPrompt();
    await wrapper.vm.$nextTick();
    await wrapper.get('#form-field-name').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('cancel')).toBeTruthy();
  });
});

describe('FormPrompt — field value emission', () => {
  it('emits a select value', async () => {
    withForm({
      fields: [{ id: 'role', label: 'Role', type: 'select', selector: '#role', options: [{ label: 'Admin', value: 'r1' }, { label: 'Viewer', value: 'r2' }] }],
    });
    const wrapper = mountPrompt();
    await wrapper.vm.$nextTick();
    await wrapper.get('select').setValue('r2');
    await submitButton(wrapper).trigger('click');
    expect(firstEmit(wrapper.emitted('submit'), 'submit')).toEqual({ role: 'r2' });
  });

  it('emits a radio value', async () => {
    withForm({
      fields: [{ id: 'plan', label: 'Plan', type: 'radio', selector: '#plan', options: [{ label: 'Pro', value: 'pro' }, { label: 'Free', value: 'free' }] }],
    });
    const wrapper = mountPrompt();
    await wrapper.vm.$nextTick();
    await wrapper.get('input[type="radio"][value="pro"]').setValue();
    await submitButton(wrapper).trigger('click');
    expect(firstEmit(wrapper.emitted('submit'), 'submit')).toEqual({ plan: 'pro' });
  });

  it('emits a checkbox boolean', async () => {
    withForm({ fields: [{ id: 'tos', label: 'Accept', type: 'checkbox', selector: '#tos' }] });
    const wrapper = mountPrompt();
    await wrapper.vm.$nextTick();
    await wrapper.get('[role="checkbox"]').trigger('click');
    await submitButton(wrapper).trigger('click');
    expect(firstEmit(wrapper.emitted('submit'), 'submit')).toEqual({ tos: true });
  });
});

describe('FormPrompt — focus on appear', () => {
  it('focuses the first field when the form appears', async () => {
    withForm({ fields: [{ id: 'name', label: 'Name', type: 'text', selector: '#name' }] });
    mountPrompt();
    await flush();
    expect(document.activeElement?.id).toBe('form-field-name');
  });

  it('focuses a leading checkbox field (shadcn role=checkbox, not <input>)', async () => {
    withForm({ fields: [{ id: 'agree', label: 'Agree', type: 'checkbox', selector: '#agree' }] });
    mountPrompt();
    await flush();
    expect(document.activeElement?.getAttribute('role')).toBe('checkbox');
  });
});
