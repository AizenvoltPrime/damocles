// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ForgeRefusedNotice from '../ForgeRefusedNotice.vue';
import VirtualItemWrapper from '../VirtualItemWrapper.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { transcriptHasCard, useForgeRefusalStore, type ForgeShellRefused } from '@/stores/useForgeRefusalStore';
import { createForgeRefusedHandlers } from '@/composables/message-handler/handlers/forge-refused-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import type { VirtualItem } from '@/composables/useVirtualizedMessages';
import type { ChatMessage } from '@shared/types/session';
import type { ForgeAccountSummary, ForgeAccountsState } from '@shared/forge/accounts';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import { i18n } from '@/i18n';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (message: WebviewToExtensionMessage) => void posted.push(message), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

// sample data
const SERVER = 'gitlab.indigital.gr';
function account(id: string, login: string, agentShells: boolean): ForgeAccountSummary {
  return { id: `${SERVER}|${id}`, serverId: SERVER, login, route: 'browser', scopes: [], agentShells, needsSignIn: false, addedAt: 0, bindings: { projects: 1, hosts: 0 }, orgAccess: [] };
}
const ASTEF = account('7', 'astefanopoulos', false);
const ADMIN = account('9', 'astef-admin', true);
const OTHER = { ...account('3', 'elsewhere', true), id: 'gitlab.com|3', serverId: 'gitlab.com' };

function accountsState(accounts: ForgeAccountSummary[]): ForgeAccountsState {
  return { status: 'ready', servers: [], accounts, notices: [], redirectUris: { github: '', gitlab: '' }, showAvatars: false };
}

function refusedOf(fields: Partial<ForgeShellRefused> = {}): ForgeShellRefused {
  return {
    type: 'forgeShellRefused',
    toolCallId: 'call-1',
    serverId: SERVER,
    serverLabel: SERVER,
    project: 'damocles',
    canBind: true,
    account: { id: ASTEF.id, login: 'astefanopoulos' },
    reason: 'agentShellsOff',
    ...fields,
  };
}

const handlers = createForgeRefusedHandlers();
const ctx = {} as HandlerContext;
function receive(message: ForgeShellRefused | { type: 'forgeRefusedBindResult'; toolCallId: string; accountId: string; ok: boolean } | { type: 'forgeRefusedOpenMenu'; toolCallId: string }): void {
  if (message.type === 'forgeShellRefused') handlers.forgeShellRefused!(message, ctx);
  else if (message.type === 'forgeRefusedBindResult') handlers.forgeRefusedBindResult!(message, ctx);
  else handlers.forgeRefusedOpenMenu!(message, ctx);
}

const mounted: VueWrapper[] = [];
async function mountNotice(refused = refusedOf()): Promise<VueWrapper> {
  receive(refused);
  const store = useForgeRefusalStore();
  const wrapper = mount({
    components: { ForgeRefusedNotice },
    setup: () => ({ store }),
    template: '<ForgeRefusedNotice v-if="store.refusals.get(\'call-1\')" :refusal="store.refusals.get(\'call-1\')" />',
  }, { attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  await nextTick();
  return wrapper;
}

// Reka opens the menu across a custom event and its own nextTick, and returns focus two timers after it closes.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await flush();
};
const byTestId = (id: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const chooseButton = (): HTMLElement => byTestId('forge-refused-choose')!;
const menu = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="menu"]');
// the menu's accessible name: the element aria-labelledby names
const menuName = (): string => document.getElementById(menu()!.getAttribute('aria-labelledby')!)!.textContent!.trim();
const radios = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
const press = (target: Element, key: string): boolean => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
// what a screen reader reads: aria-label, else the text without aria-hidden parts (the avatar's initial)
function name(element: HTMLElement): string {
  const label = element.getAttribute('aria-label');
  if (label !== null) return label;
  const copy = element.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent!.replace(/\s+/g, ' ').trim();
}

async function openMenu(): Promise<void> {
  chooseButton().focus();
  press(chooseButton(), 'Enter');
  await settle();
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  useSettingsStore().setForgeAccounts(accountsState([ASTEF, ADMIN, OTHER]));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('ForgeRefusedNotice', () => {
  it('names the account and server when the switch is off, as a warning notice with both actions', async () => {
    const wrapper = await mountNotice();
    expect(wrapper.find('section').attributes('aria-label')).toBe("The agent's git was refused");
    expect(name(byTestId('forge-refused-message')!)).toBe('The account this project uses on gitlab.indigital.gr, astefanopoulos, does not allow agent shells. Damocles kept its token out of the shell.');
    // the avatar's initial is hidden from assistive technology
    expect(byTestId('forge-refused-message')!.querySelector('[data-testid="forge-avatar"]')!.getAttribute('aria-hidden')).toBe('true');
    expect(chooseButton().textContent!.trim()).toBe('Choose account');
    expect(chooseButton().getAttribute('aria-haspopup')).toBe('menu');
    expect(byTestId('forge-refused-settings')!.textContent!.trim()).toBe('Open Git hosting settings');
    expect(byTestId('forge-refused-notice')!.dataset['reason']).toBe('agentShellsOff');
  });

  it('says no account resolved when nothing was chosen for the project', async () => {
    await mountNotice(refusedOf({ reason: 'noAccount', account: null }));
    expect(name(byTestId('forge-refused-message')!)).toBe("Damocles found no account for this project on gitlab.indigital.gr, so the agent's git got no credentials.");
    await openMenu();
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false']);
  });

  it('offers only settings when core has no project to bind, whatever the project label says', async () => {
    await mountNotice(refusedOf({ project: 'damocles', canBind: false }));
    expect(byTestId('forge-refused-choose')).toBeNull();
    expect(byTestId('forge-refused-settings')).not.toBeNull();
  });

  it('spends a menu request aimed at a notice without a menu, so it never opens one later', async () => {
    await mountNotice(refusedOf({ canBind: false }));
    receive({ type: 'forgeRefusedOpenMenu', toolCallId: 'call-1' });
    await settle();
    expect(useForgeRefusalStore().menuRequest).toBeNull();
    expect(menu()).toBeNull();
  });

  // a browser reads the item's block lines with a space between them, so a hidden comma would read as "login , ..."
  it('names each account item by its aria-label, the comma right after the login, and shows the login and the hint on their own lines', async () => {
    await mountNotice();
    await openMenu();
    const item = radios()[0]!;
    expect(item.getAttribute('aria-label')).toBe('astefanopoulos, Agent shells not allowed');
    expect(item.querySelector('[dir="ltr"]')!.textContent).toBe('astefanopoulos');
    expect(item.querySelector('.sr-only')).toBeNull();
  });

  it('is dismissible in the dock only, where Dismiss asks its owner to take it away', async () => {
    receive(refusedOf());
    const store = useForgeRefusalStore();
    const dismissed = vi.fn();
    const wrapper = mount(ForgeRefusedNotice, { props: { refusal: store.refusals.get('call-1')!, dismissible: true, onDismiss: dismissed }, attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(wrapper);
    const dismiss = byTestId('transcript-notice-dismiss')!;
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss');
    dismiss.click();
    expect(dismissed).toHaveBeenCalledOnce();
    const inline = mount(ForgeRefusedNotice, { props: { refusal: store.refusals.get('call-1')! }, global: { plugins: [i18n] } });
    mounted.push(inline);
    expect(inline.find('[data-testid="transcript-notice-dismiss"]').exists()).toBe(false);
  });

  it('docks one notice per server and reason for refusals no card shows, and its Dismiss takes them all', () => {
    const store = useForgeRefusalStore();
    for (const id of ['nested-1', 'nested-2', 'card-1']) receive(refusedOf({ toolCallId: id }));
    receive(refusedOf({ toolCallId: 'nested-3', reason: 'noAccount', account: null }));
    receive(refusedOf({ toolCallId: 'nested-4', serverId: 'gitlab.com', serverLabel: 'gitlab.com' }));
    const docked = store.docked(transcriptHasCard([{ toolCalls: [{ id: 'other' }] }, { toolCalls: [{ id: 'card-1' }] }, {}]));
    expect(docked.map((entry) => [entry.refusal.refused.toolCallId, entry.toolCallIds])).toEqual([
      ['nested-2', ['nested-1', 'nested-2']],
      ['nested-3', ['nested-3']],
      ['nested-4', ['nested-4']],
    ]);
    store.dismiss(docked[0]!.toolCallIds);
    expect([...store.refusals.keys()]).toEqual(['card-1', 'nested-3', 'nested-4']);
  });

  it('finds a recent card searching from the end of the transcript, reading no older message', () => {
    const older = { get toolCalls(): never { throw new Error('read an older message'); } };
    const transcript = [older, { toolCalls: [{ id: 'call-9' }] }, { toolCalls: [{ id: 'call-10' }, { id: 'call-11' }] }];
    const hasCard = transcriptHasCard(transcript);
    expect(hasCard('call-11')).toBe(true);
    expect(hasCard('call-9')).toBe(true);
    expect(() => hasCard('nested-1')).toThrow('read an older message');
  });

  it('opens a menu named for the server with a radio item per account there, hinted by its agent-shells switch', async () => {
    await mountNotice();
    await openMenu();
    expect(menuName()).toBe('Account for gitlab.indigital.gr');
    expect(chooseButton().getAttribute('aria-expanded')).toBe('true');
    expect(radios().map(name)).toEqual(['astefanopoulos, Agent shells not allowed', 'astef-admin, Agent shells allowed']);
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(menu()!.textContent).toContain('damocles · gitlab.indigital.gr');
    expect(menu()!.querySelector('[role="menuitem"]')!.textContent!.trim()).toBe('Open Git hosting settings');
    // focus starts on the account the project uses
    expect(document.activeElement).toBe(radios()[0]);
    press(document.activeElement!, 'ArrowDown');
    await flush();
    expect(document.activeElement).toBe(radios()[1]);
  });

  it('closes on Escape and returns focus to Choose account', async () => {
    await mountNotice();
    await openMenu();
    press(document.activeElement!, 'Escape');
    await settle();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chooseButton());
  });

  it('binds the project to the chosen account through core and says the agent may use it once core saved it', async () => {
    const wrapper = await mountNotice();
    await openMenu();
    radios()[1]!.click();
    await settle();
    expect(posted).toEqual([{ type: 'forgeRefusedBind', toolCallId: 'call-1', accountId: ADMIN.id }]);
    expect(document.activeElement).toBe(chooseButton());
    // nothing changes until core answers
    expect(wrapper.find('section').attributes('aria-label')).toBe("The agent's git was refused");

    receive({ type: 'forgeRefusedBindResult', toolCallId: 'call-1', accountId: ADMIN.id, ok: true });
    await nextTick();
    expect(wrapper.find('section').attributes('aria-label')).toBe('damocles now uses astef-admin');
    expect(byTestId('forge-refused-message')!.textContent!.trim()).toBe("Agent shells may use astef-admin on gitlab.indigital.gr, so the agent's next git call signs in as astef-admin.");
    expect(byTestId('forge-refused-status')!.textContent!.trim()).toBe('damocles now uses astef-admin on gitlab.indigital.gr.');
    await openMenu();
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });

  it('says the agent is still refused when the chosen account does not allow agent shells either', async () => {
    await mountNotice(refusedOf({ reason: 'noAccount', account: null }));
    await openMenu();
    radios()[0]!.click();
    await settle();
    receive({ type: 'forgeRefusedBindResult', toolCallId: 'call-1', accountId: ASTEF.id, ok: true });
    await nextTick();
    expect(byTestId('forge-refused-message')!.textContent!.trim()).toBe("Agent shells may not use astefanopoulos either, so the agent's next git call is refused too.");
  });

  it('sends nothing when the account already in use is picked', async () => {
    await mountNotice();
    await openMenu();
    radios()[0]!.click();
    await settle();
    expect(posted).toEqual([]);
  });

  it('keeps the refusal and says so when core could not save the choice', async () => {
    const wrapper = await mountNotice();
    await openMenu();
    radios()[1]!.click();
    await settle();
    receive({ type: 'forgeRefusedBindResult', toolCallId: 'call-1', accountId: ADMIN.id, ok: false });
    await nextTick();
    expect(wrapper.find('section').attributes('aria-label')).toBe("The agent's git was refused");
    expect(byTestId('forge-refused-failed')!.textContent!.trim()).toBe('Damocles could not save the account for this project.');
    expect(byTestId('forge-refused-status')!.textContent!.trim()).toBe('Damocles could not save the account for this project.');
  });

  it('asks core to open Git hosting settings at the refusal, from the button and from the menu', async () => {
    await mountNotice();
    byTestId('forge-refused-settings')!.click();
    await openMenu();
    menu()!.querySelector<HTMLElement>('[role="menuitem"]')!.click();
    await settle();
    expect(posted).toEqual([
      { type: 'forgeRefusedOpenSettings', toolCallId: 'call-1' },
      { type: 'forgeRefusedOpenSettings', toolCallId: 'call-1' },
    ]);
  });

  it("opens its menu when the unfocused window's toast asked for it, focused on the account in use", async () => {
    await mountNotice();
    receive({ type: 'forgeRefusedOpenMenu', toolCallId: 'call-1' });
    await settle();
    expect(menuName()).toBe('Account for gitlab.indigital.gr');
    expect(document.activeElement).toBe(radios()[0]);
    expect(useForgeRefusalStore().menuRequest).toBeNull();
  });

  it('shows under the shell card with that toolCallId, and only there', async () => {
    receive(refusedOf());
    const message = { id: 'm1', role: 'assistant', content: '', timestamp: 0 } as ChatMessage;
    const itemOf = (id: string): VirtualItem => ({ id: `tool-${id}`, type: 'tool-call', message, toolCall: { id, name: 'Bash', input: { command: 'git fetch' }, status: 'completed' }, originalMessageIndex: 0 } as unknown as VirtualItem);
    const props = { top: 0, arriving: false, canRewind: false, promptIndex: 0 };
    const other = mount(VirtualItemWrapper, { props: { ...props, item: itemOf('call-2') }, global: { plugins: [i18n] } });
    const card = mount(VirtualItemWrapper, { props: { ...props, item: itemOf('call-1') }, global: { plugins: [i18n] } });
    mounted.push(other, card);
    expect(other.find('[data-testid="forge-refused-notice"]').exists()).toBe(false);
    expect(card.find('[data-testid="forge-refused-notice"]').exists()).toBe(true);
  });
});

describe('ForgeRefusedNotice for a forge tool call (a tool with no resolved account)', () => {
  it('names the tool and offers Choose account when the tool found no account', async () => {
    const wrapper = await mountNotice(refusedOf({ reason: 'noAccount', account: null, tool: 'ForgePipelines' }));
    expect(wrapper.find('section').attributes('aria-label')).toBe("The agent's ForgePipelines was refused");
    expect(name(byTestId('forge-refused-message')!)).toBe('Damocles found no account for this project on gitlab.indigital.gr, so ForgePipelines did not run.');
    await openMenu();
    expect(menuName()).toBe('Account for gitlab.indigital.gr');
    expect(radios().map(name)).toEqual(['astefanopoulos, Agent shells not allowed', 'astef-admin, Agent shells allowed']);
  });

  it("says the tools use the chosen account once core saved it, whatever the account's agent-shells switch", async () => {
    await mountNotice(refusedOf({ reason: 'noAccount', account: null, tool: 'ForgePipelines' }));
    await openMenu();
    radios()[0]!.click();
    await settle();
    receive({ type: 'forgeRefusedBindResult', toolCallId: 'call-1', accountId: ASTEF.id, ok: true });
    await nextTick();
    expect(name(byTestId('forge-refused-message')!)).toBe("The agent's GitHub and GitLab tools now use astefanopoulos on gitlab.indigital.gr for this project.");
    expect(posted).toEqual([{ type: 'forgeRefusedBind', toolCallId: 'call-1', accountId: ASTEF.id }]);
  });

  it("offers the org's own action instead of another account when an org needs single sign-on", async () => {
    await mountNotice(refusedOf({ reason: 'orgAccess', tool: 'ForgeIssues', org: { name: 'acme', kind: 'sso' } }));
    expect(name(byTestId('forge-refused-message')!)).toBe('acme on gitlab.indigital.gr uses single sign-on, and your account has not authorized Damocles for it yet.');
    expect(byTestId('forge-refused-choose')).toBeNull();
    const action = byTestId('forge-refused-org')!;
    expect(action.textContent!.trim()).toBe('Authorize Damocles for acme');
    action.click();
    expect(posted).toEqual([{ type: 'forgeRefusedOrgAction', toolCallId: 'call-1' }]);
  });

  it('asks for approval when an org has not approved Damocles', async () => {
    await mountNotice(refusedOf({ reason: 'orgAccess', tool: 'ForgeIssues', org: { name: 'acme', kind: 'approval' } }));
    expect(name(byTestId('forge-refused-message')!)).toBe('acme on gitlab.indigital.gr has not approved Damocles, so its private repositories stay hidden from it.');
    expect(byTestId('forge-refused-org')!.textContent!.trim()).toBe('Request approval from acme');
  });

  it("shows under the forge tool's card with that toolCallId", async () => {
    receive(refusedOf({ reason: 'noAccount', account: null, tool: 'ForgePipelines' }));
    const message = { id: 'm1', role: 'assistant', content: '', timestamp: 0 } as ChatMessage;
    const item = { id: 'tool-call-1', type: 'tool-call', message, toolCall: { id: 'call-1', name: 'ForgePipelines', input: {}, status: 'failed' }, originalMessageIndex: 0 } as unknown as VirtualItem;
    const card = mount(VirtualItemWrapper, { props: { top: 0, arriving: false, canRewind: false, promptIndex: 0, item }, global: { plugins: [i18n] } });
    mounted.push(card);
    expect(card.find('[data-testid="forge-refused-notice"]').attributes('data-reason')).toBe('noAccount');
  });
});
