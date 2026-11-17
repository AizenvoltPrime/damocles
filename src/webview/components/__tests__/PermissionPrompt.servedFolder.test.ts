// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import PermissionPrompt from '../PermissionPrompt.vue';
import { i18n, loadLocale } from '@/i18n';
import type { PermissionDetail } from '@shared/types/permissions';

// The approval card for a browser load of a file page outside the chat's folders: core's words name the action, the file and
// the folder a yes serves to the chat (`outsideFolderDetail`, core/pi-session/permission-gate.ts).

const FOLDER: PermissionDetail = {
  title: { message: 'Open a page outside this chat\'s folders?' },
  subtitle: { message: 'the page can read every file in its folder and its subfolders until the chat closes' },
  facts: [{ label: { message: 'File' }, value: 'C:\\Users\\u\\Downloads\\report\\index.html' }, { label: { message: 'Folder served' }, value: 'C:\\Users\\u\\Downloads\\report' }],
  approvedStatus: { message: 'Allowed. This chat\'s browser serves {0} until the chat closes.', args: ['C:\\Users\\u\\Downloads\\report'] },
};

const mounted: VueWrapper[] = [];

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

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  i18n.global.locale.value = 'en';
});

describe('PermissionPrompt for a page outside the chat\'s folders', () => {
  it('names the file and the folder served, says what the page can read, and offers only Yes and No', async () => {
    const wrapper = prompt({ toolName: 'BrowserOpen', toolInput: { url: 'file:///C:/Users/u/Downloads/report/index.html' }, ...FOLDER });
    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe('Open a page outside this chat\'s folders?');
    expect(spoken(wrapper.get('[data-testid="permission-subtitle"]').element)).toBe('BrowserOpen, the page can read every file in its folder and its subfolders until the chat closes');
    const facts = wrapper.get('[data-testid="permission-facts"]');
    expect(facts.findAll('dt').map((term) => term.text())).toEqual(['File', 'Folder served']);
    expect(facts.findAll('dd').map((value) => value.text())).toEqual(['C:\\Users\\u\\Downloads\\report\\index.html', 'C:\\Users\\u\\Downloads\\report']);
    expect(wrapper.find('[data-testid="tool-permission-input"]').exists()).toBe(false);
    expect(optionLabels(wrapper)).toEqual(['Yes', 'No']);
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    await nextTick();
    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe('Άνοιγμα σελίδας εκτός των φακέλων αυτής της συνομιλίας;');
    expect(wrapper.findAll('[data-testid="permission-facts"] dt').map((term) => term.text())).toEqual(['Αρχείο', 'Φάκελος που διατίθεται']);
  });
});
