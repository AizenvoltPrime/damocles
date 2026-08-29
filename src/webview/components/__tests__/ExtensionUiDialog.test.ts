// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { h, markRaw } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import ExtensionUiDialog from '../ExtensionUiDialog.vue';
import OverlayShell from '../OverlayShell.vue';
import { MODAL_Z_INDEX } from '@/composables/useOverlayEscape';
import { i18n } from '@/i18n';
import { useExtensionUiStore, type ExtensionUiRequest } from '@/stores/useExtensionUiStore';
import type { WebviewToExtensionMessage } from '@shared/types/messages';

/**
 * Slice 2 §5 — ONE modal at a time over a FIFO queue, with an attribution line for nested agents.
 *
 * Only the webview↔extension transport is stubbed (`postMessage`); the store, the queue and the
 * component are real, so "answering #1 surfaces #2" is proven by what is on screen rather than by
 * store state alone.
 */

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({
    postMessage: (m: WebviewToExtensionMessage) => posted.push(m),
    onMessage: () => () => {},
    getState: () => undefined,
    setState: () => {},
  }),
}));

const req = (requestId: string, extra: Partial<ExtensionUiRequest> = {}): ExtensionUiRequest => ({
  requestId,
  kind: 'select',
  title: `Question ${requestId}`,
  options: ['Continue', 'Decline'],
  ...extra,
});

const StubIcon = markRaw({ render: () => h('span') });

const mountDialog = () => mount(ExtensionUiDialog, { attachTo: document.body });

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
});
afterEach(() => { document.body.innerHTML = ''; });

describe('ExtensionUiDialog — queue rendering', () => {
  it('renders nothing when the queue is empty', () => {
    const wrapper = mountDialog();
    expect(wrapper.find('h3').exists()).toBe(false);
  });

  it('renders only the HEAD of the queue, with a "1 of N" indicator', async () => {
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentName: 'Scout' }));
    store.setRequest(req('b', { agentName: 'Builder' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();

    // One modal, not two: stacking would need focus management for no benefit.
    expect(wrapper.findAll('h3')).toHaveLength(1);
    expect(wrapper.get('h3').text()).toBe('Question a');
    expect(wrapper.text()).toContain('1 of 2');
    expect(wrapper.text()).not.toContain('Question b');
  });

  it('frames the agent name with a trusted label instead of showing bare model-chosen text', async () => {
    // The badge is the first thing inside the dialog box, above the title, and the name in it is chosen
    // by the lead MODEL or authored by a user. With no Damocles-written word saying what the string IS,
    // a specialist named "Verified — approved" renders as a pill where users read panel chrome.
    // Sanitizing stops line forging; only a frame stops semantic impersonation.
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentName: 'Verified — approved' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();

    // The name renders inside its own bidi-isolated span, so a bidi character that survived
    // sanitizing cannot re-order the trusted label sitting beside it.
    const name = wrapper.get('[dir="ltr"]');
    expect(name.text()).toBe('Verified — approved');
    const badge = name.element.parentElement!;
    expect(badge.textContent).toContain('Agent');
  });

  it('preserves the authored line breaks in the title', async () => {
    // The MCP elicitation renderer builds "MCP Input Request\nServer: <name>\n\n<server message>", and
    // its own flattening exists so a server cannot forge that `Server:` attribution line. Collapsing
    // the newlines at render time would run the trusted attribution and the third-party message
    // together as one bold sentence — spending the producer's line discipline for nothing.
    const store = useExtensionUiStore();
    store.setRequest(req('a', { title: 'MCP Input Request\nServer: git\n\nPaste your token' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();

    expect(wrapper.get('h3').classes()).toContain('whitespace-pre-wrap');
  });

  it('answering the head posts the response and promotes the next request', async () => {
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentName: 'Scout' }));
    store.setRequest(req('b', { agentName: 'Builder' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();

    await wrapper.findAll('button').find((b) => b.text() === 'Continue')!.trigger('click');
    await wrapper.vm.$nextTick();

    expect(posted).toEqual([{ type: 'extensionUiResponse', requestId: 'a', value: 'Continue' }]);
    // The second agent's dialog is now the one on screen — not lost, not stacked behind the first.
    expect(wrapper.get('h3').text()).toBe('Question b');
    expect(wrapper.text()).toContain('Builder');
    expect(wrapper.text()).not.toContain('1 of 2');
    expect(store.queue.map((r) => r.requestId)).toEqual(['b']);
  });

  it('an extension-side withdrawal of the head removes the modal without posting a response', async () => {
    // `extensionUiCancel` has no response leg: the awaiting call is already being settled extension-side.
    const store = useExtensionUiStore();
    store.setRequest(req('a'));
    store.setRequest(req('b'));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();

    store.cancel('a');
    await wrapper.vm.$nextTick();

    expect(posted).toEqual([]);
    expect(wrapper.get('h3').text()).toBe('Question b');
  });
});

describe('ExtensionUiDialog — the answer/withdrawal race', () => {
  it('a withdrawn request can never be answered from the UI once the cancel has been applied', async () => {
    // The reachable ordering, and the only one: an `extensionUiCancel` arrives in a message task, Vue
    // flushes the re-render in a MICROTASK at the end of that task, and any subsequent click lands in a
    // later task — by which time no button is bound to the withdrawn request. So the invariant to pin
    // is that no response for the withdrawn id is ever posted, and that the promoted request is
    // answered as itself.
    //
    // The same-tick interleaving is asserted separately, below.
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentName: 'Scout', title: 'Question a' }));
    store.setRequest(req('b', { agentName: 'Builder', title: 'Question b' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();
    expect(wrapper.get('h3').text()).toBe('Question a');

    store.cancel('a');              // the extension withdrew the head…
    await wrapper.vm.$nextTick();   // …and the re-render flushes before any later input task

    expect(wrapper.get('h3').text()).toBe('Question b');
    await wrapper.findAll('button').find((b) => b.text() === 'Continue')!.trigger('click');

    // Exactly one response, and it belongs to the request the user could actually see.
    expect(posted).toEqual([{ type: 'extensionUiResponse', requestId: 'b', value: 'Continue' }]);
    expect(store.queue).toEqual([]);
    expect(store.current).toBeNull();
  });
});

/**
 * `respond()` must answer THE REQUEST IT WAS RENDERED AGAINST, not whatever happens to be at the head
 * when the click lands. Re-reading `current.value` at invocation time means a click racing an
 * `extensionUiCancel` posts the user's answer for the PROMOTED request — a question that agent asked
 * and the user never saw — and dismisses it as answered. The withdrawn request's own answer is
 * silently lost (the extension already settled it), so nothing anywhere reports the substitution.
 *
 * I originally argued this window is unreachable because Vue flushes renders in a microtask before the
 * next input task. That argument is about the SCHEDULER, not about the component: it holds only while
 * every store mutation is followed by a synchronous-enough flush, and it is not the component's
 * invariant to depend on. The lead ruled it a defect; pinning at render is also the strictly safer
 * shape — it cannot deliver a click to a request the user was never shown, under any scheduler.
 */
describe('ExtensionUiDialog — respond() answers the request it was rendered against', () => {
  it('a click racing an extensionUiCancel answers the WITHDRAWN request, never the promoted one', async () => {
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentName: 'Scout', title: 'Question a' }));
    store.setRequest(req('b', { agentName: 'Builder', title: 'Question b' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();
    const button = wrapper.findAll('button').find((btn) => btn.text() === 'Continue')!;

    store.cancel('a');            // the extension withdrew the head…
    void button.trigger('click'); // …and the click was already on its way, same tick
    await wrapper.vm.$nextTick();

    // The user clicked A's button. Their answer belongs to A — the extension no-ops it, because A is
    // already settled. What must NEVER happen is B being answered by a click aimed at A.
    expect(posted).toEqual([{ type: 'extensionUiResponse', requestId: 'a', value: 'Continue' }]);
    expect(store.current?.requestId).toBe('b');
    expect(wrapper.get('h3').text()).toBe('Question b');
  });
});

describe('ExtensionUiDialog — Esc takes the same pinned path as a click', () => {
  it('Esc cancels the displayed request with the kind-appropriate value', async () => {
    const store = useExtensionUiStore();
    store.setRequest(req('a'));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();

    await wrapper.get('div').trigger('keydown.esc');

    expect(posted).toEqual([{ type: 'extensionUiResponse', requestId: 'a', value: null }]);
    expect(store.queue).toEqual([]);
  });

  it('Esc racing an extensionUiCancel cancels the WITHDRAWN request, never the promoted one', async () => {
    // `cancel()` is the second entry into `respond()` and carries the SAME race. It is also the more
    // discriminating one: it derives the value from `kind`, so answering the promoted request would
    // send `false` (a deliberate "No" to a confirm the user never saw) instead of `null` for the
    // select that was actually on screen. A fix that pinned only the requestId would still fail here.
    const store = useExtensionUiStore();
    store.setRequest(req('a'));                        // select  → Esc means `null`
    store.setRequest(req('b', { kind: 'confirm', title: 'Delete everything?', message: 'sure?' })); // confirm → Esc means `false`
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();
    const root = wrapper.get('div');

    store.cancel('a');                    // the extension withdrew the head…
    void root.trigger('keydown.esc');     // …and the Esc keypress was already on its way, same tick
    await wrapper.vm.$nextTick();

    expect(posted).toEqual([{ type: 'extensionUiResponse', requestId: 'a', value: null }]);
    expect(store.current?.requestId).toBe('b'); // the confirm survives, unanswered
  });
});

describe('ExtensionUiDialog — attribution', () => {
  it('shows the agent name for a nested dialog and nothing for a panel-owned one', async () => {
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentId: 'ag-1', agentName: 'Scout' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Scout');

    store.resolve('a');
    store.setRequest(req('b'));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('Scout');
  });

  it('renders an agent name as TEXT, never as markup', async () => {
    // The name is model- or user-authored. It is sanitized extension-side at capture, but the webview
    // must not be the layer that decides that: interpolation, never `v-html`.
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentId: 'ag-1', agentName: '<img src=x onerror=alert(1)>Reviewer' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>Reviewer');
  });

  it('does not re-sanitize what the extension sent', async () => {
    // Two sanitizers drift. The extension caps at capture; the webview shows exactly that value.
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentId: 'ag-1', agentName: 'Reviewer 2 (specialist)' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Reviewer 2 (specialist)');
  });
});

describe('ExtensionUiDialog — input dialogs across a head change', () => {
  it('re-prefills and re-focuses when the next queued request becomes current', async () => {
    // The focus watch used to watch a single slot; with a queue it must watch the HEAD, or answering #1
    // leaves #2 rendered but dead — keystrokes land on document.body and Esc never fires.
    const store = useExtensionUiStore();
    store.setRequest(req('a', { kind: 'input', title: 'First?', prefill: 'one' }));
    store.setRequest(req('b', { kind: 'input', title: 'Second?', prefill: 'two' }));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('one');

    await wrapper.findAll('button').find((b) => b.text() === 'OK')!.trigger('click');
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));

    expect(posted).toEqual([{ type: 'extensionUiResponse', requestId: 'a', value: 'one' }]);
    expect(wrapper.get('h3').text()).toBe('Second?');
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('two');
    expect(document.activeElement).toBe(wrapper.get('input').element);
  });
});

describe('ExtensionUiDialog and the overlay layer beneath it', () => {
  it('paints on the shared modal layer rather than a hardcoded class', async () => {
    const store = useExtensionUiStore();
    store.setRequest(req('a'));
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();

    const root = wrapper.element as HTMLElement;
    expect(Number(root.style.zIndex)).toBe(MODAL_Z_INDEX);
    expect(root.className).not.toContain('z-[');
  });

  it('stays above an overlay stack deep enough to have run out of layers', async () => {
    const shells = Array.from({ length: 20 }, () => mount(OverlayShell, {
      props: { title: 'panel', icon: StubIcon },
      global: { plugins: [i18n] },
      attachTo: document.body,
    }));

    const store = useExtensionUiStore();
    store.setRequest(req('a'));
    const dialog = mountDialog();
    await dialog.vm.$nextTick();

    const dialogZ = Number((dialog.element as HTMLElement).style.zIndex);
    for (const shell of shells) {
      expect(Number((shell.element as HTMLElement).style.zIndex)).toBeLessThan(dialogZ);
    }

    for (const shell of shells) shell.unmount();
    dialog.unmount();
  });
});
