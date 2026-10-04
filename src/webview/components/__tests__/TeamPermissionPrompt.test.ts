// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import TeamPermissionPrompt from '../TeamPermissionPrompt.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';

enableAutoUnmount(afterEach);

beforeEach(() => setActivePinia(createPinia()));

function prompt(toolName: string, toolInput: Record<string, unknown>): VueWrapper {
  useTeamStore().handlePermissionRequest({ requestId: 'r-1', teamId: 't-1', agentId: 'a-1', agentName: 'Mira', toolName, toolInput });
  return mount(TeamPermissionPrompt, { global: { plugins: [i18n] }, attachTo: document.body });
}

describe("a team agent's permission card", () => {
  it('lets the keyboard reach the input, so a long command can be scrolled', () => {
    const wrapper = prompt('Bash', { command: 'npm test' });

    const input = wrapper.get('[data-testid="team-permission-input"]');
    expect(input.attributes('tabindex')).toBe('0');
    expect(input.attributes('aria-label')).toBe(i18n.global.t('team.permission.input', { tool: 'Bash' }));
    expect(input.text()).toBe('npm test');
  });

  it('names an edited file relative to the chat folder, with the full path only in the tooltip', () => {
    useSettingsStore().setWorkspaceFolders([{ key: 'k', name: 'proj', label: 'proj', path: '/home/a/proj' }], 'k', 'k');
    const wrapper = prompt('Edit', { file_path: '/home/a/proj/src/a.ts', old_string: 'a', new_string: 'b' });

    const subtitle = wrapper.get('[data-testid="team-permission-subtitle"]');
    expect(subtitle.text()).toBe('Edit · src/a.ts');
    expect(subtitle.attributes('title')).toBe('Edit · /home/a/proj/src/a.ts');
    expect(JSON.parse(wrapper.get('[data-testid="team-permission-input"]').text())).toEqual({ old_string: 'a', new_string: 'b' });
  });

  it('names the agent inside one Greek sentence, in Greek word order', () => {
    i18n.global.locale.value = 'el';
    try {
      const wrapper = prompt('Bash', { command: 'npm test' });

      const title = wrapper.get('[data-testid="team-permission-title"]');
      expect(title.text()).toBe('Ο πράκτορας Mira θέλει να εκτελέσει');
      expect(title.get('span').text()).toBe('Mira');
    } finally {
      i18n.global.locale.value = 'en';
    }
  });
});
