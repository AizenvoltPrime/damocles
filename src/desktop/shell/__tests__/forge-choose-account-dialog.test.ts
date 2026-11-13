// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ForgeChooseAccountDialog from '../overlay/components/ForgeChooseAccountDialog.vue';
import { applyShellLocale, shellI18n } from '../i18n';
import type { OverlayRequest } from '../../preload/overlay-channels';
import type { ForgeChooseAccountDialog as Dialog } from '../../preload/forge-channels';
import type { RepoAccountOption } from '../../../shared/forge/bindings';
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
const ALEXIOS: RepoAccountOption = { id: 'gitlab.com|1', login: 'alexios-s', name: 'Alexios S.', needsSignIn: false, canPush: true, owner: true };
const WORK: RepoAccountOption = { id: 'gitlab.com|2', login: 'work-alexios', name: 'Alexios at Indigital', needsSignIn: false, canPush: true };

// preselectId undefined: nothing preselected yet
type Fields = Partial<Omit<Dialog, 'preselectId'>> & { readonly preselectId?: string | undefined };

function dialogOf({ preselectId = ALEXIOS.id, ...fields }: Fields = {}): Dialog {
  return {
    requestId: 'ask-1',
    projectKey: 'C:/work/damocles',
    project: 'damocles',
    serverId: 'gitlab.com',
    server: 'gitlab.com',
    kind: 'gitlab',
    repoPath: 'alexios-s/damocles',
    operation: 'push',
    accounts: [ALEXIOS, WORK],
    checking: false,
    ...(preselectId !== undefined ? { preselectId } : {}),
    ...fields,
  };
}

async function open(fields: Fields = {}): Promise<{ wrapper: VueWrapper; api: FakeOverlayApi }> {
  const api = fakeOverlayApi();
  const request: Extract<OverlayRequest, { kind: 'forgeChooseAccount' }> = { kind: 'forgeChooseAccount', dialog: dialogOf(fields) };
  const wrapper = mount(ForgeChooseAccountDialog, { props: { api, request }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, api };
}

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="forge-ask"]')!;
const list = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="forge-ask-list"]')!;
const options = (): HTMLElement[] => [...list().querySelectorAll<HTMLElement>('[role="option"]')];
// what a row shows: its parts that v-show leaves displayed
const shown = (root: ParentNode, selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => element.style.display !== 'none');
const shownText = (option: HTMLElement): string => shown(option, 'span').filter((part) => part.querySelector('span') === null && part.closest('[style*="display: none"]') === null).map((part) => part.textContent!.trim()).join(' ');
const confirm = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-testid="forge-ask-confirm"]')!;
const press = async (key: string): Promise<void> => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
};

describe('ForgeChooseAccountDialog', () => {
  it('is an alertdialog named by its question, with the numbered listbox and a primary button naming the pick', async () => {
    await open();
    expect(dialog().getAttribute('role')).toBe('alertdialog');
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent?.trim()).toBe('Which gitlab.com account should damocles use?');
    expect(list().getAttribute('aria-label')).toBe('Account for gitlab.com');
    // the description is the where-line and the message, never the options
    const description = document.getElementById(dialog().getAttribute('aria-describedby')!)!;
    expect(description.contains(list())).toBe(false);
    expect(description.textContent).toContain('Damocles remembers your choice for this project.');
    expect(document.activeElement).toBe(list());
    expect(options().map((option) => option.getAttribute('aria-keyshortcuts'))).toEqual(['1', '2', '3', '4']);
    expect(options()[2]!.textContent).toContain("Use Git's own credentials");
    expect(options()[3]!.textContent).toContain('Sign in with another account…');
    expect(confirm().textContent?.trim()).toBe('Use alexios-s');
    expect(options()[0]!.querySelector('[data-testid="forge-ask-owner"]')!.textContent).toBe('owner');
    expect(document.querySelector('[data-testid="forge-ask-where"]')!.textContent).toContain('gitlab.com/alexios-s/damocles');
  });

  it('moves with ArrowDown, renames the primary button and answers the account with it', async () => {
    const { wrapper } = await open();
    await press('ArrowDown');
    expect(confirm().textContent?.trim()).toBe('Use work-alexios');
    confirm().click();
    await flushPromises();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'forgeChooseAccount', accountId: WORK.id }]]);
  });

  it('picks with the digits and confirms with Enter: 3 is Git\'s own credentials, 4 signs in with another account', async () => {
    const { wrapper } = await open();
    await press('3');
    expect(confirm().textContent?.trim()).toBe("Use Git's own credentials");
    await press('4');
    expect(confirm().textContent?.trim()).toBe('Sign in…');
    await press('Enter');
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'forgeChooseAccount', signIn: true }]]);
  });

  it('answers null for Git\'s own credentials', async () => {
    const { wrapper } = await open();
    await press('3');
    await press('Enter');
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'forgeChooseAccount', accountId: null }]]);
  });

  it('cancels with Escape and with the scrim, answering dismissed', async () => {
    const first = await open();
    await press('Escape');
    expect(first.wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
    first.wrapper.unmount();
    mounted.splice(0);
    document.body.innerHTML = '';
    const second = await open();
    document.querySelector<HTMLElement>('.overlay-dialog')!.click();
    await flushPromises();
    expect(second.wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('shows checking access until the rows arrive, then the access and the preselection the check found', async () => {
    const unchecked = ({ canPush: _canPush, owner: _owner, ...account }: RepoAccountOption): RepoAccountOption => ({ ...account, checking: true });
    const pending = [unchecked(ALEXIOS), unchecked(WORK)];
    const { api } = await open({ accounts: pending, checking: true, preselectId: undefined });
    expect(list().getAttribute('aria-busy')).toBe('true');
    expect(shown(document, '[data-testid="forge-ask-checking"]')).toHaveLength(2);
    expect(shown(document, '[data-testid="forge-ask-message"]').map((message) => message.textContent!.trim())).toEqual([expect.stringContaining('Damocles is checking which of them can push here')]);
    api.forgeRows({ requestId: 'other', accounts: [], checking: false });
    await flushPromises();
    expect(shown(document, '[data-testid="forge-ask-checking"]')).toHaveLength(2);
    api.forgeRows({ requestId: 'ask-1', accounts: [{ ...ALEXIOS, canPush: false, owner: false }, { ...WORK, owner: true }], checking: false, preselectId: WORK.id });
    await flushPromises();
    expect(shown(document, '[data-testid="forge-ask-checking"]')).toHaveLength(0);
    expect(shownText(options()[0]!)).toContain('read only');
    expect(shownText(options()[1]!)).toContain('can push');
    expect(shownText(options()[1]!)).not.toContain('read only');
    expect(shown(options()[1]!, '[data-testid="forge-ask-owner"]')).toHaveLength(1);
    expect(shown(options()[0]!, '[data-testid="forge-ask-owner"]')).toHaveLength(0);
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(confirm().textContent?.trim()).toBe('Use work-alexios');
  });

  it('ends an account\'s checking access when its own check ends, while another account\'s check still runs', async () => {
    const { api } = await open({ accounts: [{ ...ALEXIOS, checking: true }, { ...WORK, checking: true }], checking: true, preselectId: undefined });
    const { canPush: _canPush, owner: _owner, ...unreachable } = ALEXIOS;
    api.forgeRows({ requestId: 'ask-1', accounts: [unreachable, { ...WORK, checking: true }], checking: true });
    await flushPromises();
    expect(shown(options()[0]!, '[data-testid="forge-ask-checking"]')).toHaveLength(0);
    expect(shownText(options()[0]!)).toBe('1 A alexios-s Alexios S.');
    expect(shown(options()[1]!, '[data-testid="forge-ask-checking"]')).toHaveLength(1);
  });

  it('says SSO required and not approved for an account its organization refused', async () => {
    const { canPush: _alexiosPush, owner: _owner, ...alexios } = ALEXIOS;
    const { canPush: _workPush, ...work } = WORK;
    await open({ accounts: [{ ...alexios, ssoRequired: true }, { ...work, appNotApproved: true }] });
    expect(shownText(options()[0]!)).toBe('1 A alexios-s Alexios S. · SSO required');
    expect(shownText(options()[1]!)).toBe('2 W work-alexios Alexios at Indigital · not approved by the organization');
  });

  it('removes no node as the rows update, which would make the alert dialog\'s focus scope take focus from the list', async () => {
    const { api } = await open({ checking: true, preselectId: undefined });
    const removed: Node[] = [];
    const observer = new MutationObserver((mutations) => removed.push(...mutations.flatMap((mutation) => [...mutation.removedNodes])));
    observer.observe(dialog(), { childList: true, subtree: true });
    api.forgeRows({ requestId: 'ask-1', accounts: [{ ...ALEXIOS, canPush: false }, WORK], checking: false, preselectId: WORK.id });
    await flushPromises();
    observer.disconnect();
    expect(removed).toEqual([]);
    expect(shown(document, '[data-testid="forge-ask-message"]').map((message) => message.textContent!.trim())).toEqual([expect.stringContaining('Damocles remembers your choice')]);
  });

  it('keeps the user\'s own pick when the access check answers later', async () => {
    const { api } = await open({ checking: true, preselectId: undefined });
    await press('3');
    api.forgeRows({ requestId: 'ask-1', accounts: [ALEXIOS, WORK], checking: false, preselectId: WORK.id });
    await flushPromises();
    expect(confirm().textContent?.trim()).toBe("Use Git's own credentials");
  });

  it('shows the remote host badge in the where-line, and admin for a GitHub owner', async () => {
    await open({ where: { hostName: 'prod-1' }, kind: 'github', server: 'github.com', serverId: 'github.com' });
    expect(document.querySelector('[data-testid="forge-ask-host"]')!.textContent).toContain('prod-1');
    expect(document.querySelector('[data-testid="forge-ask-where"]')!.textContent).toContain('damocles');
    expect(options()[0]!.querySelector('[data-testid="forge-ask-owner"]')!.textContent).toBe('admin');
  });

  it('speaks Greek when the UI is Greek', async () => {
    await applyShellLocale('el');
    await open();
    expect(dialog().textContent).toContain('Ποιον λογαριασμό gitlab.com να χρησιμοποιεί το damocles;');
  });
});
