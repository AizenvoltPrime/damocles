// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import McpServerFormDialog from '../McpServerFormDialog.vue';
import OverlayShell from '../OverlayShell.vue';
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

const byField = (field: string): HTMLInputElement => {
  const found = document.body.querySelector<HTMLInputElement>(`[data-field="${field}"]`);
  if (!found) throw new Error(`no input with data-field "${field}"`);
  return found;
};

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

  it('switches to remote mode and emits the http discriminant, with no SSE choice offered', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'remote-one');
    await chooseRadio('remote');
    await type(byPlaceholder('https://example.com/mcp'), 'https://mcp.example.com/v1');

    expect(inputs().some((el) => el.type === 'radio' && el.value === 'sse')).toBe(false);
    expect(bodyText()).not.toMatch(/\bSSE\b/);
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')![0]![1]).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/v1',
    });
  });

  it('emits description, timeout and the OAuth fields the user filled in', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'remote-one');
    await chooseRadio('remote');
    await type(byPlaceholder('https://example.com/mcp'), 'https://mcp.example.com/v1');
    await type(byField('description'), 'Issue tracker');
    await type(byField('timeout'), '30');
    await type(byField('oauthClientName'), 'Acme Agent');
    await type(byField('oauthAuthServerMetadataUrl'), 'https://auth.example.com/meta');
    await type(byField('oauthCallbackUrl'), 'http://localhost:8080/callback');
    await type(byField('oauthCallbackPort'), '8080');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')![0]![1]).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/v1',
      description: 'Issue tracker',
      timeout: 30,
      oauth: {
        clientName: 'Acme Agent',
        authServerMetadataUrl: 'https://auth.example.com/meta',
        callbackUrl: 'http://localhost:8080/callback',
        callbackPort: 8080,
      },
    });
  });

  it('offers OAuth fields only in remote mode, and Description and Timeout in both', async () => {
    mountForm();
    await nextTick();
    expect(document.body.querySelector('[data-field="oauthClientName"]')).toBeNull();
    expect(byField('description')).toBeTruthy();
    expect(byField('timeout')).toBeTruthy();

    await chooseRadio('remote');
    for (const field of ['oauthClientName', 'oauthAuthServerMetadataUrl', 'oauthCallbackUrl', 'oauthCallbackPort']) {
      expect(byField(field).id).not.toBe('');
      expect(document.body.querySelector(`label[for="${byField(field).id}"]`)?.textContent?.trim()).toBeTruthy();
    }
    expect(Array.from(document.body.querySelectorAll('legend')).map((el) => el.textContent?.trim())).toContain('OAuth');
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

  it.each([
    ['timeout', '0', 'The timeout must be a positive number of seconds.'],
    ['oauthAuthServerMetadataUrl', 'http://auth.example.com/meta', 'This must be an https URL'],
    ['oauthCallbackUrl', 'https://localhost:8080/cb', 'This must be an http URL on localhost'],
    ['oauthCallbackPort', '65536', 'This must be a port number from 1 to 65535.'],
  ])('marks %s invalid inline, with an alert, and emits nothing', async (field, value, message) => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'remote-one');
    await chooseRadio('remote');
    await type(byPlaceholder('https://example.com/mcp'), 'https://mcp.example.com');
    await type(byField(field), value);
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(byField(field).getAttribute('aria-invalid')).toBe('true');
    const errorId = byField(field).getAttribute('aria-describedby')?.split(' ').at(-1);
    const alert = document.getElementById(errorId ?? '');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain(message);
  });

  it('flags a callback port that differs from the callback URL\u2019s port', async () => {
    const wrapper = mountForm();
    await nextTick();
    await type(byPlaceholder('my-server'), 'remote-one');
    await chooseRadio('remote');
    await type(byPlaceholder('https://example.com/mcp'), 'https://mcp.example.com');
    await type(byField('oauthCallbackUrl'), 'http://localhost:8080/cb');
    await type(byField('oauthCallbackPort'), '9090');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(bodyText()).toContain('The callback URL names a different port.');
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

    expect(bodyText()).toContain('Προσθήκη διακομιστή MCP');
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

  // ~/.damocles/mcp.json is pi format, so a typed $ or leading ! changes what the value means.
  it('explains how $ and a leading ! are read, for env and header values alike', async () => {
    mountForm();
    await nextTick();
    const hint = '$NAME and ${NAME} insert an environment variable, and $$ is a literal $. A value starting with ! runs as a shell command';
    expect(bodyText()).toContain(hint);

    await chooseRadio('remote');
    expect(bodyText()).toContain(hint);
  });

  it('explains it in Greek too', async () => {
    applyLocale('el');
    mountForm();
    await nextTick();
    expect(bodyText()).toContain('Τα $NAME και ${NAME} εισάγουν μια μεταβλητή περιβάλλοντος');
  });
});

describe('McpServerFormDialog — write acknowledgement', () => {
  it('refuses to send a second time while a write is in flight', async () => {
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

  it('reports a draft while it holds typed text or a write is in flight, so a scrim click leaves it open', async () => {
    const wrapper = mountForm();
    await nextTick();
    const shell = wrapper.findComponent(OverlayShell);
    expect(shell.props('hasDraft')).toBe(false);

    await type(byPlaceholder('my-server'), 'weather');
    expect(shell.props('hasDraft')).toBe(true);
    await click(document.body.querySelector<HTMLElement>('[data-testid="overlay-scrim"]')!);
    expect(wrapper.emitted('cancel')).toBeUndefined();
    expect(bodyText()).not.toContain('Discard your changes?');

    const pristineSaving = mountForm({ editingName: 'weather', editingConfig: { command: 'node' }, submitting: true });
    await nextTick();
    expect(pristineSaving.findComponent(OverlayShell).props('hasDraft')).toBe(true);
  });
});

describe('McpServerFormDialog — focus', () => {
  it('opens with focus on the Name field', async () => {
    mountForm();
    await nextTick();

    expect(document.activeElement).toBe(byPlaceholder('my-server'));
  });
});

describe('McpServerFormDialog — tool names shared with another server', () => {
  it('notes without blocking that a lower-precedence server with the same tool names will not load', async () => {
    const wrapper = mountForm({ servers: [{ name: 'my-server', source: 'claude' }] });
    await nextTick();
    await type(byPlaceholder('my-server'), 'my.server');
    await type(byPlaceholder('npx'), 'node');

    expect(bodyText()).toContain('"my-server" gets the same tool names as this name, so "my-server" will not load.');
    await click(buttonByText('Save'));
    expect(wrapper.emitted('save')).toHaveLength(1);
  });

  it('blocks a name that gets the same tool names as another server in ~/.damocles/mcp.json', async () => {
    const wrapper = mountForm({ servers: [{ name: 'my-server', source: 'damocles' }] });
    await nextTick();
    await type(byPlaceholder('my-server'), 'my.server');
    await type(byPlaceholder('npx'), 'node');
    await click(buttonByText('Save'));

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(bodyText()).toContain('"my-server" in ~/.damocles/mcp.json gets the same tool names.');
  });
});

describe('McpServerFormDialog — fields carried through an edit', () => {
  it('round-trips streamable-http, enabled:false and the OAuth fields untouched', async () => {
    const stored: McpServerConfig = {
      type: 'streamable-http',
      url: 'https://mcp.example.com',
      enabled: false,
      description: 'Docs',
      timeout: 1.5,
      oauth: { clientName: 'Acme', callbackPort: 8080 },
    };
    const wrapper = mountForm({ editingName: 'docs', editingConfig: stored });
    await nextTick();

    expect(byField('description').value).toBe('Docs');
    expect(byField('timeout').value).toBe('1.5');
    await click(buttonByText('Save'));
    expect(wrapper.emitted('save')![0]).toEqual(['docs', stored]);
  });
});
