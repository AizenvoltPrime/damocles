// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { DesignChatStateView } from '@shared/types/design';
import type { ImageBlock } from '@shared/types/content';
import type { ChatMessage } from '@shared/types/session';
import { designMarkupView, type DesignMarkupNote, type MarkupJsonInput } from '@shared/design-markup';
import { i18n } from '@/i18n';
import { useDesignStore } from '@/stores/useDesignStore';
import MarkupMessage from '../MarkupMessage.vue';
import UserMessageBlock from '../../UserMessageBlock.vue';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const DESIGN: DesignChatStateView = {
  designId: 'contacts-1a2b3c4d', title: 'Design · Contacts', folder: '/home/u/.damocles/designs/contacts-1a2b3c4d', parentSessionId: 'parent-1', parentTitle: 'Contacts',
  status: 'draft', version: null, fidelity: 'static', ruleSet: 'full', enabled: true, superseded: false, supersededBy: null, decisions: [],
};

const IMAGE: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };

// The markup as the shell sends it; core keeps its view on the message (`designMarkupView`) and writes the prompt text for the model.
const MARKUP: MarkupJsonInput = {
  screen: 'S1',
  file: 'screens/S1-contacts.html',
  viewport: { breakpoint: 'xl', width: 1280 },
  zoom: 1,
  pixelRatio: 2,
  state: 'default',
  marks: [
    { type: 'pin', n: 1, kind: 'change', text: 'Make the rows denser', at: [10, 20], anchor: { element: 'ui/Table: rows', facts: [] } },
    { type: 'pin', n: 2, kind: 'note', text: 'Keep: this spacing', at: [30, 40], anchor: null },
    { type: 'box', bbox: [0, 0, 100, 50], anchors: ['ui/Button', 'ui/Table'] },
    { type: 'pen', bbox: [0, 0, 10, 10], anchors: [] },
  ],
};
const NOTE: DesignMarkupNote = { feedbackId: 'F1', markup: designMarkupView(MARKUP) };
const CONTENT = 'Markup F1 on screens/S1-contacts.html at xl · 1280 · default:\nPin 1 (change) on ui/Table: rows: Make the rows denser';

const mounted: VueWrapper[] = [];
beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  useDesignStore().setState(DESIGN, null);
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  i18n.global.locale.value = 'en';
});

function card(note: DesignMarkupNote = NOTE, image: ImageBlock | undefined = IMAGE, content = CONTENT): VueWrapper {
  const wrapper = mount(MarkupMessage, { props: { note, content, image }, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

describe('the markup message card', () => {
  it('shows the image, where it was drawn, one row per mark and the counts, from the markup itself', () => {
    const wrapper = card();
    expect(wrapper.get('[data-testid="markup-message"]').attributes('aria-label')).toBe('Markup F1 sent to the designer');
    expect(wrapper.text()).toContain('Markup F1');
    expect(wrapper.text()).toContain('2 pins · 2 strokes');
    expect(wrapper.findAll('[data-testid="markup-message-where"] span').map((part) => part.text())).toEqual(['screens/S1-contacts.html', 'xl · 1280 px']);
    expect(wrapper.get('img').attributes('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(wrapper.get('img').attributes('alt')).toBe('Marked-up preview F1');

    const rows = wrapper.findAll('[data-testid="markup-message-mark"]');
    expect(rows.map((row) => row.attributes('data-kind'))).toEqual(['change', 'note', 'box', 'pen']);
    // An element name that holds ": " stays whole; only the core's text format could split it.
    expect(rows[0]!.text()).toBe('1Pin 1, changeui/Table: rowsMake the rows denser');
    expect(rows[1]!.text()).toBe('2Pin 2, noteno elementKeep: this spacing');
    expect(rows[2]!.text()).toBe('Boxui/Button, ui/Table');
    expect(rows[3]!.text()).toBe('Pen strokeno element');
  });

  it('names its list of marks and words "no element" in the view\'s language', async () => {
    const wrapper = card();
    expect(wrapper.get('[data-testid="markup-message-marks"]').attributes('aria-label')).toBe('Marks of F1');

    i18n.global.locale.value = 'el';
    await nextTick();
    expect(wrapper.findAll('[data-testid="markup-message-mark"]')[1]!.text()).toContain('κανένα στοιχείο');
    expect(wrapper.text()).not.toContain('no element');
  });

  it('names a state other than the default where it was drawn', () => {
    const wrapper = card({ feedbackId: 'F2', markup: designMarkupView({ ...MARKUP, state: 'empty' }) });
    expect(wrapper.findAll('[data-testid="markup-message-where"] span').map((part) => part.text())).toEqual(['screens/S1-contacts.html', 'xl · 1280 px · state empty']);
  });

  it('shows the text of a markup an earlier build sent without its marks', () => {
    const wrapper = card({ feedbackId: 'F1' });
    expect(wrapper.find('[data-testid="markup-message-marks"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="markup-message-text"]').text()).toBe('Pin 1 (change) on ui/Table: rows: Make the rows denser');
  });

  it('opens F1.png and F1.json of the chat\'s own design through openDesignFile', async () => {
    const wrapper = card();
    const files = wrapper.findAll('[data-testid="markup-message-file"]');
    expect(files.map((file) => file.text())).toEqual(['F1.png', 'F1.json']);
    await files[0]!.trigger('click');
    await files[1]!.trigger('click');
    expect(posted).toEqual([
      { type: 'openDesignFile', designId: 'contacts-1a2b3c4d', file: 'feedback/F1.png' },
      { type: 'openDesignFile', designId: 'contacts-1a2b3c4d', file: 'feedback/F1.json' },
    ]);
  });

  it('omits a zero count', () => {
    const wrapper = card({ feedbackId: 'F2', markup: designMarkupView({ ...MARKUP, marks: [{ type: 'arrow', bbox: [0, 0, 1, 1], anchors: ['ui/Button'] }] }) });
    expect(wrapper.text()).toContain('1 stroke');
    expect(wrapper.text()).not.toContain('pin');
    expect(wrapper.findAll('[data-testid="markup-message-mark"]').map((row) => row.attributes('data-kind'))).toEqual(['arrow']);
  });

  it('opens the lightbox from the image', async () => {
    const wrapper = card();
    await wrapper.get('[data-testid="markup-message-image"]').trigger('click');
    expect(wrapper.emitted('openLightbox')).toEqual([[IMAGE]]);
  });
});

describe('a user message carrying designMarkup', () => {
  const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
    id: 'u1', role: 'user', content: CONTENT, contentBlocks: [{ type: 'text', text: CONTENT }, IMAGE], timestamp: 1_700_000_000_000, promptIndex: 0, ...overrides,
  });
  const block = (chat: ChatMessage): VueWrapper => {
    const wrapper = mount(UserMessageBlock, { props: { message: chat, messageIndex: 0, canRewind: true, promptIndex: 0 }, global: { plugins: [i18n] } });
    mounted.push(wrapper);
    return wrapper;
  };

  it('renders the card in place of the text and the image chip, live and replayed alike', () => {
    for (const chat of [message({ designMarkup: NOTE }), message({ designMarkup: NOTE, isReplay: true })]) {
      const wrapper = block(chat);
      expect(wrapper.find('[data-testid="markup-message"]').exists()).toBe(true);
      expect(wrapper.findAll('[data-testid="markup-message-mark"]')).toHaveLength(4);
      expect(wrapper.text()).not.toContain('Markup F1 on screens/S1-contacts.html');
      expect(wrapper.find('[data-testid="user-message-expand"]').exists()).toBe(false);
    }
  });

  it('keeps a plain user message as it was', () => {
    const wrapper = block(message({ content: 'Hello', contentBlocks: [{ type: 'text', text: 'Hello' }] }));
    expect(wrapper.find('[data-testid="markup-message"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Hello');
  });
});
