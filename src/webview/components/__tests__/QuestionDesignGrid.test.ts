// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import type { DesignChatStateView } from '@shared/types/design';
import type { Question } from '@shared/types/permissions';
import QuestionDesignGrid from '../QuestionDesignGrid.vue';
import { useDesignStore } from '@/stores/useDesignStore';
import { i18n } from '@/i18n';

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

interface Posted { type: string; requestId?: string; toolUseId?: string; questionIndex?: number; optionIndex?: number; designId?: string; relPath?: string }

const DESIGN: DesignChatStateView = {
  designId: 'contacts-1a2b3c4d', title: 'Design · Contacts', folder: '/home/u/.damocles/designs/contacts-1a2b3c4d', parentSessionId: 'p1', parentTitle: 'Contacts',
  status: 'draft', version: null, fidelity: 'interactive', ruleSet: 'full', enabled: true, superseded: false, supersededBy: null, decisions: [],
};

const QUESTION: Question = {
  question: 'Which layout?',
  header: 'Layout',
  multiSelect: false,
  options: [
    { label: 'Table', description: 'Dense rows', preview: { kind: 'design', path: 'variants/a/screens/S1.html' } },
    { label: 'Cards', description: 'One card per contact', preview: { kind: 'design', path: 'variants/b/screens/S1.html' } },
    { label: 'Split', description: 'List and detail', preview: { kind: 'design', path: 'variants/c/screens/S1.html' } },
  ],
};

const PNG_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg';

let posted: Posted[] = [];
let pinia: Pinia;
// The page's image cache outlives a test, so each test's prompt has an id of its own.
let run = 0;
const toolUseId = (): string => `q-${run}`;
const mounted: VueWrapper[] = [];

function mountGrid(over: { selected?: ReadonlySet<string>; question?: Question } = {}): VueWrapper {
  const wrapper = mount(QuestionDesignGrid, {
    props: { toolUseId: toolUseId(), questionIndex: 1, question: over.question ?? QUESTION, selected: over.selected ?? new Set<string>() },
    global: { plugins: [i18n, pinia] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

const requests = () => posted.filter((message) => message.type === 'requestDesignPreviewImage');

async function reply(data: Record<string, unknown>): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'designPreviewImage', ...data } }));
  await nextTick();
}

beforeEach(() => {
  run += 1;
  pinia = createPinia();
  setActivePinia(pinia);
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as Posted));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('QuestionDesignGrid on FULL', () => {
  beforeEach(() => {
    useDesignStore().setState(DESIGN, null);
    useDesignStore().setOpenPreview(true);
  });

  it('asks for one thumbnail per option, naming the question and the option, and shows a skeleton until each lands', () => {
    const wrapper = mountGrid();

    expect(requests()).toEqual([0, 1, 2].map((optionIndex) => ({
      type: 'requestDesignPreviewImage', requestId: expect.any(String), toolUseId: toolUseId(), questionIndex: 1, optionIndex,
    })));
    expect(new Set(requests().map((request) => request.requestId)).size).toBe(3);
    expect(wrapper.findAll('[data-testid="question-design-image-loading"]')).toHaveLength(3);
    expect(wrapper.find('[data-testid="question-design-tile"]').exists()).toBe(false);
  });

  it('fills only the option whose request a reply answers, and ignores a reply to no request of its own', async () => {
    const wrapper = mountGrid();
    const second = requests()[1]!.requestId;

    await reply({ requestId: 'someone-else', image: { mimeType: 'image/png', data: PNG_DATA, width: 1280, height: 900 } });
    expect(wrapper.findAll('[data-testid="question-design-image"]')).toHaveLength(0);

    await reply({ requestId: second, image: { mimeType: 'image/png', data: PNG_DATA, width: 1280, height: 900 } });
    const cards = wrapper.findAll('[data-testid="question-design-option"]');
    expect(cards[0]!.find('[data-testid="question-design-image-loading"]').exists()).toBe(true);
    expect(cards[1]!.get('img').attributes('src')).toMatch(/^blob:/);
    expect(cards[1]!.get('img').attributes('alt')).toBe('Cards at the primary width');
    expect(cards[2]!.find('[data-testid="question-design-image-loading"]').exists()).toBe(true);

    // A second reply to an answered request changes nothing.
    await reply({ requestId: second, error: { message: 'No Damocles app is attached to render this design.' } });
    expect(cards[1]!.find('img').exists()).toBe(true);
  });

  it('keeps the image out of every Pinia store', async () => {
    mountGrid();
    for (const request of requests()) await reply({ requestId: request.requestId, image: { mimeType: 'image/png', data: PNG_DATA, width: 1280, height: 900 } });

    expect(JSON.stringify(pinia.state.value)).not.toContain(PNG_DATA);
  });

  it('shows core\'s reason in the card when a thumbnail fails, and a reason of its own when core gave none', async () => {
    const wrapper = mountGrid();
    await reply({ requestId: requests()[0]!.requestId, error: { message: 'No Damocles app is attached to render this design.' } });
    await reply({ requestId: requests()[1]!.requestId, image: { mimeType: 'image/jpeg', data: PNG_DATA, width: 1, height: 1 } });

    const errors = wrapper.findAll('[data-testid="question-design-image-error"]');
    expect(errors.map((error) => error.text())).toEqual(['No Damocles app is attached to render this design.', 'The preview could not be rendered.']);
  });

  it('opens the option\'s variant live in the preview tab', async () => {
    const wrapper = mountGrid();
    const buttons = wrapper.findAll('[data-testid="question-design-open-live"]');

    expect(buttons.map((button) => button.attributes('aria-label'))).toEqual([
      'Open live: Table', 'Open live: Cards', 'Open live: Split',
    ]);
    await buttons[2]!.trigger('click');
    expect(posted.at(-1)).toEqual({ type: 'openDesignPreview', designId: DESIGN.designId, relPath: 'variants/c/screens/S1.html' });
    expect(wrapper.find('[data-testid="question-design-open-browser"]').exists()).toBe(false);
  });

  it('shows the thumbnails it already has when the user comes back to the question, asking only for the ones it lacks', async () => {
    const first = mountGrid();
    await reply({ requestId: requests()[0]!.requestId, image: { mimeType: 'image/png', data: PNG_DATA, width: 1280, height: 900 } });
    await reply({ requestId: requests()[2]!.requestId, image: { mimeType: 'image/png', data: PNG_DATA, width: 1280, height: 900 } });
    const shown = first.findAll('[data-testid="question-design-image"]').map((img) => img.attributes('src'));
    first.unmount();
    mounted.splice(mounted.indexOf(first), 1);

    const again = mountGrid();

    expect(requests().slice(3)).toEqual([expect.objectContaining({ optionIndex: 1 })]);
    expect(again.findAll('[data-testid="question-design-image"]').map((img) => img.attributes('src'))).toEqual(shown);
    expect(again.findAll('[data-testid="question-design-image-loading"]')).toHaveLength(1);
  });

  it('leaves Enter on a card\'s Open live to that button, never continuing the question', async () => {
    const wrapper = mountGrid({ selected: new Set(['Cards']) });
    await flushPromises();
    const openLive = wrapper.findAll('[data-testid="question-design-open-live"]')[1]!;

    (openLive.element as HTMLElement).focus();
    await openLive.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('confirm')).toBeUndefined();
  });

  it('asks again for a new question and drops a reply meant for the old one', async () => {
    const wrapper = mountGrid();
    const old = requests()[0]!.requestId;

    await wrapper.setProps({ questionIndex: 2 });
    expect(requests()).toHaveLength(6);
    expect(requests()[3]).toMatchObject({ questionIndex: 2, optionIndex: 0 });

    await reply({ requestId: old, image: { mimeType: 'image/png', data: PNG_DATA, width: 1280, height: 900 } });
    expect(wrapper.findAll('[data-testid="question-design-image"]')).toHaveLength(0);
  });
});

describe('QuestionDesignGrid on REDUCED', () => {
  beforeEach(() => {
    useDesignStore().setState({ ...DESIGN, ruleSet: 'reduced' }, null);
    useDesignStore().setOpenInBrowser(true);
  });

  it('shows a tile with the file name and asks for no thumbnail', () => {
    const wrapper = mountGrid();

    expect(requests()).toEqual([]);
    expect(wrapper.findAll('[data-testid="question-design-tile"]').map((tile) => tile.text())).toEqual(['S1.html', 'S1.html', 'S1.html']);
    expect(wrapper.findAll('[data-testid="question-design-file"]').map((file) => file.text())).toEqual([
      'variants/a/screens/S1.html', 'variants/b/screens/S1.html', 'variants/c/screens/S1.html',
    ]);
    expect(wrapper.find('[data-testid="question-design-open-live"]').exists()).toBe(false);
  });

  it('opens the option in the browser', async () => {
    const wrapper = mountGrid();

    await wrapper.findAll('[data-testid="question-design-open-browser"]')[0]!.trigger('click');
    expect(posted.at(-1)).toEqual({ type: 'openDesignInBrowser', designId: DESIGN.designId, relPath: 'variants/a/screens/S1.html' });
  });
});

describe('QuestionDesignGrid choice semantics', () => {
  beforeEach(() => useDesignStore().setState(DESIGN, null));

  it('is one radio group whose radios are named by the label and described by the description and file', async () => {
    const wrapper = mountGrid({ selected: new Set(['Cards']) });
    await flushPromises();

    expect(wrapper.findAll('[role="radiogroup"]')).toHaveLength(1);
    expect(wrapper.get('[role="radiogroup"]').attributes('aria-label')).toBe('Which layout?');
    const radios = wrapper.findAll('[role="radio"]');
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual(['false', 'true', 'false']);
    const first = radios[0]!.element;
    expect(document.getElementById(first.getAttribute('aria-labelledby')!)?.textContent).toBe('Table');
    expect(first.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent)).toEqual(['Dense rows', 'variants/a/screens/S1.html']);
    // The checked radio is the one tab stop, and takes focus as the grid mounts.
    expect(radios.map((radio) => radio.attributes('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(document.activeElement).toBe(radios[1]!.element);
  });

  it('chooses with the radio, a click on the card, and the arrow keys, and continues on Enter once one is chosen', async () => {
    const wrapper = mountGrid();
    await flushPromises();

    await wrapper.findAll('[role="radio"]')[0]!.trigger('click');
    await wrapper.findAll('[data-testid="question-design-thumbnail"]')[2]!.trigger('click');
    expect(wrapper.emitted('choose')).toEqual([['Table'], ['Split']]);

    await wrapper.setProps({ selected: new Set(['Split']) });
    const radios = wrapper.findAll('[role="radio"]');
    (radios[2]!.element as HTMLElement).focus();
    await radios[2]!.trigger('keydown', { key: 'ArrowRight' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(radios[0]!.element);
    expect(wrapper.emitted('choose')!.at(-1)).toEqual(['Table']);

    await radios[0]!.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('confirm')).toHaveLength(1);
  });

  it('does not continue on Enter with nothing chosen', async () => {
    const wrapper = mountGrid();
    await flushPromises();

    await wrapper.findAll('[role="radio"]')[0]!.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('confirm')).toBeUndefined();
  });

  it('uses checkboxes in a group, never radios, for a multi-select question', async () => {
    const wrapper = mountGrid({ question: { ...QUESTION, multiSelect: true }, selected: new Set(['Table']) });

    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false);
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Which layout?');
    const boxes = wrapper.findAll('[role="checkbox"]');
    expect(boxes.map((box) => box.attributes('aria-checked'))).toEqual(['true', 'false', 'false']);
    await boxes[1]!.trigger('click');
    expect(wrapper.emitted('toggle')).toEqual([['Cards']]);
  });
});
