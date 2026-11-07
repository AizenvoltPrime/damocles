// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import { TOOL_DESIGN_PARITY } from '@shared/tool-names';
import { DESIGN_PARITY_CHECK_IDS, type DesignParityDetails } from '@shared/design-parity';
import { i18n, loadLocale } from '@/i18n';
import en from '@/i18n/locales/en.json' with { type: 'json' };
import el from '@/i18n/locales/el.json' with { type: 'json' };
import DesignParityToolCard from '../DesignParityToolCard.vue';
import ToolCallRouter from '../../ToolCallRouter.vue';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const DETAILS: DesignParityDetails = {
  screen: 'S1',
  file: 'screens/S1.html',
  url: 'http://127.0.0.1:5173/contacts',
  widths: [
    { width: 640, breakpoint: 'sm', passes: 12, score: 1, status: 'verified', failed: [] },
    {
      width: 1280, breakpoint: 'xl', passes: 9, score: 0.75, status: 'needs_iteration', failed: [
        { id: 'layout.column_count_match', label: 'Column count', reason: 'The design has a side rail; the app has one column.' },
        { id: 'color.accent_color_match', label: 'Accent color', reason: 'The button is teal, not violet.' },
        { id: 'components.icon_motif_match', label: 'Icon style', reason: 'Filled icons instead of line icons.' },
      ],
    },
  ],
  images: [{ width: 640, kind: 'design' }, { width: 640, kind: 'app' }, { width: 1280, kind: 'design' }, { width: 1280, kind: 'app' }],
};

const BROWSER_OFF = 'DesignParity captures the app with the Damocles browser, which is off. Turn on the browser in Settings, then call DesignParity again.';

const mounted: VueWrapper[] = [];
const call = (overrides: Partial<ToolCall>): ToolCall => ({
  id: 't1', name: TOOL_DESIGN_PARITY, input: { screen: 'S1', url: DETAILS.url, widths: [640, 1280] }, status: 'completed', metadata: DETAILS as unknown as Record<string, unknown>, ...overrides,
});
/** A call with no result yet, so no details. */
function running(): ToolCall {
  const { metadata: _details, ...rest } = call({ status: 'running' });
  return rest;
}
function card(toolCall: ToolCall): VueWrapper {
  const wrapper = mount(DesignParityToolCard, { props: { toolCall }, global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  i18n.global.locale.value = 'en';
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  i18n.global.locale.value = 'en';
});

describe('the DesignParity card', () => {
  it('is a table with one row per width: breakpoint and width, passes out of 12 and the status', () => {
    const wrapper = card(call({}));
    expect(wrapper.text()).toContain('Design parity');
    expect(wrapper.text()).toContain('S1 · http://127.0.0.1:5173/contacts');
    const table = wrapper.get('[data-testid="design-parity-table"]');
    expect(table.get('caption').text()).toBe('Parity of http://127.0.0.1:5173/contacts with S1, per width');
    expect(table.findAll('thead th').map((th) => [th.text(), th.attributes('scope')])).toEqual([['Width', 'col'], ['Score', 'col'], ['Status', 'col']]);
    const rows = table.findAll('[data-testid="design-parity-row"]');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.get('th').attributes('scope'))).toEqual(['row', 'row']);
    expect(rows.map((row) => row.get('th').text())).toEqual(['sm · 640 px', 'xl · 1280 px, 3 failed checks']);
    expect(rows.map((row) => row.get('[data-testid="design-parity-score"] [aria-hidden="true"]').text())).toEqual(['12/12', '9/12']);
    expect(rows.map((row) => row.get('[data-testid="design-parity-score"] .sr-only').text())).toEqual(['12 of 12 checks passed', '9 of 12 checks passed']);
    expect(rows.map((row) => row.get('[data-testid="design-parity-status"]').text())).toEqual(['Verified', 'Needs iteration']);
    expect(rows.map((row) => row.get('[data-testid="design-parity-status"]').classes())).toEqual([
      expect.arrayContaining(['d-tone-success']),
      expect.arrayContaining(['d-tone-warning']),
    ]);
    // The meter fills one segment per pass.
    expect(rows[1]!.findAll('[data-testid="design-parity-meter"] > span').filter((segment) => segment.classes().includes('bg-(--tone)'))).toHaveLength(9);
    expect(wrapper.get('[data-testid="design-parity-weakest"]').text()).toContain('9/12');
    expect(wrapper.get('[data-testid="design-parity-footer"]').text()).toBe('12 fixed yes/no checks per width. The score counts the passes; the judge model never sets it.');
  });

  it('shows the passes core counted, never a score field of its own making', () => {
    const details = { ...DETAILS, widths: [{ ...DETAILS.widths[1]!, score: 0.99 }] };
    const wrapper = card(call({ metadata: details as unknown as Record<string, unknown> }));
    expect(wrapper.get('[data-testid="design-parity-score"] [aria-hidden="true"]').text()).toBe('9/12');
  });

  it('expands and collapses a width\'s failed checks by its disclosure button, with localized labels and the reason verbatim', async () => {
    const wrapper = card(call({}));
    const widths = wrapper.findAll('[data-testid="design-parity-width"]');
    expect(widths[0]!.find('[data-testid="design-parity-toggle"]').exists()).toBe(false);
    const toggle = widths[1]!.get('[data-testid="design-parity-toggle"]');
    expect(toggle.element.tagName).toBe('BUTTON');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    // The closed row stays in the table, hidden and empty, so aria-controls always names an element.
    const closed = widths[1]!.get('[data-testid="design-parity-failed"]');
    expect(closed.attributes('hidden')).toBeDefined();
    expect(closed.find('[data-testid="design-parity-check"]').exists()).toBe(false);

    await toggle.trigger('click');
    await flushPromises();
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const failed = widths[1]!.get('[data-testid="design-parity-failed"]');
    expect(failed.element.tagName).toBe('TR');
    expect(failed.attributes('hidden')).toBeUndefined();
    expect(toggle.attributes('aria-controls')).toBe(failed.attributes('id'));
    expect(failed.get('td').attributes('colspan')).toBe('3');
    expect(failed.get('ul').attributes('aria-label')).toBe('Failed checks at xl · 1280 px');
    const checks = failed.findAll('[data-testid="design-parity-check"]');
    expect(checks.map((check) => check.attributes('data-check'))).toEqual(['layout.column_count_match', 'color.accent_color_match', 'components.icon_motif_match']);
    expect(checks.map((check) => check.get('[data-testid="design-parity-check-label"]').text())).toEqual(['Column count', 'Accent color', 'Icon style']);
    expect(checks[0]!.text()).toContain('Layout');
    expect(checks.map((check) => check.get('[data-testid="design-parity-check-reason"]').text())).toEqual([
      'The design has a side rail; the app has one column.', 'The button is teal, not violet.', 'Filled icons instead of line icons.',
    ]);
    // Opening a width's checks stays in the card rather than opening the tool overlay.
    expect(posted).toEqual([]);

    await toggle.trigger('click');
    await flushPromises();
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(widths[1]!.get('[data-testid="design-parity-failed"]').attributes('hidden')).toBeDefined();
    expect(widths[1]!.find('[data-testid="design-parity-check"]').exists()).toBe(false);
  });

  it('shows core\'s English label for a check id this build does not know', async () => {
    const details = { ...DETAILS, widths: [{ ...DETAILS.widths[1]!, failed: [{ id: 'layout.future_check', label: 'Future check', reason: 'r' }] }] };
    const wrapper = card(call({ metadata: details as unknown as Record<string, unknown> }));
    await wrapper.get('[data-testid="design-parity-toggle"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="design-parity-check-label"]').text()).toBe('Future check');
  });

  it('asks for the result\'s images by count and captions them design then app per width', () => {
    const wrapper = card(call({ imageCount: 4 }));
    expect(posted).toEqual([{ type: 'requestToolResultImages', requestId: expect.any(String), toolUseId: 't1', owner: { kind: 'session' } }]);
    const images = wrapper.getComponent({ name: 'ToolResultImages' });
    expect(images.props('captions')).toEqual(['sm · 640 px · design', 'sm · 640 px · app', 'xl · 1280 px · design', 'xl · 1280 px · app']);
    expect(wrapper.findAll('[data-testid="tool-result-image-placeholder"]')).toHaveLength(4);
  });

  it('says the chat model got no captures when the result carries none, and requests none', () => {
    const wrapper = card(call({ imageCount: 0, metadata: { ...DETAILS, images: [] } as unknown as Record<string, unknown> }));
    expect(wrapper.find('[data-testid="design-parity-images"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="design-parity-no-images"]').text()).toBe('This chat\'s model reads no images, so the result carries no captures; the background model judged them.');
    expect(posted).toEqual([]);
  });

  it('shows the requested widths while it runs, with no table yet', () => {
    const wrapper = card(running());
    expect(wrapper.get('[data-testid="design-parity-running"]').text()).toBe('Comparing the app with the design at each width…');
    expect(wrapper.text()).toContain('640 px');
    expect(wrapper.text()).toContain('1280 px');
    expect(wrapper.find('[data-testid="design-parity-table"]').exists()).toBe(false);
    expect(wrapper.find('.d-sweep-bar').exists()).toBe(true);
  });

  it('shows a refusal\'s localized text as the error line, and no table', () => {
    const wrapper = card(call({ status: 'failed', metadata: { refusal: { message: BROWSER_OFF } }, errorMessage: 'English for the model' }));
    expect(wrapper.get('[data-testid="design-parity-error"]').text()).toBe(BROWSER_OFF);
    expect(wrapper.find('[data-testid="design-parity-table"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="design-parity-running"]').exists()).toBe(false);
  });

  it('fills a refusal\'s arguments', () => {
    const wrapper = card(call({ status: 'failed', metadata: { refusal: { message: 'The app at {0} did not load ({1}). Start the app or check the address, then call DesignParity again.', args: ['http://127.0.0.1:5173', 'net::ERR_CONNECTION_REFUSED'] } }, errorMessage: 'x' }));
    expect(wrapper.get('[data-testid="design-parity-error"]').text()).toBe('The app at http://127.0.0.1:5173 did not load (net::ERR_CONNECTION_REFUSED). Start the app or check the address, then call DesignParity again.');
  });

  it('shows the error message of a failure that carries no refusal', () => {
    const wrapper = card(call({ status: 'failed', metadata: {}, errorMessage: 'Unexpected: socket hang up' }));
    expect(wrapper.get('[data-testid="design-parity-error"]').text()).toBe('Unexpected: socket hang up');
  });

  it('plays its entrance only for a result that lands while it is shown', async () => {
    const wrapper = card(call({}));
    expect(wrapper.find('.d-row-reveal').exists()).toBe(false);
    const live = card(running());
    await live.setProps({ toolCall: call({}) });
    await nextTick();
    expect(live.findAll('[data-testid="design-parity-row"]').every((row) => row.classes().includes('d-row-reveal'))).toBe(true);
  });

  it('reads in Greek', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    const wrapper = card(call({}));
    expect(wrapper.text()).toContain('Ισοτιμία σχεδίασης');
    const table = wrapper.get('[data-testid="design-parity-table"]');
    expect(table.findAll('thead th').map((th) => th.text())).toEqual(['Πλάτος', 'Βαθμός', 'Κατάσταση']);
    expect(table.findAll('[data-testid="design-parity-status"]').map((status) => status.text())).toEqual(['Επαληθεύτηκε', 'Θέλει δουλειά']);
    await table.get('[data-testid="design-parity-toggle"]').trigger('click');
    await flushPromises();
    expect(table.findAll('[data-testid="design-parity-check-label"]').map((label) => label.text())).toEqual(['Αριθμός στηλών', 'Χρώμα έμφασης', 'Στυλ εικονιδίων']);
    // The reason is the judge model's text, shown as it came.
    expect(table.get('[data-testid="design-parity-check-reason"]').text()).toBe('The design has a side rail; the app has one column.');
  });

  it('has an en and an el label for every check and status core can send', () => {
    const labels = (catalog: typeof en, id: string): unknown => id.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], catalog.design.parity.check);
    for (const id of DESIGN_PARITY_CHECK_IDS) {
      expect(typeof labels(en, id), id).toBe('string');
      expect(typeof labels(el as typeof en, id), id).toBe('string');
    }
    expect(Object.keys(en.design.parity.statusName).sort()).toEqual(['failed', 'needs_iteration', 'needs_review', 'verified']);
  });
});

describe('the tool call router', () => {
  it('routes DesignParity to its card', () => {
    const toolCall = call({});
    const message: ChatMessage = { id: 'a1', role: 'assistant', content: '', timestamp: 1 };
    const wrapper = mount(ToolCallRouter, { props: { toolCall, toolUseId: 't1', toolName: TOOL_DESIGN_PARITY, message }, global: { plugins: [i18n] } });
    mounted.push(wrapper);
    expect(wrapper.find('[data-testid="design-parity-card"]').exists()).toBe(true);
  });
});
