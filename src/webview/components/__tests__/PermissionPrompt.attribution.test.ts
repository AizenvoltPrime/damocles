// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import PermissionPrompt from '../PermissionPrompt.vue';
import type { PromptOwner } from '@shared/types/permissions';
import { i18n } from '@/i18n';

/** The dock names the agent that asks: a subagent by its description, a team agent by its name and its team. */

const TEAM: PromptOwner = { kind: 'team', teamId: 'team-1', agentId: 'agent-1', teamTitle: 'Lockout', agentName: 'Mira' };

const mounted: VueWrapper[] = [];

function prompt(props: Record<string, unknown>): VueWrapper {
  const wrapper = mount(PermissionPrompt, {
    props: { visible: true, toolUseId: 't-1', ...props },
    global: { plugins: [i18n, createPinia()], stubs: { PermissionDestinationPicker: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('PermissionPrompt attribution', () => {
  it('names a team agent and its team for each kind of call', () => {
    expect(prompt({ toolName: 'Bash', toolInput: { command: 'ls' }, command: 'ls', owner: TEAM }).text())
      .toContain('Mira from team Lockout wants to run this command:');
    expect(prompt({ toolName: 'mcp__docs__search', toolInput: { q: 'x' }, owner: TEAM }).text())
      .toContain('Mira from team Lockout wants to use mcp__docs__search with this input:');
    expect(prompt({ toolName: 'Write', toolInput: { file_path: 'a.ts', content: 'x' }, filePath: 'a.ts', owner: TEAM }).text())
      .toContain('Mira from team Lockout wants to create this file');
    expect(prompt({ toolName: 'Edit', toolInput: { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, filePath: 'a.ts', patch: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-x\n+y\n', owner: TEAM }).text())
      .toContain('Mira from team Lockout wants to edit');
  });

  it('keeps the subagent wording for a subagent and none for the chat itself', () => {
    expect(prompt({ toolName: 'Bash', toolInput: { command: 'ls' }, command: 'ls', owner: { kind: 'subagent', agentId: 'sub-1' }, agentDescription: 'Explore' }).text())
      .toContain(i18n.global.t('permission.runCommandAgent', { agent: 'Explore' }));
    expect(prompt({ toolName: 'Bash', toolInput: { command: 'ls' }, command: 'ls', owner: { kind: 'main' } }).text())
      .not.toContain('wants to run');
  });

  it('says it in Greek with one sentence per call', () => {
    i18n.global.locale.value = 'el';
    try {
      expect(prompt({ toolName: 'Bash', toolInput: { command: 'ls' }, command: 'ls', owner: TEAM }).text())
        .toContain('Ο πράκτορας Mira της ομάδας Lockout θέλει να εκτελέσει αυτή την εντολή:');
    } finally {
      i18n.global.locale.value = 'en';
    }
  });
});
