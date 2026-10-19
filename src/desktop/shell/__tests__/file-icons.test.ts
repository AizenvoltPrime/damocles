// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { FileCode, Folder, FolderOpen } from 'lucide-vue-next';
import FileIcon from '../components/FileIcon.vue';
import { materialIconName, materialIconNames } from '../material-icons';

describe('materialIconName', () => {
  const file = (path: string, kind: 'dark' | 'light' = 'dark'): string => materialIconName(path, false, false, kind);

  it('matches a file name before its extensions, case-insensitively', () => {
    expect(file('package.json')).toBe('nodejs');
    expect(file('src/Package.JSON')).toBe('nodejs');
    expect(file('other.json')).toBe('json');
  });

  it('tries the longest extension first', () => {
    expect(file('types.d.ts')).toBe('typescript-def');
    expect(file('app.spec.ts')).toBe('test-ts');
    expect(file('app.ts')).toBe('typescript');
    expect(file('.gitignore')).toBe('git');
  });

  it('matches a name qualified by its parent folder before the bare name', () => {
    expect(materialIconName('.github/workflows', true, false, 'dark')).not.toBe(materialIconName('workflows', true, false, 'dark'));
    expect(file('repo\\.config\\eslintrc.yml')).toBe(file('.eslintrc.yml'));
  });

  it('opens a folder icon into its open counterpart', () => {
    expect(materialIconName('src', true, false, 'dark')).toBe('folder-src');
    expect(materialIconName('a/src', true, true, 'dark')).toBe('folder-src-open');
    expect(materialIconName('no-such-folder', true, true, 'dark')).toBe('folder-open');
  });

  it('takes the light theme override where there is one', () => {
    expect(materialIconName('.idea', true, false, 'light')).toBe('folder-intellij_light');
    expect(materialIconName('.idea', true, true, 'light')).toBe('folder-intellij-open_light');
    expect(materialIconName('.idea', true, false, 'dark')).toBe('folder-intellij');
    expect(file('app.ts', 'light')).toBe('typescript');
  });

  it('falls back to the default icons, also for names on Object.prototype', () => {
    expect(file('notes.unknownext')).toBe('file');
    expect(file('constructor')).toBe('file');
    expect(file('x.__proto__')).toBe('file');
    expect(materialIconName('constructor', true, false, 'dark')).toBe('folder');
  });

  it('lists every icon a lookup can return for the build to emit', () => {
    const names = materialIconNames();
    for (const name of ['file', 'folder', 'folder-open', 'typescript', 'folder-src-open', 'folder-intellij-open_light']) expect(names.has(name)).toBe(true);
  });
});

describe('FileIcon', () => {
  const ICONS = 'app://damocles/desktop-shell/file-icons/';
  const settle = async (): Promise<void> => {
    // the MutationObserver callback, then the re-render it schedules
    await nextTick();
    await nextTick();
  };
  const host = async (kind: 'dark' | 'light', fileIconTheme: 'material' | 'minimal'): Promise<void> => {
    document.body.dataset['vscodeThemeKind'] = `vscode-${kind}`;
    document.documentElement.dataset['fileIconTheme'] = fileIconTheme;
    await settle();
  };

  beforeEach(() => host('dark', 'material'));

  it('keeps one <img> while a folder opens and the theme kind switches, changing only its src', async () => {
    const wrapper = mount(FileIcon, { props: { path: '.idea', directory: true }, attrs: { class: 'size-3.5' } });
    const img = wrapper.get('img').element;
    expect(img.getAttribute('src')).toBe(`${ICONS}folder-intellij.svg`);
    expect(img.getAttribute('alt')).toBe('');
    expect(img.classList.contains('size-3.5')).toBe(true);

    await wrapper.setProps({ open: true });
    expect(wrapper.get('img').element).toBe(img);
    expect(img.getAttribute('src')).toBe(`${ICONS}folder-intellij-open.svg`);

    await host('light', 'material');
    expect(wrapper.get('img').element).toBe(img);
    expect(img.getAttribute('src')).toBe(`${ICONS}folder-intellij-open_light.svg`);

    await host('light', 'minimal');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.findComponent(FolderOpen).exists()).toBe(true);
    wrapper.unmount();
  });

  it('draws Minimal icons in design token colours, matching by the last path segment', async () => {
    await host('dark', 'minimal');
    const code = mount(FileIcon, { props: { path: 'src/app.ts' } });
    expect(code.findComponent(FileCode).attributes('style')).toContain('var(--d-accent)');
    const folder = mount(FileIcon, { props: { path: 'src', directory: true } });
    expect(folder.findComponent(Folder).attributes('style')).toContain('var(--d-muted)');
    code.unmount();
    folder.unmount();
  });
});
