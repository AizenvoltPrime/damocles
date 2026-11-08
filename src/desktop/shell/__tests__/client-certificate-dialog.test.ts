// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ClientCertificateDialog from '../overlay/components/ClientCertificateDialog.vue';
import { applyShellLocale, shellI18n } from '../i18n';
import type { ClientCertificateRow, OverlayRequest } from '../../preload/overlay-channels';

const mounted: VueWrapper[] = [];

beforeEach(async () => {
  await applyShellLocale('en');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

// 2024-01-15 and 2030-06-01, UTC noon so no time zone moves the day
const START = Date.UTC(2024, 0, 15, 12) / 1000;
const EXPIRY = Date.UTC(2030, 5, 1, 12) / 1000;
const row = (id: string, subject: string, fields: Partial<ClientCertificateRow> = {}): ClientCertificateRow => ({ id, subject, issuer: 'Corp CA', validStart: START, validExpiry: EXPIRY, distinct: true, ...fields });

async function open(certificates: readonly ClientCertificateRow[]): Promise<VueWrapper> {
  const request: Extract<OverlayRequest, { kind: 'clientCertificate' }> = { kind: 'clientCertificate', site: 'intranet.example.test', certificates };
  const wrapper = mount(ClientCertificateDialog, { props: { request }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="client-certificate"]')!;
const list = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="client-certificate-list"]')!;
const options = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="client-certificate-option"]')];
const press = async (key: string): Promise<void> => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
};

describe('ClientCertificateDialog', () => {
  it('is a dialog titled with the site, listing each certificate\'s subject, issuer and validity in the UI locale', async () => {
    await open([row('0', 'alice'), row('1', 'bob', { issuer: 'Other CA', validExpiry: START + 1 })]);
    expect(dialog().getAttribute('role')).toBe('alertdialog');
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent?.trim()).toBe('Choose a certificate for intranet.example.test');
    expect(list().getAttribute('role')).toBe('listbox');
    expect(list().getAttribute('aria-label')).toBe('Certificates for intranet.example.test');
    expect(options().map((option) => option.getAttribute('role'))).toEqual(['option', 'option']);
    const first = options()[0]!;
    expect(first.querySelector('[data-testid="client-certificate-subject"]')!.textContent).toBe('alice');
    expect(first.querySelector('[data-testid="client-certificate-issuer"]')!.textContent).toBe('Issued by Corp CA');
    const format = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
    expect(first.querySelector('[data-testid="client-certificate-validity"]')!.textContent).toContain(`Valid from ${format.format(START * 1000)} to ${format.format(EXPIRY * 1000)}`);
    expect(options()[1]!.textContent).toContain('Other CA');
    expect(options()[1]!.textContent).toContain('Expired');
  });

  it('formats validity in Greek when the UI is Greek', async () => {
    await applyShellLocale('el');
    await open([row('0', 'alice')]);
    const format = new Intl.DateTimeFormat('el', { dateStyle: 'medium' });
    expect(options()[0]!.textContent).toContain(`Ισχύει από ${format.format(START * 1000)} έως ${format.format(EXPIRY * 1000)}`);
    expect(dialog().textContent).toContain('Επιλέξτε πιστοποιητικό για τον ιστότοπο intranet.example.test');
  });

  it('focuses the list, moves with the arrow keys and chooses with Enter', async () => {
    const wrapper = await open([row('0', 'alice'), row('1', 'bob'), row('2', 'carol')]);
    expect(document.activeElement).toBe(list());
    expect(list().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowDown');
    // focus stays on the list as the highlight moves
    expect(document.activeElement).toBe(list());
    expect(list().getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true');
    await press('ArrowUp');
    await press('Enter');
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'clientCertificate', id: '1' }]]);
  });

  it('chooses the highlighted certificate with Use Certificate, and Home and End reach the ends', async () => {
    const wrapper = await open([row('0', 'alice'), row('1', 'bob'), row('2', 'carol')]);
    await press('End');
    expect(list().getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
    await press('Home');
    expect(list().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    options()[1]!.click();
    await flushPromises();
    document.querySelector<HTMLElement>('[data-testid="client-certificate-use"]')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'clientCertificate', id: '1' }]]);
  });

  it('cancels on Escape and on Cancel', async () => {
    const escaped = await open([row('0', 'alice')]);
    await press('Escape');
    expect(escaped.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
    escaped.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    const cancelled = await open([row('0', 'alice')]);
    document.querySelector<HTMLElement>('[data-testid="client-certificate-cancel"]')!.click();
    expect(cancelled.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('never chooses a certificate Chrome could not tell apart, and says why', async () => {
    const wrapper = await open([row('0', 'twin', { distinct: false }), row('1', 'twin', { distinct: false }), row('2', 'bob')]);
    expect(list().getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
    expect(options()[0]!.getAttribute('aria-disabled')).toBe('true');
    expect(options()[0]!.querySelector('[data-testid="client-certificate-indistinct"]')!.textContent).toBe('Another certificate has the same names, so the browser cannot tell them apart.');
    await press('Home');
    await press('Enter');
    expect(document.querySelector<HTMLButtonElement>('[data-testid="client-certificate-use"]')!.disabled).toBe(true);
    expect(wrapper.emitted('answer')).toBeUndefined();
  });

  it('keeps Tab inside the dialog', async () => {
    await open([row('0', 'alice')]);
    const use = document.querySelector<HTMLElement>('[data-testid="client-certificate-use"]')!;
    use.focus();
    await press('Tab');
    expect(document.activeElement).toBe(list());
  });
});
