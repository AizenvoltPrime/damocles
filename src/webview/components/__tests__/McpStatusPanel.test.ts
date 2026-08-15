// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import McpStatusPanel from '../McpStatusPanel.vue';
import { i18n, applyLocale } from '@/i18n';
import type { McpConfigError, McpServerStatusInfo, McpWriteErrorInfo } from '@shared/types/mcp';

/**
 * `mcp-write-contract` §7.1 — which rows expose Add / Edit / Delete, and what the panel emits.
 *
 * These are mount tests because nothing else in this repo executes a `.vue` script block: the
 * gating predicate could be right in `mcp-server-form-logic.ts` and still be wired to the wrong
 * `v-if`, and `npm run typecheck` would never notice.
 */

/**
 * Mounted components, unmounted after each test. `document.body.innerHTML = ''` strips the DOM but
 * never runs `onUnmounted`, so a component with a document-level listener leaks one per test.
 */
const mounted: { unmount: () => void }[] = [];
function track<T extends { unmount: () => void }>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}
function mountPanel(servers: McpServerStatusInfo[], configErrors: McpConfigError[] = []) {
  return track(mount(McpStatusPanel, {
    props: {
      servers,
      configErrors,
      mcpWriteInFlight: false,
      mcpWriteError: null,
      mcpEnabled: true,
      visible: true,
    },
    attachTo: document.body,
    global: { plugins: [i18n] },
  }));
}

/**
 * The extension acknowledging a write: in-flight goes true while it is in the air, then false.
 * The form closes only on a clean settle, which is what keeps a typed definition alive across a
 * rejection the webview could not have predicted.
 */
async function settleWrite(
  wrapper: ReturnType<typeof mountPanel>,
  error: McpWriteErrorInfo | null = null,
): Promise<void> {
  await wrapper.setProps({ mcpWriteInFlight: true, mcpWriteError: null });
  await wrapper.setProps({ mcpWriteInFlight: false, mcpWriteError: error });
  await nextTick();
}

const editableDamocles: McpServerStatusInfo = {
  name: 'weather',
  status: 'connected',
  enabled: true,
  source: 'damocles',
  readonly: false,
  editableConfig: { command: 'node', args: ['server.js'] },
};

const buttons = (): HTMLButtonElement[] =>
  Array.from(document.body.querySelectorAll('button'));

const buttonsByText = (text: string): HTMLButtonElement[] =>
  buttons().filter((el) => el.textContent?.trim() === text);

const buttonByText = (text: string): HTMLButtonElement => {
  const found = buttonsByText(text)[0];
  if (!found) throw new Error(`no button labelled "${text}"`);
  return found;
};

const inputByPlaceholder = (placeholder: string): HTMLInputElement => {
  const found = Array.from(document.body.querySelectorAll<HTMLInputElement>('input')).find(
    (el) => el.placeholder === placeholder,
  );
  if (!found) throw new Error(`no input with placeholder "${placeholder}"`);
  return found;
};

async function click(el: HTMLElement): Promise<void> {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

const bodyText = (): string => document.body.textContent ?? '';

/** reka-ui leaves a closed dialog in the DOM for its exit animation, so openness is `data-state`. */
const openDialogTexts = (): string[] =>
  Array.from(document.body.querySelectorAll('[role="dialog"][data-state="open"]')).map(
    (el) => el.textContent ?? '',
  );

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  applyLocale('en');
  document.body.innerHTML = '';
});

describe('McpStatusPanel — affordance gating (contract §7.1)', () => {
  it('shows Edit and Delete for a damocles server with an editable config', async () => {
    mountPanel([editableDamocles]);
    await nextTick();
    expect(buttonsByText('Edit')).toHaveLength(1);
    expect(buttonsByText('Delete')).toHaveLength(1);
  });

  it('shows Delete but not Edit — with an explanation — when there is no editable config', async () => {
    mountPanel([{ ...editableDamocles, editableConfig: undefined }]);
    await nextTick();
    expect(buttonsByText('Edit')).toHaveLength(0);
    expect(buttonsByText('Delete')).toHaveLength(1);
    expect(bodyText()).toContain('Edit it directly in ~/.damocles/mcp.json');
  });

  it('shows NO edit or delete affordance for claude or codex imports', async () => {
    for (const source of ['claude', 'codex'] as const) {
      const wrapper = mountPanel([{ name: 'imported', status: 'connected', enabled: true, source, readonly: true }]);
      await nextTick();
      expect(buttonsByText('Edit')).toHaveLength(0);
      expect(buttonsByText('Delete')).toHaveLength(0);
      expect(bodyText()).not.toContain('Edit it directly');
      // Unmounted rather than `innerHTML = ''`: wiping the DOM under a live component leaves Vue
      // holding fragment anchors that no longer exist, and teardown then throws.
      wrapper.unmount();
    }
  });

  it('shows NO affordance for a workspace server, which is readonly:false but not ours', async () => {
    mountPanel([
      {
        name: 'project-server',
        status: 'connected',
        enabled: true,
        source: 'workspace',
        readonly: false,
        editableConfig: { command: 'node' },
      },
    ]);
    await nextTick();
    expect(buttonsByText('Edit')).toHaveLength(0);
    expect(buttonsByText('Delete')).toHaveLength(0);
    // The badge explains why the buttons are missing.
    expect(bodyText()).toContain('From workspace');
  });

  it('fails CLOSED when `readonly` is absent from the payload', async () => {
    mountPanel([{ ...editableDamocles, readonly: undefined }]);
    await nextTick();
    expect(buttonsByText('Edit')).toHaveLength(0);
    expect(buttonsByText('Delete')).toHaveLength(0);
  });

  it('offers Add server even when there are no servers at all', async () => {
    mountPanel([]);
    await nextTick();
    expect(buttonsByText('Add server')).toHaveLength(1);
  });
});

describe('McpStatusPanel — add', () => {
  it('emits addServer with the name and config the form produced', async () => {
    const wrapper = mountPanel([]);
    await nextTick();
    await click(buttonByText('Add server'));
    await type(inputByPlaceholder('my-server'), 'weather');
    await type(inputByPlaceholder('npx'), 'node');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('addServer')).toEqual([['weather', { command: 'node' }]]);
    expect(wrapper.emitted('updateServer')).toBeUndefined();
  });

  it('closes the form once the extension confirms the write, and reopens it blank', async () => {
    const wrapper = mountPanel([]);
    await nextTick();
    await click(buttonByText('Add server'));
    await type(inputByPlaceholder('my-server'), 'weather');
    await type(inputByPlaceholder('npx'), 'node');
    await click(buttonByText('Save'));

    // Still open: the write has only been SENT.
    expect(openDialogTexts().some((text) => text.includes('Add MCP server'))).toBe(true);

    await settleWrite(wrapper);

    // reka-ui keeps a closed dialog's node around for its exit animation, so "closed" is the
    // `data-state`, not the absence of the element.
    expect(openDialogTexts().some((text) => text.includes('Add MCP server'))).toBe(false);

    await click(buttonByText('Add server'));
    expect(inputByPlaceholder('my-server').value).toBe('');
  });

  it('keeps the form and everything typed in it when the extension refuses the write', async () => {
    // The whole point of the acknowledgement: an unparseable file, a name only present in the raw
    // file, or EACCES would otherwise close the dialog and take the definition with it.
    const wrapper = mountPanel([]);
    await nextTick();
    await click(buttonByText('Add server'));
    await type(inputByPlaceholder('my-server'), 'weather');
    await type(inputByPlaceholder('npx'), 'node');
    await click(buttonByText('Save'));
    await settleWrite(wrapper, { code: 'nameExists', params: { name: 'weather' } });

    expect(openDialogTexts().some((text) => text.includes('Add MCP server'))).toBe(true);
    expect(inputByPlaceholder('my-server').value).toBe('weather');
    expect(inputByPlaceholder('npx').value).toBe('node');
    expect(bodyText()).toContain('already exists in ~/.damocles/mcp.json');
  });
});

describe('McpStatusPanel — edit', () => {
  it('emits updateServer with NO newServerName for an in-place edit', async () => {
    const wrapper = mountPanel([editableDamocles]);
    await nextTick();
    await click(buttonByText('Edit'));
    await type(inputByPlaceholder('npx'), 'deno');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('updateServer')).toEqual([
      ['weather', undefined, { command: 'deno', args: ['server.js'] }],
    ]);
  });

  it('emits updateServer with the pre-rename name FIRST and the new name second', async () => {
    const wrapper = mountPanel([editableDamocles]);
    await nextTick();
    await click(buttonByText('Edit'));
    await type(inputByPlaceholder('my-server'), 'forecast');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('updateServer')).toEqual([
      ['weather', 'forecast', { command: 'node', args: ['server.js'] }],
    ]);
  });

  it('pre-populates the form from editableConfig', async () => {
    mountPanel([editableDamocles]);
    await nextTick();
    await click(buttonByText('Edit'));
    expect(inputByPlaceholder('my-server').value).toBe('weather');
    expect(inputByPlaceholder('npx').value).toBe('node');
  });
});

describe('McpStatusPanel — delete confirmation', () => {
  it('does NOT emit deleteServer on the first click', async () => {
    const wrapper = mountPanel([editableDamocles]);
    await nextTick();
    await click(buttonByText('Delete'));
    expect(wrapper.emitted('deleteServer')).toBeUndefined();
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(bodyText()).toContain('Remove MCP server?');
    expect(bodyText()).toContain('weather');
  });

  it('emits deleteServer once the confirmation is accepted', async () => {
    const wrapper = mountPanel([editableDamocles]);
    await nextTick();
    await click(buttonByText('Delete'));

    const confirm = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((el) => el.textContent?.trim() === 'Delete');
    await click(confirm!);

    expect(wrapper.emitted('deleteServer')).toEqual([['weather']]);
  });

  it('emits nothing when the confirmation is cancelled', async () => {
    const wrapper = mountPanel([editableDamocles]);
    await nextTick();
    await click(buttonByText('Delete'));

    const cancel = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((el) => el.textContent?.trim() === 'Cancel');
    await click(cancel!);

    expect(wrapper.emitted('deleteServer')).toBeUndefined();
    expect(document.body.querySelector('[role="alertdialog"][data-state="open"]')).toBeNull();
  });
});

describe('McpStatusPanel — Escape handling', () => {
  it('closes the panel when nothing is stacked on top of it', async () => {
    const wrapper = mountPanel([editableDamocles]);
    await nextTick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('does not tear the panel down while the form is open on top of it', async () => {
    const wrapper = mountPanel([editableDamocles]);
    await nextTick();
    await click(buttonByText('Edit'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('does not tear the panel down while the delete confirmation is open', async () => {
    const wrapper = mountPanel([editableDamocles]);
    await nextTick();
    await click(buttonByText('Delete'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(wrapper.emitted('close')).toBeUndefined();
  });
});

describe('McpStatusPanel — unreadable config file', () => {
  const brokenGlobal: McpConfigError = {
    path: 'C:\\Users\\me\\.damocles\\mcp.json',
    displayPath: '~/.damocles/mcp.json',
    kind: 'parse',
    line: 14,
    column: 1,
  };

  it('names the file and the location so the failure is not silent', async () => {
    mountPanel([], [brokenGlobal]);
    await nextTick();
    // The ~-collapsed form is what renders: these panels get screenshotted into bug reports, and the
    // absolute path carries the OS username.
    expect(bodyText()).toContain('~/.damocles/mcp.json');
    expect(bodyText()).not.toContain('C:\\Users\\me');
    expect(bodyText()).toContain('line 14, column 1');
  });

  it('offers to open the file at the offending line', async () => {
    const wrapper = mountPanel([], [brokenGlobal]);
    await nextTick();
    await click(buttonByText('Open file'));
    expect(wrapper.emitted('openFile')).toEqual([[brokenGlobal.path, 14]]);
  });

  it('still offers to open a file the parser gave no location for', async () => {
    const wrapper = mountPanel([], [{ path: '/home/me/.damocles/mcp.json', line: null, column: null }]);
    await nextTick();
    expect(bodyText()).not.toContain('line null');
    await click(buttonByText('Open file'));
    expect(wrapper.emitted('openFile')).toEqual([['/home/me/.damocles/mcp.json', null]]);
  });

  it('shows no notice when every config file is readable', async () => {
    mountPanel([editableDamocles]);
    await nextTick();
    expect(bodyText()).not.toContain('A config file could not be read');
    expect(buttonsByText('Open file')).toHaveLength(0);
  });
});

describe('McpStatusPanel — i18n', () => {
  it('labels the new actions in Greek', async () => {
    applyLocale('el');
    mountPanel([editableDamocles]);
    await nextTick();
    expect(bodyText()).toContain('Προσθήκη server');
    expect(bodyText()).toContain('Επεξεργασία');
    expect(bodyText()).toContain('Διαγραφή');
    expect(bodyText()).not.toContain('Add server');
  });

  it('translates the unreadable-config notice, location included', async () => {
    applyLocale('el');
    mountPanel([], [{ path: '/x/mcp.json', line: 14, column: 1 }]);
    await nextTick();
    // The location is interpolated by the webview, so it is inside the translated sentence rather
    // than an English fragment handed over by the extension.
    expect(bodyText()).toContain('γραμμή 14, στήλη 1');
    expect(bodyText()).toContain('Άνοιγμα αρχείου');
    expect(bodyText()).not.toContain('Invalid JSON');
  });
});
