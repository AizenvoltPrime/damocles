// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { JourneyStep } from '@shared/types/design';
import { i18n } from '@/i18n';
import JourneyStepText from '../design/JourneyStepText.vue';

const text = (step: JourneyStep): string => mount(JourneyStepText, { props: { step }, global: { plugins: [i18n] } }).text();

describe('JourneyStepText', () => {
  it('says a scroll step and an exact: false target as what they do, never as an exact match', () => {
    expect(text({ action: 'scroll', to: 'end' })).toBe('Scroll the page to its end');
    expect(text({ action: 'scroll', target: { role: 'list', name: 'Results' }, to: 'end' })).toBe('Scroll list “Results” to its end');
    expect(text({ action: 'scroll', target: { text: 'Item 40' } })).toBe('Scroll text “Item 40” into view');
    expect(text({ action: 'click', target: { role: 'button', name: 'save', exact: false } })).toBe('Click button containing “save”');
    expect(text({ action: 'assert', target: { text: 'unread', exact: false }, expect: { visible: true } })).toBe('text containing “unread” is visible');
    expect(text({ action: 'click', target: { role: 'button', name: 'Save' } })).toBe('Click button “Save”');
  });
});
