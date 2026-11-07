// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import DesignVersionPrompt from '@/components/design/DesignVersionPrompt.vue';
import { i18n, loadLocale } from '@/i18n';
import { useDesignStore } from '@/stores/useDesignStore';
import { createDesignHandlers } from '@/composables/message-handler/handlers/design-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: (message: unknown) => void posted.push(message) }) }));

const REQUEST = {
  type: 'requestDesignVersionDecision',
  promptId: 'dv-1',
  designId: 'contacts-1a2b3c4d',
  fromVersion: 1,
  toVersion: 2,
  changes: [{ kind: 'screenChanged', screen: 'S1' }, { kind: 'screenAdded', screen: 'S2' }, { kind: 'decisionAdded', id: 'D3', title: 'Density', chosen: 'Compact' }],
  owner: { kind: 'main' },
} as const satisfies ExtensionToWebviewMessage;

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  i18n.global.locale.value = 'en';
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  i18n.global.locale.value = 'en';
});

// The prompt's messages arrive through the chat page's design handlers, as core posts them.
function deliver(message: ExtensionToWebviewMessage): void {
  const handlers = createDesignHandlers() as Record<string, (msg: ExtensionToWebviewMessage, ctx: HandlerContext) => void>;
  handlers[message.type]!(message, {} as HandlerContext);
}

async function mountCard(): Promise<VueWrapper> {
  wrapper = mount(DesignVersionPrompt, { global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const card = (w: VueWrapper) => w.find('[data-testid="design-version-card"]');
const options = (w: VueWrapper) => w.findAll('[role="option"]').map((option) => option.text().replace(/^\d/, ''));

function press(key: string): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('the design version prompt', () => {
  it('shows nothing until core raises it, then the reference text, the changes and the two options in order', async () => {
    const w = await mountCard();
    expect(card(w).exists()).toBe(false);

    deliver(REQUEST);
    await flushPromises();

    expect(card(w).attributes('role')).toBe('region');
    expect(card(w).attributes('aria-label')).toBe('The design changed after you approved the plan');
    expect(card(w).attributes('data-dock-prompt')).toBeDefined();
    expect(w.get('[data-testid="design-version-body"]').text()).toBe('The plan was approved against v1. The design is now v2:');
    expect(w.findAll('[data-testid="design-version-changes"] li').map((li) => li.text())).toEqual(['S1 changed', 'S2 added', 'D3 Density · Compact']);
    expect(options(w)).toEqual(['Update the plan and re-approve', 'Finish v1 first']);
    expect(posted).toEqual([]);
  });

  it.each([
    ['replan', 0],
    ['finishFirst', 1],
  ] as const)('answers %s from its option, once, and leaves the dock', async (choice, index) => {
    const w = await mountCard();
    deliver(REQUEST);
    await flushPromises();

    const option = w.findAll('[role="option"]')[index]!;
    await option.trigger('click');
    await option.trigger('click');
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveDesignVersionDecision', promptId: 'dv-1', choice }]);
    expect(card(w).exists()).toBe(false);
    expect(useDesignStore().versionPrompts).toEqual([]);
  });

  it('answers from a digit while it is the only dock prompt, and ignores a digit past its options', async () => {
    const w = await mountCard();
    deliver(REQUEST);
    await flushPromises();

    press('3');
    expect(posted).toEqual([]);
    press('2');
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveDesignVersionDecision', promptId: 'dv-1', choice: 'finishFirst' }]);
    expect(card(w).exists()).toBe(false);
  });

  it('shows one card when core posts the same prompt again to a reattached view, and drops it when core closes it', async () => {
    const w = await mountCard();
    deliver(REQUEST);
    deliver(REQUEST);
    await flushPromises();
    expect(w.findAll('[data-testid="design-version-card"]')).toHaveLength(1);

    deliver({ type: 'designVersionDecisionClosed', promptId: 'dv-1' });
    await flushPromises();

    expect(card(w).exists()).toBe(false);
    expect(posted).toEqual([]);
  });

  it('shows the replacement prompt for a newer version after the old one closes', async () => {
    const w = await mountCard();
    deliver(REQUEST);
    deliver({ type: 'designVersionDecisionClosed', promptId: 'dv-1' });
    deliver({ ...REQUEST, promptId: 'dv-2', toVersion: 3, changes: [{ kind: 'screenChanged', screen: 'S1' }] });
    await flushPromises();

    expect(card(w).attributes('data-to-version')).toBe('3');
    expect(w.get('[data-testid="design-version-body"]').text()).toBe('The plan was approved against v1. The design is now v3:');
  });

  it('words a plan approved before the design had any version without naming a v0', async () => {
    const w = await mountCard();
    deliver({ ...REQUEST, fromVersion: 0, toVersion: 1, changes: [{ kind: 'screenAdded', screen: 'S1' }] });
    await flushPromises();

    expect(w.get('[data-testid="design-version-body"]').text()).toBe('The plan was approved before the design had a version. The design is now v1:');
    expect(options(w)).toEqual(['Update the plan and re-approve', 'Finish the approved plan first']);
  });

  it('ends the body with a full stop when the version lists no change', async () => {
    const w = await mountCard();
    deliver({ ...REQUEST, changes: [] });
    await flushPromises();

    expect(w.get('[data-testid="design-version-body"]').text()).toBe('The plan was approved against v1. The design is now v2.');
    expect(w.find('[data-testid="design-version-changes"]').exists()).toBe(false);
  });

  it('is gone once the conversation resets', async () => {
    const w = await mountCard();
    deliver(REQUEST);
    await flushPromises();

    useDesignStore().resetConversation();
    await flushPromises();

    expect(card(w).exists()).toBe(false);
  });

  it('speaks Greek in the el locale', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    const w = await mountCard();
    deliver(REQUEST);
    await flushPromises();

    expect(card(w).attributes('aria-label')).toBe('Η σχεδίαση άλλαξε αφού εγκρίνατε το πλάνο');
    expect(w.get('[data-testid="design-version-body"]').text()).toBe('Το πλάνο εγκρίθηκε με βάση την v1. Η σχεδίαση είναι πλέον στην v2:');
    expect(options(w)).toEqual(['Ενημέρωση του πλάνου και νέα έγκριση', 'Ολοκλήρωση της v1 πρώτα']);
    expect(w.findAll('[data-testid="design-version-changes"] li').map((li) => li.text())).toEqual(['S1 άλλαξε', 'S2 προστέθηκε', 'D3 Density · Compact']);
  });
});
