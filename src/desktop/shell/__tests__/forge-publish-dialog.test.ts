// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ForgePublishDialog from '../overlay/components/ForgePublishDialog.vue';
import { applyShellLocale, shellI18n } from '../i18n';
import type { OverlayRequest } from '../../preload/overlay-channels';
import type { FlowStep, PublishAccount, PublishDialog, PublishOwnersAnswer, PublishStepId, PublishTarget } from '../../../shared/forge/publish';
import type { PopupAnswer } from '../../preload/overlay-channels';
import { fakeOverlayApi, type FakeOverlayApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(async () => {
  await applyShellLocale('en');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

// sample data
const ALEXIOS: PublishAccount = { accountId: 'gitlab.com|1', serverName: 'gitlab.com', login: 'alexios-s', kind: 'gitlab', personal: { value: 'gitlab.com|alexios-s|personal', kind: 'personal', path: 'alexios-s', internal: true } };
const ASTEF: PublishAccount = { accountId: 'gitlab.indigital.gr|32', serverName: 'gitlab.indigital.gr', login: 'astefanopoulos', kind: 'gitlab', personal: { value: 'gitlab.indigital.gr|astefanopoulos|personal', kind: 'personal', path: 'astefanopoulos', internal: true } };
const GITHUB: PublishAccount = { accountId: 'github.com|7', serverName: 'github.com', login: 'astefanopoulos', kind: 'github', personal: { value: 'github.com|astefanopoulos|personal', kind: 'personal', path: 'astefanopoulos', internal: false } };
const DIALOG: PublishDialog = {
  requestId: 'publish-1',
  project: 'damocles',
  branch: 'main',
  accounts: [ALEXIOS, ASTEF, GITHUB],
  defaultOwner: 'gitlab.com|alexios-s|personal',
  defaultName: 'damocles',
};
const LISTED: Readonly<Record<string, PublishOwnersAnswer>> = {
  [ALEXIOS.accountId]: { status: 'loaded', truncated: false, owners: [{ value: 'gitlab.com|alexios-s|indigital-oss', kind: 'group', path: 'indigital-oss', internal: true }] },
  [ASTEF.accountId]: {
    status: 'loaded', truncated: false, owners: [
      { value: 'gitlab.indigital.gr|astefanopoulos|grp', kind: 'group', path: 'grp', internal: true },
      { value: 'gitlab.indigital.gr|astefanopoulos|grp/platform', kind: 'group', path: 'grp/platform', internal: true },
    ],
  },
  [GITHUB.accountId]: { status: 'error', message: 'github.com did not list the organizations of astefanopoulos.' },
};

const TARGET: PublishTarget = { serverName: 'gitlab.com', path: 'alexios-s/damocles-fork', login: 'alexios-s', branch: 'main' };
const steps = (...states: Array<FlowStep<PublishStepId>['state']>): FlowStep<PublishStepId>[] => (['create', 'origin', 'push'] as const).map((step, index) => ({ step, state: states[index] ?? 'pending' }));

// Each account's listing waits until the test answers it.
interface Listing { readonly accountId: string; readonly resolve: (answer: PopupAnswer<PublishOwnersAnswer>) => void; readonly reject: (error: Error) => void }

// OverlayApp adds a dialog inside a render flush, after the dialog layer's focus trap listens, as this host does.
async function open(options: { listed?: boolean } = {}): Promise<{ wrapper: VueWrapper; api: FakeOverlayApi; listings: Listing[] }> {
  const api = fakeOverlayApi();
  const listings: Listing[] = [];
  vi.mocked(api.forgePublishOwners).mockImplementation((_requestId, accountId) => new Promise((resolve, reject) => listings.push({ accountId, resolve, reject })));
  const request: Extract<OverlayRequest, { kind: 'forgePublish' }> = { kind: 'forgePublish', dialog: DIALOG };
  const shown = ref(false);
  const Host = defineComponent({ setup: () => () => (shown.value ? h(ForgePublishDialog, { api, request }) : null) });
  const host = mount(Host, { global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(host);
  shown.value = true;
  await flushPromises();
  if (options.listed !== false) {
    for (const listing of listings.splice(0)) listing.resolve({ ok: true, value: LISTED[listing.accountId]! });
    await flushPromises();
  }
  return { wrapper: host.findComponent(ForgePublishDialog), api, listings };
}

const $ = <T extends HTMLElement = HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);
const dialog = (): HTMLElement => $('forge-publish')!;
const owner = (): HTMLSelectElement => $<HTMLSelectElement>('forge-publish-owner')!;
const nameField = (): HTMLInputElement => $<HTMLInputElement>('forge-publish-name')!;
const radios = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
const titleOf = (element: HTMLElement): string => document.getElementById(element.getAttribute('aria-labelledby')!)!.textContent!.trim();
const labelOf = (control: HTMLElement): string => document.querySelector(`label[for="${control.id}"]`)!.textContent!.trim();
// the label's own text, without the screen reader's state after it
const stepLabels = (): string[] => [...document.querySelectorAll('[data-testid="flow-step"]')].map((row) => [...row.querySelector('span.font-medium')!.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim());

async function pick(value: string): Promise<void> {
  owner().value = value;
  owner().dispatchEvent(new Event('change'));
  await flushPromises();
}

async function type(text: string): Promise<void> {
  nameField().value = text;
  nameField().dispatchEvent(new Event('input'));
  await flushPromises();
}

const press = async (key: string): Promise<void> => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
};

describe('ForgePublishDialog', () => {
  it('is a dialog named "Publish <project>" with the Owner select grouped by account, its hint, the Name prefix and Private chosen', async () => {
    await open();
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(titleOf(dialog())).toBe('Publish damocles');
    expect(document.activeElement).toBe(owner());
    expect(labelOf(owner())).toBe('Owner');
    expect([...owner().querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['alexios-s on gitlab.com', 'astefanopoulos on gitlab.indigital.gr', 'astefanopoulos on github.com']);
    expect([...owner().options].map((option) => [option.value, option.textContent!.trim()])).toEqual([
      ['gitlab.com|alexios-s|personal', 'alexios-s (you)'],
      ['gitlab.com|alexios-s|indigital-oss', 'indigital-oss'],
      ['gitlab.indigital.gr|astefanopoulos|personal', 'astefanopoulos (you)'],
      ['gitlab.indigital.gr|astefanopoulos|grp', 'grp'],
      ['gitlab.indigital.gr|astefanopoulos|grp/platform', 'grp/platform'],
      ['github.com|astefanopoulos|personal', 'astefanopoulos (you)'],
    ]);
    expect(owner().value).toBe('gitlab.com|alexios-s|personal');
    await pick('gitlab.indigital.gr|astefanopoulos|grp');
    expect($('forge-publish-owner-hint')!.textContent!.trim()).toBe('Groups where astefanopoulos can create projects.');
    expect(labelOf(nameField())).toBe('Name');
    expect(nameField().value).toBe('damocles');
    expect($('forge-publish-prefix')!.textContent).toBe('gitlab.indigital.gr/grp/');
    expect($('forge-publish-prefix')!.getAttribute('aria-hidden')).toBe('true');
    expect(radios().map((radio) => [radio.textContent!.trim(), radio.getAttribute('aria-checked')])).toEqual([['Private', 'true'], ['Internal', 'false'], ['Public', 'false']]);
    expect($('forge-publish-go')!.textContent!.trim()).toBe('Publish');
    // a description, never the form's fields
    const description = document.getElementById(dialog().getAttribute('aria-describedby')!)!;
    expect(description.textContent!.replace(/\s+/g, ' ').trim()).toBe('Damocles creates the repository, adds it as origin and pushes main with the account you pick. This project then uses that account.');
    expect(description.contains(owner())).toBe(false);
  });

  it('follows the journey: the user namespace on gitlab.com, "damocles fork" typed as damocles-fork, Public, then Publish sends them', async () => {
    const { api } = await open();
    await pick('gitlab.com|alexios-s|personal');
    expect($('forge-publish-owner-hint')!.textContent!.trim()).toBe('Your own namespace on gitlab.com.');
    expect($('forge-publish-prefix')!.textContent).toBe('gitlab.com/alexios-s/');
    await type('damocles fork');
    expect(nameField().value).toBe('damocles-fork');
    radios()[2]!.click();
    await flushPromises();
    expect(radios()[2]!.getAttribute('aria-checked')).toBe('true');
    $('forge-publish-go')!.click();
    await flushPromises();
    expect(api.forgePublishSubmit).toHaveBeenCalledWith('publish-1', 'gitlab.com|alexios-s|personal', 'damocles-fork', 'public');
    expect($<HTMLButtonElement>('forge-publish-go')!.disabled).toBe(true);
  });

  it('keeps the caret where it was when a space typed mid-name becomes a dash', async () => {
    await open();
    nameField().value = 'damo cles';
    nameField().setSelectionRange(5, 5);
    nameField().dispatchEvent(new Event('input'));
    await flushPromises();
    expect(nameField().value).toBe('damo-cles');
    expect([nameField().selectionStart, nameField().selectionEnd]).toEqual([5, 5]);
  });

  it('offers Internal only where the owner allows it, and an Internal pick falls back to Private on an owner without it', async () => {
    await open();
    radios()[1]!.click();
    await flushPromises();
    await pick('github.com|astefanopoulos|personal');
    expect(radios().map((radio) => radio.textContent!.trim())).toEqual(['Private', 'Public']);
    expect(radios()[0]!.getAttribute('aria-checked')).toBe('true');
    // the account's organizations could not be listed: the hint says why beside whose namespace it is
    expect($('forge-publish-owner-hint')!.textContent!.trim()).toBe('Your own namespace on github.com.');
    const error = $('forge-publish-owners-error')!;
    expect(error.getAttribute('data-account')).toBe('github.com|7');
    expect(error.querySelector('[role="alert"]')!.textContent!.trim()).toBe('github.com did not list the organizations of astefanopoulos.');
  });

  it('refuses a name the servers cannot hold before asking main, shaking the field with the rule under it', async () => {
    const { api } = await open();
    await type('..');
    $('forge-publish-go')!.click();
    await flushPromises();
    expect(api.forgePublishSubmit).not.toHaveBeenCalled();
    expect($('forge-publish-refusal')!.textContent!.trim()).toBe('Use letters, digits, dots, dashes or underscores.');
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect($('forge-publish-name-box')!.classList.contains('d-shake')).toBe(true);
    expect(document.activeElement).toBe(nameField());
  });

  it('shows the server\'s refusal of a name: the form again, the field shaken and invalid, the reason as an alert; typing clears it', async () => {
    const { api } = await open();
    $('forge-publish-go')!.click();
    await flushPromises();
    api.forgePublishState({ requestId: 'publish-1', phase: 'running', target: { ...TARGET, serverName: 'gitlab.indigital.gr', path: 'grp/damocles' }, steps: steps('active'), cancellable: true });
    await flushPromises();
    api.forgePublishState({ requestId: 'publish-1', phase: 'refused', reason: 'gitlab.indigital.gr refused: grp already has a project named damocles. Choose another name.' });
    await flushPromises();
    expect(dialog().closest('.overlay-dialog')!.getAttribute('data-phase')).toBe('form');
    const refusal = $('forge-publish-refusal')!;
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(refusal.textContent!.trim()).toBe('gitlab.indigital.gr refused: grp already has a project named damocles. Choose another name.');
    expect(nameField().getAttribute('aria-describedby')).toBe(refusal.id);
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect($('forge-publish-name-box')!.classList.contains('d-shake')).toBe(true);
    expect(document.activeElement).toBe(nameField());
    expect($<HTMLButtonElement>('forge-publish-go')!.disabled).toBe(false);
    await type('damocles-2');
    expect($('forge-publish-refusal')).toBeNull();
    expect(nameField().getAttribute('aria-invalid')).toBeNull();
  });

  it('runs in the StepTimeline look with Cancel until the push, then nothing to press and Escape does nothing', async () => {
    const { wrapper, api } = await open();
    $('forge-publish-go')!.click();
    await flushPromises();
    api.forgePublishState({ requestId: 'publish-1', phase: 'running', target: TARGET, steps: steps('done', 'active'), cancellable: true });
    await flushPromises();
    expect(titleOf(dialog())).toBe('Publishing alexios-s/damocles-fork');
    expect($('forge-publish-form')!.style.display).toBe('none');
    expect(stepLabels()).toEqual(['Create alexios-s/damocles-fork on gitlab.com', 'Add it as origin', 'Push main as alexios-s']);
    expect([...document.querySelectorAll('[data-testid="flow-step"]')].map((row) => row.getAttribute('data-state'))).toEqual(['done', 'active', 'pending']);
    expect($('flow-progress')!.getAttribute('aria-valuetext')).toBe('1 of 3 steps done');
    expect(document.activeElement).toBe($('forge-publish-cancel'));

    api.forgePublishState({ requestId: 'publish-1', phase: 'running', target: TARGET, steps: steps('done', 'done', 'active'), cancellable: false });
    await flushPromises();
    expect($('forge-publish-cancel')).toBeNull();
    expect(document.activeElement).toBe(dialog());
    await press('Escape');
    expect(wrapper.emitted('answer')).toBeUndefined();
  });

  it('Cancel while the steps run answers dismissed', async () => {
    const { wrapper, api } = await open();
    api.forgePublishState({ requestId: 'publish-1', phase: 'running', target: TARGET, steps: steps('active'), cancellable: true });
    await flushPromises();
    $('forge-publish-cancel')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('a failed step shows the timeline\'s failure box under it, and Close takes focus', async () => {
    const { wrapper, api } = await open();
    api.forgePublishState({ requestId: 'publish-1', phase: 'failed', target: TARGET, steps: [{ step: 'create', state: 'done' }, { step: 'origin', state: 'done' }, { step: 'push', state: 'failed', failure: 'gitlab.com refused the push: pre-receive hook declined.' }] });
    await flushPromises();
    const failure = $('flow-failure')!;
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.closest('[data-testid="flow-step"]')!.getAttribute('data-step')).toBe('push');
    expect(failure.textContent!.trim()).toBe('gitlab.com refused the push: pre-receive hook declined.');
    expect(document.activeElement).toBe($('forge-publish-close'));
    $('forge-publish-close')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('done: the success badge, the status naming the repository and the binding, and Close', async () => {
    const { api } = await open();
    api.forgePublishState({ requestId: 'publish-1', phase: 'done', target: TARGET, steps: steps('done', 'done', 'done') });
    await flushPromises();
    expect(dialog().getAttribute('data-severity')).toBe('success');
    expect(titleOf(dialog())).toBe('Published alexios-s/damocles-fork');
    const status = $('forge-publish-status')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('Published gitlab.com/alexios-s/damocles-fork. This project now uses alexios-s on gitlab.com.');
    expect(document.activeElement).toBe($('forge-publish-close'));
  });

  it('ignores another request\'s state', async () => {
    const { api } = await open();
    api.forgePublishState({ requestId: 'publish-2', phase: 'done', target: TARGET, steps: steps('done', 'done', 'done') });
    await flushPromises();
    expect(titleOf(dialog())).toBe('Publish damocles');
  });

  it('says main could not start the publish on a line of its own, leaving the name valid, and takes Publish again', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api } = await open();
    vi.mocked(api.forgePublishSubmit).mockRejectedValueOnce(new Error('no handler'));
    $('forge-publish-go')!.click();
    await flushPromises();
    errors.mockRestore();
    const failed = $('forge-publish-start-failed')!;
    expect(failed.getAttribute('role')).toBe('alert');
    expect(failed.textContent!.trim()).toBe('Damocles could not start this publish.');
    expect(nameField().getAttribute('aria-invalid')).toBeNull();
    expect($('forge-publish-refusal')).toBeNull();
    expect($<HTMLButtonElement>('forge-publish-go')!.disabled).toBe(false);
    await type('other');
    expect($('forge-publish-start-failed')).toBeNull();
  });

  it('takes Publish again when main ignored the submit', async () => {
    const { api } = await open();
    vi.mocked(api.forgePublishSubmit).mockResolvedValueOnce({ ok: true, value: 'ignored' });
    $('forge-publish-go')!.click();
    await flushPromises();
    expect($<HTMLButtonElement>('forge-publish-go')!.disabled).toBe(false);
  });

  it('keeps the typed form and a running publish through a click beside the panel; Escape still cancels', async () => {
    const { wrapper, api } = await open();
    await type('typed name');
    const scrim = document.querySelector<HTMLElement>('.overlay-dialog')!;
    scrim.click();
    expect(wrapper.emitted('answer')).toBeUndefined();
    api.forgePublishState({ requestId: 'publish-1', phase: 'running', target: TARGET, steps: steps('active'), cancellable: true });
    await flushPromises();
    scrim.click();
    expect(wrapper.emitted('answer')).toBeUndefined();
    await press('Escape');
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('names the Visibility radios by their visible label', async () => {
    await open();
    const group = document.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('Visibility');
  });
});

describe('ForgePublishDialog: owners load inside the dialog, per account', () => {
  const statusOf = (): HTMLElement => $('forge-publish-owners-status')!;
  // what a screen reader reads of each line: the spinner and the sheen are hidden from it
  const loadingLines = (): string[] => [...document.querySelectorAll('[data-testid="forge-publish-owners-loading"]')].map((line) => [...line.children].filter((part) => part.getAttribute('aria-hidden') !== 'true').map((part) => part.textContent).join('').trim());
  const answer = async (listings: Listing[], accountId: string, value: PublishOwnersAnswer): Promise<void> => {
    const index = listings.findIndex((listing) => listing.accountId === accountId);
    listings.splice(index, 1)[0]!.resolve({ ok: true, value });
    await flushPromises();
  };

  it("opens at once with each account's own namespace, asks each account's listing, and keeps Name, Visibility and Publish usable meanwhile", async () => {
    const { api, listings } = await open({ listed: false });
    expect(vi.mocked(api.forgePublishOwners).mock.calls).toEqual([['publish-1', 'gitlab.com|1'], ['publish-1', 'gitlab.indigital.gr|32'], ['publish-1', 'github.com|7']]);
    expect(listings).toHaveLength(3);
    expect([...owner().options].map((option) => [option.value, option.textContent!.trim(), option.disabled])).toEqual([
      ['gitlab.com|alexios-s|personal', 'alexios-s (you)', false],
      ['', 'Loading groups…', true],
      ['gitlab.indigital.gr|astefanopoulos|personal', 'astefanopoulos (you)', false],
      ['', 'Loading groups…', true],
      ['github.com|astefanopoulos|personal', 'astefanopoulos (you)', false],
      ['', 'Loading organizations…', true],
    ]);
    expect(statusOf().getAttribute('role')).toBe('status');
    expect(statusOf().getAttribute('aria-atomic')).toBe('false');
    expect(loadingLines()).toEqual([
      'Listing the groups of alexios-s on gitlab.com…',
      'Listing the groups of astefanopoulos on gitlab.indigital.gr…',
      'Listing the organizations of astefanopoulos on github.com…',
    ]);
    expect(statusOf().querySelectorAll('.d-sheen')).toHaveLength(3);
    await type('damocles fork');
    expect(nameField().value).toBe('damocles-fork');
    radios()[2]!.click();
    await flushPromises();
    expect(radios()[2]!.getAttribute('aria-checked')).toBe('true');
    expect($<HTMLButtonElement>('forge-publish-go')!.disabled).toBe(false);
    $('forge-publish-go')!.click();
    await flushPromises();
    expect(api.forgePublishSubmit).toHaveBeenCalledWith('publish-1', 'gitlab.com|alexios-s|personal', 'damocles-fork', 'public');
  });

  it("adds an account's groups as its listing answers and says so politely, while the others still load", async () => {
    const { listings } = await open({ listed: false });
    await answer(listings, ASTEF.accountId, LISTED[ASTEF.accountId]!);
    expect([...owner().querySelectorAll('optgroup')][1]!.querySelectorAll('option').length).toBe(3);
    expect(loadingLines()).toEqual(['Listing the groups of alexios-s on gitlab.com…', 'Listing the organizations of astefanopoulos on github.com…']);
    expect(statusOf().querySelector('[data-testid="forge-publish-owners-loaded"]')!.textContent!.trim()).toBe('Listed 2 groups for astefanopoulos on gitlab.indigital.gr.');
    await pick('gitlab.indigital.gr|astefanopoulos|grp/platform');
    expect($('forge-publish-prefix')!.textContent).toBe('gitlab.indigital.gr/grp/platform/');
  });

  it("shows an account's failure as an alert with Try again, which asks again with focus on Owner and lists what it answers", async () => {
    const { api, listings } = await open({ listed: false });
    await answer(listings, GITHUB.accountId, { status: 'error', message: 'github.com did not answer.' });
    const error = $('forge-publish-owners-error')!;
    expect(error.querySelector('[role="alert"]')!.textContent!.trim()).toBe('github.com did not answer.');
    expect(error.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
    const retry = $<HTMLButtonElement>('forge-publish-owners-retry')!;
    expect(retry.getAttribute('aria-label')).toBe('Try again for astefanopoulos on github.com');
    retry.focus();
    retry.click();
    await flushPromises();
    expect(vi.mocked(api.forgePublishOwners).mock.calls.filter(([, accountId]) => accountId === GITHUB.accountId)).toHaveLength(2);
    expect($('forge-publish-owners-error')).toBeNull();
    expect(document.activeElement).toBe(owner());
    expect(loadingLines()).toContain('Listing the organizations of astefanopoulos on github.com…');
    await answer(listings, GITHUB.accountId, { status: 'loaded', truncated: false, owners: [{ value: 'github.com|astefanopoulos|indigital', kind: 'org', path: 'indigital', internal: false }] });
    expect([...owner().options].map((option) => option.value)).toContain('github.com|astefanopoulos|indigital');
    expect(statusOf().textContent).toContain('Listed 1 organization for astefanopoulos on github.com.');
  });

  it('says why when main could not ask for a listing at all', async () => {
    const { listings } = await open({ listed: false });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listings.find((listing) => listing.accountId === ALEXIOS.accountId)!.reject(new Error('no handler'));
    await flushPromises();
    expect($('forge-publish-owners-error')!.textContent).toContain('Damocles could not ask where alexios-s on gitlab.com can publish.');
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('says when a list was cut at the page limit', async () => {
    const { listings } = await open({ listed: false });
    await answer(listings, ASTEF.accountId, { ...(LISTED[ASTEF.accountId] as Extract<PublishOwnersAnswer, { status: 'loaded' }>), truncated: true });
    const hint = $('forge-publish-owners-truncated')!;
    expect(hint.closest('[role="status"]')).toBe(statusOf());
    expect(hint.textContent!.trim()).toBe('Only the first 2 groups of astefanopoulos on gitlab.indigital.gr are listed. The server has more.');
  });

  it('drops a cancelled answer and keeps the listing that replaced it', async () => {
    const { listings } = await open({ listed: false });
    await answer(listings, GITHUB.accountId, { status: 'error', message: 'github.com did not answer.' });
    $('forge-publish-owners-retry')!.click();
    await flushPromises();
    await answer(listings, GITHUB.accountId, { status: 'cancelled' });
    expect(loadingLines()).toContain('Listing the organizations of astefanopoulos on github.com…');
    expect($('forge-publish-owners-error')).toBeNull();
  });

  it('closing with listings in flight answers dismissed, and their cancelled answers change nothing', async () => {
    const { wrapper, listings } = await open({ listed: false });
    $('forge-publish-cancel')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
    const errors = vi.spyOn(console, 'error');
    for (const listing of listings.splice(0)) listing.resolve({ ok: true, value: { status: 'cancelled' } });
    await flushPromises();
    expect(errors).not.toHaveBeenCalled();
    expect($('forge-publish-owners-error')).toBeNull();
    expect(loadingLines()).toHaveLength(3);
    errors.mockRestore();
  });
});
