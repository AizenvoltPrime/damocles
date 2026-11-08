// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { i18n, applyLocale } from '@/i18n';
import en from '../../i18n/locales/en.json' with { type: 'json' };
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { GLOBAL_SERVER_VARIANTS, memoryScopeKey, memorySavedToastKey, useMemoryScopeLabel } from '../useMemoryScopeLabel';

const Probe = defineComponent({
  setup() {
    return useMemoryScopeLabel();
  },
  template: `<div>
    <span data-testid="global">{{ scopeLabel('global') }}</span>
    <span data-testid="project">{{ scopeLabel('project') }}</span>
    <span data-testid="stored">{{ scopeLabel('legacy') }}</span>
    <span data-testid="action">{{ $t(scopeKey('memoryAudit.action.rescope_global')) }}</span>
    <span data-testid="profile">{{ globalProfileLabel }}</span>
  </div>`,
});

function texts(wrapper: ReturnType<typeof mount>): Record<string, string> {
  const id = (name: string) => wrapper.get(`[data-testid="${name}"]`).text();
  return { global: id('global'), project: id('project'), stored: id('stored'), action: id('action'), profile: id('profile') };
}

function setOnServer(value: boolean | undefined): void {
  const { globalMemoryOnServer: _omitted, ...rest } = VSCODE_HOST_CAPABILITIES;
  useSettingsStore().hostCapabilities = value === undefined ? rest : { ...rest, globalMemoryOnServer: value };
}

type Tree = { [key: string]: string | Tree };
function flatten(node: Tree, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') out.set(path, value);
    else flatten(value, path, out);
  }
  return out;
}

const ON_SERVER = { ...VSCODE_HOST_CAPABILITIES, globalMemoryOnServer: true };

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => applyLocale('en'));

describe('useMemoryScopeLabel', () => {
  it('labels global memory plainly where it lives on the user\'s computer', () => {
    const wrapper = mount(Probe, { global: { plugins: [i18n] } });
    expect(texts(wrapper)).toEqual({ global: 'Global', project: 'Project', stored: 'legacy', action: 'Move to global', profile: 'Global profile' });
  });

  it('names the server once the host says global memory lives there, and only for the global scope', async () => {
    const wrapper = mount(Probe, { global: { plugins: [i18n] } });
    setOnServer(true);
    await nextTick();
    expect(texts(wrapper)).toEqual({
      global: 'Global (this server)',
      project: 'Project',
      stored: 'legacy',
      action: 'Move to global (this server)',
      profile: 'Global profile (this server)',
    });
    await applyLocale('el');
    await nextTick();
    expect(texts(wrapper).global).toBe('Καθολικό (αυτός ο διακομιστής)');
  });

  it('treats a host that omits the flag as this computer', () => {
    setOnServer(undefined);
    const wrapper = mount(Probe, { global: { plugins: [i18n] } });
    expect(texts(wrapper).global).toBe('Global');
  });

  it('keys the saved toast by tier, naming the server only for a global memory', () => {
    expect(memorySavedToastKey('global', ON_SERVER)).toBe('memory.toast.saved.globalServer');
    expect(memorySavedToastKey('note', ON_SERVER)).toBe('memory.toast.saved.note');
    expect(memorySavedToastKey('global', VSCODE_HOST_CAPABILITIES)).toBe('memory.toast.saved.global');
  });

  it('swaps only a key that has a server variant', () => {
    expect(memoryScopeKey('memoryPanel.addPlaceholder.global', ON_SERVER)).toBe('memoryPanel.addPlaceholder.globalServer');
    expect(memoryScopeKey('memoryPanel.addPlaceholder.project', ON_SERVER)).toBe('memoryPanel.addPlaceholder.project');
    expect(memoryScopeKey('memoryPanel.addPlaceholder.global', VSCODE_HOST_CAPABILITIES)).toBe('memoryPanel.addPlaceholder.global');
  });

  // A string naming the global memory scope with no server variant would still say plain "global" on a server.
  it('gives every webview string that says "global" a server variant, but for the non-memory ones', () => {
    const NOT_MEMORY_SCOPE = new Set(['permission.destination.global']);
    // shown only in a desktop remote chat, about this computer's global memories, where globalMemoryOnServer is never set
    const THIS_COMPUTER_SCOPE = new Set(['memoryPanel.userMemoryOffDetail', 'memoryPanel.userTiersOff']);
    const strings = flatten(en as Tree);
    const variants = new Set(GLOBAL_SERVER_VARIANTS.values());
    const saysGlobal = [...strings]
      .filter(([key, value]) => /\bglobal\b/i.test(value) && !variants.has(key) && !NOT_MEMORY_SCOPE.has(key) && !THIS_COMPUTER_SCOPE.has(key))
      .map(([key]) => key)
      .sort();
    expect(saysGlobal).toEqual([...GLOBAL_SERVER_VARIANTS.keys()].sort());
    for (const variant of variants) expect(strings.get(variant), variant).toMatch(/this server/);
  });
});
