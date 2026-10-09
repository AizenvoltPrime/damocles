// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import type { TerminalProfileOption, TerminalProfileReport } from '../../preload/terminal-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// One overlay page per file, as in the app: the bridge is installed before anything uses it.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const mounted: VueWrapper[] = [];
let pinia: Pinia;

const profile = (overrides: Partial<TerminalProfileOption> & Pick<TerminalProfileOption, 'id' | 'name'>): TerminalProfileOption => ({
  path: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', source: 'detected', icon: 'powershell', customIcon: null, color: null, args: [], isDefault: false, ...overrides,
});

const REPORT: TerminalProfileReport = {
  profiles: [
    profile({ id: 'windows-powershell', name: 'Windows PowerShell', isDefault: true }),
    profile({ id: 'user:Developer PowerShell', name: 'Developer PowerShell', source: 'user', customIcon: 'wrench', color: 'magenta', args: ['-NoExit', '-Command', '&{Import-Module DevShell.dll}'] }),
  ],
  hidden: ['Command Prompt'],
  problems: [
    { name: 'Broken <img src=x onerror=alert(1)>', reason: 'pathNotFound', detail: 'C:/missing/<b>pwsh</b>.exe' },
    { name: 'Odd', reason: 'unknownField', detail: 'env' },
  ],
};

async function openTerminalSettings(): Promise<void> {
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section: 'terminal' });
  await flushPromises();
}

const q = (testid: string): HTMLElement | null => document.querySelector(`[data-testid="${testid}"]`);
const all = (testid: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  api.terminalProfiles.report = REPORT;
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Settings › Terminal profiles', () => {
  it('lists a user profile with its icon in its colour, its path and its arguments', async () => {
    await openTerminalSettings();
    const row = all('terminal-profile').find((element) => element.dataset.profileId === 'user:Developer PowerShell')!;
    expect(row.dataset.source).toBe('user');
    expect(row.querySelector('[data-testid="terminal-profile-name"]')!.textContent).toBe('Developer PowerShell');
    expect(row.querySelector('[data-testid="terminal-profile-path"]')!.textContent).toBe('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
    expect([...row.querySelectorAll('[data-testid="terminal-profile-arg"]')].map((arg) => arg.textContent)).toEqual(['-NoExit', '-Command', '&{Import-Module DevShell.dll}']);
    const icon = row.querySelector<HTMLElement>('[data-testid="terminal-profile-icon"]')!;
    expect(icon.dataset.glyph).toBe('wrench');
    expect(icon.getAttribute('style')).toContain('--terminal-tint-5');
  });

  it('lists the detected profiles, a hidden one marked hidden', async () => {
    await openTerminalSettings();
    const detected = all('terminal-profile').filter((element) => element.dataset.source === 'detected');
    expect(detected.map((element) => element.querySelector('[data-testid="terminal-profile-name"]')!.textContent)).toEqual(['Windows PowerShell']);
    const hidden = all('terminal-profile-hidden');
    expect(hidden.map((element) => element.querySelector('[data-testid="terminal-profile-name"]')!.textContent)).toEqual(['Command Prompt']);
    expect(hidden[0]!.textContent).toContain('Hidden');
  });

  it('lists each invalid entry with its reason in words and its detail, as text only', async () => {
    await openTerminalSettings();
    const problems = all('terminal-profile-problem');
    expect(problems).toHaveLength(2);
    expect(problems[0]!.querySelector('[data-testid="terminal-profile-problem-name"]')!.textContent).toBe('Broken <img src=x onerror=alert(1)>');
    expect(problems[0]!.querySelector('[data-testid="terminal-profile-problem-reason"]')!.textContent).toBe('No file exists at this path or on PATH.');
    expect(problems[0]!.querySelector('[data-testid="terminal-profile-problem-detail"]')!.textContent).toBe('C:/missing/<b>pwsh</b>.exe');
    expect(problems[1]!.querySelector('[data-testid="terminal-profile-problem-reason"]')!.textContent).toBe('Profiles take only path, args, icon and color; this field is not one of them.');
    expect(document.querySelector('img, b')).toBeNull();
  });

  it('shows the setting as a whole when it is not an object of entries', async () => {
    api.terminalProfiles.report = { profiles: [], hidden: [], problems: [{ name: null, reason: 'settingNotAnObject', detail: null }] };
    await openTerminalSettings();
    const problem = q('terminal-profile-problem')!;
    expect(problem.querySelector('[data-testid="terminal-profile-problem-name"]')!.textContent).toBe('damocles.desktop.terminal.profiles');
    expect(problem.querySelector('[data-testid="terminal-profile-problem-detail"]')).toBeNull();
  });

  it('follows the report main pushes after it validates the profiles again', async () => {
    await openTerminalSettings();
    api.pushTerminalProfiles({ profiles: [REPORT.profiles[0]!], hidden: [], problems: [] });
    await flushPromises();
    expect(all('terminal-profile-problem')).toHaveLength(0);
    expect(all('terminal-profile')).toHaveLength(1);
    expect(q('terminal-profiles-no-problems')).not.toBeNull();
  });

  // Scrollback's minimum is 0, and every open terminal trims its history to a new scrollback at once.
  it('refuses an emptied or non-decimal Scrollback instead of writing 0', async () => {
    await openTerminalSettings();
    const field = document.querySelector<HTMLInputElement>(`input[aria-label="${shellI18n.global.t('settingsHost.rows.terminalScrollback.label')}"]`)!;
    for (const raw of ['', '  ', '0x10', '1e1', '1.0', '-0']) {
      field.value = raw;
      field.dispatchEvent(new Event('input'));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flushPromises();
      expect(field.getAttribute('aria-invalid'), JSON.stringify(raw)).toBe('true');
    }
    expect(api.setPref).not.toHaveBeenCalledWith('damocles.desktop.terminal.scrollback', expect.anything());
    field.value = ' 5000 ';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flushPromises();
    expect(api.setPref).toHaveBeenCalledWith('damocles.desktop.terminal.scrollback', 5000);
  });

  it('refuses a font family that names no font: a CSS-wide keyword or var()', async () => {
    vi.stubGlobal('CSS', {
      supports: (property: string, value: string) => property === 'font-family' || !/^1px (?:inherit|initial|unset|revert)$/.test(value),
      escape: (value: string) => value,
    });
    await openTerminalSettings();
    const field = document.querySelector<HTMLInputElement>(`input[aria-label="${shellI18n.global.t('settingsHost.rows.terminalFontFamily.label')}"]`)!;
    for (const raw of ['inherit', 'var(--d-mono)']) {
      field.value = raw;
      field.dispatchEvent(new Event('input'));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flushPromises();
      expect(field.getAttribute('aria-invalid'), raw).toBe('true');
    }
    expect(api.setPref).not.toHaveBeenCalledWith('damocles.desktop.terminal.fontFamily', expect.anything());
  });

  it('every problem reason has a sentence in English and Greek', async () => {
    const { TERMINAL_PROFILE_PROBLEMS } = await import('../../preload/terminal-channels');
    for (const locale of ['en', 'el'] as const) {
      for (const reason of TERMINAL_PROFILE_PROBLEMS) {
        const key = `settingsHost.terminal.problem.${reason}`;
        expect(shellI18n.global.te(key, locale), `${locale} ${key}`).toBe(true);
        expect(String(shellI18n.global.t(key, {}, { locale }))).not.toContain('—');
      }
    }
  });
});
