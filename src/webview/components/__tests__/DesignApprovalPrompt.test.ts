// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import DesignApprovalPrompt from '@/components/design/DesignApprovalPrompt.vue';
import { i18n, loadLocale } from '@/i18n';
import { useDesignStore } from '@/stores/useDesignStore';
import { createDesignHandlers } from '@/composables/message-handler/handlers/design-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: (message: unknown) => void posted.push(message) }) }));

const REQUEST = {
  type: 'requestDesignApproval',
  promptId: 'da-1',
  designId: 'contacts-1a2b3c4d',
  summary: 'The contacts list page: a searchable table.\nAn Add contact button opens a dialog.',
  previousVersion: 1,
  changes: [{ kind: 'screenChanged', screen: 'S1' }, { kind: 'screenAdded', screen: 'S2' }],
  warnings: [{ rule: 'ds.hidden-required', severity: 'warning', screen: 'S1', element: 'input#email', message: 'Hidden at sm' }],
  decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }],
  screens: [{ id: 'S1', file: 'screens/S1-contacts.html' }, { id: 'S2', file: 'screens/S2-detail.html' }],
  hasParent: true,
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
  wrapper = mount(DesignApprovalPrompt, { global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

async function raised(request: ExtensionToWebviewMessage = REQUEST): Promise<VueWrapper> {
  const w = await mountCard();
  deliver(request);
  await flushPromises();
  return w;
}

const card = (w: VueWrapper) => w.find('[data-testid="design-approval-card"]');
const options = (w: VueWrapper) => w.findAll('[role="option"]').map((option) => option.text().replace(/^\d/, ''));
const texts = (w: VueWrapper, selector: string) => w.findAll(selector).map((node) => node.text());

function press(key: string): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

async function requestChanges(w: VueWrapper): Promise<void> {
  await w.get('[data-testid="design-approval-option-changes"]').trigger('click');
  await flushPromises();
}

describe('the design approval prompt', () => {
  it('shows nothing until core raises it, then the summary, the changes, the warnings, the decisions and the three answers', async () => {
    const w = await mountCard();
    expect(card(w).exists()).toBe(false);

    deliver(REQUEST);
    await flushPromises();

    expect(card(w).attributes('role')).toBe('region');
    expect(card(w).attributes('aria-label')).toBe('The design is ready for your approval');
    expect(card(w).attributes('data-dock-prompt')).toBeDefined();
    expect(w.get('[data-testid="design-approval-subtitle"]').text()).toBe('Approving makes a version and sends it to the main chat.');
    expect((w.get('[data-testid="design-approval-summary"]').element as HTMLElement).textContent).toBe(REQUEST.summary);
    expect(w.get('[data-testid="design-approval-details"]').attributes('aria-label')).toBe('What you are approving');
    expect(w.get('[data-testid="design-approval-changes"]').text()).toContain('Changed since v1');
    expect(texts(w, '[data-testid="design-change"]')).toEqual(['S1 changed', 'S2 added']);
    expect(texts(w, '[data-testid="design-approval-warnings"] [data-testid="design-result-warning"]')).toEqual(['Required field hidden at a width S1 input#email']);
    expect(texts(w, '[data-testid="design-decision"]')).toEqual(['D1 Fidelity · Static mockup']);
    expect(w.find('[data-testid="design-approval-unchecked"]').exists()).toBe(false);
    expect(options(w)).toEqual(['Approve and send to main chat', 'Request changes', 'Stop']);
    expect(posted).toEqual([]);
  });

  it('names the decisions the conflict check could not check, and why, so the user approves knowingly (D98, acceptance)', async () => {
    const w = await raised({ ...REQUEST, uncheckedDecisions: [{ ids: ['D23', 'D24'], cause: 'noModel' }] });
    expect(texts(w, '[data-testid="design-approval-unchecked"]')).toEqual(['The conflict check could not run for D23, D24 (no background model). Approve only if they do not contradict other decisions.']);
  });

  it('shows each cause with its own decisions, worded for one decision or several, in both languages', async () => {
    const w = await raised({ ...REQUEST, uncheckedDecisions: [{ ids: ['D3'], cause: 'unreachable' }, { ids: ['D5', 'D6'], cause: 'stopped' }] });
    expect(texts(w, '[data-testid="design-approval-unchecked"]')).toEqual([
      'The conflict check could not run for D3 (the background model could not be reached). Approve only if it does not contradict other decisions.',
      'The conflict check could not run for D5, D6 (the check was stopped). Approve only if they do not contradict other decisions.',
    ]);
    await loadLocale('el');
    i18n.global.locale.value = 'el';
    await flushPromises();
    expect(texts(w, '[data-testid="design-approval-unchecked"]')).toEqual([
      'Ο έλεγχος αντιφάσεων δεν μπόρεσε να γίνει για την D3 (το μοντέλο παρασκηνίου δεν ήταν διαθέσιμο). Εγκρίνετε μόνο αν δεν αντιφάσκει με άλλες αποφάσεις.',
      'Ο έλεγχος αντιφάσεων δεν μπόρεσε να γίνει για τις D5, D6 (ο έλεγχος διακόπηκε). Εγκρίνετε μόνο αν δεν αντιφάσκουν με άλλες αποφάσεις.',
    ]);
  });

  it('words a cause from a newer core generically, never as its key', async () => {
    const w = await raised({ ...REQUEST, uncheckedDecisions: [{ ids: ['D9'], cause: 'quotaExceeded' as never }] });
    expect(texts(w, '[data-testid="design-approval-unchecked"]')).toEqual(['The conflict check could not run for D9 (an unknown cause). Approve only if it does not contradict other decisions.']);
  });

  it('says a first version is one, and that a version with no main chat is only approved', async () => {
    const w = await raised({ ...REQUEST, previousVersion: null, changes: [], hasParent: false });

    expect(w.get('[data-testid="design-approval-changes"]').text()).toBe('This will be the design\'s first version.');
    expect(w.get('[data-testid="design-approval-subtitle"]').text()).toBe('Approving makes a version. This design has no main chat to send it to.');
    expect(options(w)[0]).toBe('Approve the version');
  });

  it('says nothing changed when a later version lists no change, and leaves out empty warnings and decisions', async () => {
    const w = await raised({ ...REQUEST, changes: [], warnings: [], decisions: [] });

    expect(w.get('[data-testid="design-approval-changes"]').text()).toBe('Changed since v1No screen or decision changed.');
    expect(w.find('[data-testid="design-approval-warnings"]').exists()).toBe(false);
    expect(w.find('[data-testid="design-approval-decisions"]').exists()).toBe(false);
  });

  it.each([
    ['approve', 0],
    ['stop', 2],
  ] as const)('answers %s from its option, once, and leaves the dock', async (choice, index) => {
    const w = await raised();

    const option = w.findAll('[role="option"]')[index]!;
    await option.trigger('click');
    await option.trigger('click');
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveDesignApproval', promptId: 'da-1', choice }]);
    expect(card(w).exists()).toBe(false);
    expect(useDesignStore().approvalPrompts).toEqual([]);
  });

  it('asks for a note on Request changes, keeps Send disabled while it is blank, and sends the trimmed note once', async () => {
    const w = await raised();
    await requestChanges(w);
    expect(posted).toEqual([]);

    const note = w.get('[data-testid="design-approval-note"]');
    expect(document.activeElement).toBe(note.element);
    expect(w.get('label[for="design-approval-note"]').text()).toBe('What should the designer change?');
    const send = w.get('[data-testid="design-approval-send-note"]');
    expect(send.attributes('disabled')).toBeDefined();

    await note.setValue('   \n ');
    expect(send.attributes('disabled')).toBeDefined();
    await w.get('form').trigger('submit');
    expect(posted).toEqual([]);

    await note.setValue('  Make the table denser.  ');
    expect(send.attributes('disabled')).toBeUndefined();
    const form = w.get('form');
    await form.trigger('submit');
    await form.trigger('submit');
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveDesignApproval', promptId: 'da-1', choice: 'changes', feedback: 'Make the table denser.' }]);
    expect(card(w).exists()).toBe(false);
  });

  it('sends the note on Ctrl+Enter and goes back to the answers on Escape', async () => {
    const w = await raised();
    await requestChanges(w);
    await w.get('[data-testid="design-approval-note"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(w.find('[data-testid="design-approval-note-form"]').exists()).toBe(false);
    expect(options(w)).toHaveLength(3);

    await requestChanges(w);
    const note = w.get('[data-testid="design-approval-note"]');
    await note.setValue('Use the brand blue.');
    await note.trigger('keydown', { key: 'Enter', ctrlKey: true });
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveDesignApproval', promptId: 'da-1', choice: 'changes', feedback: 'Use the brand blue.' }]);
  });

  it('answers from a digit while it is the only dock prompt, and ignores a digit past its answers', async () => {
    const w = await raised();

    press('4');
    expect(posted).toEqual([]);
    press('1');
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveDesignApproval', promptId: 'da-1', choice: 'approve' }]);
    expect(card(w).exists()).toBe(false);
  });

  it('opens a digit 2 as the note, never as an answer', async () => {
    const w = await raised();
    press('2');
    await flushPromises();

    expect(posted).toEqual([]);
    expect(w.find('[data-testid="design-approval-note"]').exists()).toBe(true);
  });

  it('opens each screen in the preview tab where the host has it, named by its file', async () => {
    useDesignStore().setOpenPreview(true);
    useDesignStore().setOpenInBrowser(true);
    const w = await raised();

    const screens = w.findAll('[data-testid="design-approval-screen"]');
    expect(screens.map((screen) => screen.text())).toEqual(['S1', 'S2']);
    expect(screens.map((screen) => screen.attributes('aria-label'))).toEqual(['Open screens/S1-contacts.html in the preview tab', 'Open screens/S2-detail.html in the preview tab']);
    await screens[1]!.trigger('click');

    expect(posted).toEqual([{ type: 'openDesignPreview', designId: REQUEST.designId, relPath: 'screens/S2-detail.html' }]);
    expect(card(w).exists()).toBe(true);
  });

  it('opens each screen in the browser where the host opens designs from the chat and has no preview tab', async () => {
    useDesignStore().setOpenInBrowser(true);
    const w = await raised();

    const screen = w.get('[data-testid="design-approval-screen"]');
    expect(screen.attributes('aria-label')).toBe('Open screens/S1-contacts.html in the browser');
    await screen.trigger('click');

    expect(posted).toEqual([{ type: 'openDesignInBrowser', designId: REQUEST.designId, relPath: 'screens/S1-contacts.html' }]);
  });

  it('offers no screen buttons where the host can open neither', async () => {
    const w = await raised();

    expect(w.find('[data-testid="design-approval-screens"]').exists()).toBe(false);
  });

  it('shows one card when core posts the same prompt again to a reattached view, and drops it when core closes it', async () => {
    const w = await raised();
    deliver(REQUEST);
    await flushPromises();
    expect(w.findAll('[data-testid="design-approval-card"]')).toHaveLength(1);

    deliver({ type: 'designApprovalClosed', promptId: 'da-1' });
    await flushPromises();

    expect(card(w).exists()).toBe(false);
    expect(posted).toEqual([]);
  });

  it('hands focus on when it leaves holding it, and keeps quiet when focus was elsewhere', async () => {
    const w = await raised();
    (w.get('[role="option"]').element as HTMLElement).focus();
    deliver({ type: 'designApprovalClosed', promptId: 'da-1' });
    await flushPromises();
    expect(w.emitted('release-focus')).toHaveLength(1);

    deliver({ ...REQUEST, promptId: 'da-2' });
    await flushPromises();
    (document.activeElement as HTMLElement | null)?.blur();
    deliver({ type: 'designApprovalClosed', promptId: 'da-2' });
    await flushPromises();
    expect(w.emitted('release-focus')).toHaveLength(1);
  });

  it('drops a draft note when its prompt closes and the next one shows', async () => {
    const w = await raised();
    await requestChanges(w);
    await w.get('[data-testid="design-approval-note"]').setValue('Half a thought');

    deliver({ type: 'designApprovalClosed', promptId: 'da-1' });
    deliver({ ...REQUEST, promptId: 'da-2' });
    await flushPromises();

    expect(w.find('[data-testid="design-approval-note-form"]').exists()).toBe(false);
    await requestChanges(w);
    expect((w.get('[data-testid="design-approval-note"]').element as HTMLTextAreaElement).value).toBe('');
  });

  it('is gone once the conversation resets', async () => {
    const w = await raised();

    useDesignStore().resetConversation();
    await flushPromises();

    expect(card(w).exists()).toBe(false);
  });

  it('speaks Greek in the el locale', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    const w = await raised();

    expect(card(w).attributes('aria-label')).toBe('Η σχεδίαση περιμένει την έγκρισή σας');
    expect(options(w)).toEqual(['Έγκριση και αποστολή στην κύρια συνομιλία', 'Αίτημα αλλαγών', 'Διακοπή']);
    expect(w.get('[data-testid="design-approval-changes"]').text()).toContain('Αλλαγές από την v1');
  });
});
