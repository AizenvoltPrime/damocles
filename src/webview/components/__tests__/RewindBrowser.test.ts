// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import RewindBrowser from '../RewindBrowser.vue';
import { useOverlayEscape } from '@/composables/useOverlayEscape';
import { i18n } from '@/i18n';
import type { RestorePoint, RewindHistoryItem } from '@shared/types/session';

const mounted: VueWrapper[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const q = (selector: string) => document.body.querySelector(selector);

const skipped: NonNullable<RewindHistoryItem['skipped']> = {
  totalCount: 2,
  totalBytes: 2048,
  byReason: { size: { count: 2, bytes: 2048 } },
  patterns: [],
  manifest: 'a'.repeat(40),
};

const items: RewindHistoryItem[] = [
  { messageId: 'u2', content: 'second prompt', timestamp: Date.now(), filesAffected: 1, skipped },
  { messageId: 'u1', content: 'first prompt', timestamp: Date.now(), filesAffected: 1 },
];

function mountBrowser(): VueWrapper {
  const wrapper = mount(RewindBrowser, { props: { prompts: items }, attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper as VueWrapper);
  return wrapper as VueWrapper;
}

/** The overlay root the browser teleports to `body`. */
function browserRoot(): HTMLElement {
  const root = q('[data-testid="rewind-browser"]') as HTMLElement | null;
  if (!root) throw new Error('rewind browser not rendered');
  return root;
}

function key(target: EventTarget, name: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('RewindBrowser keyboard', () => {
  const search = () => q('[data-testid="rewind-search"]') as HTMLInputElement;

  it('opens with the search box focused and selects the active row with Enter from it', async () => {
    const wrapper = mountBrowser();
    await flush();
    expect(document.activeElement).toBe(search());

    key(search(), 'ArrowDown');
    await flush();
    key(search(), 'Enter');

    expect(wrapper.emitted('select')).toEqual([[items[1]]]);
  });

  it('lets Enter on the "not restored" toggle expand it instead of selecting the row', async () => {
    const wrapper = mountBrowser();
    await flush();
    const toggle = q('[data-testid="rewind-not-restored"] button') as HTMLButtonElement;
    toggle.focus();
    key(toggle, 'Enter');
    await flush();
    expect(wrapper.emitted('select')).toBeUndefined();

    key(search(), 'Enter');
    expect(wrapper.emitted('select')).toEqual([[items[0]]]);
  });

  it('closes from the shared header X, and only itself', async () => {
    const wrapper = mountBrowser();
    await flush();

    (browserRoot().querySelector('[data-testid="overlay-close"]') as HTMLButtonElement).click();

    expect(wrapper.emitted('close')).toEqual([[]]);
    expect(browserRoot().querySelector('h2')?.textContent).toContain('Rewind to Previous Prompt');
  });
});

describe('RewindBrowser restore points', () => {
  const at = new Date();
  at.setHours(14, 32, 0, 0);
  const points: RestorePoint[] = [
    { id: 'rw2', createdAt: at.getTime() + 60_000, target: { kind: 'undo', preRewindId: 'rw1' }, skipped, filesAffected: 1 },
    { id: 'rw1', createdAt: at.getTime(), target: { kind: 'turn', userEntryId: 'u1' }, skipped: { ...skipped, totalCount: 0, totalBytes: 0, byReason: {}, manifest: null }, filesAffected: 3 },
  ];

  function mountWithPoints(): VueWrapper {
    const wrapper = mount(RewindBrowser, {
      props: { prompts: items, restorePoints: points },
      attachTo: document.body,
      global: { plugins: [i18n] },
    });
    mounted.push(wrapper as VueWrapper);
    return wrapper as VueWrapper;
  }

  it('lists each pre-rewind snapshot by its time and undoes the one the user picks', async () => {
    const wrapper = mountWithPoints();
    await flush();
    const rows = [...document.body.querySelectorAll('[data-testid="rewind-restore-point"]')];
    expect(rows[0]!.textContent).toContain('Before undo at 14:33');
    expect(rows[1]!.textContent).toContain('Before rewind at 14:32');
    expect(rows[1]!.textContent).toContain('Rewound to "first prompt"');
    expect(rows[1]!.textContent).toContain('3 files will be restored');
    // Only the point that skipped files offers the "not restored" list, keyed to the point itself.
    expect(rows[0]!.querySelector('[data-testid="rewind-not-restored"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-testid="rewind-not-restored"]')).toBeNull();

    const undo = rows[1]!.querySelector('[data-testid="rewind-undo"]') as HTMLButtonElement;
    undo.focus();
    key(undo, 'Enter');
    expect(wrapper.emitted('select')).toBeUndefined();
    undo.click();
    expect(wrapper.emitted('undo')).toEqual([[points[1]]]);
  });

  it('labels restore points in Greek', async () => {
    i18n.global.locale.value = 'el';
    mountWithPoints();
    await flush();
    expect(q('[data-testid="rewind-restore-points"]')?.textContent).toContain('Πριν από την επαναφορά στις');
    expect(q('[data-testid="rewind-undo"]')?.textContent).toContain('Αναίρεση επαναφοράς');
  });
});

describe('RewindBrowser overlay stack', () => {
  it('paints above an overlay it was opened over, and Escape closes only the browser', async () => {
    let underneathClosed = 0;
    const Underneath = defineComponent({
      setup() {
        const { zIndex } = useOverlayEscape(() => { underneathClosed++; });
        return () => h('div', { 'data-testid': 'underneath', style: { zIndex: zIndex.value } });
      },
    });
    mounted.push(mount(Underneath, { attachTo: document.body }) as VueWrapper);
    const wrapper = mountBrowser();
    await flush();

    const below = Number((q('[data-testid="underneath"]') as HTMLElement).style.zIndex);
    expect(browserRoot().className).not.toMatch(/\bz-\d+/);
    expect(Number(browserRoot().style.zIndex)).toBe(below + 1);

    key(document.body, 'Escape');
    expect(wrapper.emitted('close')).toEqual([[]]);
    expect(underneathClosed).toBe(0);
  });

  it('leaves its keys alone while another overlay is open above it', async () => {
    const wrapper = mountBrowser();
    await flush();
    const Above = defineComponent({
      setup() {
        useOverlayEscape(() => undefined);
        return () => h('div');
      },
    });
    mounted.push(mount(Above, { attachTo: document.body }) as VueWrapper);
    await flush();

    key(document.body, 'Enter');
    key(document.body, 'Escape');
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(wrapper.emitted('close')).toBeUndefined();
  });
});
