// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import App from '@/App.vue';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage } from '@shared/types/messages';
import type { DesignChatStateView } from '@shared/types/design';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

const DESIGN: DesignChatStateView = {
  designId: 'contacts-1a2b3c4d', title: 'Design · Contacts', folder: '/home/u/.damocles/designs/contacts-1a2b3c4d', parentSessionId: 'parent-1',
  parentTitle: 'Contacts', status: 'draft', version: 1, fidelity: 'interactive', ruleSet: 'full', enabled: true, superseded: false, supersededBy: null,
  decisions: [],
};

let app: VueWrapper | null = null;
let posted: { type: string; [key: string]: unknown }[] = [];
const q = (selector: string): HTMLElement | null => document.body.querySelector<HTMLElement>(selector);
// Transitions end on a timer in happy-dom, which runs no animations.
const frames = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

async function send(message: ExtensionToWebviewMessage): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
  await nextTick();
  await frames();
}

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  posted = [];
  const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
  useSettingsStore().hostCapabilities = { ...VSCODE_HOST_CAPABILITIES };
  app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
});

afterEach(() => {
  app?.unmount();
  app = null;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a superseded design chat (PD-36)', () => {
  it('keeps the composer and rewinds while the design chat is current', async () => {
    await send({ type: 'designState', design: DESIGN, link: null, openInBrowser: false });
    expect(q('[data-testid="composer"]')).not.toBeNull();
    expect(q('[data-testid="design-superseded"]')).toBeNull();
    expect(useUIStore().historyReadOnly).toBe(false);
  });

  it('puts the banner in the composer\'s place, offers no rewind, and opens the current design chat by its own designId', async () => {
    await send({ type: 'designState', design: DESIGN, link: null, openInBrowser: false });
    await send({ type: 'designState', design: { ...DESIGN, superseded: true, supersededBy: 'design-2' }, link: null, openInBrowser: false });

    expect(q('[data-testid="composer"]')).toBeNull();
    const banner = q('[data-testid="design-superseded"]')!;
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('This design continues in another chat.');
    expect(banner.textContent).toContain('This chat is read-only now.');
    expect(useUIStore().historyReadOnly).toBe(true);

    const open = q('[data-testid="design-superseded-open"]')!;
    expect(open.textContent?.trim()).toBe('Open the current design chat');
    open.click();
    expect(posted).toContainEqual({ type: 'openDesignChat', designId: 'contacts-1a2b3c4d' });
  });

  it('reads in Greek', async () => {
    i18n.global.locale.value = 'el';
    await send({ type: 'designState', design: { ...DESIGN, superseded: true, supersededBy: 'design-2' }, link: null, openInBrowser: false });
    expect(q('[data-testid="design-superseded"]')?.textContent).toContain('Αυτή η σχεδίαση συνεχίζεται σε άλλη συνομιλία.');
    expect(q('[data-testid="design-superseded-open"]')?.textContent?.trim()).toBe('Άνοιγμα της τρέχουσας συνομιλίας σχεδίασης');
  });
});
