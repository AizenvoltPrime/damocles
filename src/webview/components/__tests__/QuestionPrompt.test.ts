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
});
