// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { DamoclesShellApi, ShellChat, ShellChatList } from '../../preload/shell-channels';
import ChatsSection from '../components/ChatsSection.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, chat, fakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function mountChats(api: DamoclesShellApi): VueWrapper {
  const wrapper = mount(ChatsSection, {
    props: { api, projectKey: 'p1', stateRevision: 1, projectName: 'alpha', selectedChatId: 'parent', newChatShortcut: 'Ctrl+N', newChatInWorktreeShortcut: 'Shift+Alt+N', collapsed: false },
    global: { plugins: [shellI18n] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

const PARENT = chat({ id: 'parent', title: 'Contacts', timestamp: Date.now() - 1000 });
const DESIGN = chat({ id: 'design', title: 'Design · Contacts', design: { parentId: 'parent' }, timestamp: Date.now(), status: 'running' });

describe('a design chat in the sidebar', () => {
  it('sits indented under its parent with the palette badge, the design chat label and a pulsing dot while it runs', async () => {
    const wrapper = mountChats(fakeShellApi([DESIGN, PARENT]));
    await flushPromises();

    expect(wrapper.findAll('[data-chat-id]').map((row) => row.attributes('data-chat-id'))).toEqual(['parent', 'design']);
    const row = wrapper.get('[data-chat-id="design"]');
    expect(row.attributes('data-nested')).toBe('true');
    expect(row.get('[data-testid="chat-title"]').text()).toBe('Design · Contacts');
    expect(row.get('[data-testid="chat-design-icon"]').classes()).toContain('size-4.5');
    expect(row.get('[data-testid="chat-design-dot"]').classes()).toContain('d-pulsing');
    expect(row.text()).toContain('Design chat,');
    expect(wrapper.get('[data-chat-id="parent"]').attributes('data-nested')).toBeUndefined();
  });

  it('shows the success dot once idle with a finished version, which a run turns back into the pulsing dot', async () => {
    const finished = mountChats(fakeShellApi([{ ...DESIGN, status: 'idle', design: { parentId: 'parent', finishedVersion: 2 } }, PARENT]));
    await flushPromises();
    const row = finished.get('[data-chat-id="design"]');
    expect(row.get('[data-testid="chat-design-dot"]').attributes('data-state')).toBe('finished');
    expect(row.get('[data-testid="chat-design-dot"]').classes()).toContain('bg-(--d-success)');
    expect(row.text()).toContain('Finished v2,');

    const running = mountChats(fakeShellApi([{ ...DESIGN, design: { parentId: 'parent', finishedVersion: 2 } }, PARENT]));
    await flushPromises();
    expect(running.get('[data-chat-id="design"] [data-testid="chat-design-dot"]').attributes('data-state')).toBe('running');
    expect(running.get('[data-chat-id="design"]').text()).not.toContain('Finished v2');
  });

  it('shows no dot while it is idle with no finished version, and the warning dot while it waits for the user', async () => {
    const wrapper = mountChats(fakeShellApi([{ ...DESIGN, status: 'idle' }, PARENT]));
    await flushPromises();
    expect(wrapper.find('[data-chat-id="design"] [data-testid="chat-design-dot"]').exists()).toBe(false);

    const waiting = mountChats(fakeShellApi([{ ...DESIGN, status: 'waiting' }, PARENT]));
    await flushPromises();
    expect(waiting.get('[data-chat-id="design"] [data-testid="chat-design-dot"]').classes()).toContain('bg-(--d-warning)');
    expect(waiting.get('[data-chat-id="design"]').text()).toContain('Needs you,');
  });

  it('is one line, its title and tag, in a shorter row whose dot gives way to the hover actions', async () => {
    const wrapper = mountChats(fakeShellApi([{ ...DESIGN, tag: 'ui' }, PARENT]));
    await flushPromises();

    const row = wrapper.get('[data-chat-id="design"]');
    const parent = wrapper.get('[data-chat-id="parent"]');
    expect(row.get('[data-testid="chat-title"]').element.nextElementSibling?.querySelector('[data-testid="chat-tag"]')?.textContent?.trim()).toBe('ui');
    expect(row.text()).not.toContain(':');
    expect(parent.get('[data-testid="chat-title"]').element.nextElementSibling?.textContent).toMatch(/\d:\d\d/);
    const height = (element: Element): number => Number.parseFloat((element.parentElement as HTMLElement).style.height);
    expect(height(row.element)).toBeLessThan(height(parent.element));
    expect(row.get('[data-testid="chat-design-dot"]').classes()).toContain('group-hover/row:hidden');
  });

  it("draws the tree from the parent through each design chat, ending at the last", async () => {
    const SECOND = chat({ id: 'second', title: 'Design · Contacts 2', design: { parentId: 'parent' }, timestamp: Date.now() - 2000 });
    const wrapper = mountChats(fakeShellApi([DESIGN, PARENT, SECOND]));
    await flushPromises();

    expect(wrapper.findAll('[data-chat-id]').map((row) => row.attributes('data-chat-id'))).toEqual(['parent', 'design', 'second']);
    const [first, last] = ['design', 'second'].map((id) => wrapper.get(`[data-chat-id="${id}"]`));
    expect(first!.find('[data-testid="chat-tree-line"]').exists()).toBe(true);
    expect(first!.get('[data-testid="chat-tree-elbow"]').classes()).not.toContain('rounded-bl-5');
    expect(last!.find('[data-testid="chat-tree-line"]').exists()).toBe(false);
    expect(last!.get('[data-testid="chat-tree-elbow"]').classes()).toEqual(expect.arrayContaining(['rounded-bl-5', 'border-l', 'border-b']));
    expect(wrapper.find('[data-chat-id="parent"] [data-testid="chat-tree-elbow"]').exists()).toBe(false);
  });

  it('lists a design chat a rewind superseded below the current one, muted, locked and read-only, with no dot', async () => {
    // newer than the current one, as a chat rewound after a later edit can be
    const OLD = chat({ id: 'old', title: 'Design · Contacts', design: { parentId: 'parent', finishedVersion: 3, superseded: true }, timestamp: Date.now() + 1000 });
    const CURRENT = { ...DESIGN, status: 'idle' as const, design: { parentId: 'parent', finishedVersion: 3 } };
    const api = fakeShellApi([OLD, CURRENT, PARENT]);
    const wrapper = mountChats(api);
    await flushPromises();

    expect(wrapper.findAll('[data-chat-id]').map((row) => row.attributes('data-chat-id'))).toEqual(['parent', 'design', 'old']);
    const row = wrapper.get('[data-chat-id="old"]');
    expect(row.attributes('data-superseded')).toBe('true');
    expect(row.attributes('data-nested')).toBe('true');
    expect(row.find('[data-testid="chat-design-dot"]').exists()).toBe(false);
    expect(row.text()).toContain('Design chat,Read-only,');
    expect(row.text()).not.toContain('Finished v3');
    expect(row.get('[data-testid="chat-title"]').classes()).toContain('text-(--d-muted)');
    const lock = row.get('[data-testid="chat-design-read-only"]');
    expect(lock.attributes('title')).toBe('Read-only. This design continues in another chat.');
    expect(lock.attributes('aria-hidden')).toBe('true');
    expect(wrapper.get('[data-chat-id="design"] [data-testid="chat-design-dot"]').attributes('data-state')).toBe('finished');
    expect(wrapper.find('[data-chat-id="design"] [data-testid="chat-design-read-only"]').exists()).toBe(false);

    await row.trigger('click');
    expect(api.selectChat).toHaveBeenCalledWith('old');

    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(row.text()).toContain('Μόνο για ανάγνωση,');
  });

  it('keeps the two-line row with the badge as its icon for a forked design chat with no parent', async () => {
    const wrapper = mountChats(fakeShellApi([chat({ id: 'forked', title: 'Design · Contacts', design: {}, status: 'running' }), PARENT]));
    await flushPromises();

    const row = wrapper.get('[data-chat-id="forked"]');
    expect(row.attributes('data-nested')).toBeUndefined();
    // a top-level row's badge fills its w-4 icon slot, as the other rows' icons do
    expect(row.get('[data-testid="chat-design-icon"]').classes()).toContain('size-4');
    expect(row.find('[data-testid="chat-tree-elbow"]').exists()).toBe(false);
    expect(row.get('[data-testid="chat-title"]').element.nextElementSibling?.textContent).toMatch(/\d:\d\d/);
    expect(row.get('[data-testid="chat-design-dot"]').classes()).toContain('d-pulsing');
  });

  it('slides in a design chat that appears after the first list, and leaves the first list still', async () => {
    let chats: ShellChat[] = [PARENT];
    const api = fakeShellApi([], { listChats: vi.fn(async (projectKey: string): Promise<ShellChatList> => ({ projectKey, chats, tags: [] })) });
    const wrapper = mountChats(api);
    await flushPromises();
    expect(wrapper.get('[data-chat-id="parent"]').classes()).not.toContain('d-row-arrive');

    chats = [DESIGN, PARENT];
    api.chatsChanged('p1');
    await flushPromises();

    const row = wrapper.get('[data-chat-id="design"]');
    expect(row.classes()).toContain('d-row-arrive');
    await row.trigger('animationend');
    expect(wrapper.get('[data-chat-id="design"]').classes()).not.toContain('d-row-arrive');
  });

  it('never slides in later a design chat that arrived while its row was not rendered', async () => {
    const OTHERS = Array.from({ length: 20 }, (_, index) => chat({ id: `other-${index}`, title: `Other ${index}`, timestamp: Date.now() - index }));
    const OLD_PARENT = { ...PARENT, timestamp: Date.now() - 60_000 };
    let chats: ShellChat[] = [...OTHERS, OLD_PARENT];
    const api = fakeShellApi([], { listChats: vi.fn(async (projectKey: string): Promise<ShellChatList> => ({ projectKey, chats, tags: [] })) });
    const wrapper = mountChats(api);
    await flushPromises();

    chats = [...OTHERS, OLD_PARENT, { ...DESIGN, timestamp: Date.now() - 59_000 }];
    api.chatsChanged('p1');
    await flushPromises();
    expect(wrapper.find('[data-chat-id="design"]').exists()).toBe(false);

    chats = [OLD_PARENT, { ...DESIGN, timestamp: Date.now() - 59_000 }];
    api.chatsChanged('p1');
    await flushPromises();
    expect(wrapper.get('[data-chat-id="design"]').classes()).not.toContain('d-row-arrive');
  });
});
