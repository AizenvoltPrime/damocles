// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { LETTER_TONE, type StatusLetter as Letter } from '@shared/scm/status-letter';
import StatusLetter from '../scm/StatusLetter.vue';
import { TONE_TEXT } from '../scm/scm-list';

const LETTERS = Object.keys(LETTER_TONE) as Letter[];

describe('StatusLetter', () => {
  it('draws every letter in one type style, coloured by its own tone', () => {
    for (const letter of LETTERS) {
      const root = mount(StatusLetter, { props: { letter } }).element as HTMLElement;
      expect(root.textContent).toBe(letter);
      expect([...root.classList]).toEqual(['flex', 'w-4', 'shrink-0', 'justify-center', 'text-11', 'font-semibold']);
      expect(root.style.color).toBe(TONE_TEXT[LETTER_TONE[letter]]);
    }
  });

  it('colours R and C as renamed, the tone source control gives them, wherever only the letter is known', () => {
    expect((mount(StatusLetter, { props: { letter: 'R' } }).element as HTMLElement).style.color).toBe('var(--d-success-text)');
    expect((mount(StatusLetter, { props: { letter: 'C' } }).element as HTMLElement).style.color).toBe('var(--d-success-text)');
    expect((mount(StatusLetter, { props: { letter: 'T' } }).element as HTMLElement).style.color).toBe('var(--d-warning-text)');
  });

  it('takes a given tone over the letter\'s, and puts the title and the letter test id where the views read them', () => {
    const wrapper = mount(StatusLetter, { props: { letter: 'M', tone: 'conflict', title: 'Modified', letterTestId: 'scm-letter' }, attrs: { 'data-testid': 'outer' } });
    const root = wrapper.element as HTMLElement;
    expect(root.style.color).toBe(TONE_TEXT.conflict);
    expect(root.getAttribute('title')).toBe('Modified');
    expect(root.dataset['testid']).toBe('outer');
    expect(wrapper.get('[data-testid="scm-letter"]').text()).toBe('M');
  });
});
