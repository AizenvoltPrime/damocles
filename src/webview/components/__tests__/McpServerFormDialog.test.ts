// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import McpServerFormDialog from '../McpServerFormDialog.vue';
import { i18n, applyLocale } from '@/i18n';
import type { McpServerConfig, McpWriteErrorInfo } from '@shared/types/mcp';
import type { McpCollisionServer } from '../mcp-server-form-logic';

/**
 * The panel and this form are `.vue` files, and NOTHING in this repo type-checks or executes a
 * `.vue` script block otherwise (`tsconfig.json` excludes `src/webview`, and `tsconfig.webview.json`
 * is not wired to any script). These mount tests are therefore the only thing that proves the
 * template compiles, the props and emits line up, and the bindings actually reach the logic module —
 * a green `npm run typecheck` proves none of it.
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
function mountForm(overrides: {
  editingName?: string | null;
  editingConfig?: McpServerConfig | null;
  servers?: McpCollisionServer[];
  submitting?: boolean;
  writeError?: McpWriteErrorInfo | null;
} = {}) {
  return track(mount(McpServerFormDialog, {
    props: {
      visible: true,
      editingName: overrides.editingName ?? null,
      editingConfig: overrides.editingConfig ?? null,
      servers: overrides.servers ?? [],
      submitting: overrides.submitting ?? false,
      writeError: overrides.writeError ?? null,
    },
    attachTo: document.body,
    global: { plugins: [i18n] },
  }));
}

const inputs = (): HTMLInputElement[] =>
  Array.from(document.body.querySelectorAll<HTMLInputElement>('input'));

const byPlaceholder = (placeholder: string): HTMLInputElement => {
  const found = inputs().find((el) => el.placeholder === placeholder);
  if (!found) throw new Error(`no input with placeholder "${placeholder}"`);
  return found;
};

const buttonByText = (text: string): HTMLButtonElement => {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (el) => el.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no button labelled "${text}"`);
  return found;
};

async function type(el: HTMLInputElement, value: string): Promise<void> {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

async function click(el: HTMLElement): Promise<void> {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
}

async function chooseRadio(value: string): Promise<void> {
  const radio = inputs().find((el) => el.type === 'radio' && el.value === value);
  if (!radio) throw new Error(`no radio with value "${value}"`);
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

const buttonByLabel = (label: string): HTMLButtonElement => {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (el) => el.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
};

const bodyText = (): string => document.body.textContent ?? '';

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  applyLocale('en');
  document.body.innerHTML = '';
});

describe('McpServerFormDialog — add', () => {
  it('opens blank in stdio mode and emits the minimal config on save', async () => {
    const wrapper = mountForm();
    await nextTick();

    expect(byPlaceholder('my-server').value).toBe('');
    await type(byPlaceholder('my-server'), 'weather');
    await type(byPlaceholder('npx'), 'node');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')).toHaveLength(1);
    expect(wrapper.emitted('save')![0]).toEqual(['weather', { command: 'node' }]);
  });

  it('trims the submitted name, since the extension rejects padded names', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), '  weather  ');
    await type(byPlaceholder('npx'), 'node');
    await click(buttonByText('Save'));
    expect(wrapper.emitted('save')![0]![0]).toBe('weather');
  });

  it('emits args and env when the user adds rows, and omits the empty ones', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'weather');
    await type(byPlaceholder('npx'), 'npx');

    await click(buttonByText('Add argument'));
    await click(buttonByText('Add argument'));
    const args = inputs().filter((el) => el.placeholder === '-y');
    await type(args[0]!, '-y');
    // args[1] is left blank on purpose — a blank row must not become an empty argument.

    await click(buttonByText('Add variable'));
    await type(byPlaceholder('NAME'), 'API_HOST');
    await type(byPlaceholder('value'), 'example.com');

    await click(buttonByText('Save'));
    expect(wrapper.emitted('save')![0]![1]).toEqual({
      command: 'npx',
      args: ['-y'],
      env: { API_HOST: 'example.com' },
    });
  });

  it('switches to remote mode and emits the type discriminant', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'remote-one');
    await chooseRadio('remote');
    await type(byPlaceholder('https://example.com/mcp'), 'https://mcp.example.com/v1');
    await chooseRadio('sse');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')![0]![1]).toEqual({
      type: 'sse',
      url: 'https://mcp.example.com/v1',
    });
  });
});

describe('McpServerFormDialog — invalid input is rejected with a visible error', () => {
  it('shows an inline error and emits nothing when the name is missing', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('npx'), 'node');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(bodyText()).toContain('A name is required.');
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows an inline error and emits nothing when the command is missing', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'weather');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(bodyText()).toContain('A command is required.');
  });

  it('stays silent until the first save attempt, then clears as the user fixes the field', async () => {
    const wrapper = mountForm();
    await nextTick();
    expect(bodyText()).not.toContain('A name is required.');

    await click(buttonByText('Save'));
    expect(bodyText()).toContain('A name is required.');

    await type(byPlaceholder('my-server'), 'weather');
    await type(byPlaceholder('npx'), 'node');
    expect(bodyText()).not.toContain('A name is required.');
    expect(wrapper.emitted('save')).toBeUndefined();
  });

  it.each(['workspace', 'damocles-local'] as const)(
    'reports a collision with the project %s file before anything is sent',
    async (source) => {
      const wrapper = mountForm({
        servers: [{ name: 'taken', source }],
      });
      await nextTick();
      await type(byPlaceholder('my-server'), 'taken');
      await type(byPlaceholder('npx'), 'node');
      await click(buttonByText('Save'));

      expect(wrapper.emitted('save')).toBeUndefined();
      // The wording no longer names `.mcp.json`: two different project files reach this branch, and
      // claiming the wrong one would send the user to edit a file that does not define the name.
      expect(bodyText()).toContain('A project config file already defines this name');
    },
  );

  it('rejects a non-http URL', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'remote-one');
    await chooseRadio('remote');
    await type(byPlaceholder('https://example.com/mcp'), 'file:///etc/passwd');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(bodyText()).toContain('A URL must use http or https.');
  });
});

describe('McpServerFormDialog — secrets', () => {
  it('offers a bearer-token VARIABLE field and no raw token field', async () => {
    mountForm();
    await nextTick();
    await chooseRadio('remote');

    expect(bodyText()).toContain('Bearer token variable');
    expect(bodyText()).toContain('not the token itself');
    // A field that accepted a token value would have to be labelled as one.
    expect(bodyText()).not.toMatch(/Bearer token\s*$/m);
    expect(inputs().some((el) => el.type === 'password')).toBe(false);
  });

  it('rejects a pasted token in the variable field instead of persisting it', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'remote-one');
    await chooseRadio('remote');
    await type(byPlaceholder('https://example.com/mcp'), 'https://mcp.example.com');
    await type(byPlaceholder('MY_API_TOKEN'), 'sk-ant-api03-not-a-variable-name');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(bodyText()).toContain('This must be a variable name');
  });

  it('emits the variable name, never a `bearerToken` key', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'remote-one');
    await chooseRadio('remote');
    await type(byPlaceholder('https://example.com/mcp'), 'https://mcp.example.com');
    await type(byPlaceholder('MY_API_TOKEN'), 'MY_API_TOKEN');
    await click(buttonByText('Save'));

    const config = wrapper.emitted('save')![0]![1] as Record<string, unknown>;
    expect(config['bearerTokenEnv']).toBe('MY_API_TOKEN');
    expect(config).not.toHaveProperty('bearerToken');
  });
});

describe('McpServerFormDialog — edit', () => {
  const stored: McpServerConfig = {
    command: 'node',
    args: ['server.js'],
    env: { API_HOST: 'example.com' },
    cwd: '/srv',
  };

  it('pre-populates from the stored definition', async () => {
    mountForm({ editingName: 'weather', editingConfig: stored });
    await nextTick();

    expect(byPlaceholder('my-server').value).toBe('weather');
    expect(byPlaceholder('npx').value).toBe('node');
    expect(byPlaceholder('-y').value).toBe('server.js');
    expect(byPlaceholder('NAME').value).toBe('API_HOST');
    expect(byPlaceholder('value').value).toBe('example.com');
    expect(bodyText()).toContain('Edit MCP server');
  });

  it('round-trips an untouched definition byte-for-byte', async () => {
    const wrapper = mountForm({ editingName: 'weather', editingConfig: stored });
    await nextTick();
    await click(buttonByText('Save'));
    expect(wrapper.emitted('save')![0]).toEqual(['weather', stored]);
  });

  it('emits the new name when the user renames', async () => {
    const wrapper = mountForm({ editingName: 'weather', editingConfig: stored });
    await nextTick();
    await type(byPlaceholder('my-server'), 'forecast');
    await click(buttonByText('Save'));
    expect(wrapper.emitted('save')![0]![0]).toBe('forecast');
  });

  it('does not flag the edited server\u2019s own name as a collision', async () => {
    const wrapper = mountForm({
      editingName: 'weather',
      editingConfig: stored,
      servers: [
        { name: 'weather', source: 'damocles' },
      ],
    });
    await nextTick();
    await click(buttonByText('Save'));
    expect(wrapper.emitted('save')).toHaveLength(1);
  });

  it('emits cancel without saving', async () => {
    const wrapper = mountForm({ editingName: 'weather', editingConfig: stored });
    await nextTick();
    await click(buttonByText('Cancel'));
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    expect(wrapper.emitted('save')).toBeUndefined();
  });
});

describe('McpServerFormDialog — i18n', () => {
  it('renders Greek with no English left in the form, including the error text', async () => {
    applyLocale('el');
    mountForm();
    await nextTick();

    expect(bodyText()).toContain('Προσθήκη MCP server');
    expect(bodyText()).toContain('Όνομα');
    expect(bodyText()).not.toContain('Add MCP server');

    await click(buttonByText('Αποθήκευση'));
    expect(bodyText()).toContain('Απαιτείται όνομα.');
    expect(bodyText()).not.toContain('A name is required.');
  });
});

describe('McpServerFormDialog — secret values', () => {
  it('masks env values by default and reveals one on request', async () => {
    // `env` is the ordinary home for an MCP token and these values are rendered verbatim. VS Code
    // webviews get screen-shared and screenshotted constantly.
    mountForm({
      editingName: 'docs',
      editingConfig: { command: 'node', env: { GITHUB_TOKEN: 'ghp_SECRET' } },
    });
    await nextTick();

    const value = inputs().find((el) => el.value === 'ghp_SECRET');
    expect(value?.type).toBe('password');

    await click(buttonByLabel('Reveal value'));
    expect(inputs().find((el) => el.value === 'ghp_SECRET')?.type).toBe('text');
  });

  it('masks header values too', async () => {
    mountForm({
      editingName: 'api',
      editingConfig: { type: 'http', url: 'https://x.test', headers: { Authorization: 'Bearer sk-SECRET' } },
    });
    await nextTick();

    expect(inputs().find((el) => el.value === 'Bearer sk-SECRET')?.type).toBe('password');
  });

  it('says plainly that the value is stored in plain text', async () => {
    mountForm();
    await nextTick();
    expect(bodyText()).toContain('stored in plain text');
  });
});

describe('McpServerFormDialog — write acknowledgement', () => {
  it('refuses to send a second time while a write is in flight', async () => {
    // reka keeps DialogContent mounted through its exit animation, so Save stays clickable; without
    // the guard a double-click sends twice and the second is refused as "already exists" — by the row
    // the first one just created.
    const wrapper = mountForm({ submitting: true });
    await nextTick();
    await type(byPlaceholder('my-server'), 'weather');
    await type(byPlaceholder('npx'), 'node');

    await click(buttonByText('Saving…'));

    expect(wrapper.emitted('save')).toBeUndefined();
  });

  it('renders the extension\u2019s refusal against the still-filled form', async () => {
    mountForm({ writeError: { code: 'nameExists', params: { name: 'weather' } } });
    await nextTick();

    expect(bodyText()).toContain('already exists in ~/.damocles/mcp.json');
  });
});

describe('McpServerFormDialog — discarding work', () => {
  it('does not cancel a filled-in form on the first dismissal', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'weather');

    await click(buttonByText('Cancel'));

    expect(wrapper.emitted('cancel')).toBeUndefined();
    expect(bodyText()).toContain('Discard your changes?');
  });

  it('cancels on the second dismissal, once the user has confirmed', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'weather');
    await click(buttonByText('Cancel'));

    await click(buttonByText('Discard'));

    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('cancels an untouched form immediately, with nothing to lose', async () => {
    const wrapper = mountForm();
    await nextTick();

    await click(buttonByText('Cancel'));

    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });
});

describe('McpServerFormDialog — tool prefix', () => {
  it('warns without blocking when the tool prefix collides with another server', async () => {
    const wrapper = mountForm({ servers: [{ name: 'my-server', source: 'damocles' }] });
    await nextTick();
    await type(byPlaceholder('my-server'), 'my.server');
    await type(byPlaceholder('npx'), 'node');

    expect(bodyText()).toContain('my-server');
    await click(buttonByText('Save'));
    expect(wrapper.emitted('save')).toHaveLength(1);
  });
});
