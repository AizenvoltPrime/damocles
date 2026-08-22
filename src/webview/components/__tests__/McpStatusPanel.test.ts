// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import McpStatusPanel from '../McpStatusPanel.vue';
import { i18n, applyLocale } from '@/i18n';
import { mcpSourceOrder } from '@shared/types/mcp';
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
function mountPanel(
  servers: McpServerStatusInfo[],
  configErrors: McpConfigError[] = [],
  localMcpUnignored = false,
  over: { visible?: boolean; configRevision?: number } = {},
) {
  return track(mount(McpStatusPanel, {
    props: {
      servers,
      configErrors,
      mcpWriteInFlight: false,
      mcpWriteError: null,
      mcpEnabled: true,
      localMcpUnignored,
      // The panel clears its reload spinner when this counter moves, so it has to be controllable.
      configRevision: 0,
      visible: true,
      ...over,
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

/** A payload with `key` genuinely absent, which is how the extension withholds a field. */
function without<K extends 'editableConfig' | 'readonly'>(
  server: McpServerStatusInfo,
  key: K,
): McpServerStatusInfo {
  const copy = { ...server };
  delete copy[key];
  return copy;
}

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
    mountPanel([without(editableDamocles, 'editableConfig')]);
    await nextTick();
    expect(buttonsByText('Edit')).toHaveLength(0);
    expect(buttonsByText('Delete')).toHaveLength(1);
    expect(bodyText()).toContain('Edit it directly in ~/.damocles/mcp.json');
  });

  it.each([
    ['claude', 'From Claude Code'],
    ['claude-local', 'From Claude Code (local)'],
    ['codex', 'From Codex'],
    ['damocles-local', 'From project .damocles'],
  ] as const)('shows NO edit or delete affordance for a %s server, and badges it instead', async (source, badge) => {
    // Every readonly source needs the badge: the brief's rule is that a missing Edit/Delete button
    // must never look arbitrary. `damocles-local` is the sharp case, since it is a Damocles file the
    // user may reasonably expect to be editable here.
    mountPanel([{ name: 'imported', status: 'connected', enabled: true, source, readonly: true }]);
    await nextTick();

    expect(buttonsByText('Edit')).toHaveLength(0);
    expect(buttonsByText('Delete')).toHaveLength(0);
    expect(bodyText()).not.toContain('Edit it directly');
    expect(bodyText()).toContain(badge);
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
    mountPanel([without(editableDamocles, 'readonly')]);
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

describe('McpStatusPanel: source badges', () => {
  /** Every member of `McpServerSource`, with the label the panel must render for it. */
  const BADGE_BY_SOURCE = {
    workspace: 'From workspace',
    damocles: 'From Damocles',
    claude: 'From Claude Code',
    codex: 'From Codex',
    'claude-local': 'From Claude Code (local)',
    'damocles-local': 'From project .damocles',
  } as const satisfies Record<NonNullable<McpServerStatusInfo['source']>, string>;

  it('gives every member of the source union a distinct label', () => {
    expect(new Set(Object.values(BADGE_BY_SOURCE)).size).toBe(Object.keys(BADGE_BY_SOURCE).length);
  });

  it('renders a badge for every member of McpServerSource, enumerated at runtime', async () => {
    // `getSourceLabel` used to end in `default: return null`, so a new member shipped unbadged. The
    // `Record<McpServerSource, string>` behind it is exhaustive, but nothing CHECKS that: the root
    // tsconfig excludes `src/webview` and the repo has no `vue-tsc`, so a seventh member would ship
    // with a green typecheck. Enumerating the union from `mcpSourceOrder` at runtime is what closes
    // that hole, and it cannot go stale the way a list written here would.
    const everySource = mcpSourceOrder('claude');
    expect(everySource.length).toBe(Object.keys(BADGE_BY_SOURCE).length);

    for (const source of everySource) {
      const wrapper = mountPanel([{ name: 'srv', status: 'connected', enabled: true, source, readonly: true }]);
      await nextTick();

      const expected = BADGE_BY_SOURCE[source];
      expect(expected, `no badge label declared for source "${source}"`).toBeDefined();
      expect(bodyText()).toContain(expected);

      // Unmounted before the DOM is wiped: clearing `innerHTML` under a live component leaves Vue
      // holding fragment anchors that no longer exist, and teardown then throws.
      wrapper.unmount();
      document.body.innerHTML = '';
    }
  });

  it('translates the badge for the personal project file', async () => {
    // A label key that exists in en.json but not el.json renders as the dotted key path, so this also
    // guards the key set staying in step across the two locales.
    applyLocale('el');
    mountPanel([{ name: 'srv', status: 'connected', enabled: true, source: 'damocles-local', readonly: true }]);
    await nextTick();

    expect(bodyText()).toContain('Από το .damocles του έργου');
    expect(bodyText()).not.toContain('mcp.from');
  });

  it('renders no badge for a server that arrived with no source at all', async () => {
    mountPanel([{ name: 'srv', status: 'connected', enabled: true }]);
    await nextTick();

    for (const badge of Object.values(BADGE_BY_SOURCE)) expect(bodyText()).not.toContain(badge);
  });
});

describe('McpStatusPanel: name collisions carry trust through to the form', () => {
  // The panel derives the form's collision list from its own server rows. A field dropped in that
  // derivation cannot be seen by a test of the logic module, which is where this last regressed.
  const SHADOWED = 'A project config file already defines this name and takes precedence';

  const row = (over: Partial<McpServerStatusInfo>): McpServerStatusInfo => ({
    name: 'github',
    status: 'connected',
    enabled: true,
    source: 'workspace',
    readonly: false,
    ...over,
  });

  /** Open Add, fill in a stdio server under `name`, and submit. */
  async function attemptAdd(name: string): Promise<void> {
    await click(buttonByText('Add server'));
    await type(inputByPlaceholder('my-server'), name);
    await type(inputByPlaceholder('npx'), 'node');
    // The dialog renders field errors only after a submit attempt, so asserting before this click
    // would pass for every case and prove nothing.
    await click(buttonByText('Save'));
  }

  it.each(['workspace', 'damocles-local'] as const)(
    'lets the user add a name an untrusted %s entry holds, and emits the write',
    async (source) => {
      const wrapper = mountPanel([row({ source, untrusted: true })]);
      await nextTick();

      await attemptAdd('github');

      expect(bodyText()).not.toContain(SHADOWED);
      expect(wrapper.emitted('addServer')).toHaveLength(1);
    },
  );

  it.each(['workspace', 'damocles-local'] as const)(
    'still refuses the name when the %s entry is trusted, and emits nothing',
    async (source) => {
      const wrapper = mountPanel([row({ source })]);
      await nextTick();

      await attemptAdd('github');

      expect(bodyText()).toContain(SHADOWED);
      expect(wrapper.emitted('addServer')).toBeUndefined();
    },
  );

  it('still refuses a clash whose source never arrived', async () => {
    const wrapper = mountPanel([{ name: 'github', status: 'connected', enabled: true }]);
    await nextTick();

    await attemptAdd('github');

    expect(bodyText()).toContain('already exists in ~/.damocles/mcp.json');
    expect(wrapper.emitted('addServer')).toBeUndefined();
  });

  it('refuses a name held by an entry that is untrusted but carries no source', async () => {
    // `untrusted` is optional on the wire just as `source` is, so the panel can forward one without
    // the other. The allowance exists for a known repo-authored source that got demoted; with no
    // source there is nothing demoted and the refusal stands.
    const wrapper = mountPanel([{ name: 'github', status: 'connected', enabled: true, untrusted: true }]);
    await nextTick();

    await attemptAdd('github');

    expect(bodyText()).toContain('already exists in ~/.damocles/mcp.json');
    expect(wrapper.emitted('addServer')).toBeUndefined();
  });

  it('does not let an untrusted entry excuse an unrelated name clash', async () => {
    // The allowance is per clashing entry, not a blanket "untrusted workspace, anything goes".
    const wrapper = mountPanel([
      row({ source: 'workspace', untrusted: true }),
      row({ name: 'weather', source: 'damocles', readonly: false }),
    ]);
    await nextTick();

    await attemptAdd('weather');

    expect(bodyText()).toContain('already exists in ~/.damocles/mcp.json');
    expect(wrapper.emitted('addServer')).toBeUndefined();
  });
});

describe('McpStatusPanel: reload config', () => {
  const reloadButton = (): HTMLButtonElement => buttonByText('Reload config');

  it('emits reloadConfig, the only way an unwatched ~/.claude.json is re-read', async () => {
    const wrapper = mountPanel([]);
    await nextTick();
    await click(reloadButton());

    expect(wrapper.emitted('reloadConfig')).toHaveLength(1);
  });

  it('names what it re-reads, since the reply usually renders identically to what is on screen', async () => {
    mountPanel([]);
    await nextTick();

    expect(reloadButton().getAttribute('title')).toContain('~/.claude.json');
  });

  it('goes disabled with a spinner and swallows the repeat click', async () => {
    // Each click runs a full config load and re-feeds the live MCP client, so a button that looks
    // dead invites the user to do that three more times.
    const wrapper = mountPanel([]);
    await nextTick();
    await click(reloadButton());

    expect(reloadButton().hasAttribute('disabled')).toBe(true);
    expect(reloadButton().querySelector('.animate-spinner')).not.toBeNull();

    await click(reloadButton());
    expect(wrapper.emitted('reloadConfig')).toHaveLength(1);
  });

  it('re-enables when the config update lands, and takes the spinner with it', async () => {
    const wrapper = mountPanel([]);
    await nextTick();
    await click(reloadButton());

    await wrapper.setProps({ configRevision: 1 });
    await nextTick();

    expect(reloadButton().hasAttribute('disabled')).toBe(false);
    expect(reloadButton().querySelector('.animate-spinner')).toBeNull();
  });

  it('re-enables on its own when the reply never arrives', async () => {
    // Nothing acknowledges a reload by id, so a dropped reply would otherwise disable the button for
    // the life of the panel.
    vi.useFakeTimers();
    try {
      mountPanel([]);
      await nextTick();
      await click(reloadButton());
      expect(reloadButton().hasAttribute('disabled')).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000);
      await nextTick();

      expect(reloadButton().hasAttribute('disabled')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads when the panel is opened, so an edit made while it was closed is picked up', async () => {
    const wrapper = mountPanel([], [], false, { visible: false });
    await nextTick();
    expect(wrapper.emitted('reloadConfig')).toBeUndefined();

    await wrapper.setProps({ visible: true });
    await nextTick();

    expect(wrapper.emitted('reloadConfig')).toHaveLength(1);
  });

  it('does not spin the button for a reload the user did not click', async () => {
    const wrapper = mountPanel([], [], false, { visible: false });
    await nextTick();
    await wrapper.setProps({ visible: true });
    await nextTick();

    expect(reloadButton().hasAttribute('disabled')).toBe(false);
  });

  it('does not reload again when the reply to the open lands', async () => {
    // The host answers a reload with a config update. If that fed the watcher, the panel would loop.
    const wrapper = mountPanel([], [], false, { visible: false });
    await nextTick();
    await wrapper.setProps({ visible: true });
    await wrapper.setProps({ configRevision: 7 });
    await nextTick();

    expect(wrapper.emitted('reloadConfig')).toHaveLength(1);
  });

  it('does not reload on mount when the panel is already visible', async () => {
    const wrapper = mountPanel([]);
    await nextTick();

    expect(wrapper.emitted('reloadConfig')).toBeUndefined();
  });
});

describe('McpStatusPanel: the gitignore leak warning', () => {
  const alertText = (): string =>
    Array.from(document.body.querySelectorAll('[role="alert"]')).map(el => el.textContent ?? '').join(' ');

  it('announces the warning rather than leaving it as body text', async () => {
    // A screen reader gets nothing from an unlabelled div inside a scrolling region, and this is the
    // highest-consequence message the panel renders.
    mountPanel([], [], true);
    await nextTick();

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('Git can commit your MCP credentials');
    expect(alert!.querySelector('svg')).not.toBeNull();
  });

  it('gives the instruction, not just the path', async () => {
    // Rendering the bare constant with no sentence around it would leave the user with a filename and
    // no idea what to do with it.
    mountPanel([], [], true);
    await nextTick();

    expect(alertText()).toContain('.damocles/mcp.local.json');
    expect(alertText()).toContain('Git does not ignore');
    expect(alertText()).toContain('Add that line to .gitignore');
  });

  it('shows nothing when the file is ignored, absent, or the workspace is not a repo', async () => {
    mountPanel([], [], false);
    await nextTick();

    expect(bodyText()).not.toContain('.damocles/mcp.local.json');
    expect(bodyText()).not.toContain('Git can commit your MCP credentials');
  });

  it('takes the warning down on a mounted panel once git starts ignoring the file', async () => {
    // The host re-samples the flag when `.gitignore` changes. A warning that survives the fix teaches
    // the user to ignore warnings.
    const wrapper = mountPanel([], [], true);
    await nextTick();
    expect(bodyText()).toContain('.damocles/mcp.local.json');

    await wrapper.setProps({ localMcpUnignored: false });
    await nextTick();

    expect(bodyText()).not.toContain('.damocles/mcp.local.json');
    expect(bodyText()).not.toContain('Git can commit your MCP credentials');
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it('raises the warning on a mounted panel when the user deletes the ignore line', async () => {
    const wrapper = mountPanel([], [], false);
    await nextTick();

    await wrapper.setProps({ localMcpUnignored: true });
    await nextTick();

    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(alertText()).toContain('.damocles/mcp.local.json');
  });

  it('translates the warning, title included', async () => {
    applyLocale('el');
    mountPanel([], [], true);
    await nextTick();

    expect(alertText()).toContain('Το Git μπορεί να κάνει commit τα διαπιστευτήριά σας MCP');
    expect(alertText()).toContain('.damocles/mcp.local.json');
    expect(alertText()).not.toContain('Git does not ignore');
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

  it.each(['.mcp.json', '.damocles/mcp.local.json'])(
    'names %s when the extension refuses the write as shadowed',
    async (file) => {
      // Two project files can shadow now, so a refusal that did not name one would leave the user
      // hunting for a definition in the wrong place.
      const wrapper = mountPanel([]);
      await nextTick();
      await click(buttonByText('Add server'));
      await type(inputByPlaceholder('my-server'), 'weather');
      await type(inputByPlaceholder('npx'), 'node');
      await click(buttonByText('Save'));
      await settleWrite(wrapper, { code: 'nameShadowed', params: { name: 'weather', file } });

      expect(bodyText()).toContain(file);
      expect(bodyText()).toContain('weather');
    },
  );
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
    const wrapper = mountPanel([], [{ path: '/home/me/.damocles/mcp.json', displayPath: '~/.damocles/mcp.json', kind: 'parse', line: null, column: null }]);
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
    mountPanel([], [{ path: '/x/mcp.json', displayPath: '/x/mcp.json', kind: 'parse', line: 14, column: 1 }]);
    await nextTick();
    // The location is interpolated by the webview, so it is inside the translated sentence rather
    // than an English fragment handed over by the extension.
    expect(bodyText()).toContain('γραμμή 14, στήλη 1');
    expect(bodyText()).toContain('Άνοιγμα αρχείου');
    expect(bodyText()).not.toContain('Invalid JSON');
  });
});
