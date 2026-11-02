// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { i18n } from '@/i18n';

// The exit keyframes' timing as motion.css gives it, so the leaving dialog stays until its animationend.
const EXIT_STYLE = '.d-dialog[data-state="closed"],.d-scrim[data-state="closed"]{animation-name:o-zoom-out;animation-duration:.18s}';

const mounted: VueWrapper[] = [];
let style: HTMLStyleElement | undefined;

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  style?.remove();
  style = undefined;
  document.body.innerHTML = '';
});

// A dialog (the Connect dialog) holding a button that opens a confirmation over it (Forget host).
function stacked(kind: 'alert dialog' | 'dialog') {
  const outer = ref(true);
  const inner = ref(false);
  const confirmation = (): ReturnType<typeof h> => (kind === 'alert dialog'
    ? h(AlertDialog, { open: inner.value, 'onUpdate:open': (open: boolean) => { inner.value = open; } }, { default: () => h(AlertDialogContent, { 'data-test-inner': '' }, { default: () => h('button', { 'data-test-cancel': '' }, 'Cancel') }) })
    : h(Dialog, { open: inner.value, 'onUpdate:open': (open: boolean) => { inner.value = open; } }, { default: () => h(DialogContent, { 'data-test-inner': '' }, { default: () => h(DialogTitle, null, { default: () => 'Forget' }) }) }));
  const App = defineComponent(() => () => h(Dialog, { open: outer.value, 'onUpdate:open': (open: boolean) => { outer.value = open; } }, {
    default: () => h(DialogContent, { 'data-test-outer': '' }, { default: () => [h(DialogTitle, null, { default: () => 'Connect' }), h('button', { 'data-test-opener': '' }, 'Forget'), confirmation()] }),
  }));
  mounted.push(mount(App, { global: { plugins: [i18n], stubs: { transition: false } }, attachTo: document.body }));
  return { outer, inner };
}

const pressEscape = (): void => void document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const innerContent = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-test-inner]');

describe('a dialog playing its exit over another dialog', () => {
  it.each(['alert dialog', 'dialog'] as const)('no longer takes Escape once its %s started closing, so the dialog beneath closes', async (kind) => {
    style = document.head.appendChild(Object.assign(document.createElement('style'), { textContent: EXIT_STYLE }));
    const { outer, inner } = stacked(kind);
    await flushPromises();
    const opener = document.querySelector<HTMLElement>('[data-test-opener]')!;
    opener.focus();
    inner.value = true;
    await flushPromises();
    expect(innerContent()?.contains(document.activeElement)).toBe(true);

    inner.value = false;
    await nextTick();
    // the exit plays on the element it leaves behind, which reka renders closed
    expect(innerContent()?.dataset['state']).toBe('closed');
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(opener);
    expect(innerContent()).not.toBeNull();

    pressEscape();
    await flushPromises();
    expect(outer.value).toBe(false);
  });

  it('removes a closing dialog at once when no exit animation runs, as under reduced motion', async () => {
    const { outer, inner } = stacked('alert dialog');
    await flushPromises();
    inner.value = true;
    await flushPromises();
    inner.value = false;
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(innerContent()).toBeNull();
    expect(outer.value).toBe(true);
  });
});
