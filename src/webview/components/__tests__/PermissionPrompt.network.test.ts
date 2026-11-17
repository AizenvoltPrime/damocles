// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import PermissionPrompt from '../PermissionPrompt.vue';
import { i18n, loadLocale } from '@/i18n';
import type { PermissionDetail } from '@shared/types/permissions';

// The approval card for a file tool whose path may reach a network host, on Windows: core's words name the computer and
// say that opening the path sends the user's Windows sign-in there (`networkPathDetail`, core/pi-session/permission-gate.ts).

// pathLabel and written: the path fact core puts first, the paths as the agent wrote them, one per line
const onHost = (title: string, pathLabel: string, written: string): PermissionDetail => ({
  title: { message: title, args: ['fileserver'] },
  subtitle: { message: 'opening it sends your Windows sign-in to that computer' },
  facts: [{ label: { message: pathLabel }, value: written }, { label: { message: 'Computer' }, value: 'fileserver' }],
  approvedStatus: { message: 'Allowed once. Your Windows sign-in goes to {0}.', args: ['fileserver'] },
});

const DEVICE: PermissionDetail = {
  title: { message: 'Read a file that may be on another computer?' },
  subtitle: { message: 'opening it may send your Windows sign-in to another computer' },
  facts: [{ label: { message: 'File' }, value: '\\\\?\\C:\\x.txt' }],
  approvedStatus: { message: 'Allowed once. Your Windows sign-in may go to another computer.' },
};

const kindIcon = (wrapper: VueWrapper): string | undefined =>
  wrapper.get('header svg').classes().find((name) => name.startsWith('lucide-') && !name.endsWith('-icon'));

const mounted: VueWrapper[] = [];

// what a screen reader reads: the text without aria-hidden parts (the visual separators)
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

describe('PermissionPrompt for a path on another computer', () => {
  it('names the file and the computer in the facts, says the sign-in goes there, and hides the raw input', () => {
    const wrapper = prompt({ toolName: 'Read', toolInput: { file_path: '\\\\fileserver\\share\\a.txt' }, ...onHost('Read a file on {0}?', 'File', '\\\\fileserver\\share\\a.txt') });
    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe('Read a file on fileserver?');
    expect(spoken(wrapper.get('[data-testid="permission-subtitle"]').element)).toBe('Read, opening it sends your Windows sign-in to that computer');
    const facts = wrapper.get('[data-testid="permission-facts"]');
    expect(facts.findAll('dt').map((term) => term.text())).toEqual(['File', 'Computer']);
    expect(facts.findAll('dd').map((value) => value.text())).toEqual(['\\\\fileserver\\share\\a.txt', 'fileserver']);
    expect(wrapper.find('[data-testid="tool-permission-input"]').exists()).toBe(false);
    expect(optionLabels(wrapper)).toEqual(['Yes', 'No']);
  });

  it('shows a search\'s card in Greek', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    const wrapper = prompt({ toolName: 'Grep', toolInput: { pattern: 'a', path: '\\\\fileserver\\share' }, ...onHost('Search files on {0}?', 'Folder', '\\\\fileserver\\share') });
    await nextTick();
    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe('Αναζήτηση αρχείων σε fileserver;');
    expect(spoken(wrapper.get('[data-testid="permission-subtitle"]').element))
      .toBe('Grep, το άνοιγμά του στέλνει τα στοιχεία σύνδεσής σας στα Windows σε εκείνον τον υπολογιστή');
    expect(wrapper.findAll('[data-testid="permission-facts"] dt').map((term) => term.text())).toEqual(['Φάκελος', 'Υπολογιστής']);
  });

  it('lists each file of an upload from several on its own line, spaces as written', async () => {
    const written = '\\\\fileserver\\s\\a  b.png\n\\\\fileserver\\s\\c.png';
    const detail: PermissionDetail = { ...onHost('Upload files from {0}?', 'Files', written), subtitle: { message: 'opening them sends your Windows sign-in to that computer' } };
    const wrapper = prompt({ toolName: 'BrowserUpload', toolInput: { paths: written.split('\n') }, ...detail });
    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe('Upload files from fileserver?');
    const value = wrapper.get('[data-testid="permission-facts"] dd span[dir="ltr"]');
    expect(value.text()).toBe(written);
    expect(value.classes()).toContain('whitespace-pre-wrap');
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    await nextTick();
    expect(wrapper.get('[data-testid="permission-facts"] dt').text()).toBe('Αρχεία');
  });

  it('shows the card in place of the diff for an Edit or a Write, with the edit icon and no accept-all, which acceptEdits would ask again for', () => {
    for (const [toolName, toolInput] of [
      ['Edit', { file_path: '\\\\fileserver\\share\\a.txt', old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: '\\\\fileserver\\share\\b.txt', content: 'x' }],
    ] as const) {
      const withDiff = prompt({ toolName, toolInput, filePath: toolInput.file_path });
      const wrapper = prompt({ toolName, toolInput, filePath: toolInput.file_path, ...onHost('Change a file on {0}?', 'File', toolInput.file_path) });
      expect(wrapper.get('[data-testid="permission-title"]').text()).toBe('Change a file on fileserver?');
      expect(spoken(wrapper.get('[data-testid="permission-subtitle"]').element)).toBe(`${toolName}, opening it sends your Windows sign-in to that computer`);
      expect(wrapper.findAll('[data-testid="permission-facts"] dd').map((value) => value.text())).toEqual([toolInput.file_path, 'fileserver']);
      expect(wrapper.find('[data-testid="permission-open-diff"]').exists()).toBe(false);
      expect(withDiff.find('[data-testid="permission-open-diff"]').exists()).toBe(true);
      expect(kindIcon(wrapper)).toBe('lucide-pencil-line');
      expect(optionLabels(withDiff)).toEqual(['Yes', 'Yes, and accept all edits this session', 'No']);
      expect(optionLabels(wrapper)).toEqual(['Yes', 'No']);
    }
  });

  it('words a device path\'s card without a host and names the path as written', () => {
    const wrapper = prompt({ toolName: 'Read', toolInput: { file_path: '\\\\?\\C:\\x.txt' }, ...DEVICE });
    expect(wrapper.get('[data-testid="permission-title"]').text()).toBe('Read a file that may be on another computer?');
    expect(spoken(wrapper.get('[data-testid="permission-subtitle"]').element)).toBe('Read, opening it may send your Windows sign-in to another computer');
    expect(wrapper.findAll('[data-testid="permission-facts"] dd').map((value) => value.text())).toEqual(['\\\\?\\C:\\x.txt']);
    expect(wrapper.find('[data-testid="tool-permission-input"]').exists()).toBe(false);
  });
});
