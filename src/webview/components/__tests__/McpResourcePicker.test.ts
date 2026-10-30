// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import McpResourcePicker from '../McpResourcePicker.vue';
import { stackLayout } from '../ui/__tests__/list-layout';
import { applyLocale, i18n } from '@/i18n';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { inGreek } from '../../../__mocks__/greek-locale';

const bridge = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
let posted: Array<{ type: string; requestId?: string; [key: string]: unknown }> = [];
const mounted: VueWrapper[] = [];

beforeEach(() => {
  i18n.global.locale.value = 'en';
  posted = [];
  vi.spyOn(bridge, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function picker(): VueWrapper {
  const wrapper = mount(McpResourcePicker, { props: { serverName: 'docs' }, global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

const last = (type: string) => [...posted].reverse().find((message) => message.type === type)!;
const count = (type: string) => posted.filter((message) => message.type === type).length;

async function reply(message: ExtensionToWebviewMessage): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
  await flushPromises();
}

const REQUEST_OF: Record<string, string> = {
  mcpResources: 'requestMcpResources',
  mcpResourceTemplates: 'requestMcpResourceTemplates',
  mcpResourceChildren: 'requestMcpResourceChildren',
  mcpResourceCompletion: 'requestMcpResourceCompletion',
  mcpResourceAttached: 'attachMcpResource',
};

/** Core's reply to a request; the latest of the matching type unless one is named. */
const answer = (type: string, fields: Record<string, unknown>, requestId = last(REQUEST_OF[type]!).requestId!) =>
  reply({ type, requestId, ...fields } as unknown as ExtensionToWebviewMessage);

const rowUris = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="mcp-resource-row"]').map((row) => row.attributes('data-uri'));
const filterInput = () => document.querySelector<HTMLInputElement>('[data-testid="mcp-resource-filter"]')!;
const highlighted = () => document.querySelector<HTMLElement>('[data-testid="mcp-resource-picker"] [data-highlighted]');
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  filterInput().dispatchEvent(event);
  await flushPromises();
  return event;
}

describe('McpResourcePicker', () => {
  it('shows the first page as it arrives, loads more from its row, lists templates and filters the loaded rows', async () => {
    const wrapper = picker();
    expect(posted.map((message) => message.type)).toEqual(['requestMcpResources', 'requestMcpResourceTemplates']);
    expect(last('requestMcpResources')).toMatchObject({ serverName: 'docs' });
    expect(last('requestMcpResources').cursor).toBeUndefined();

    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'alpha', mimeType: 'text/plain', size: 2048, description: 'The first letter' }], nextCursor: 'p2' });
    expect(rowUris(wrapper)).toEqual(['docs://a']);
    const row = wrapper.get('[data-testid="mcp-resource-row"]');
    expect(row.attributes('role')).toBe('option');
    expect(row.text()).toContain('text/plain · 2 kB');
    expect(row.text()).toContain('The first letter');

    await wrapper.get('[data-testid="mcp-resource-load-more"]').trigger('click');
    expect(last('requestMcpResources')).toMatchObject({ cursor: 'p2' });
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'alpha' }, { uri: 'docs://b', name: 'beta' }, { uri: 'docs://b', name: 'beta' }] });
    expect(rowUris(wrapper)).toEqual(['docs://a', 'docs://b']);
    expect(wrapper.find('[data-testid="mcp-resource-load-more"]').exists()).toBe(false);

    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }], nextCursor: 't2' });
    await wrapper.get('[data-testid="mcp-template-load-more"]').trigger('click');
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }, { uriTemplate: 'docs://tags/{tag}', name: 'tag' }] });
    expect(wrapper.findAll('[data-testid="mcp-template-row"]').map((option) => option.attributes('data-uri-template'))).toEqual(['docs://items/{id}', 'docs://tags/{tag}']);

    await wrapper.get('[data-testid="mcp-resource-filter"]').setValue('bet');
    expect(rowUris(wrapper)).toEqual(['docs://b']);
    expect(wrapper.findAll('[data-testid="mcp-template-row"]')).toHaveLength(0);
    await wrapper.get('[data-testid="mcp-resource-filter"]').setValue('zzz');
    expect(wrapper.get('[data-testid="mcp-resource-status"]').text()).toBe('No loaded resource matches the filter.');
  });

  it('keeps focus in the filter while the arrow keys move between rows, and Enter runs the highlighted row', async () => {
    const wrapper = picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'alpha' }, { uri: 'docs://b', name: 'beta' }], nextCursor: 'p2' });
    await answer('mcpResourceTemplates', { templates: [] });
    expect(document.activeElement).toBe(filterInput());
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://a');
    expect(filterInput().getAttribute('aria-activedescendant')).toBe(highlighted()!.id);
    expect(filterInput().getAttribute('aria-controls')).toBe(wrapper.get('[role="listbox"]').attributes('id'));

    await press('ArrowDown');
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://b');
    await press('Enter');
    expect(last('attachMcpResource')).toMatchObject({ serverName: 'docs', uri: 'docs://b', name: 'beta' });
    expect(document.activeElement).toBe(filterInput());

    await press('ArrowDown');
    expect(highlighted()?.getAttribute('data-testid')).toBe('mcp-resource-load-more');
    await press('Enter');
    expect(last('requestMcpResources')).toMatchObject({ cursor: 'p2' });
    await press('Enter');
    expect(count('requestMcpResources')).toBe(2);
    expect(highlighted()?.getAttribute('data-testid')).toBe('mcp-resource-load-more');
    await answer('mcpResources', { resources: [{ uri: 'docs://c', name: 'gamma' }] });
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://c');
    expect(document.activeElement).toBe(filterInput());
  });

  it('highlights the first row whatever group answers first until the user moves, and loops at either end as VS Code does', async () => {
    picker();
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }] });
    expect(highlighted()?.getAttribute('data-uri-template')).toBe('docs://items/{id}');
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'alpha' }, { uri: 'docs://b', name: 'beta' }] });
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://a');

    await press('ArrowUp');
    expect(highlighted()?.getAttribute('data-uri-template')).toBe('docs://items/{id}');
    await press('ArrowDown');
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://a');
    await press('ArrowDown');
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://b');
  });

  it('leaves the highlight where the user moved it when another group arrives', async () => {
    picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'alpha' }, { uri: 'docs://b', name: 'beta' }] });
    await press('ArrowDown');
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }] });
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://b');
  });

  it('leaves Home and End to the filter’s caret, and Ctrl+Home and Ctrl+End move to the first and last row as VS Code’s quick pick does', async () => {
    picker();
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }] });
    for (const key of ['End', 'Home']) {
      expect((await press(key)).defaultPrevented).toBe(false);
      expect(highlighted()?.getAttribute('data-uri-template')).toBe('docs://items/{id}');
    }
    // The caret moved, not the highlight, so the first row that arrives still takes it.
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'alpha' }, { uri: 'docs://b', name: 'beta' }] });
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://a');

    expect((await press('End', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(highlighted()?.getAttribute('data-uri-template')).toBe('docs://items/{id}');
    await press('Home', { ctrlKey: true });
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://a');
    await press('ArrowDown');
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://b');
    await press('Enter');
    expect(last('attachMcpResource')).toMatchObject({ uri: 'docs://b' });
    expect(document.activeElement).toBe(filterInput());
  });

  it('keeps the row Ctrl+End moved to when another group arrives', async () => {
    picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'alpha' }, { uri: 'docs://b', name: 'beta' }] });
    await press('End', { ctrlKey: true });
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }] });
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://b');
  });

  it('pages with PageDown and PageUp, and keeps the row a page move reached when another group arrives', async () => {
    picker();
    const resources = Array.from({ length: 8 }, (_, index) => ({ uri: `docs://${index}`, name: `doc ${index}` }));
    await answer('mcpResources', { resources });
    // The overlay's body is the scroll area: a 20 px heading and three 20 px rows of it show.
    const body = document.querySelector<HTMLElement>('[data-testid="mcp-resource-picker"] .overflow-y-auto')!;
    stackLayout(body, { viewPx: 80, rowPx: 20, headingPx: 20 });
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://0');

    expect((await press('PageDown')).defaultPrevented).toBe(true);
    expect([highlighted()?.getAttribute('data-uri'), body.scrollTop]).toEqual(['docs://2', 0]);
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }] });
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://2');

    await press('PageDown');
    expect([highlighted()?.getAttribute('data-uri'), body.scrollTop]).toEqual(['docs://6', 80]);
    await press('PageUp');
    expect([highlighted()?.getAttribute('data-uri'), body.scrollTop]).toEqual(['docs://3', 80]);
    await press('Enter');
    expect(last('attachMcpResource')).toMatchObject({ uri: 'docs://3' });
    expect(document.activeElement).toBe(filterInput());
  });

  it('announces loading through status regions that are in place before their text', async () => {
    const wrapper = picker();
    expect(wrapper.get('[data-testid="mcp-resource-status"]').attributes('role')).toBe('status');
    expect(wrapper.get('[data-testid="mcp-resource-status"]').text()).toBe('');
    await frame();
    await flushPromises();
    expect(wrapper.get('[data-testid="mcp-resource-status"]').text()).toBe('Loading...');
    expect(wrapper.get('[data-testid="mcp-template-status"]').text()).toBe('Loading...');
    await answer('mcpResources', { resources: [] });
    expect(wrapper.get('[data-testid="mcp-resource-status"]').text()).toBe('This server lists no resources.');
  });

  it('shows a list error from core, and a failed first page offers Retry', async () => {
    const wrapper = picker();
    await answer('mcpResources', { resources: [], error: { message: 'Could not list the resources of {0}: {1}', args: ['docs', 'boom'] } });
    expect(wrapper.get('[data-testid="mcp-resource-section"] [role="alert"]').text()).toBe('Could not list the resources of docs: boom');
    const retry = wrapper.get('[data-testid="mcp-resource-load-more"]');
    expect(retry.text()).toBe('Retry');
    expect(highlighted()).toBe(retry.element);

    await press('Enter');
    expect(count('requestMcpResources')).toBe(2);
    expect(last('requestMcpResources').cursor).toBeUndefined();
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'alpha' }] });
    expect(wrapper.find('[data-testid="mcp-resource-section"] [role="alert"]').exists()).toBe(false);
    expect(rowUris(wrapper)).toEqual(['docs://a']);
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://a');
  });

  it("renders core's list, directory and attach errors in the language the view switches to", async () => {
    const coreText = { message: 'Could not open file: {0}', args: ['docs://a'] };
    const wrapper = picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'a' }, { uri: 'docs://dir', name: 'dir', directory: true }], error: coreText });
    await answer('mcpResourceTemplates', { templates: [], error: coreText });
    await wrapper.get('[data-uri="docs://a"]').trigger('click');
    await answer('mcpResourceAttached', { refused: coreText });
    const shown = (): string[] => [
      wrapper.get('[data-testid="mcp-resource-section"] [role="alert"]').text(),
      wrapper.get('[data-testid="mcp-template-section"] [role="alert"]').text(),
      wrapper.get('[data-testid="mcp-resource-attach-error"]').text(),
    ];
    expect(shown()).toEqual(Array(3).fill('Could not open file: docs://a'));

    await applyLocale('el');
    await flushPromises();
    expect(shown()).toEqual(Array(3).fill(inGreek(coreText)));

    await wrapper.get('[data-uri="docs://dir"] [data-testid="mcp-row-action"]').trigger('click');
    await answer('mcpResourceChildren', { children: [], error: coreText });
    await applyLocale('en');
    await flushPromises();
    expect(wrapper.get('[data-testid="mcp-resource-section"] [role="alert"]').text()).toBe('Could not open file: docs://a');
  });

  it('opens a directory in place, a sub-directory below it, and Back returns level by level to the row it left', async () => {
    const wrapper = picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'a' }, { uri: 'docs://dir', name: 'dir', directory: true }] });
    expect(wrapper.get('[data-uri="docs://dir"] [data-testid="mcp-row-action"]').text()).toBe('Open');
    await press('ArrowDown');
    await press('Enter');
    expect(last('requestMcpResourceChildren')).toMatchObject({ serverName: 'docs', uri: 'docs://dir' });
    await answer('mcpResourceChildren', { children: [{ uri: 'docs://dir/x', name: 'x', size: 3 }, { uri: 'docs://dir/sub', name: 'sub', directory: true }, { uri: 'docs://dir/x', name: 'x' }] });
    expect(rowUris(wrapper)).toEqual(['docs://dir/x', 'docs://dir/sub']);
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://dir/x');
    expect(wrapper.get('[data-testid="mcp-resource-back"]').text()).toBe('Back to Resources');
    expect(wrapper.find('[data-testid="mcp-template-section"]').exists()).toBe(false);

    await wrapper.get('[data-uri="docs://dir/sub"]').trigger('click');
    await answer('mcpResourceChildren', { children: [] });
    expect(wrapper.get('[data-testid="mcp-resource-status"]').text()).toBe('This directory is empty.');
    expect(wrapper.get('[data-testid="mcp-resource-back"]').text()).toBe('Back to dir');
    expect(highlighted()?.getAttribute('data-testid')).toBe('mcp-resource-back');

    await press('Enter');
    expect(rowUris(wrapper)).toEqual(['docs://dir/x', 'docs://dir/sub']);
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://dir/sub');
    await wrapper.get('[data-testid="mcp-resource-back"]').trigger('click');
    await flushPromises();
    expect(rowUris(wrapper)).toEqual(['docs://a', 'docs://dir']);
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://dir');
    expect(document.activeElement).toBe(filterInput());
  });

  it('ignores a directory reply that arrives after Back', async () => {
    const wrapper = picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://dir', name: 'dir', directory: true }, { uri: 'docs://a', name: 'a' }] });
    await press('Enter');
    const children = last('requestMcpResourceChildren').requestId!;
    await wrapper.get('[data-testid="mcp-resource-back"]').trigger('click');
    await flushPromises();
    await answer('mcpResourceChildren', { children: [{ uri: 'docs://dir/x', name: 'x' }] }, children);
    expect(rowUris(wrapper)).toEqual(['docs://dir', 'docs://a']);
    expect(wrapper.find('[data-testid="mcp-resource-back"]').exists()).toBe(false);
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://dir');
  });

  it('stops listening when it closes, so a reply that arrives later reaches nothing', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    picker();
    const listener = added.mock.calls.find(([type]) => type === 'message')![1];
    const listing = last('requestMcpResources').requestId!;
    mounted.pop()!.unmount();
    expect(removed).toHaveBeenCalledWith('message', listener);
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'a' }] }, listing);
    expect(document.querySelector('[data-testid="mcp-resource-row"]')).toBeNull();
  });

  it('offers Attach on a row shown as a directory whose read returned its own content', async () => {
    const wrapper = picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://empty', name: 'empty', directory: true }, { uri: 'docs://a', name: 'a' }] });
    await press('Enter');
    await answer('mcpResourceChildren', { children: [], notDirectory: true });

    expect(wrapper.find('[data-testid="mcp-resource-back"]').exists()).toBe(false);
    expect(rowUris(wrapper)).toEqual(['docs://empty', 'docs://a']);
    expect(wrapper.get('[data-uri="docs://empty"] [data-testid="mcp-row-action"]').text()).toBe('Attach');
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://empty');
    await press('Enter');
    expect(last('attachMcpResource')).toMatchObject({ serverName: 'docs', uri: 'docs://empty', name: 'empty' });
  });

  it('attaches a row whose not-a-directory answer arrived after Back, rather than opening it again', async () => {
    const wrapper = picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://empty', name: 'empty', directory: true }] });
    await press('Enter');
    const children = last('requestMcpResourceChildren').requestId!;
    await press('Enter');
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://empty');
    await answer('mcpResourceChildren', { children: [], notDirectory: true }, children);
    expect(wrapper.get('[data-uri="docs://empty"] [data-testid="mcp-row-action"]').text()).toBe('Attach');

    await press('Enter');
    expect(count('requestMcpResourceChildren')).toBe(1);
    expect(last('attachMcpResource')).toMatchObject({ uri: 'docs://empty' });
  });

  it('keeps a denied or binary row reachable with its reason, does nothing on Enter there, and attaches anything else', async () => {
    const wrapper = picker();
    await answer('mcpResources', {
      resources: [
        { uri: 'docs://secret', name: 'secret', denied: { rule: 'mcp__docs__read_mcp_resource(docs://secret)' } },
        { uri: 'docs://zip', name: 'zip', mimeType: 'application/zip' },
        { uri: 'docs://logo', name: 'logo', mimeType: 'image/png' },
        { uri: 'docs://notes', name: 'notes' },
        { uri: 'docs://app.js', name: 'app.js', mimeType: 'application/javascript' },
        { uri: 'docs://main.ts', name: 'main.ts', mimeType: 'video/mp2t' },
      ],
    });
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://blobs/{id}', name: 'blob', mimeType: 'application/octet-stream' }] });
    const reason = (selector: string) => wrapper.find(`${selector} [data-testid="mcp-resource-unavailable"]`);
    expect(reason('[data-uri="docs://secret"]').text()).toBe('A deny rule covers this resource: mcp__docs__read_mcp_resource(docs://secret)');
    expect(reason('[data-uri="docs://zip"]').text()).toBe('application/zip is binary content, which cannot be sent to the model.');
    expect(reason('[data-uri-template="docs://blobs/{id}"]').text()).toBe('application/octet-stream is binary content, which cannot be sent to the model.');
    for (const uri of ['docs://logo', 'docs://notes', 'docs://app.js', 'docs://main.ts']) {
      expect(wrapper.get(`[data-uri="${uri}"]`).attributes('aria-disabled')).toBeUndefined();
    }

    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://secret');
    expect(highlighted()?.getAttribute('aria-disabled')).toBe('true');
    await press('Enter');
    await press('ArrowDown');
    expect(highlighted()?.getAttribute('data-uri')).toBe('docs://zip');
    await press('Enter');
    await wrapper.get('[data-uri-template="docs://blobs/{id}"]').trigger('click');
    expect(count('attachMcpResource')).toBe(0);
    expect(wrapper.find('[data-testid="mcp-template-form"]').exists()).toBe(false);

    await wrapper.get('[data-uri="docs://notes"]').trigger('click');
    expect(last('attachMcpResource')).toMatchObject({ serverName: 'docs', uri: 'docs://notes', name: 'notes' });
    expect(wrapper.get('[data-uri="docs://notes"]').text()).toContain('Attaching...');
    await answer('mcpResourceAttached', { refused: { message: 'A message holds at most {0} attachments. Remove one to attach another.', args: [8] } });
    const error = wrapper.get('[data-testid="mcp-resource-attach-error"]');
    expect(error.attributes('role')).toBe('alert');
    expect(error.text()).toContain('at most 8');
    expect(error.element.closest('.sticky')).not.toBeNull();
    expect(wrapper.emitted('attached')).toBeUndefined();

    await wrapper.get('[data-uri="docs://logo"]').trigger('click');
    expect(last('attachMcpResource')).toMatchObject({ uri: 'docs://logo', mimeType: 'image/png' });
    await answer('mcpResourceAttached', {});
    expect(wrapper.emitted('attached')).toHaveLength(1);
  });

  it('shows every server-supplied URI with its hidden characters visible, and keeps the raw one for the request', async () => {
    const wrapper = picker();
    const spoofed = 'docs://safe\u202Etxt.exe';
    await answer('mcpResources', { resources: [{ uri: spoofed, name: 'safe' }] });
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://\u200Bitems/{id}', name: 'item' }] });
    const row = wrapper.get('[data-testid="mcp-resource-row"]');
    expect(row.attributes('data-uri')).toBe(spoofed);
    expect(row.text()).toContain('docs://safe\\u{202E}txt.exe');
    expect(row.text()).not.toContain('\u202E');
    expect(wrapper.get('[data-testid="mcp-template-row"]').text()).toContain('docs://\\u{200B}items/{id}');

    await wrapper.get('[data-testid="mcp-resource-row"]').trigger('click');
    expect(last('attachMcpResource')).toMatchObject({ uri: spoofed });

    await wrapper.get('[data-testid="mcp-template-row"]').trigger('click');
    const form = wrapper.get('[data-testid="mcp-template-form"]');
    expect(form.text()).toContain('docs://\\u{200B}items/{id}');
    await form.get('[data-template-variable="id"]').setValue('7');
    expect(wrapper.get('[data-testid="mcp-template-uri"]').text()).toBe('docs://\\u{200B}items/7');
  });

  it('fills a template, asks for completions 300 ms after typing with the other values as context, and attaches the expanded URI on Enter', async () => {
    vi.useFakeTimers();
    const wrapper = picker();
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://{kind}/items/{id}{?q}', name: 'item', mimeType: 'text/plain' }] });
    await wrapper.get('[data-testid="mcp-template-row"]').trigger('click');
    const form = wrapper.get('[data-testid="mcp-template-form"]');
    expect(form.findAll('[data-template-variable]').map((input) => input.attributes('data-template-variable'))).toEqual(['kind', 'id', 'q']);
    expect(document.activeElement).toBe(form.get('[data-template-variable="kind"]').element);
    expect(form.text()).toContain('optional');
    expect(wrapper.get('[data-testid="mcp-template-attach"]').attributes('disabled')).toBeDefined();

    await form.get('[data-template-variable="kind"]').setValue('fruit');
    await vi.advanceTimersByTimeAsync(300);
    expect(last('requestMcpResourceCompletion')).toMatchObject({ argument: 'kind', value: 'fruit', context: {} });
    const id = form.get('[data-template-variable="id"]');
    await id.trigger('focus');
    expect(last('requestMcpResourceCompletion')).toMatchObject({ argument: 'id', value: '', context: { kind: 'fruit' } });
    const before = count('requestMcpResourceCompletion');
    await id.setValue('a');
    await id.setValue('ap');
    await vi.advanceTimersByTimeAsync(299);
    expect(count('requestMcpResourceCompletion')).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(count('requestMcpResourceCompletion')).toBe(before + 1);
    expect(last('requestMcpResourceCompletion')).toMatchObject({ serverName: 'docs', template: 'docs://{kind}/items/{id}{?q}', argument: 'id', value: 'ap', context: { kind: 'fruit' } });
    await answer('mcpResourceCompletion', { values: ['apple', 'apricot', 'apple', 'ap'] });
    const suggestions = wrapper.findAll('[data-testid="mcp-template-completion"]');
    expect(suggestions.map((button) => button.text())).toEqual(['apple', 'apricot']);
    // A browser submits the field's form on Enter through its one submit button, which Back and a suggestion must not be.
    const fieldForm = (id.element as HTMLInputElement).form!;
    expect(Array.from(fieldForm.querySelectorAll('button:not([type="button"])'))).toEqual([wrapper.get('[data-testid="mcp-template-attach"]').element]);

    await suggestions[1]!.trigger('click');
    expect(wrapper.get('[data-testid="mcp-template-uri"]').text()).toBe('docs://fruit/items/apricot');
    expect(document.activeElement).toBe(id.element);
    expect(count('requestMcpResourceCompletion')).toBe(before + 1);

    // happy-dom has no implicit submission, so the test submits as Enter would.
    fieldForm.requestSubmit();
    await flushPromises();
    expect(last('attachMcpResource')).toMatchObject({ uri: 'docs://fruit/items/apricot', name: 'item (fruit, apricot)', mimeType: 'text/plain' });
  });

  it('applies no completion reply for a value the user has since changed, and a focus inside the debounce asks once', async () => {
    vi.useFakeTimers();
    const wrapper = picker();
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }] });
    await wrapper.get('[data-testid="mcp-template-row"]').trigger('click');
    const id = wrapper.get('[data-template-variable="id"]');

    await id.setValue('a');
    await vi.advanceTimersByTimeAsync(300);
    const forA = last('requestMcpResourceCompletion').requestId!;
    await id.setValue('ap');
    await answer('mcpResourceCompletion', { values: ['avocado'] }, forA);
    expect(wrapper.findAll('[data-testid="mcp-template-completion"]')).toHaveLength(0);

    const before = count('requestMcpResourceCompletion');
    await id.trigger('blur');
    await id.trigger('focus');
    expect(count('requestMcpResourceCompletion')).toBe(before + 1);
    expect(last('requestMcpResourceCompletion')).toMatchObject({ value: 'ap' });
    await vi.advanceTimersByTimeAsync(300);
    expect(count('requestMcpResourceCompletion')).toBe(before + 1);
  });

  it('returns from the form to the template row with focus in the filter', async () => {
    const wrapper = picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://a', name: 'a' }] });
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }, { uriTemplate: 'docs://tags/{tag}', name: 'tag' }] });
    await press('ArrowDown');
    await press('ArrowDown');
    await press('Enter');
    expect(wrapper.get('[data-testid="mcp-template-form"] h3').text()).toBe('tag');
    expect(wrapper.get('[data-testid="mcp-template-back"]').text()).toBe('Back to Templates');

    await wrapper.get('[data-testid="mcp-template-back"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="mcp-template-form"]').exists()).toBe(false);
    expect(document.activeElement).toBe(filterInput());
    expect(highlighted()?.getAttribute('data-uri-template')).toBe('docs://tags/{tag}');
  });

  it('names the template’s Back in Greek with the right article', async () => {
    i18n.global.locale.value = 'el';
    const wrapper = picker();
    await answer('mcpResources', { resources: [{ uri: 'docs://dir', name: 'dir', directory: true }] });
    await answer('mcpResourceTemplates', { templates: [{ uriTemplate: 'docs://items/{id}', name: 'item' }] });
    await press('Enter');
    expect(wrapper.get('[data-testid="mcp-resource-back"]').text()).toBe('Πίσω στους Πόρους');
    await wrapper.get('[data-testid="mcp-resource-back"]').trigger('click');
    await wrapper.get('[data-testid="mcp-template-row"]').trigger('click');
    expect(wrapper.get('[data-testid="mcp-template-back"]').text()).toBe('Πίσω στα Πρότυπα');
  });

  const RESOURCES_WITH_DETAILS = [
    { uri: 'docs://a', name: 'a', mimeType: 'text/plain', size: 1536 },
    { uri: 'docs://b', name: 'b', mimeType: 'text/plain' },
    { uri: 'docs://c', name: 'c', size: 8 },
    { uri: 'docs://d', name: 'd' },
  ];
  const details = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="mcp-resource-row"]').map((row) => row.find('[data-testid="mcp-resource-details"]'))
    .map((line) => (line.exists() ? line.text() : null));

  it.each([
    ['en', ['text/plain · 1.5 kB', 'text/plain', '8 bytes']],
    ['el', ['text/plain · 1,5 kB', 'text/plain', '8 byte']],
  ] as const)('shows a row’s type and size in %s', async (locale, expected) => {
    i18n.global.locale.value = locale;
    const wrapper = picker();
    await answer('mcpResources', { resources: RESOURCES_WITH_DETAILS });
    expect(wrapper.findAll('[data-testid="mcp-resource-row"]')).toHaveLength(4);
    expect(details(wrapper)).toEqual([...expected, null]);
  });

  it('leaves the order and punctuation of a row’s type and size to the translation', async () => {
    const shipped = (i18n.global.getLocaleMessage('en') as { mcp: { resourcePicker: { details: string } } }).mcp.resourcePicker.details;
    i18n.global.mergeLocaleMessage('en', { mcp: { resourcePicker: { details: '{size} ({type})' } } });
    try {
      const wrapper = picker();
      await answer('mcpResources', { resources: RESOURCES_WITH_DETAILS.slice(0, 1) });
      expect(details(wrapper)).toEqual(['1.5 kB (text/plain)']);
    } finally {
      i18n.global.mergeLocaleMessage('en', { mcp: { resourcePicker: { details: shipped } } });
    }
  });
});
