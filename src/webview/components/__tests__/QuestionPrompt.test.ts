// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import QuestionPrompt from '../QuestionPrompt.vue';
import SlidingIndicator from '../SlidingIndicator.vue';
import { useQuestionStore } from '@/stores/useQuestionStore';
import type { QuestionOption } from '@shared/types/permissions';
import { i18n } from '@/i18n';

const shiki = vi.hoisted(() => {
  const instance = {
    loadLanguage: vi.fn(async () => undefined),
    loadTheme: vi.fn(async () => undefined),
    codeToHtml: vi.fn(() => '<pre><code><span class="shiki-token">highlighted</span></code></pre>'),
  };
  return { instance, createHighlighter: vi.fn(async () => instance) };
});

vi.mock('shiki', () => ({
  createHighlighter: shiki.createHighlighter,
  bundledLanguages: { typescript: {} },
}));
vi.mock('@/utils/perf', () => ({ perfSpan: () => ({ end: () => undefined }), resourceFields: () => ({ fields: {}, lastEnd: 0 }) }));

const mounted: VueWrapper[] = [];

function questionCard(options: QuestionOption[], multiSelect = false): VueWrapper {
  useQuestionStore().setQuestion({
    toolUseId: 'q-1',
    questions: [{ question: 'Which layout?', header: 'Layout', multiSelect, options }],
  });
  const wrapper = mount(QuestionPrompt, { props: { visible: true }, global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

// The options list focuses its first option a tick after it mounts.
async function settledQuestionCard(options: QuestionOption[], multiSelect = false): Promise<VueWrapper> {
  const wrapper = questionCard(options, multiSelect);
  await flushPromises();
  return wrapper;
}

// Longer than the hover intent, which a pointer crossing a row never rests for.
const rest = async () => {
  vi.advanceTimersByTime(500);
  await nextTick();
};
const markdown = (content: string) => ({ kind: 'markdown' as const, content });
const pane = (wrapper: VueWrapper) => wrapper.get('[data-testid="question-option-preview-body"]');
const optionRows = (wrapper: VueWrapper) => wrapper.findAll('[role="option"]');

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  vi.useRealTimers();
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('the question card', () => {
  it('says how many questions wait behind the one on screen, and nothing when none do', async () => {
    const wrapper = questionCard([{ label: 'Grid', description: '' }, { label: 'List', description: '' }]);
    await nextTick();
    expect(wrapper.get('[data-testid="question-waiting"]').text()).toBe('');

    useQuestionStore().setQuestion({ toolUseId: 'q-2', questions: [{ question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] }] });
    await nextTick();
    expect(wrapper.get('[data-testid="question-waiting"]').text()).toBe('1 more question waiting');
    expect(wrapper.get('[data-testid="question-waiting"]').attributes('aria-live')).toBe('polite');
  });

  it('moves its tab selection with the shared sliding indicator', async () => {
    const wrapper = questionCard([{ label: 'Grid', description: '' }]);
    await nextTick();

    expect(wrapper.findComponent(SlidingIndicator).props('box')).not.toBeNull();
  });

  it('keeps the plain option layout when no option has a preview', () => {
    const wrapper = questionCard([{ label: 'Grid', description: 'rows' }, { label: 'List', description: 'one column' }]);

    expect(wrapper.find('[data-testid="question-option-preview"]').exists()).toBe(false);
    expect(optionRows(wrapper)[0]!.attributes()).not.toHaveProperty('aria-describedby');
  });

  it('renders a markdown preview through Vue, with fenced code highlighted and lists formatted', async () => {
    const content = '- one\n- two\n\n```ts\nconst x = 1;\n```';
    const wrapper = questionCard([{ label: 'Grid', description: '', preview: markdown(content) }, { label: 'List', description: '' }]);
    await flushPromises();

    const body = pane(wrapper);
    expect(body.findAll('ul > li').map((li) => li.text())).toEqual(['one', 'two']);
    expect(shiki.instance.codeToHtml).toHaveBeenCalledWith('const x = 1;', expect.objectContaining({ lang: 'typescript' }));
    expect(body.find('.shiki-token').exists()).toBe(true);
  });

  it('shows HTML in a markdown preview as literal text', async () => {
    const html = '<p style="position: fixed; inset: 0" onclick="alert(1)">Two columns</p><button>Send</button>';
    const wrapper = questionCard([{ label: 'Grid', description: '', preview: markdown(html) }, { label: 'List', description: '' }]);
    await flushPromises();

    const body = pane(wrapper);
    expect(body.findAll('p[style], button, [onclick]')).toHaveLength(0);
    expect(body.text()).toContain(html);
  });

  it('titles the pane and shows the preview of the option the list focuses as it mounts', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('grid preview') },
      { label: 'List', description: '', preview: markdown('list preview') },
      { label: 'Plain', description: '' },
    ]);

    expect(wrapper.get('[data-testid="question-option-preview"]').text()).toContain('Preview');
    expect(wrapper.get('[data-testid="question-option-preview"]').text()).not.toContain('markdown');
    expect(pane(wrapper).text()).toBe('grid preview');
  });

  it('follows the option last hovered or focused, falling back to the focused one over an option without a preview', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('grid preview') },
      { label: 'List', description: '', preview: markdown('list preview') },
      { label: 'Plain', description: '' },
    ]);
    const [grid, list, plain] = optionRows(wrapper);
    vi.useFakeTimers();

    await list!.trigger('pointerover');
    expect(pane(wrapper).text()).toBe('list preview');

    await grid!.trigger('focusin');
    expect(pane(wrapper).text()).toBe('grid preview');

    await list!.trigger('pointerover');
    await plain!.trigger('pointerover');
    await rest();
    expect(pane(wrapper).text()).toBe('grid preview');
  });

  it('moves the hovered preview to another option only once the pointer rests on it, so crossing rows changes nothing', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('grid preview') },
      { label: 'List', description: '', preview: markdown('list preview') },
      { label: 'Split', description: '', preview: markdown('split preview') },
    ]);
    const [grid, list, split] = optionRows(wrapper);
    vi.useFakeTimers();

    await list!.trigger('pointerover');
    await split!.trigger('pointerover');
    await pane(wrapper).trigger('pointerover');
    await rest();
    expect(pane(wrapper).text()).toBe('list preview');

    await grid!.trigger('pointerover');
    await nextTick();
    expect(pane(wrapper).text()).toBe('list preview');
    await rest();
    expect(pane(wrapper).text()).toBe('grid preview');
  });

  it('falls back to the selected option once focus leaves the list', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('grid preview') },
      { label: 'List', description: '', preview: markdown('list preview') },
    ], true);
    useQuestionStore().toggleOption('Which layout?', 'List', true);
    optionRows(wrapper)[0]!.element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    await nextTick();

    expect(pane(wrapper).text()).toBe('list preview');
  });

  it('keeps the preview it shows while focus moves from the option into the pane', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('grid preview') },
      { label: 'List', description: '', preview: markdown('list preview') },
    ]);
    const list = optionRows(wrapper)[1]!;

    const focusOut = async (relatedTarget: Element) => {
      list.element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget }));
      await nextTick();
    };

    await list.trigger('focusin');
    await focusOut(pane(wrapper).element);
    expect(pane(wrapper).text()).toBe('list preview');

    await focusOut(document.body);
    expect(pane(wrapper).text()).toBe('grid preview');
  });

  it('describes each option that has a preview by a short hint, never the preview, and labels the pane by the option it shows', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('grid preview') },
      { label: 'Plain', description: '' },
      { label: 'List', description: '', preview: markdown('list preview') },
    ]);
    const [grid, plain, list] = optionRows(wrapper);

    await list!.trigger('focusin');

    const hintId = list!.attributes('aria-describedby')!;
    expect(document.getElementById(hintId)?.textContent).toBe('Preview available, Tab to read');
    expect(grid!.attributes('aria-describedby')).toBe(hintId);
    expect(plain!.attributes()).not.toHaveProperty('aria-describedby');
    expect(pane(wrapper).text()).toBe('list preview');
    expect(pane(wrapper).element.tagName).toBe('SECTION');
    expect(pane(wrapper).attributes('tabindex')).toBe('0');
    const label = pane(wrapper).attributes('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(label).toEqual(['Preview', 'List']);
    expect(wrapper.get('[role="listbox"]').attributes('aria-label')).toBe('Which layout?');
  });

  it('keeps the hovered option\'s preview while the pointer crosses the Other row or rests in the pane, until it leaves both', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('grid preview') },
      { label: 'List', description: '', preview: markdown('list preview') },
    ]);
    const list = optionRows(wrapper)[1]!;
    const other = wrapper.findAll('[role="option"]').find((row) => !row.attributes('data-option-label'))!;
    vi.useFakeTimers();
    const grid = wrapper.get('[data-testid="question-options"]').element;

    await list.trigger('pointerover');
    await other.trigger('pointerover');
    await rest();
    expect(pane(wrapper).text()).toBe('list preview');

    // The list's own pointerleave fires on the way into the pane, which sits beside or below it.
    list.element.closest('[role="listbox"]')!.dispatchEvent(new PointerEvent('pointerleave'));
    await pane(wrapper).trigger('pointerover');
    expect(pane(wrapper).text()).toBe('list preview');

    grid.dispatchEvent(new PointerEvent('pointerleave'));
    await nextTick();
    expect(pane(wrapper).text()).toBe('grid preview');
  });

  it('keeps the preview it shows once focus enters the pane, whatever the pointer does, and lets go when focus leaves list and pane', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('grid preview') },
      { label: 'List', description: '', preview: markdown('list preview') },
    ]);
    const list = optionRows(wrapper)[1]!;
    const grid = wrapper.get('[data-testid="question-options"]').element;

    await list.trigger('pointerover');
    (pane(wrapper).element as HTMLElement).focus();
    await nextTick();
    grid.dispatchEvent(new PointerEvent('pointerleave'));
    await nextTick();
    expect(pane(wrapper).text()).toBe('list preview');

    pane(wrapper).element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: optionRows(wrapper)[0]!.element }));
    await nextTick();
    expect(pane(wrapper).text()).toBe('list preview');

    pane(wrapper).element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    await nextTick();
    expect(pane(wrapper).text()).toBe('grid preview');
  });

  it('holds the pane at one height whichever option it shows, so hovering never resizes the dock', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('short') },
      { label: 'List', description: '', preview: markdown(Array.from({ length: 80 }, (_, i) => `- line ${i}`).join('\n')) },
    ]);
    const box = wrapper.get('[data-testid="question-option-preview"]');
    expect(box.classes()).toContain('h-72');
    expect(pane(wrapper).classes()).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-auto']));
    expect(pane(wrapper).classes().some((name) => name.startsWith('max-h-'))).toBe(false);
  });

  it('shows the pane for a multi-select question, checks options without leaving the tab, and annotates each chosen preview', async () => {
    const wrapper = await settledQuestionCard([
      { label: 'Grid', description: '', preview: markdown('grid preview') },
      { label: 'List', description: '', preview: markdown('list preview') },
      { label: 'Plain', description: '' },
    ], true);
    const [, list, plain] = optionRows(wrapper);

    await list!.trigger('pointerover');
    expect(pane(wrapper).text()).toBe('list preview');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    await plain!.trigger('click');
    await list!.trigger('click');
    await nextTick();

    expect(useQuestionStore().currentTabIndex).toBe(0);
    expect(useQuestionStore().currentSelections).toEqual(new Set(['Grid', 'Plain', 'List']));
    expect(useQuestionStore().compiledAnnotations).toEqual({
      'Which layout?': { previews: { Grid: markdown('grid preview'), List: markdown('list preview') } },
    });
  });
});

describe('the question card with design previews', () => {
  const design = (path: string) => ({ kind: 'design' as const, path });
  const OPTIONS: QuestionOption[] = [
    { label: 'Table', description: 'Dense rows', preview: design('variants/a/screens/S1.html') },
    { label: 'Cards', description: 'One card per contact', preview: design('variants/b/screens/S1.html') },
    { label: 'Split', description: 'List and detail', preview: design('variants/c/screens/S1.html') },
  ];

  it('shows a grid of option cards in one radio group instead of the option list', async () => {
    const wrapper = await settledQuestionCard(OPTIONS);

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="question-option-preview"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="radiogroup"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="question-design-option"]')).toHaveLength(3);
  });

  it('keeps a choice on its tab, so a user can compare, and continues with Next', async () => {
    const wrapper = await settledQuestionCard(OPTIONS);
    const next = wrapper.get('[data-testid="question-design-next"]');
    expect(next.attributes('disabled')).toBeDefined();

    await wrapper.findAll('[role="radio"]')[1]!.trigger('click');
    expect(useQuestionStore().currentTabIndex).toBe(0);
    expect(useQuestionStore().currentSelections).toEqual(new Set(['Cards']));
    expect(wrapper.get('[data-option-label="Cards"]').attributes('data-checked')).toBe('true');

    await next.trigger('click');
    expect(useQuestionStore().isOnSubmitTab).toBe(true);
    expect(useQuestionStore().compiledAnnotations).toEqual({ 'Which layout?': { preview: design('variants/b/screens/S1.html') } });
  });

  it('opens the custom answer from the grid', async () => {
    const wrapper = await settledQuestionCard(OPTIONS);

    await wrapper.get('[data-testid="question-design-other"]').trigger('click');
    expect(useQuestionStore().isCustomInputMode).toBe(true);
  });

  it('takes the focus a notification asks for on the tab stop of the radio group', async () => {
    const { focusDockPrompt } = await import('@/composables/useDockPrompt');
    const wrapper = await settledQuestionCard(OPTIONS);
    const split = wrapper.findAll('[role="radio"]')[2]!;
    (split.element as HTMLElement).focus();
    await split.trigger('click');
    (document.activeElement as HTMLElement | null)?.blur();

    focusDockPrompt(wrapper.get('[data-testid="question-card"]').element as HTMLElement);
    expect(document.activeElement).toBe(wrapper.findAll('[role="radio"]')[2]!.element);
  });

  it('takes the focus a notification asks for on the first radio when the grid mounted while the user typed and nothing is chosen', async () => {
    const { focusDockPrompt } = await import('@/composables/useDockPrompt');
    const composer = document.body.appendChild(document.createElement('textarea'));
    composer.focus();
    const wrapper = await settledQuestionCard(OPTIONS);
    expect(document.activeElement).toBe(composer);
    expect(wrapper.findAll('[role="radio"]').map((radio) => radio.attributes('tabindex'))).not.toContain('0');

    focusDockPrompt(wrapper.get('[data-testid="question-card"]').element as HTMLElement);
    expect(document.activeElement).toBe(wrapper.findAll('[role="radio"]')[0]!.element);
  });

  it('chooses with a digit key and stays on the tab, as the radios do', async () => {
    const wrapper = await settledQuestionCard(OPTIONS);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    await nextTick();

    expect(useQuestionStore().currentTabIndex).toBe(0);
    expect(useQuestionStore().currentSelections).toEqual(new Set(['Cards']));
    expect(wrapper.get('[data-option-label="Cards"]').attributes('data-checked')).toBe('true');
  });

  it('uses checkboxes for a multi-select question, toggled by click and digit on the tab, and annotates each chosen screen', async () => {
    const wrapper = await settledQuestionCard(OPTIONS, true);
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="checkbox"]')).toHaveLength(3);

    await wrapper.findAll('[role="checkbox"]')[0]!.trigger('click');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }));
    await nextTick();
    expect(useQuestionStore().currentTabIndex).toBe(0);
    expect(useQuestionStore().currentSelections).toEqual(new Set(['Table', 'Split']));
    expect(wrapper.findAll('[data-testid="question-design-option"]').map((card) => card.attributes('data-checked'))).toEqual(['true', undefined, 'true']);

    await wrapper.get('[data-testid="question-design-next"]').trigger('click');
    expect(useQuestionStore().isOnSubmitTab).toBe(true);
    expect(useQuestionStore().compiledAnnotations).toEqual({
      'Which layout?': { previews: { Table: design('variants/a/screens/S1.html'), Split: design('variants/c/screens/S1.html') } },
    });
  });
});
