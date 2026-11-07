// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import { DESIGN_DECISIONS_DETAIL_KEY, type DeclareTweaksDetails, type DesignChatStateView, type MapReferenceDetails } from '@shared/types/design';
import type { ImageBlock } from '@shared/types/content';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import { TOOL_DECLARE_TWEAKS, TOOL_MAP_REFERENCE, TOOL_RECORD_DECISION } from '@shared/tool-names';
import { i18n } from '@/i18n';
import { useDesignStore } from '@/stores/useDesignStore';
import { buildUserMessage } from '@/stores/useStreamingStore';
import DesignToolCard from '../DesignToolCard.vue';
import UserMessageBlock from '../../UserMessageBlock.vue';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const DESIGN: DesignChatStateView = {
  designId: 'contacts-1a2b3c4d', title: 'Design · Contacts', folder: '/home/u/.damocles/designs/contacts-1a2b3c4d', parentSessionId: 'parent-1', parentTitle: 'Contacts',
  status: 'draft', version: null, fidelity: 'static', ruleSet: 'full', enabled: true, superseded: false, supersededBy: null, decisions: [],
};

const mounted: VueWrapper[] = [];
function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}
const call = (name: string, input: Record<string, unknown>, metadata: Record<string, unknown>): ToolCall => ({ id: 't1', name, input, status: 'completed', metadata });
const card = (toolCall: ToolCall): VueWrapper => track(mount(DesignToolCard, { props: { toolCall }, global: { plugins: [i18n] } }));

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  useDesignStore().setState(DESIGN, null);
  i18n.global.locale.value = 'en';
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe('the MapReference card', () => {
  const DETAILS: MapReferenceDetails = {
    reference: 'R1',
    image: 'references/R1.jpg',
    rows: [
      { element: 'Header bar', mapsTo: 'Button', status: 'mapped' },
      { element: 'Card radius', mapsTo: '--radius-lg', status: 'mapped' },
      { element: 'Avatar stack', mapsTo: null, status: 'needsDecision' },
      { element: 'Ad banner', mapsTo: null, status: 'out' },
    ],
  };

  it('is a table of Element, Maps to and Status, one row per element, toned by status', () => {
    const wrapper = card(call(TOOL_MAP_REFERENCE, { reference: 'R1', rows: [] }, DETAILS as unknown as Record<string, unknown>));
    expect(wrapper.text()).toContain('Map reference');
    expect(wrapper.text()).toContain('R1');
    const table = wrapper.get('[data-testid="design-map-reference"]');
    expect(table.findAll('th').map((th) => th.text())).toEqual(['Element', 'Maps to', 'Status']);
    const rows = table.findAll('[data-testid="design-map-reference-row"]');
    expect(rows.map((row) => row.findAll('td').map((td) => td.text()))).toEqual([
      ['Header bar', 'Button', 'Mapped'],
      ['Card radius', '--radius-lg', 'Mapped'],
      ['Avatar stack', 'Nothing in the app', 'Needs decision'],
      ['Ad banner', 'Nothing in the app', 'Out'],
    ]);
    expect(rows.map((row) => row.get('[data-testid="design-map-reference-status"]').classes())).toEqual([
      expect.arrayContaining(['d-tone-success']),
      expect.arrayContaining(['d-tone-success']),
      expect.arrayContaining(['d-tone-warning']),
      expect.arrayContaining(['d-tone-faint']),
    ]);
    expect(table.get('[data-testid="design-map-reference-summary"]').text()).toBe('2 mapped · 1 needs a decision · 1 out');
  });

  it('opens the reference image of the chat\'s own design', async () => {
    const wrapper = card(call(TOOL_MAP_REFERENCE, { reference: 'R1', rows: [] }, DETAILS as unknown as Record<string, unknown>));
    const image = wrapper.get('[data-testid="design-map-reference-image"]');
    expect(image.text()).toBe('R1.jpg');
    await image.trigger('click');
    expect(posted).toEqual([{ type: 'openDesignFile', designId: 'contacts-1a2b3c4d', file: 'references/R1.jpg' }]);
  });
});

describe('the DeclareTweaks card', () => {
  const DETAILS: DeclareTweaksDetails = {
    controls: [
      { id: 'radius', label: 'Radius', property: '--radius', kind: 'segment', stops: [{ token: '--radius-sm', value: '0.25rem' }, { token: '--radius-lg', value: '0.5rem' }], locked: null },
      { id: 'accent', label: 'Accent', property: '--color-primary', kind: 'swatch', stops: [{ token: '--color-blue', value: '#2563eb' }, { token: '--color-violet', value: '#7c5cff' }], locked: { decisionId: 'D3', value: '--color-violet' } },
    ],
  };

  it('lists each control with its property and token stops, swatches for colors, and a lock with its decision id', () => {
    const wrapper = card(call(TOOL_DECLARE_TWEAKS, {}, DETAILS as unknown as Record<string, unknown>));
    expect(wrapper.text()).toContain('Declare tweaks');
    expect(wrapper.text()).toContain('Radius, Accent');
    const controls = wrapper.findAll('[data-testid="design-declared-tweak"]');
    expect(controls.map((item) => item.attributes('data-tweak'))).toEqual(['radius', 'accent']);
    expect(controls[0]!.findAll('[data-testid="design-declared-tweak-stop"]').map((item) => item.text())).toEqual(['sm, 0.25rem', 'lg, 0.5rem']);
    expect(controls[0]!.find('[data-testid="design-declared-tweak-swatch"]').exists()).toBe(false);
    expect(controls[0]!.find('[data-testid="design-declared-tweak-lock"]').exists()).toBe(false);
    expect(controls[1]!.get('[data-testid="design-declared-tweak-lock"]').text()).toBe('Locked by decisionD3');
    expect(controls[1]!.get('[data-locked-value]').attributes('data-token')).toBe('--color-violet');
    const swatches = controls[1]!.findAll('[data-testid="design-declared-tweak-swatch"]');
    expect(swatches.map((swatch) => (swatch.element as HTMLElement).style.background)).toEqual([expect.stringMatching(/^(#2563eb|rgb\(37, 99, 235\))$/), expect.stringMatching(/^(#7c5cff|rgb\(124, 92, 255\))$/)]);
    // The value is read out too, which the swatch alone never says.
    expect(controls[1]!.findAll('[data-testid="design-declared-tweak-stop"] .sr-only').map((value) => value.text())).toEqual([', #2563eb', ', #7c5cff']);
  });

  it('binds no swatch for a value that is no literal color, whatever core classed it as', () => {
    const hostile: DeclareTweaksDetails = { controls: [{ ...DETAILS.controls[1]!, stops: [{ token: '--color-blue', value: 'url(https://example.com/x.png)' }, { token: '--color-violet', value: '#7c5cff' }], locked: null }] };
    const wrapper = card(call(TOOL_DECLARE_TWEAKS, {}, hostile as unknown as Record<string, unknown>));
    const stops = wrapper.findAll('[data-testid="design-declared-tweak-stop"]');

    expect(stops[0]!.find('[data-testid="design-declared-tweak-swatch"]').exists()).toBe(false);
    expect(stops[1]!.find('[data-testid="design-declared-tweak-swatch"]').exists()).toBe(true);
    expect(wrapper.html()).not.toContain('example.com/x.png);');
  });
});

describe('a RecordDecision from a tweak or a reference', () => {
  const decision = (source: { kind: 'tweak' | 'reference'; ref: string }): ToolCall => call(TOOL_RECORD_DECISION, { title: 'Radius' }, {
    [DESIGN_DECISIONS_DETAIL_KEY]: [{ id: 'D4', title: 'Radius', chosen: '--radius-lg', rejected: [], source }],
  });

  it('names the tweak, and the reference with its element', () => {
    expect(card(decision({ kind: 'tweak', ref: 'radius' })).get('[data-testid="design-recorded-decisions"]').text()).toContain('From tweak radius');
    expect(card(decision({ kind: 'reference', ref: 'R1#Avatar stack' })).get('[data-testid="design-recorded-decisions"]').text()).toContain('From reference R1 · Avatar stack');
  });
});

describe('a user message with saved references', () => {
  const SHOT: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c2hvdA==' } };
  const PHOTO: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'cGhvdG8=' } };
  const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
    id: 'u1', role: 'user', content: 'Map this onto the contacts page', contentBlocks: [{ type: 'text', text: 'Map this onto the contacts page' }, SHOT, PHOTO], timestamp: 1_700_000_000_000, promptIndex: 0, ...overrides,
  });
  const block = (chat: ChatMessage): VueWrapper => track(mount(UserMessageBlock, { props: { message: chat, messageIndex: 0, canRewind: true, promptIndex: 0 }, global: { plugins: [i18n] } }));

  it('shows each saved image\'s thumbnail and the file core saved it as; an unsaved image stays a chip', async () => {
    // The first image is the preview's screenshot, never a reference; the second became R1.
    const wrapper = block(message({ designReferences: [{ id: 'R1', image: 'references/R1.jpg', imageIndex: 1 }] }));
    const notes = wrapper.findAll('[data-testid="reference-note"]');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.attributes('data-reference')).toBe('R1');
    expect(notes[0]!.get('[data-testid="reference-note-text"]').text()).toBe('saved by core as references/R1.jpg');
    expect(notes[0]!.get('img').attributes('src')).toBe('data:image/jpeg;base64,cGhvdG8=');
    expect(notes[0]!.get('img').attributes('alt')).toBe('Reference image R1');
    expect(wrapper.findAll('img').map((img) => img.attributes('src'))).toContain('data:image/png;base64,c2hvdA==');
    expect(wrapper.text()).toContain('Map this onto the contacts page');

    await notes[0]!.get('[data-testid="reference-note-file"]').trigger('click');
    expect(posted).toEqual([{ type: 'openDesignFile', designId: 'contacts-1a2b3c4d', file: 'references/R1.jpg' }]);
    await notes[0]!.get('[data-testid="reference-note-image"]').trigger('click');
    expect(wrapper.emitted('openLightbox')).toEqual([[PHOTO]]);
  });

  it('keeps the references the message carried, live and replayed', () => {
    const references = [{ id: 'R2', image: 'references/R2.png', imageIndex: 0 }];
    const live = buildUserMessage([{ type: 'text', text: 'see' }, SHOT], false, undefined, undefined, 'c1', 0, undefined, undefined, undefined, 1, { designReferences: references });
    const replayed = buildUserMessage([{ type: 'text', text: 'see' }, SHOT], true, 's1', undefined, undefined, 0, undefined, undefined, undefined, 1, { designReferences: references });
    for (const chat of [live, replayed]) {
      expect(chat.designReferences).toEqual(references);
      const wrapper = block(chat);
      expect(wrapper.get('[data-testid="reference-note-text"]').text()).toBe('saved by core as references/R2.png');
    }
    expect(buildUserMessage('plain')).not.toHaveProperty('designReferences');
  });
});
