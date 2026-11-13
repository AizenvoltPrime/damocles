// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PermissionPrompt from '../PermissionPrompt.vue';
import { i18n } from '@/i18n';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { createPermissionHandlers } from '@/composables/message-handler/handlers/permission-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import type { PermissionDetail, PermissionUpdate } from '@shared/types/permissions';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

// The approval card for a forge write, on a local chat: core's words, facts and content replace the raw input.

const SUGGESTION: PermissionUpdate = {
  type: 'addRules',
  rules: [{ toolName: 'ForgeComment', ruleContent: 'gitlab.indigital.gr/grp/damocles' }],
  behavior: 'allow',
  destination: 'localSettings',
};

const DETAIL: PermissionDetail = {
  title: { message: 'Comment on merge request {0}?', args: ['!45'] },
  subtitle: { message: 'writes to the server as you' },
  facts: [
    { label: { message: 'Server' }, value: 'gitlab.indigital.gr' },
    { label: { message: 'Project' }, value: 'grp/damocles', detail: '!45 Refresh tokens one at a time' },
    { label: { message: 'Account' }, value: 'astefanopoulos', avatar: { key: 'k1' }, note: { message: 'chosen automatically' } },
  ],
  content: { label: { message: 'Comment text' }, text: 'Pushed the fix.\n<img src=x onerror="alert(1)"> **not bold**' },
  alwaysAllowLabel: { message: "Yes, and don't ask again for {0} on {1}", args: ['ForgeComment', 'grp/damocles'] },
  approvedStatus: { message: 'Allowed once. Posting the comment to {0} as {1} on {2}.', args: ['!45', 'astefanopoulos', 'gitlab.indigital.gr'] },
};

const mounted: VueWrapper[] = [];

// what a screen reader reads: the text without aria-hidden parts (the avatar's initial, the visual separators)
function spoken(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent!.replace(/\s+/g, ' ').trim();
}
const optionLabels = (wrapper: VueWrapper): string[] => wrapper.findAll('[role="option"] .truncate').map((label) => label.text());

function prompt(props: Record<string, unknown>): VueWrapper {
  const wrapper = mount(PermissionPrompt, {
    props: { visible: true, toolUseId: 'r-1', ...props },
    global: { plugins: [i18n, createPinia()], stubs: { PermissionDestinationPicker: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function forgePrompt(extra: Record<string, unknown> = {}): VueWrapper {
  return prompt({ toolName: 'ForgeComment', toolInput: { body: 'x', merge_request: 45 }, suggestions: [SUGGESTION], ...DETAIL, ...extra });
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('PermissionPrompt for a forge write', () => {
  it('titles the card with the action in words and names the options listbox by it, with no host badge on a local chat', () => {
    const wrapper = forgePrompt();
    const title = wrapper.get('[data-testid="permission-title"]');
    expect(title.text()).toBe('Comment on merge request !45?');
    expect(title.find('[data-testid="host-name-badge"]').exists()).toBe(false);
    expect(wrapper.get('[role="listbox"]').attributes('aria-label')).toBe('Comment on merge request !45?');
  });

  it('shows the tool name and "writes to the server as you" as the subtitle', () => {
    const subtitle = forgePrompt().get('[data-testid="permission-subtitle"]');
    expect(subtitle.get('.font-mono').text()).toBe('ForgeComment');
    expect(spoken(subtitle.element)).toBe('ForgeComment, writes to the server as you');
  });

  it('lists Server, Project with the merge request title, and Account with its avatar and how it was chosen', () => {
    const facts = forgePrompt().get('[data-testid="permission-facts"]');
    expect(facts.element.tagName).toBe('DL');
    // a dl has no role of its own, so its name reaches assistive technology only through the group role
    expect(facts.attributes('role')).toBe('group');
    expect(facts.attributes('aria-label')).toBe('Where this goes');
    expect(facts.findAll('dt').map((term) => term.text())).toEqual(['Server', 'Project', 'Account']);
    const values = facts.findAll('dd');
    expect(values[0]!.text()).toBe('gitlab.indigital.gr');
    expect(spoken(values[1]!.element)).toBe('grp/damocles, !45 Refresh tokens one at a time');
    expect(spoken(values[2]!.element)).toBe('astefanopoulos, chosen automatically');
    expect(values[2]!.find('[data-testid="forge-avatar"]').exists()).toBe(true);
    expect(values[0]!.find('[data-testid="forge-avatar"]').exists()).toBe(false);
  });

  it("draws the account's initial when it has no picture to serve", () => {
    const facts = DETAIL.facts!.map((fact) => (fact.avatar ? { ...fact, avatar: {} } : fact));
    const account = forgePrompt({ facts }).findAll('[data-testid="permission-facts"] dd')[2]!;
    expect(account.find('[data-testid="forge-avatar"]').text()).toBe('A');
    expect(account.find('[data-testid="forge-avatar-image"]').exists()).toBe(false);
  });

  it('shows the content as plain text in a scrollable region: markup stays literal', () => {
    const wrapper = forgePrompt();
    const content = wrapper.get('[data-testid="permission-content"]');
    expect(content.attributes('role')).toBe('region');
    expect(content.attributes('aria-label')).toBe('Comment text');
    expect(content.attributes('tabindex')).toBe('0');
    expect(content.classes()).toEqual(expect.arrayContaining(['max-h-40', 'overflow-y-auto', 'whitespace-pre-wrap']));
    expect(content.element.textContent).toBe('Pushed the fix.\n<img src=x onerror="alert(1)"> **not bold**');
    expect(content.find('img').exists()).toBe(false);
    expect(content.find('strong').exists()).toBe(false);
    expect(wrapper.find('[data-testid="tool-permission-input"]').exists()).toBe(false);
  });

  it('offers Yes, the scoped option 2 from the payload, and No, with no deny rule', () => {
    expect(optionLabels(forgePrompt())).toEqual(['Yes', "Yes, and don't ask again for ForgeComment on grp/damocles", 'No']);
  });

  it("answers option 2 with the payload's own rule, through the destination picker", async () => {
    const wrapper = forgePrompt();
    await wrapper.get('[data-testid="permission-option-always-allow"]').trigger('click');
    const picker = wrapper.getComponent({ name: 'PermissionDestinationPicker' });
    expect(picker.props('open')).toBe(true);
    picker.vm.$emit('select', 'localSettings');
    await nextTick();
    expect(wrapper.emitted('approve')).toEqual([[true, { updatedPermissions: [SUGGESTION] }]]);
  });

  it('sends the feedback field as a refusal with the message', async () => {
    const wrapper = forgePrompt();
    const feedback = wrapper.get('[data-testid="permission-feedback"]');
    expect(feedback.attributes('placeholder')).toBe(i18n.global.t('prompts.permission.feedbackPlaceholder'));
    await feedback.setValue('Post it after the pipeline passes');
    await feedback.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('approve')).toEqual([[false, { customMessage: 'Post it after the pipeline passes' }]]);
  });

  it('keeps a generic prompt without these fields as it was: the raw input, the tool in the title, no facts', () => {
    const wrapper = prompt({ toolName: 'mcp__docs__search', toolInput: { q: 'x' }, suggestions: [{ ...SUGGESTION, rules: [{ toolName: 'mcp__docs__search' }] }] });
    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe(i18n.global.t('permission.useTool', { tool: 'mcp__docs__search' }));
    expect(JSON.parse(wrapper.get('[data-testid="tool-permission-input"]').text())).toEqual({ q: 'x' });
    expect(wrapper.find('[data-testid="permission-facts"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="permission-content"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="permission-subtitle"]').exists()).toBe(false);
    expect(optionLabels(wrapper)).toEqual([
      'Yes',
      i18n.global.t('permission.options.alwaysAllow', { pattern: 'mcp__docs__search' }),
      'No',
      i18n.global.t('permission.options.alwaysDeny', { pattern: 'mcp__docs__search' }),
    ]);
  });

  it('ignores the words for a command, whose card keeps its own view', () => {
    const wrapper = prompt({ toolName: 'Bash', toolInput: { command: 'ls' }, command: 'ls', ...DETAIL });
    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe(i18n.global.t('permission.runCommand'));
    expect(wrapper.find('[data-testid="permission-facts"]').exists()).toBe(false);
  });
});

describe('the status after Yes', () => {
  function requestMessage(toolUseId: string): Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }> {
    return { type: 'requestPermission', toolUseId, toolName: 'ForgeComment', toolInput: {}, owner: { kind: 'main' }, ...DETAIL };
  }

  it('keeps every field of the request for the card, and a new request clears the last status', () => {
    setActivePinia(createPinia());
    const store = usePermissionStore();
    const stores = {
      permissionStore: store,
      streamingStore: { addToolCall: () => {}, updateToolStatus: () => {} },
      sessionStore: { trackFileAccess: () => {} },
      subagentStore: {},
    };
    const ctx = { stores } as unknown as HandlerContext;
    store.showApprovedStatus(DETAIL.approvedStatus!);
    createPermissionHandlers().requestPermission!(requestMessage('t-1'), ctx);
    expect(store.approvedStatus).toBeNull();
    const pending = store.pendingPermissions['t-1']!;
    expect(pending.title).toEqual(DETAIL.title);
    expect(pending.subtitle).toEqual(DETAIL.subtitle);
    expect(pending.facts).toEqual(DETAIL.facts);
    expect(pending.content).toEqual(DETAIL.content);
    expect(pending.alwaysAllowLabel).toEqual(DETAIL.alwaysAllowLabel);
    expect(pending.approvedStatus).toEqual(DETAIL.approvedStatus);
  });
});
