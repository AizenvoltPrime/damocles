// @vitest-environment happy-dom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { shallowRef } from 'vue';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import { Wrench } from 'lucide-vue-next';
import ToolCallCard from '@/components/ToolCallCard.vue';
import ToolCallRouter from '@/components/ToolCallRouter.vue';
import ToolCardFrame from '@/components/ToolCardFrame.vue';
import { CHAT_VIEW_PROVIDE } from '@/__tests__/code-highlighter';
import { IN_TRANSCRIPT } from '@/composables/transcript-scope';
import { i18n } from '@/i18n';
import { useTeamStore } from '@/stores/useTeamStore';
import { CHARACTER_STATES, type CharacterState, type CharacterView, type ShownCharacters } from '@shared/themes/characters';
import { CSS_HOOKS, type CssHook } from '@shared/themes/css-hooks';
import { CHARACTER_SELECTIONS, CSS_REGIONS, type CharacterSelection, type CssRegion } from '@shared/themes/schema';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import type { ChatStatus, ShellEditorTab, ShellProject, ShellState } from '../../preload/shell-channels';
import type { TerminalGroupInfo, TerminalInfo, TerminalStatus } from '../../preload/terminal-channels';
import App from '../App.vue';
import ChatRow from '../components/ChatRow.vue';
import Breadcrumbs from '../editor/Breadcrumbs.vue';
import EditorTabs from '../editor/EditorTabs.vue';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import TerminalList from '../terminal/TerminalList.vue';
import { createTerminalStore, TERMINAL_STORE, type TerminalStore } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, FakeResizeObserver, STATE, TERMINAL_STATE, chat, fakeShellApi } from './fakes';

vi.mock('@/utils/highlightDiff', () => ({
  highlightDiffLines: vi.fn(async (lines: Array<{ content: string }>) => lines.map((line) => ({ ...line, highlightedContent: line.content }))),
}));

// docs/themes.md "Hooks" promises theme authors the attributes of CSS_HOOKS in each region; a theme reaches only a scope root's
// strict descendants, so each hook is pinned here inside its region's root, with every value it lists and no other.

// Each union a hook publishes, as a map that must name every member: a new member fails typecheck here until it is added, and
// then the registry comparison below until CSS_HOOKS and docs/themes.md list it.
const CHAT_STATUSES = { idle: true, running: true, waiting: true } satisfies Record<ChatStatus, true>;
const TERMINAL_STATUSES = { starting: true, running: true, exited: true, reconnecting: true } satisfies Record<TerminalStatus, true>;
// the chat counts that put a project in each state
const PROJECT_COUNTS = { idle: [0, 0], running: [1, 0], waiting: [1, 1] } satisfies Record<CharacterState, readonly [running: number, waiting: number]>;
const keysOf = <K extends string>(map: Readonly<Record<K, unknown>>): K[] => Object.keys(map) as K[];

const mounted: VueWrapper[] = [];
beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const attributeOf = (hook: CssHook): string => /^\[([a-z-]+)\]$/.exec(hook.selector)![1]!;

// region → selector → the values seen on hooked elements strictly inside the region's scope roots
type Seen = Map<string, Set<string>>;
function collect(region: CssRegion, seen: Seen): void {
  for (const root of document.querySelectorAll(`[data-theme-scope~="${region}"]`)) {
    for (const hook of CSS_HOOKS[region]) {
      for (const element of root.querySelectorAll(hook.selector)) {
        const values = seen.get(hook.selector) ?? new Set<string>();
        values.add(element.getAttribute(attributeOf(hook))!);
        seen.set(hook.selector, values);
      }
    }
  }
}

function expectHooks(region: CssRegion, seen: Seen): void {
  for (const hook of CSS_HOOKS[region]) {
    const values = seen.get(hook.selector);
    expect(values, `${region} ${hook.selector}`).toBeDefined();
    if (hook.values === null) expect([...values!].every((value) => value.trim() !== ''), `${region} ${hook.selector}`).toBe(true);
    else if (hook.values.length > 0) expect([...values!].sort(), `${region} ${hook.selector}`).toEqual([...hook.values].sort());
  }
}

// An attribute only Damocles' hooks use sits nowhere outside the roots of the regions that list it; a generic one (data-part,
// data-active, data-selected, data-status, data-dirty) may mean something else elsewhere on the page.
const GENERIC = new Set(['[data-part]', '[data-active]', '[data-selected]', '[data-status]', '[data-dirty]']);
function expectNoneOutside(regions: readonly CssRegion[]): void {
  for (const region of regions) {
    for (const hook of CSS_HOOKS[region]) {
      if (GENERIC.has(hook.selector)) continue;
      const listing = CSS_REGIONS.filter((other) => CSS_HOOKS[other].some((candidate) => candidate.selector === hook.selector));
      for (const element of document.querySelectorAll(hook.selector)) {
        expect(listing.some((other) => element.parentElement?.closest(`[data-theme-scope~="${other}"]`)), `${hook.selector} outside ${listing.join(', ')}`).toBe(true);
      }
    }
  }
}

describe('the hook registry', () => {
  it('lists every region and only them', () => {
    expect(Object.keys(CSS_HOOKS).sort()).toEqual([...CSS_REGIONS].sort());
    for (const region of CSS_REGIONS) {
      const selectors = CSS_HOOKS[region].map((hook) => hook.selector);
      expect(new Set(selectors).size, region).toBe(selectors.length);
      for (const hook of CSS_HOOKS[region]) expect(hook.selector).toMatch(/^\[data-[a-z-]+\]$/);
    }
  });

  it('lists every member of the unions its hooks publish', () => {
    const values = (region: CssRegion, selector: string): string[] => [...CSS_HOOKS[region].find((hook) => hook.selector === selector)!.values!].sort();
    expect(keysOf(PROJECT_COUNTS).sort()).toEqual([...CHARACTER_STATES].sort());
    expect(values('sidebar', '[data-project-state]')).toEqual([...CHARACTER_STATES].sort());
    expect(values('sidebar', '[data-chat-state]')).toEqual(keysOf(CHAT_STATUSES).sort());
    for (const region of ['sidebar', 'titlebar'] as const) {
      expect(values(region, '[data-character-state]'), region).toEqual([...CHARACTER_STATES].sort());
      expect(values(region, '[data-selection]'), region).toEqual([...CHARACTER_SELECTIONS].sort());
    }
    expect(values('terminalChrome', '[data-status]')).toEqual(keysOf(TERMINAL_STATUSES).sort());
  });

  // docs/themes.md "Hooks" holds one table per region, written from the registry: selector, values, meaning.
  it('matches the Hooks tables of docs/themes.md', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../../../docs/themes.md'), 'utf8').split(/\r?\n/);
    const start = doc.indexOf('### Hooks');
    const end = doc.findIndex((line, at) => at > start && line.startsWith('### '));
    const tables: Record<string, string[]> = {};
    let region: string | undefined;
    for (const line of doc.slice(start, end)) {
      const heading = /^#### `([A-Za-z]+)`$/.exec(line);
      if (heading) region = heading[1]!;
      else if (region && line.startsWith('| `[')) (tables[region] ??= []).push(line);
    }
    const cell = (hook: CssHook): string => (hook.values === null ? 'A name' : hook.values.length === 0 ? 'Present or absent' : hook.values.map((value) => `\`${value}\``).join(', '));
    const expected = Object.fromEntries(CSS_REGIONS.map((name) => [name, CSS_HOOKS[name].map((hook) => `| \`${hook.selector}\` | ${cell(hook)} | ${hook.meaning} |`)]));
    expect(tables).toEqual(expected);
  });
});

describe('transcript hooks', () => {
  const STATUSES: ReadonlyArray<ToolCall['status']> = ['running', 'completed', 'failed', 'cancelled', 'blocked'];
  const inTranscript = { plugins: [i18n], provide: { [IN_TRANSCRIPT as symbol]: true, ...CHAT_VIEW_PROVIDE }, stubs: { transition: false } };
  const MESSAGE: ChatMessage = { id: 'a1', role: 'assistant', content: '', timestamp: 1 };
  const USAGE = { totalInputTokens: 4000, totalOutputTokens: 1000, cacheReadTokens: 15000, cacheCreationTokens: 0, costUsd: 1.5 };
  const PATCH = createTwoFilesPatch('src/a.ts', 'src/a.ts', 'one\ntwo\n', 'one\n2\n', undefined, undefined, { headerOptions: FILE_HEADERS_ONLY })!;
  const AGENT: SubagentState = { id: 'c2', description: 'Scan', prompt: 'scan', status: 'completed', startTime: 1, messages: [], toolCalls: [], messagesSealed: true, usage: USAGE, dollarBilled: true };
  const route = (call: ToolCall, subagents?: Record<string, SubagentState>): void => {
    mounted.push(mount(ToolCallRouter, { props: { toolCall: call, toolUseId: call.id, toolName: call.name, message: MESSAGE, subagents }, global: inTranscript, attachTo: document.body }));
  };

  // A diff body and the agent and team cards carry attributes of their own beside the hooks, and data-part takes none of them.
  it('puts each tool card hook, with each value, inside a transcript scope root', async () => {
    setActivePinia(createPinia());
    for (const status of STATUSES) {
      mounted.push(mount(ToolCardFrame, {
        props: { tool: 'Bash', icon: Wrench, name: 'Run command', arg: 'ls', status },
        slots: { default: '<pre>output</pre>' },
        global: inTranscript,
        attachTo: document.body,
      }));
    }
    mounted.push(mount(ToolCallCard, {
      props: { toolCall: { id: 't-edit', name: 'Edit', input: { file_path: '/w/src/a.ts', old_string: 'two', new_string: '2' }, status: 'completed', metadata: { patch: PATCH } }, source: 'session' },
      global: inTranscript,
      attachTo: document.body,
    }));
    route({ id: 'c2', name: 'Agent', input: { description: 'Scan' }, status: 'completed' }, { c2: AGENT });
    useTeamStore().restoreTeamFromHistory({
      teamId: 't1', toolUseId: 'c3', title: 'Lockout', status: 'completed', phase: 'working', messages: [], scratchpad: [], result: null, startTime: 0, endTime: null, totalToolCount: 0,
      agents: [{
        agentId: 'a1', name: 'Atlas', role: 'lead', description: null, task: null, model: 'm', profileId: null, attempt: 0, status: 'completed', activeMs: 0, runningSince: null,
        toolCount: 0, lastToolName: null, ...USAGE, dollarBilled: true, effort: null, progressSummary: null, result: null, logFilePath: null,
      }],
      runs: [{ toolUseId: 'c3', status: 'completed', startTime: 0, endTime: null, toolCount: 0, usage: USAGE, legacyTokens: 1200 }],
    });
    route({ id: 'c3', name: 'create_team', input: { title: 'Lockout' }, status: 'completed' });
    await flushPromises();

    const inRoot = (selector: string): number => document.querySelectorAll(`[data-theme-scope~="transcript"] ${selector}`).length;
    expect(inRoot('[data-testid="diff-view"] [data-diff-line]')).toBeGreaterThan(0);
    expect(inRoot('[data-testid="subagent-card"] [data-usage]')).toBe(3);
    expect(inRoot('[data-testid="team-card"] [data-usage]')).toBe(4);

    const seen: Seen = new Map();
    collect('transcript', seen);
    expectHooks('transcript', seen);
    expectNoneOutside(['transcript']);
  });
});

describe('sidebar and title bar hooks', () => {
  const still = { url: 'app://damocles/theme-blob/idle', moves: false, playable: false };
  const PIP: CharacterView = { name: 'Pip', states: { idle: still, running: { url: 'app://damocles/theme-blob/run', strip: { frameWidth: 10, frameHeight: 10, frames: 4, fps: 4 }, moves: true, playable: true } } };
  const project = (key: string, running: number, waiting: number): ShellProject => ({ ...STATE.projects[0]!, key, name: key, fsPath: `/w/${key}`, trusted: true, running, waiting });
  // one project with a character per state, and one with no pin, which keeps its letter since the set has no characters of its own
  const PINNED = keysOf(PROJECT_COUNTS).map((state) => project(state, ...PROJECT_COUNTS[state]));
  const PROJECTS = [...PINNED, project('letter', 0, 0)];
  const CHATS = keysOf(CHAT_STATUSES).map((status) => chat({ id: `c-${status}`, status }));
  const SELECTED_CHAT = CHATS[0]!.id;
  const characters = (selection: CharacterSelection): ShownCharacters => ({ characters: [], pins: Object.fromEntries(PINNED.map(({ key }) => [key, PIP])), motion: 'always', selection });
  const attributes = (selector: string, attribute: string): Array<string | null> => [...document.querySelectorAll(`[data-theme-scope~="sidebar"] ${selector}`)].map((element) => element.getAttribute(attribute));

  // The title bar shows only the selected project, so each state and kind of its avatar takes a window of its own.
  it('puts each hook, with each value, inside its region\'s scope roots', async () => {
    const seen = { sidebar: new Map() as Seen, titlebar: new Map() as Seen };
    for (const { key: selected } of PROJECTS) {
      for (const selection of CHARACTER_SELECTIONS) {
        const state: ShellState = { ...STATE, projects: PROJECTS, selected: { projectKey: selected, chatId: SELECTED_CHAT }, selectedChat: { id: SELECTED_CHAT, title: 'Fix login', status: 'idle' }, characters: characters(selection) };
        const wrapper = mount(App, { props: { api: fakeShellApi(CHATS, { getState: vi.fn(async () => state) }) }, global: { plugins: [shellI18n] }, attachTo: document.body });
        await flushPromises();
        collect('sidebar', seen.sidebar);
        collect('titlebar', seen.titlebar);
        expectNoneOutside(['sidebar', 'titlebar']);
        // data-selected has three carriers and is listed once, so each is pinned on its own
        expect(attributes('[data-project-row][data-selected]', 'data-project-key'), selected).toEqual([selected]);
        expect(attributes('[data-chat-row][data-selected]', 'data-chat-id'), selected).toEqual([SELECTED_CHAT]);
        expect(attributes('[data-project-row][data-selected] [data-avatar][data-selected]', 'data-avatar'), selected).toEqual([selected === 'letter' ? 'letter' : 'character']);
        expect(attributes('[data-avatar][data-selected]', 'data-avatar'), selected).toHaveLength(1);
        wrapper.unmount();
        document.body.innerHTML = '';
      }
    }
    expectHooks('sidebar', seen.sidebar);
    expectHooks('titlebar', seen.titlebar);
  });

  it('keeps a chat row\'s hooks on it while it is renamed', () => {
    const wrapper = mount(ChatRow, { props: { chat: chat({ id: 'c1', status: 'running' }), optionId: 'o1', selected: true, active: true, renaming: true }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    const row = wrapper.get('[data-testid="chat-rename"]');
    expect(row.attributes('data-chat-row')).toBe('');
    expect(row.attributes('data-selected')).toBe('');
    expect(row.attributes('data-chat-state')).toBe('running');
  });
});

describe('editor and terminal chrome hooks', () => {
  it('puts each editor chrome hook inside an editorChrome scope root', async () => {
    const tab = (id: string, dirty: boolean): ShellEditorTab => ({ id, kind: 'code', documentId: `d-${id}`, title: `${id}.ts`, projectKey: 'p1', relativePath: `src/${id}.ts`, displayPath: `/w/alpha/src/${id}.ts`, dirty, readOnly: false, conflict: false });
    const tabs = [tab('a', true), tab('b', false)];
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs, activeTabId: 'a' })) });
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const global = { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: createTerminalStore(api) } };
    mounted.push(mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects: [], hosts: [] }, global, attachTo: document.body }));
    mounted.push(mount(Breadcrumbs, { props: { tab: tabs[0]!, projectName: 'alpha', place: { kind: 'project' } }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();

    const seen: Seen = new Map();
    collect('editorChrome', seen);
    expectHooks('editorChrome', seen);
    expectNoneOutside(['editorChrome']);
    expect(document.querySelector('[data-editor-tab][data-active]')?.getAttribute('data-tab-id')).toBe('a');
    expect([...document.querySelectorAll('[data-editor-tab][data-dirty]')].map((element) => element.getAttribute('data-tab-id'))).toEqual(['a']);
  });

  it('puts each terminal chrome hook inside the terminalChrome scope root', () => {
    const info = (id: string, status: TerminalStatus): TerminalInfo => ({
      id, title: id, name: null, profileId: 'cmd', icon: 'cmd', customIcon: null, color: null, projectKey: 'p1', projectName: 'alpha', status, exitCode: status === 'exited' ? 1 : null, description: null, running: null, integrated: false, restoring: false, windowsBuild: null, pathFlavor: 'posix', placement: 'panel',
    });
    const terminals = keysOf(TERMINAL_STATUSES).map((status) => info(`t-${status}`, status));
    const activeId = terminals[0]!.id;
    const groups: TerminalGroupInfo[] = terminals.map((terminal) => ({ id: `g-${terminal.id}`, paneIds: [terminal.id], activePaneId: terminal.id, sizes: [1] }));
    const store = { renaming: shallowRef(null), startRename: vi.fn(), state: shallowRef({ ...TERMINAL_STATE, terminals, groups, activeId }), moved: shallowRef(null), move: vi.fn() } as unknown as TerminalStore;
    mounted.push(mount(TerminalList, {
      props: { api: fakeShellApi(), platform: 'win32', terminals, groups, activeId, splitShortcut: 'Ctrl+Shift+5', widthRem: 12, panelWidth: 1200 },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store } },
      attachTo: document.body,
    }));

    const seen: Seen = new Map();
    collect('terminalChrome', seen);
    expectHooks('terminalChrome', seen);
    expectNoneOutside(['terminalChrome']);
    expect([...document.querySelectorAll('[data-terminal-row][data-active]')].map((element) => element.getAttribute('data-terminal-id'))).toEqual([activeId]);
  });
});
