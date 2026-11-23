// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchField from '../search/SearchField.vue';
import { shellI18n } from '../i18n';

const render = (invalid: boolean) => mount(SearchField, {
  props: { modelValue: '', label: 'Files to include', maxlength: 100, testid: 'include', isMac: false, invalid },
  global: { plugins: [shellI18n] },
});
const borders = (invalid: boolean): string[] => render(invalid).classes().filter((name) => /(^|:)border-\(/.test(name));

describe('SearchField', () => {
  it('keeps the danger border on an invalid field while it has focus: one border color class per state', () => {
    expect(borders(true)).toEqual(['border-(--d-danger-fill)']);
    expect(borders(false).sort()).toEqual(['border-(--d-border2)', 'focus-within:border-(--d-accent-fill)']);
  });
});
