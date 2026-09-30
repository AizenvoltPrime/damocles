// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import SettingSourceBadge from '../SettingSourceBadge.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';

const PROJECT_FILE = '/w/a/.damocles/settings.json';
const LOCAL_FILE = '/w/a/.damocles/settings.local.json';

function badges(settingKey: string | readonly string[]): string[] {
  const wrapper = mount(SettingSourceBadge, { props: { settingKey }, global: { plugins: [i18n] } });
  return wrapper.findAll('[title]').map((badge) => badge.attributes('title')!);
}

beforeEach(() => setActivePinia(createPinia()));

describe('SettingSourceBadge', () => {
  it('shows one badge for several keys set in the same file', () => {
    const store = useSettingsStore();
    store.updateSettings(store.currentSettings, {
      'damocles.team.leadModel': { scope: 'project', path: PROJECT_FILE },
      'damocles.team.leadEffort': { scope: 'project', path: PROJECT_FILE },
    });

    expect(badges(['damocles.team.leadModel', 'damocles.team.leadEffort'])).toEqual([i18n.global.t('settings.source.fromFile', { path: PROJECT_FILE })]);
  });

  it('shows a badge per file when the keys come from different files', () => {
    const store = useSettingsStore();
    store.updateSettings(store.currentSettings, {
      'damocles.team.leadModel': { scope: 'project', path: PROJECT_FILE },
      'damocles.team.leadEffort': { scope: 'local', path: LOCAL_FILE },
    });

    expect(badges(['damocles.team.leadModel', 'damocles.team.leadEffort'])).toHaveLength(2);
    expect(badges('damocles.team.leadEffort')).toEqual([i18n.global.t('settings.source.fromFile', { path: LOCAL_FILE })]);
    expect(badges('damocles.maxBudgetUsd')).toEqual([]);
  });
});
