// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import McpRenamedRulesBanner from '../McpRenamedRulesBanner.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n, applyLocale } from '@/i18n';
import type { McpRenamedToolRuleNotice } from '@shared/types/mcp';

const mounted: { unmount: () => void }[] = [];
function mountBanner(notices: McpRenamedToolRuleNotice[]) {
  const wrapper = mount(McpRenamedRulesBanner, { props: { notices }, attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  applyLocale('en');
  document.body.innerHTML = '';
});

const projectNotice: McpRenamedToolRuleNotice = {
  path: 'C:\\Users\\someone\\repo\\.damocles\\settings.json',
  displayPath: '~/repo/.damocles/settings.json',
  rules: [
    { old: 'mcp__context7__resolve-library-id', new: 'mcp__context7__resolve_library_id' },
    { old: 'mcp__docs__get-page(<b>x</b>)', new: 'mcp__docs__get_page(<b>x</b>)' },
  ],
};

describe('McpRenamedRulesBanner', () => {
  it('announces itself and lists each file by its display path with every rule as old → new', async () => {
    mountBanner([projectNotice]);
    await nextTick();

    const banner = document.body.querySelector('[data-testid="mcp-renamed-rules-banner"]')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('Rules name MCP tools that were renamed');
    const file = document.body.querySelector('[data-testid="mcp-renamed-rules-file"]')!;
    expect(file.textContent).toContain('~/repo/.damocles/settings.json');
    expect(file.textContent).not.toContain('C:\\Users\\someone');

    const rules = [...document.body.querySelectorAll('[data-testid="mcp-renamed-rule"]')].map((el) => el.textContent?.replace(/\s+/g, ' ').trim());
    expect(rules[0]).toContain('mcp__context7__resolve-library-id → ');
    expect(rules[0]).toContain('mcp__context7__resolve_library_id');
  });

  it('renders rule text literally, never as markup', async () => {
    mountBanner([projectNotice]);
    await nextTick();
    const rule = document.body.querySelectorAll('[data-testid="mcp-renamed-rule"]')[1]!;
    expect(rule.textContent).toContain('mcp__docs__get-page(<b>x</b>)');
    expect(rule.querySelector('b')).toBeNull();
  });

  it('opens a file by its absolute path from a button named for it, and dismisses', async () => {
    const wrapper = mountBanner([projectNotice]);
    await nextTick();

    document.body.querySelector<HTMLButtonElement>('[aria-label="Open ~/repo/.damocles/settings.json"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-testid="mcp-renamed-rules-dismiss"]')!.click();

    expect(wrapper.emitted('openFile')).toEqual([[projectNotice.path]]);
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
    expect(document.body.querySelector('[data-testid="mcp-renamed-rules-dismiss"]')?.getAttribute('aria-label')).toBe('Dismiss');
  });

  it('is translated into Greek', async () => {
    applyLocale('el');
    mountBanner([projectNotice]);
    await nextTick();
    const text = document.body.querySelector('[data-testid="mcp-renamed-rules-banner"]')?.textContent ?? '';
    expect(text).not.toContain('Rules name MCP tools that were renamed');
    expect(text).not.toContain('mcp.renamedRules');
  });
});

describe('settings store: renamed-rule notices', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('merges notices by file, adding only rules not already listed', () => {
    const store = useSettingsStore();
    store.addMcpRenamedToolRules([{ ...projectNotice, rules: [projectNotice.rules[0]!] }]);
    store.addMcpRenamedToolRules([projectNotice, { path: '/h/.claude/settings.json', displayPath: '~/.claude/settings.json', rules: [{ old: 'a', new: 'b' }] }]);

    expect(store.mcpRenamedToolRules.map((n) => n.path)).toEqual([projectNotice.path, '/h/.claude/settings.json']);
    expect(store.mcpRenamedToolRules[0]!.rules).toEqual(projectNotice.rules);
  });

  it('clears every notice on dismiss and on reset', () => {
    const store = useSettingsStore();
    store.addMcpRenamedToolRules([projectNotice]);
    store.dismissMcpRenamedToolRules();
    expect(store.mcpRenamedToolRules).toEqual([]);

    store.addMcpRenamedToolRules([projectNotice]);
    store.$reset();
    expect(store.mcpRenamedToolRules).toEqual([]);
  });
});
