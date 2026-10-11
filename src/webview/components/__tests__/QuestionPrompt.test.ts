// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import QuestionPrompt from '../QuestionPrompt.vue';
import SlidingIndicator from '../SlidingIndicator.vue';
import { useQuestionStore } from '@/stores/useQuestionStore';
import type { QuestionOption } from '@shared/types/permissions';
import { i18n } from '@/i18n';

const mounted: VueWrapper[] = [];

function questionCard(options: QuestionOption[]): VueWrapper {
  useQuestionStore().setQuestion({
    toolUseId: 'q-1',
    questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options }],
  });
  const wrapper = mount(QuestionPrompt, { props: { visible: true }, global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('the question card', () => {
  it('moves its tab selection with the shared sliding indicator', async () => {
    const wrapper = questionCard([{ label: 'Grid', description: '' }]);
    await nextTick();

    expect(wrapper.findComponent(SlidingIndicator).props('box')).not.toBeNull();
  });

  it('shows a model-written preview without its styles or class names, so it cannot restyle or cover the panel', async () => {
    // happy-dom's node iterator skips the node after a removed one, so the style tag comes last.
    const preview = '<p style="position: fixed; inset: 0" class="fixed inset-0">Two columns</p><style>body { display: none }</style>';
    const wrapper = questionCard([{ label: 'Grid', description: '', preview }]);

    await wrapper.get('button[aria-pressed]').trigger('click');

    const shown = wrapper.get('[data-testid="question-option-preview"]');
    expect(shown.find('style').exists()).toBe(false);
    expect(shown.get('p').attributes()).not.toHaveProperty('style');
    expect(shown.get('p').attributes()).not.toHaveProperty('class');
    expect(shown.text()).toBe('Two columns');
  });

  it('strips event handlers from a model-written preview', async () => {
    const wrapper = questionCard([{ label: 'Grid', description: '', preview: '<img src=x onerror="alert(1)">' }]);

    await wrapper.get('button[aria-pressed]').trigger('click');

    const img = wrapper.get('[data-testid="question-option-preview"] img');
    expect(img.attributes()).not.toHaveProperty('onerror');
  });

  it.each(['<form action="https://example.com">Send</form>', '<input value="Send">', '<button>Send</button>', '<textarea>Send</textarea>', '<select><option>Send</option></select>'])(
    'shows a model-written preview without controls, so it cannot draw a working form or button (%s)',
    async (control) => {
      const wrapper = questionCard([{ label: 'Grid', description: '', preview: `<p>Two columns</p>${control}<p>End</p>` }]);

      await wrapper.get('button[aria-pressed]').trigger('click');

      const shown = wrapper.get('[data-testid="question-option-preview"]');
      expect(shown.findAll('form, input, button, textarea, select')).toHaveLength(0);
      expect(shown.findAll('p')).toHaveLength(2);
    },
  );
});
