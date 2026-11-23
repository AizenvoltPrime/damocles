// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { toast } from 'vue-sonner';
import App from '@/App.vue';
import VirtualItemWrapper from '@/components/VirtualItemWrapper.vue';
import type { VirtualItem } from '@/composables/useVirtualizedMessages';
import { i18n } from '@/i18n';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { useQuestionStore } from '@/stores/useQuestionStore';
import { useFormStore } from '@/stores/useFormStore';
import { useDesignStore } from '@/stores/useDesignStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useUIStore } from '@/stores/useUIStore';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { installVisibilityObserver } from './visibility-observer';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import { installPreview } from '@/components/theme/__tests__/install-preview';
import type { ChatHost } from '@/composables/useChatHost';
import { HELD_EVENTS } from '@/composables/useTrustedVisibility';

// A remote chat's host, which the sign-in card needs: main's panel init names it, and a test sets it here.
const chatHost = await vi.hoisted(async () => (await import('vue')).shallowRef<ChatHost | undefined>(undefined));
vi.mock('@/composables/useChatHost', async (original) => ({ ...(await original<typeof import('@/composables/useChatHost')>()), useChatHost: () => chatHost }));

// Theme CSS reaches only [data-theme-scope] roots, and its @scope stops at [data-trusted]; a trusted card under a scope
// root, or a scope root inside a trusted card, would let a theme restyle consent UI.

if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

// App.vue imports these cards lazily; compiling them on first use would land inside a test's waits
beforeAll(async () => {
  await Promise.all([
    import('@/components/QuestionPrompt.vue'),
    import('@/components/FormPrompt.vue'),
    import('@/components/SkillApprovalPrompt.vue'),
    import('@/components/PlanApprovalOverlay.vue'),
    import('@/components/theme/ThemeChangePrompt.vue'),
    import('@/components/theme/ThemeScreenshotPrompt.vue'),
    import('@/components/theme/ThemeInstallPrompt.vue'),
  ]);
});

const mounted: VueWrapper[] = [];
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  chatHost.value = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every [data-trusted] element with a scope root above it, and every scope root inside a trusted region. */
function crossings(root: ParentNode): string[] {
  const found: string[] = [];
  for (const trusted of root.querySelectorAll('[data-trusted]')) {
    if (trusted.parentElement?.closest('[data-theme-scope]')) found.push(`trusted under scope: ${trusted.outerHTML.slice(0, 120)}`);
  }
  for (const scope of root.querySelectorAll('[data-theme-scope]')) {
    if (scope.closest('[data-trusted]')) found.push(`scope inside trusted: ${scope.outerHTML.slice(0, 120)}`);
  }
  return found;
}

const MESSAGE: ChatMessage = { id: 'a1', role: 'assistant', content: 'Hello', timestamp: 1 };

function call(name: string, input: Record<string, unknown>, status: ToolCall['status'] = 'completed'): ToolCall {
  return { id: `call-${name}`, name, input, status };
}

function item(type: VirtualItem['type'], extra: Partial<VirtualItem> = {}): VirtualItem {
  return { id: `${type}-1`, type, message: MESSAGE, originalMessageIndex: 0, sourceMessageId: 'a1', spacingLevel: 0, ...extra };
}

// One row of each content block kind the transcript draws, with the element that must be its scope root.
// `inside`: an element a theme styles as a whole, which must be a strict descendant of the root, since @scope rules reach
// only the root's descendants.
const ROWS: readonly { readonly name: string; readonly item: VirtualItem; readonly root: string; readonly inside?: string }[] = [
  { name: 'user bubble', item: item('user-message', { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1 } }), root: '[data-theme-scope]', inside: '.bubble-fade-transitions' },
  { name: 'markdown block', item: item('text-block', { text: '**done**' }), root: ':scope > [data-theme-scope]' },
  { name: 'streaming markdown', item: item('streaming-text', { text: 'typing' }), root: ':scope > [data-theme-scope]' },
  { name: 'thinking block', item: item('thinking-block', { message: { ...MESSAGE, thinking: 'hmm', thinkingDuration: 2 } }), root: ':scope > [data-theme-scope]' },
  { name: 'tool card', item: item('tool-call', { toolCall: call('Bash', { command: 'ls' }) }), root: '[data-theme-scope]', inside: '[data-tool-card]' },
  { name: 'compaction marker', item: item('compact-marker', { marker: { id: 'm1', timestamp: 1, trigger: 'manual', preTokens: 100 } }), root: ':scope > [data-theme-scope]' },
  { name: 'cache miss notice', item: item('cache-miss-notice', { notice: { id: 'n1', missedTokens: 10, missedCost: 0.1, idleMs: 400_000, modelChanged: false, timestamp: 1 } }), root: ':scope > [data-theme-scope]' },
  { name: 'compaction aborted notice', item: item('compaction-aborted-notice', { compactionAborted: { id: 'n2', trigger: 'threshold', willRetry: true, timestamp: 1 } }), root: ':scope > [data-theme-scope]' },
  { name: 'thinking dropped notice', item: item('thinking-dropped-notice', { thinkingDropped: { id: 'n3', count: 1, reasons: [{ text: { message: 'unknown reason' }, count: 1 }], timestamp: 1 } }), root: ':scope > [data-theme-scope]' },
  { name: 'error notice', item: item('error-message', { message: { ...MESSAGE, role: 'error', content: 'broke' } }), root: ':scope > [data-theme-scope]' },
  { name: 'refusal notice', item: item('refusal-message', { message: { ...MESSAGE, role: 'refusal', refusalExplanation: 'no' } }), root: ':scope > [data-theme-scope]' },
  { name: 'background label', item: item('background-label', { text: 'Task result' }), root: ':scope > [data-theme-scope]' },
  {
    name: 'design result card', root: ':scope > [data-theme-scope]', inside: '[data-testid="design-result-card"]',
    item: item('design-result', { designCard: { kind: 'result', entryId: 'e1', afterMessageId: 'a1', afterTimestamp: 1, live: false, result: { designId: 'contacts-1a2b3c4d', version: 1, folder: '/designs/contacts-1a2b3c4d', title: 'Contacts', screens: ['S1'], decisions: [], check: { errors: 0, warnings: [] }, journeys: [], previousVersion: null, changes: [] } } }),
  },
];

function row(virtual: VirtualItem): VueWrapper {
  const wrapper = mount(VirtualItemWrapper, {
    props: { item: virtual, top: 0, arriving: false, canRewind: false, promptIndex: 0 },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

describe('the transcript', () => {
  it.each(ROWS)('makes the $name its own transcript scope root, never the row', async ({ item: virtual, root, inside }) => {
    const wrapper = row(virtual);
    await flushPromises();
    const element = wrapper.element as HTMLElement;
    expect(element.hasAttribute('data-theme-scope')).toBe(false);
    const scope = element.querySelector(root);
    expect(scope?.getAttribute('data-theme-scope')).toBe('transcript');
    if (inside !== undefined) {
      const styled = scope!.querySelector(inside);
      expect(styled).not.toBeNull();
      expect(styled!.hasAttribute('data-theme-scope')).toBe(false);
    }
    expect(crossings(element)).toEqual([]);
  });

  it('leaves the plan card, which is trusted UI, with no scope root above or inside it', async () => {
    usePermissionStore().setPendingPlanApproval({ toolUseId: 'call-ExitPlanMode', planContent: '# Plan' });
    const wrapper = row(item('tool-call', { toolCall: call('ExitPlanMode', {}, 'awaiting_approval') }));
    await flushPromises();
    const card = wrapper.get('[data-testid="plan-card"]').element;
    expect(card.hasAttribute('data-trusted')).toBe(true);
    expect(card.parentElement?.closest('[data-theme-scope]')).toBeNull();
    expect(wrapper.element.querySelector('[data-theme-scope]')).toBeNull();
  });
});

// The dock cards a chat raises from the question, form and design approval stores, as core's messages fill them.
function raiseQuestionFormAndDesignApproval(): void {
  useQuestionStore().setQuestion({ toolUseId: 'q1', questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Grid', description: '' }, { label: 'List', description: '' }] }] });
  useFormStore().setForm({ toolUseId: 'f1', form: { fields: [{ id: 'name', label: 'Name', type: 'text', selector: '#name' }] } });
  useDesignStore().addApprovalPrompt({ promptId: 'da-1', designId: 'contacts-1a2b3c4d', summary: 'The contacts list', previousVersion: null, changes: [], warnings: [], decisions: [], screens: [], hasParent: true });
}

const DOCK_CARDS = ['question-card', 'form-card', 'design-approval-card'] as const;

const button = (card: string, text: string): HTMLElement => [...document.querySelectorAll<HTMLElement>(`[data-testid="${card}"] button`)].find((candidate) => candidate.textContent?.trim() === text)!;
const byTestId = (testId: string): HTMLElement => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;

// Every card of the dock that takes an answer: how core's message raises it, the control a click answers it on, the
// message that answer posts, and whether digits answer it. `digit` cards answer 1 from the document, past their own root.
const GATED_CARDS: readonly { readonly card: string; readonly raise: () => void; readonly press: () => HTMLElement; readonly answer: string; readonly digit: boolean }[] = [
  {
    card: 'permission-card', answer: 'approveEdit', digit: true,
    raise: () => usePermissionStore().addPermission('e1', { owner: { kind: 'main' }, toolName: 'Bash', toolInput: { command: 'rm -rf build' }, command: 'rm -rf build' }),
    press: () => byTestId('permission-option-no'),
  },
  {
    card: 'skill-card', answer: 'approveSkill', digit: true,
    raise: () => usePermissionStore().setPendingSkillApproval({ toolUseId: 's1', skillName: 'deploy' }),
    press: () => document.querySelector<HTMLElement>('[data-testid="skill-card"] [role="option"]')!,
  },
  {
    card: 'elicitation-card', answer: 'answerElicitation', digit: false,
    raise: () => useElicitationStore().addElicitation({ serverName: 'jira', message: 'Token?', mode: 'form', elicitationId: 'el1', requestedSchema: { properties: { token: { type: 'string' } } } }),
    press: () => button('elicitation-card', 'Decline'),
  },
  {
    card: 'sign-in-card', answer: 'continueWithMySignIn', digit: false,
    raise: () => {
      chatHost.value = { name: 'prod-1', computer: 'ALEXIOS-PC' };
      usePermissionStore().addSignIn({ requestId: 'si-1', provider: 'anthropic' });
    },
    press: () => byTestId('sign-in-continue'),
  },
  {
    card: 'form-card', answer: 'answerForm', digit: false,
    raise: () => useFormStore().setForm({ toolUseId: 'f1', form: { fields: [{ id: 'name', label: 'Name', type: 'text', selector: '#name' }] } }),
    press: () => button('form-card', 'Cancel'),
  },
  {
    card: 'design-version-card', answer: 'resolveDesignVersionDecision', digit: true,
    raise: () => useDesignStore().addVersionPrompt({ promptId: 'dv-1', designId: 'contacts-1a2b3c4d', fromVersion: 1, toVersion: 2, changes: [] }),
    press: () => byTestId('design-version-replan'),
  },
  {
    card: 'design-approval-card', answer: 'resolveDesignApproval', digit: true,
    raise: () => useDesignStore().addApprovalPrompt({ promptId: 'da-1', designId: 'contacts-1a2b3c4d', summary: 'The contacts list', previousVersion: null, changes: [], warnings: [], decisions: [], screens: [], hasParent: true }),
    press: () => byTestId('design-approval-option-stop'),
  },
  {
    card: 'theme-change-card', answer: 'resolveThemeChange', digit: true,
    raise: () => useThemePromptStore().setChangePrompt({
      promptId: 'tc-1', toolUseId: 'call_1', action: 'theme', theme: BUILTIN_THEME, themeName: 'Amber', looks: ['dark'], isNew: true,
      changes: [], contrast: [], state: 'waiting', planMode: false, canShowInWindow: true, showInWindow: false, owner: { kind: 'main' },
    }),
    press: () => byTestId('theme-change-option-discard'),
  },
  {
    card: 'theme-screenshot-card', answer: 'resolveThemeScreenshot', digit: true,
    raise: () => useThemePromptStore().setScreenshotPrompt({ promptId: 'ts-1', toolUseId: 'call_2', url: 'app://damocles/theme-shot/3f2a9c', width: 1280, height: 800, owner: { kind: 'main' } }),
    press: () => byTestId('theme-screenshot-option-deny'),
  },
  {
    card: 'theme-install-card', answer: 'resolveThemeInstall', digit: true,
    raise: () => useThemePromptStore().setInstallPrompt({ promptId: 'ti-1', toolUseId: 'call_3', preview: installPreview(), owner: { kind: 'main' } }),
    press: () => byTestId('theme-install-cancel'),
  },
];
const ANSWERS: ReadonlySet<string> = new Set(GATED_CARDS.map((gated) => gated.answer));

async function chatPage(visible: boolean): Promise<{ visibility: ReturnType<typeof installVisibilityObserver>; answers: () => string[] }> {
  const visibility = installVisibilityObserver(visible);
  useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
  // the setup's VS Code stub, which usePlatformBridge posts through
  const posted = vi.spyOn(acquireVsCodeApi!(), 'postMessage');
  mounted.push(mount(App, { global: { plugins: [i18n] }, attachTo: document.body }));
  await flushPromises();
  return { visibility, answers: () => posted.mock.calls.map(([message]) => (message as { type: string }).type).filter((type) => ANSWERS.has(type)) };
}

describe('the chat page', () => {
  it('keeps every trusted card of the dock and the plan overlay out of every scope root, with the empty state scoped', async () => {
    const permissions = usePermissionStore();
    permissions.addPermission('e1', { owner: { kind: 'main' }, toolName: 'Bash', toolInput: { command: 'rm -rf build' }, command: 'rm -rf build' });
    permissions.setPendingSkillApproval({ toolUseId: 's1', skillName: 'deploy' });
    permissions.setPendingPlanApproval({ toolUseId: 'p1', planContent: '# Plan' });
    useElicitationStore().addElicitation({ serverName: 'jira', message: 'Token?', mode: 'form', elicitationId: 'el1', requestedSchema: { properties: { token: { type: 'string' } } } });
    const themes = useThemePromptStore();
    themes.setChangePrompt({
      promptId: 'tc-1', toolUseId: 'call_1', action: 'theme', theme: BUILTIN_THEME, themeName: 'Amber', looks: ['dark'], isNew: true,
      changes: [], contrast: [], state: 'waiting', planMode: false, canShowInWindow: true, showInWindow: false, owner: { kind: 'main' },
    });
    themes.setScreenshotPrompt({ promptId: 'ts-1', toolUseId: 'call_2', url: 'app://damocles/theme-shot/3f2a9c', width: 1280, height: 800, owner: { kind: 'main' } });
    themes.setInstallPrompt({ promptId: 'ti-1', toolUseId: 'call_3', preview: installPreview(), owner: { kind: 'main' } });

    const app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(app);
    await flushPromises();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="theme-screenshot-card"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="theme-change-card"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="theme-install-card"]')).not.toBeNull();
    });

    for (const testId of ['permission-card', 'skill-card', 'elicitation-card', 'theme-change-card', 'theme-screenshot-card', 'theme-install-card', 'plan-ready-banner']) {
      expect(document.querySelector(`[data-testid="${testId}"]`)?.hasAttribute('data-trusted'), testId).toBe(true);
    }
    expect(document.querySelector('[role="dialog"][data-trusted]')).not.toBeNull();
    expect(document.querySelector('[data-testid="empty-state"]')?.getAttribute('data-theme-scope')).toBe('transcript');
    expect(crossings(document)).toEqual([]);
  });

  it('keeps the question, form and design approval cards out of every scope root', async () => {
    raiseQuestionFormAndDesignApproval();
    mounted.push(mount(App, { global: { plugins: [i18n] }, attachTo: document.body }));
    await flushPromises();
    await vi.waitFor(() => {
      for (const testId of DOCK_CARDS) expect(document.querySelector(`[data-testid="${testId}"]`), testId).not.toBeNull();
    });

    for (const testId of DOCK_CARDS) {
      expect(document.querySelector(`[data-testid="${testId}"]`)!.hasAttribute('data-trusted'), testId).toBe(true);
    }
    expect(crossings(document)).toEqual([]);
  });

  // The banner takes no decision: its one button opens the overlay, whose footer is the gated surface.
  it('opens the plan overlay from the banner while the banner is covered, and never observes the banner', async () => {
    usePermissionStore().setPendingPlanApproval({ toolUseId: 'p1', planContent: '# Plan' });
    // the plan arrives with its overlay open; closed, the banner's Review is what opens it again
    usePermissionStore().hidePlanOverlay();
    const { visibility } = await chatPage(false);
    await vi.waitFor(() => expect(byTestId('plan-ready-banner')).not.toBeNull());
    const banner = byTestId('plan-ready-banner');

    expect(visibility.observed()).not.toContain(banner);
    expect(banner.hasAttribute('data-trusted-ready')).toBe(false);
    expect(banner.hasAttribute('data-trusted')).toBe(true);
    expect(banner.querySelector('button')!.hasAttribute('aria-disabled')).toBe(false);
    expect(banner.querySelector('[role="status"]')).toBeNull();

    banner.querySelector('button')!.click();
    await flushPromises();
    expect(usePermissionStore().isPlanOverlayVisible).toBe(true);
  });

  it('gates every card of the dock on its own whole visibility, answering no click while covered', async () => {
    for (const gated of GATED_CARDS) gated.raise();
    useQuestionStore().setQuestion({ toolUseId: 'q1', questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Grid', description: '' }, { label: 'List', description: '' }] }] });
    const { visibility, answers } = await chatPage(false);
    const cards = [...GATED_CARDS.map((gated) => gated.card), 'question-card'];
    await vi.waitFor(() => {
      for (const card of cards) expect(byTestId(card), card).not.toBeNull();
    });

    for (const card of cards) {
      expect(visibility.observed(), card).toContain(byTestId(card));
      expect(byTestId(card).getAttribute('data-trusted-ready'), card).toBe('false');
    }
    for (const init of visibility.inits) expect(init).toEqual({ threshold: 1, trackVisibility: true, delay: 100 });

    const press = (): void => {
      for (const gated of GATED_CARDS) gated.press().click();
      document.querySelector<HTMLElement>('[data-testid="question-card"] [data-option-label="Grid"]')!.click();
    };
    press();
    await flushPromises();
    expect(answers()).toEqual([]);
    expect(useQuestionStore().compiledAnswers).toEqual({ 'Which layout?': '' });
    for (const card of cards) expect(byTestId(card), card).not.toBeNull();

    // a card with a part out of view is not answered either, whatever else the observer says of it
    visibility.report(true, 0.9);
    await flushPromises();
    press();
    await flushPromises();
    expect(answers()).toEqual([]);

    visibility.report(true);
    await flushPromises();
    for (const card of cards) expect(byTestId(card).getAttribute('data-trusted-ready'), card).toBe('true');
    press();
    await flushPromises();
    expect(answers().sort()).toEqual([...ANSWERS].sort());
    expect(useQuestionStore().compiledAnswers).toEqual({ 'Which layout?': 'Grid' });
  });

  // A digit is heard on the document, past the card's own root, so each card's digit rule asks the card's gate itself.
  it.each(GATED_CARDS.filter((gated) => gated.digit))('answers no digit on a lone $card while it is covered', async ({ card, raise, answer }) => {
    raise();
    const { visibility, answers } = await chatPage(false);
    await vi.waitFor(() => expect(byTestId(card)).not.toBeNull());
    const one = (): boolean => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));

    one();
    await flushPromises();
    expect(answers()).toEqual([]);
    expect(byTestId(card)).not.toBeNull();

    visibility.report(true);
    await flushPromises();
    one();
    await flushPromises();
    expect(answers()).toEqual([answer]);
  });

  it('answers no digit on a lone question card while it is covered', async () => {
    useQuestionStore().setQuestion({ toolUseId: 'q1', questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Grid', description: '' }, { label: 'List', description: '' }] }] });
    const { visibility } = await chatPage(false);
    await vi.waitFor(() => expect(byTestId('question-card')).not.toBeNull());
    const one = (): boolean => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));

    one();
    await flushPromises();
    expect(useQuestionStore().compiledAnswers).toEqual({ 'Which layout?': '' });

    visibility.report(true);
    await flushPromises();
    one();
    await flushPromises();
    expect(useQuestionStore().compiledAnswers).toEqual({ 'Which layout?': 'Grid' });
  });

  it('gates the always-allow step of the permission card, which writes the rule, on its own dialog', async () => {
    usePermissionStore().addPermission('e1', {
      owner: { kind: 'main' }, toolName: 'Bash', toolInput: { command: 'ls' }, command: 'ls',
      suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }],
    });
    const { visibility, answers } = await chatPage(true);
    await vi.waitFor(() => expect(byTestId('permission-option-always-allow')).not.toBeNull());
    byTestId('permission-option-always-allow').click();
    await flushPromises();
    const dialog = byTestId('permission-destination-picker');
    const surface = byTestId('permission-destination-surface');
    expect(dialog.hasAttribute('data-trusted')).toBe(true);
    expect(dialog.closest('[data-theme-scope]')).toBeNull();
    expect(visibility.observed()).toContain(surface);

    visibility.report(false);
    await flushPromises();
    expect(surface.getAttribute('data-trusted-ready')).toBe('false');
    byTestId('permission-destination-projectSettings').click();
    await flushPromises();
    expect(answers()).toEqual([]);
    expect(byTestId('permission-destination-picker')).not.toBeNull();

    visibility.report(true);
    await flushPromises();
    byTestId('permission-destination-projectSettings').click();
    await flushPromises();
    expect(answers()).toEqual(['approveEdit']);
  });

  it('shows the reason in a live region each card holds from the start, laid over the card so that it moves nothing', async () => {
    for (const gated of GATED_CARDS) gated.raise();
    await chatPage(false);
    await vi.waitFor(() => {
      for (const { card } of GATED_CARDS) expect(byTestId(card), card).not.toBeNull();
    });
    for (const { card } of GATED_CARDS) {
      const regions = [...byTestId(card).querySelectorAll<HTMLElement>('p[role="status"]')].filter((region) => region.classList.contains('absolute'));
      expect(regions, card).toHaveLength(1);
      expect(regions[0]!.textContent, card).toBe('');
      expect([...regions[0]!.classList], card).toEqual(expect.arrayContaining(['pointer-events-none', 'absolute', 'inset-x-0']));
    }
    await new Promise((resolve) => setTimeout(resolve, 550));
    await flushPromises();
    for (const { card } of GATED_CARDS) {
      expect(byTestId(card).querySelector('p[role="status"].absolute [data-testid="trusted-checking"]')?.textContent, card).toBe('This card must be fully visible before you can answer. Scroll it into view or move what covers it.');
    }
  });

  // IntersectionObserver v2 counts any paint over a card, a shadow included, so what floats over the transcript must stay
  // inside its clipped frame, never reaching the dock below it.
  it('positions the jump-to-latest button and the toaster in the transcript frame, which clips them, outside the dock', async () => {
    const app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(app);
    useStreamingStore().addToolCall({ id: 'b1', name: 'Bash', input: { command: 'ls' } });
    await flushPromises();
    const frame = document.querySelector<HTMLElement>('[data-testid="transcript-frame"]')!;
    const view = frame.querySelector<HTMLElement>('.message-container')!;
    Object.defineProperty(view, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(view, 'clientHeight', { configurable: true, value: 100 });
    view.scrollTop = 900;
    view.dispatchEvent(new Event('scroll'));
    view.scrollTop = 100;
    view.dispatchEvent(new Event('scroll'));
    toast.info('Saved');
    await flushPromises();

    const jump = document.querySelector<HTMLElement>('[data-testid="scroll-to-bottom"]');
    const toaster = document.querySelector<HTMLElement>('[data-sonner-toaster]');
    expect(jump?.classList).toContain('absolute');
    expect(toaster).not.toBeNull();
    expect(frame.classList).toContain('relative');
    expect(frame.classList).toContain('overflow-clip');
    expect(frame.contains(jump)).toBe(true);
    expect(frame.contains(toaster)).toBe(true);
    expect(frame.contains(document.querySelector('[data-testid="chat-dock"]'))).toBe(false);
  });
});

// IntersectionObserver v2 counts a shadow over a card as covering it, and a card's shadow reaches past the gap to the next
// one, so every dock item draws its shadow on one layer under every item's body.
const WEBVIEW = join(__dirname, '..');
const DOCK_ITEM_SOURCES = [
  'components/DockBanner.vue',
  'components/PermissionPrompt.vue',
  'components/QuestionPrompt.vue',
  'components/FormPrompt.vue',
  'components/SkillApprovalPrompt.vue',
  'components/ElicitationPrompt.vue',
  'components/SignInPrompt.vue',
  'components/PlanReadyBanner.vue',
  'components/design/DesignVersionPrompt.vue',
  'components/design/DesignApprovalPrompt.vue',
  'components/theme/ThemeChangePrompt.vue',
  'components/theme/ThemeScreenshotPrompt.vue',
  'components/theme/ThemeInstallPrompt.vue',
] as const;
const DOCK_ITEMS = [
  'auth-banner', 'permission-card', 'question-card', 'form-card', 'skill-card', 'elicitation-card', 'sign-in-card', 'design-version-card',
  'design-approval-card', 'theme-change-card', 'theme-screenshot-card', 'theme-install-card', 'plan-ready-banner',
] as const;

/** The declarations of the first rule written `<selector> {` in `css`. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at + selector.length, css.indexOf('}', at));
}

describe('the dock', () => {
  it('draws the shadow layer under the bodies from the class alone, whatever --d-shadow holds', () => {
    const css = readFileSync(join(WEBVIEW, 'style.css'), 'utf8');
    // the wrapper makes no stacking context, so its layer resolves in the dock's
    const wrapper = ruleBody(css, '.d-dock-shadow');
    expect(wrapper).toContain('position: relative;');
    expect(wrapper).not.toMatch(/z-index|isolation|transform|opacity|filter|contain/);
    const layer = ruleBody(css, '.d-dock-shadow::before');
    for (const declaration of ['position: absolute;', 'inset: 0;', 'z-index: -1;', 'border-radius: inherit;', 'box-shadow: var(--d-shadow);', 'pointer-events: none;']) {
      expect(layer).toContain(declaration);
    }
    const body = ruleBody(css, '.d-dock-shadow > *');
    expect(body).toContain('position: relative;');
    expect(body).toContain('z-index: 1;');
  });

  it.each(DOCK_ITEM_SOURCES)('%s draws its shadow through .d-dock-shadow, never on its body', (file) => {
    const source = readFileSync(join(WEBVIEW, file), 'utf8');
    expect(source).toContain('d-dock-shadow');
    expect(source).not.toContain('shadow-(--d-shadow)');
  });

  it('is isolated, and each raised item is the only child of a shadow wrapper that shares its trust', async () => {
    const permissions = usePermissionStore();
    permissions.addPermission('e1', { owner: { kind: 'main' }, toolName: 'Bash', toolInput: { command: 'rm -rf build' }, command: 'rm -rf build' });
    permissions.setPendingSkillApproval({ toolUseId: 's1', skillName: 'deploy' });
    permissions.setPendingPlanApproval({ toolUseId: 'p1', planContent: '# Plan' });
    chatHost.value = { name: 'prod-1', computer: 'ALEXIOS-PC' };
    permissions.addSignIn({ requestId: 'si-1', provider: 'anthropic' });
    useElicitationStore().addElicitation({ serverName: 'jira', message: 'Token?', mode: 'form', elicitationId: 'el1', requestedSchema: { properties: { token: { type: 'string' } } } });
    const themes = useThemePromptStore();
    themes.setChangePrompt({
      promptId: 'tc-1', toolUseId: 'call_1', action: 'theme', theme: BUILTIN_THEME, themeName: 'Amber', looks: ['dark'], isNew: true,
      changes: [], contrast: [], state: 'waiting', planMode: false, canShowInWindow: true, showInWindow: false, owner: { kind: 'main' },
    });
    themes.setScreenshotPrompt({ promptId: 'ts-1', toolUseId: 'call_2', url: 'app://damocles/theme-shot/3f2a9c', width: 1280, height: 800, owner: { kind: 'main' } });
    themes.setInstallPrompt({ promptId: 'ti-1', toolUseId: 'call_3', preview: installPreview(), owner: { kind: 'main' } });
    raiseQuestionFormAndDesignApproval();
    useDesignStore().addVersionPrompt({ promptId: 'dv-1', designId: 'contacts-1a2b3c4d', fromVersion: 1, toVersion: 2, changes: [] });
    useUIStore().setAuthFailure({ account: 'xai', reason: 'noApiAccess' });

    mounted.push(mount(App, { global: { plugins: [i18n] }, attachTo: document.body }));
    await flushPromises();
    await vi.waitFor(() => {
      for (const testId of DOCK_ITEMS) expect(document.querySelector(`[data-testid="${testId}"]`), testId).not.toBeNull();
    });

    const dock = document.querySelector<HTMLElement>('[data-testid="chat-dock"]')!;
    expect(dock.classList).toContain('isolate');
    for (const testId of DOCK_ITEMS) {
      const item = dock.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      expect(item, testId).not.toBeNull();
      const wrapper = item!.parentElement!;
      expect([...wrapper.classList], testId).toEqual(['d-dock-shadow', 'rounded-14']);
      expect(wrapper.children, testId).toHaveLength(1);
      expect(wrapper.hasAttribute('data-trusted'), testId).toBe(item!.hasAttribute('data-trusted'));
    }
    expect(dock.querySelectorAll('.d-dock-shadow')).toHaveLength(DOCK_ITEMS.length);
    // every prompt of the dock takes an answer, so each is trusted UI, and so is the wrapper that draws its shadow
    const prompts = [...dock.querySelectorAll<HTMLElement>('[data-dock-prompt]')];
    expect(prompts.map((prompt) => prompt.dataset.testid).sort()).toEqual(DOCK_ITEMS.filter((item) => item !== 'auth-banner' && item !== 'plan-ready-banner').sort());
    for (const prompt of prompts) {
      expect(prompt.hasAttribute('data-trusted'), prompt.dataset.testid).toBe(true);
      expect(prompt.parentElement!.hasAttribute('data-trusted'), prompt.dataset.testid).toBe(true);
    }
    const ownShadows = [...dock.querySelectorAll('[class]')].filter((element) => element.getAttribute('class')!.includes('shadow-(--d-shadow)'));
    expect(ownShadows.map((element) => element.outerHTML.slice(0, 120))).toEqual([]);
  });
});

// The visibility check needs the whole card in view, so a card must always fit the page: each is one element of at most
// 70dvh that scrolls inside itself, and the page scrolls when the dock outgrows it.
describe('a dock card always fits the page', () => {
  it('bounds every prompt of the dock at 70dvh, with its content scrolling inside it, on a page that scrolls', async () => {
    for (const gated of GATED_CARDS) gated.raise();
    useQuestionStore().setQuestion({ toolUseId: 'q1', questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Grid', description: '' }] }] });
    await chatPage(true);
    const cards = [...GATED_CARDS.map((gated) => gated.card), 'question-card'];
    await vi.waitFor(() => {
      for (const card of cards) expect(byTestId(card), card).not.toBeNull();
    });
    const dock = byTestId('chat-dock');
    for (const prompt of dock.querySelectorAll<HTMLElement>('[data-dock-prompt]')) {
      expect([...prompt.classList], prompt.dataset.testid).toEqual(expect.arrayContaining(['max-h-[70dvh]', 'overflow-x-hidden', 'overflow-y-auto']));
    }
    expect(dock.querySelectorAll('[data-dock-prompt]')).toHaveLength(cards.length);
    const page = dock.parentElement!;
    // the page's scrollbar takes no width: at the narrowest panel the chat column has none to give
    expect([...page.classList]).toEqual(expect.arrayContaining(['flex', 'flex-col', 'min-h-0', 'overflow-x-hidden', 'overflow-y-auto', '[scrollbar-width:none]']));
    expect(dock.classList).toContain('shrink-0');
  });
});

/** Every .vue file under `directory`, as paths relative to the webview's components. */
function vueFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'ui' ? [] : vueFiles(path);
    return entry.name.endsWith('.vue') ? [relative(join(WEBVIEW, 'components'), path).replaceAll('\\', '/')] : [];
  });
}

// Why a dialog of the chat page that asks something is not trusted UI: nothing but the user's own press, a moment before
// and in this page, raises it, so no agent, extension, host or theme decides when it appears or what it asks.
const OWN_ACTION = 'confirms an action the user started in this page';
const NO_DECISION = 'shows or edits and decides nothing';

// Every surface of the chat page that takes a decision is trusted UI: it carries data-trusted and its answers pass the
// visibility gate. A file that docks a prompt or opens a dialog is listed here, as trusted or with the reason it is not.
const SURFACES: Readonly<Record<string, 'trusted' | { readonly exempt: string }>> = {
  'PermissionPrompt.vue': 'trusted',
  'PermissionDestinationPicker.vue': 'trusted',
  'QuestionPrompt.vue': 'trusted',
  'FormPrompt.vue': 'trusted',
  'SkillApprovalPrompt.vue': 'trusted',
  'ElicitationPrompt.vue': 'trusted',
  'SignInPrompt.vue': 'trusted',
  'design/DesignVersionPrompt.vue': 'trusted',
  'design/DesignApprovalPrompt.vue': 'trusted',
  'theme/ThemeChangePrompt.vue': 'trusted',
  'theme/ThemeScreenshotPrompt.vue': 'trusted',
  'theme/ThemeInstallCard.vue': 'trusted',
  'PlanApprovalOverlay.vue': 'trusted',
  // an extension's own question (select, confirm, input, editor): its answer leaves the page, so it is gated like core's
  'ExtensionUiDialog.vue': 'trusted',
  'ConfirmDialogLayout.vue': { exempt: 'the layout of a confirmation, which the dialog that uses it answers for' },
  'CompactionRewindConfirm.vue': { exempt: OWN_ACTION },
  'DeleteSessionModal.vue': { exempt: OWN_ACTION },
  'RewindConfirmModal.vue': { exempt: OWN_ACTION },
  'StopTeamConfirm.vue': { exempt: OWN_ACTION },
  'MemoryPanel.vue': { exempt: OWN_ACTION },
  'JarvisSettings.vue': { exempt: OWN_ACTION },
  'settings/forge/ForgeHostingGroup.vue': { exempt: OWN_ACTION },
  'settings/forge/ForgeServerForm.vue': { exempt: OWN_ACTION },
  'settings/sections/VoiceSection.vue': { exempt: OWN_ACTION },
  'CompassHelpDialog.vue': { exempt: NO_DECISION },
  'ImageLightboxLayer.vue': { exempt: NO_DECISION },
};
const ASKS = /data-dock-prompt|<AlertDialog\b|<Dialog(Root)?\b|ConfirmDialogLayout|useTrustedVisibility\(|useDockCardVisibility\(/;
const GATE = /use(TrustedVisibility|DockCardVisibility)\(/;
// The events that reach listeners outside a held card: a decision bound to one would pass the hold.
const UNHELD = /@(pointer(down|up|cancel)|mouse(down|up)|touch(start|end|cancel)|contextmenu)\b/;

describe('the decision surfaces of the chat page', () => {
  const components = join(WEBVIEW, 'components');
  const sources = new Map(vueFiles(components).map((file) => [file, readFileSync(join(components, file), 'utf8')]));

  it('lists every file that docks a prompt or opens a dialog, as trusted or with the reason it is not', () => {
    const asking = [...sources].filter(([, source]) => ASKS.test(source)).map(([file]) => file);
    expect(asking.filter((file) => !(file in SURFACES))).toEqual([]);
    expect(Object.keys(SURFACES).filter((file) => !sources.has(file))).toEqual([]);
    for (const verdict of Object.values(SURFACES)) {
      if (verdict !== 'trusted') expect(verdict.exempt.length).toBeGreaterThan(10);
    }
  });

  const trusted = Object.entries(SURFACES).filter(([, verdict]) => verdict === 'trusted').map(([file]) => file);

  it.each(trusted)('%s takes the trusted palette and passes its answers through the visibility gate', (file) => {
    const source = sources.get(file)!;
    expect(source).toContain('data-trusted');
    expect(source).toMatch(GATE);
  });

  it.each(trusted)('%s binds no decision to an event the hold lets through', (file) => {
    expect(sources.get(file)!.match(UNHELD)).toBeNull();
  });

  it('holds exactly the events a card may decide on, so the list above names every other way to press', () => {
    expect([...HELD_EVENTS]).toEqual(['click', 'dblclick', 'auxclick', 'submit', 'keydown', 'keyup']);
  });

  it.each([...sources].filter(([, source]) => source.includes('useDockPromptDigits(')).map(([file]) => file))('%s asks its own gate before a digit answers', (file) => {
    const source = sources.get(file)!;
    expect(source).toMatch(/const \{[^}]*\brefuse\b[^}]*\} = use(TrustedVisibility|DockCardVisibility)\(/);
    expect(source).toMatch(/useDockPromptDigits\([\s\S]*?\n\}, refuse\);/);
  });

  it('keys the element of every card that one request can replace with another by its request, so the next request is a new element', () => {
    const app = readFileSync(join(WEBVIEW, 'App.vue'), 'utf8');
    for (const key of [':request-id="pendingSkillApproval.toolUseId"', ':request-id="`${pendingPlanApproval.toolUseId}:${pendingPlanApproval.planVersion ?? 0}`"']) {
      expect(app).toContain(key);
    }
    const keyed: Readonly<Record<string, string>> = {
      'PermissionPrompt.vue': ':key="toolUseId"',
      'QuestionPrompt.vue': ':key="store.pendingQuestion.toolUseId"',
      'FormPrompt.vue': ':key="store.pendingForm?.toolUseId"',
      'SkillApprovalPrompt.vue': ':key="requestId"',
      'PlanApprovalOverlay.vue': ':key="requestId"',
      'ElicitationPrompt.vue': ':key="currentElicitation.elicitationId"',
      'SignInPrompt.vue': ':key="current.requestId"',
      'design/DesignVersionPrompt.vue': ':key="current.promptId"',
      'design/DesignApprovalPrompt.vue': ':key="current.promptId"',
      'theme/ThemeChangePrompt.vue': ':key="current.promptId"',
      'theme/ThemeScreenshotPrompt.vue': ':key="current.promptId"',
      'theme/ThemeInstallPrompt.vue': ':key="current.promptId"',
      'ExtensionUiDialog.vue': ':key="shown.requestId"',
    };
    for (const [file, key] of Object.entries(keyed)) expect(sources.get(file), file).toContain(key);
    // never on the child of a card's own Transition: a leaving card and the next request's card would be in the page together
    for (const file of Object.keys(keyed)) expect(sources.get(file), file).not.toMatch(/v-if="current"\s+:key=/);
  });
});

describe('the attention animation', () => {
  // A scale on the card, up or down, holds its visibility check: a downscale is distortion, an upscale leaves the ratio under 1.
  it('plays on a ring inside the card and never animates the card itself, so the card it plays on stays answerable', () => {
    const motion = readFileSync(join(WEBVIEW, 'styles', 'motion.css'), 'utf8');
    expect(motion.match(/\.d-attention\{[^}]*\}/)?.[0]).toBe('.d-attention{position:relative}');
    expect(motion).not.toContain('@keyframes d-attention{');
    const ring = motion.match(/\.d-attention::after\{[^}]*\}/)?.[0] ?? '';
    expect(ring).toContain('inset:0');
    expect(ring).toContain('animation:d-attention-ring');
    expect(motion.match(/@keyframes d-attention-ring\{.*\}\}/)?.[0]).not.toMatch(/transform|filter/);
  });
});
