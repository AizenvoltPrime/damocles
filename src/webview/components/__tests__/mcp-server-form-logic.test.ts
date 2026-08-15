import { describe, it, expect } from 'vitest';
import type { McpServerStatusInfo } from '@shared/types/mcp';
import {
  buildMcpServerConfig,
  canDeleteMcpServer,
  canEditMcpServer,
  createArgRow,
  createEmptyFormState,
  formStateFromConfig,
  isMcpFormValid,
  submittedServerName,
  validateMcpServerForm,
  type McpServerFormState,
} from '../mcp-server-form-logic';

/**
 * `mcp-write-contract` §3/§4 (validation + collisions) and §7.1 (the affordance gates). The
 * extension re-validates everything here and is authoritative; these tests pin the inline mirror so
 * the user sees the error on the field instead of as a notification after a round trip.
 */

/** Form args are identified rows so `v-for` keys follow a row rather than its index. */
const argRows = (...values: string[]) => values.map((value) => createArgRow(value));

function stdio(overrides: Partial<McpServerFormState> = {}): McpServerFormState {
  return { ...createEmptyFormState(), name: 'my-server', command: 'npx', ...overrides };
}

function remote(overrides: Partial<McpServerFormState> = {}): McpServerFormState {
  return {
    ...createEmptyFormState(),
    name: 'my-server',
    mode: 'remote',
    url: 'https://example.com/mcp',
    ...overrides,
  };
}

const noServers: McpServerStatusInfo[] = [];

function server(
  name: string,
  source: NonNullable<McpServerStatusInfo['source']>,
): McpServerStatusInfo {
  return { name, status: 'connected', enabled: true, source };
}

describe('validateMcpServerForm — name', () => {
  it('accepts a well-formed stdio server', () => {
    expect(validateMcpServerForm(stdio(), null, noServers)).toEqual({});
  });

  it('rejects an empty name', () => {
    expect(validateMcpServerForm(stdio({ name: '   ' }), null, noServers).name).toEqual({
      key: 'mcp.form.errors.nameRequired',
    });
  });

  it('rejects a name longer than 64 characters and names the limit', () => {
    expect(validateMcpServerForm(stdio({ name: 'a'.repeat(65) }), null, noServers).name).toEqual({
      key: 'mcp.form.errors.nameTooLong',
      params: { max: '64' },
    });
  });

  it('accepts a name of exactly 64 characters', () => {
    expect(validateMcpServerForm(stdio({ name: 'a'.repeat(64) }), null, noServers).name).toBeUndefined();
  });

  it('rejects characters outside [A-Za-z0-9_.-]', () => {
    for (const name of ['my server', 'my/server', 'διακομιστής', 'my:server']) {
      expect(validateMcpServerForm(stdio({ name }), null, noServers).name).toEqual({
        key: 'mcp.form.errors.nameInvalid',
      });
    }
  });

  it('validates the trimmed name, since the trimmed name is what gets submitted', () => {
    const state = stdio({ name: '  ok-name  ' });
    expect(validateMcpServerForm(state, null, noServers).name).toBeUndefined();
    expect(submittedServerName(state)).toBe('ok-name');
  });
});

describe('validateMcpServerForm — name collisions (contract §4)', () => {
  it('rejects adding a name already in ~/.damocles/mcp.json', () => {
    const servers = [server('taken', 'damocles')];
    expect(validateMcpServerForm(stdio({ name: 'taken' }), null, servers).name).toEqual({
      key: 'mcp.form.errors.nameExists',
    });
  });

  it('rejects a name the workspace .mcp.json already defines, since it would be shadowed', () => {
    const servers = [server('taken', 'workspace')];
    expect(validateMcpServerForm(stdio({ name: 'taken' }), null, servers).name).toEqual({
      key: 'mcp.form.errors.nameShadowedByWorkspace',
    });
  });

  it('ALLOWS overriding a claude or codex import — damocles outranks both by design', () => {
    for (const source of ['claude', 'codex'] as const) {
      const servers = [server('imported', source)];
      expect(validateMcpServerForm(stdio({ name: 'imported' }), null, servers).name).toBeUndefined();
    }
  });

  it('does not treat the edited server\u2019s own name as a collision', () => {
    const servers = [server('mine', 'damocles')];
    expect(validateMcpServerForm(stdio({ name: 'mine' }), 'mine', servers).name).toBeUndefined();
  });

  it('rejects renaming onto another damocles server', () => {
    const servers = [server('mine', 'damocles'), server('other', 'damocles')];
    expect(validateMcpServerForm(stdio({ name: 'other' }), 'mine', servers).name).toEqual({
      key: 'mcp.form.errors.nameExists',
    });
  });
});

describe('validateMcpServerForm — stdio', () => {
  it('requires a command', () => {
    expect(validateMcpServerForm(stdio({ command: '  ' }), null, noServers).command).toEqual({
      key: 'mcp.form.errors.commandRequired',
    });
  });

  it('ignores a fully blank env row', () => {
    const state = stdio({ env: [{ key: '  ', value: '' }] });
    expect(validateMcpServerForm(state, null, noServers)).toEqual({});
  });

  it('rejects an env row with a value but no name, which would otherwise vanish on save', () => {
    const state = stdio({ env: [{ key: '', value: 'secret-ish' }] });
    expect(validateMcpServerForm(state, null, noServers).env).toEqual({
      key: 'mcp.form.errors.envKeyRequired',
    });
  });

  it('rejects duplicate env names and reports the key, never the value', () => {
    const state = stdio({
      env: [
        { key: 'TOKEN', value: 'a' },
        { key: 'TOKEN', value: 'b' },
      ],
    });
    const error = validateMcpServerForm(state, null, noServers).env;
    expect(error).toEqual({ key: 'mcp.form.errors.envDuplicateKey', params: { name: 'TOKEN' } });
    expect(JSON.stringify(error)).not.toContain('"a"');
  });

  it('does not apply remote rules while in stdio mode', () => {
    const state = stdio({ url: 'not-a-url', bearerTokenEnv: '9bad' });
    expect(validateMcpServerForm(state, null, noServers)).toEqual({});
  });
});

describe('validateMcpServerForm — remote', () => {
  it('accepts a well-formed remote server', () => {
    expect(validateMcpServerForm(remote(), null, noServers)).toEqual({});
  });

  it('requires a URL', () => {
    expect(validateMcpServerForm(remote({ url: '' }), null, noServers).url).toEqual({
      key: 'mcp.form.errors.urlRequired',
    });
  });

  it('rejects an unparseable URL', () => {
    expect(validateMcpServerForm(remote({ url: 'example.com/mcp' }), null, noServers).url).toEqual({
      key: 'mcp.form.errors.urlInvalid',
    });
  });

  it('rejects a parseable URL whose protocol is not http or https', () => {
    for (const url of ['file:///etc/passwd', 'ws://example.com', 'javascript:alert(1)']) {
      expect(validateMcpServerForm(remote({ url }), null, noServers).url).toEqual({
        key: 'mcp.form.errors.urlProtocol',
      });
    }
  });

  it('rejects a header row with a value but no name', () => {
    const state = remote({ headers: [{ key: '', value: 'Bearer x' }] });
    expect(validateMcpServerForm(state, null, noServers).headers).toEqual({
      key: 'mcp.form.errors.headerKeyRequired',
    });
  });

  it('rejects duplicate header names and reports the key, never the value', () => {
    const state = remote({
      headers: [
        { key: 'Authorization', value: 'Bearer one' },
        { key: 'Authorization', value: 'Bearer two' },
      ],
    });
    const error = validateMcpServerForm(state, null, noServers).headers;
    expect(error).toEqual({
      key: 'mcp.form.errors.headerDuplicateKey',
      params: { name: 'Authorization' },
    });
    expect(JSON.stringify(error)).not.toContain('Bearer');
  });

  it('accepts an omitted bearerTokenEnv', () => {
    expect(validateMcpServerForm(remote({ bearerTokenEnv: '  ' }), null, noServers)).toEqual({});
  });

  it('accepts a valid environment-variable name', () => {
    for (const bearerTokenEnv of ['TOKEN', '_TOKEN', 'my_token9']) {
      expect(validateMcpServerForm(remote({ bearerTokenEnv }), null, noServers)).toEqual({});
    }
  });

  it('rejects anything that is not a variable name — a pasted token does not match', () => {
    for (const bearerTokenEnv of ['9TOKEN', 'my-token', 'sk-ant-api03-abc.def', 'a b']) {
      expect(validateMcpServerForm(remote({ bearerTokenEnv }), null, noServers).bearerTokenEnv).toEqual({
        key: 'mcp.form.errors.bearerTokenEnvInvalid',
      });
    }
  });
});

describe('isMcpFormValid', () => {
  it('is true only for an empty error set', () => {
    expect(isMcpFormValid({})).toBe(true);
    expect(isMcpFormValid({ name: { key: 'mcp.form.errors.nameRequired' } })).toBe(false);
  });
});

describe('buildMcpServerConfig — contract §2 key set', () => {
  it('emits only `command` for a minimal stdio server, with no `type` key', () => {
    const config = buildMcpServerConfig(stdio());
    expect(config).toEqual({ command: 'npx' });
    expect(Object.keys(config)).toEqual(['command']);
  });

  it('omits empty optionals entirely rather than sending [] / {} / ""', () => {
    const config = buildMcpServerConfig(
      stdio({ args: argRows('', ''), env: [{ key: '', value: '' }], cwd: '' }),
    );
    expect(config).toEqual({ command: 'npx' });
  });

  it('includes args, env and cwd when filled, trimming the env key but never the value', () => {
    const config = buildMcpServerConfig(
      stdio({
        args: argRows('-y', 'pkg'),
        env: [{ key: ' TOKEN ', value: ' padded value ' }],
        cwd: '/tmp/work',
      }),
    );
    expect(config).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: ' padded value ' },
      cwd: '/tmp/work',
    });
  });

  it('stores an argument VERBATIM — trimming it would rewrite the stored definition', () => {
    // Reported by mcp-backend: the extension accepts a stored arg with significant whitespace, so
    // trimming here mutated a definition the user never touched.
    expect(buildMcpServerConfig(stdio({ args: argRows('--prefix= ') }))).toEqual({
      command: 'npx',
      args: ['--prefix= '],
    });
  });

  it('keeps a whitespace-only argument instead of making it disappear', () => {
    expect(buildMcpServerConfig(stdio({ args: argRows('  ') }))).toEqual({
      command: 'npx',
      args: ['  '],
    });
  });

  it('drops only an argument row the user never typed into', () => {
    expect(buildMcpServerConfig(stdio({ args: argRows('a', '', 'b') }))).toEqual({
      command: 'npx',
      args: ['a', 'b'],
    });
  });

  it('stores cwd VERBATIM, since a path may legitimately end in a space', () => {
    expect(buildMcpServerConfig(stdio({ cwd: '/srv/ ' }))).toEqual({
      command: 'npx',
      cwd: '/srv/ ',
    });
  });

  it('omits a whitespace-only cwd, which the extension would reject', () => {
    // Trimming decides INCLUSION, exactly as `isBlankRow` does for env/header rows; the value
    // itself is still stored verbatim. Without this, holding the spacebar in Working directory
    // produced a form that validated locally and was refused by the extension.
    const config = buildMcpServerConfig(stdio({ cwd: '   ' }));
    expect(config).toEqual({ command: 'npx' });
    expect(config).not.toHaveProperty('cwd');
  });

  it('never emits a config the extension would refuse for a whitespace-only field', () => {
    // The form's own validation must agree with what the builder emits: anything reported valid
    // here has to be acceptable downstream, or a typing slip escapes onto the toast path.
    const state = stdio({ cwd: '   ', args: argRows('  ') });
    expect(isMcpFormValid(validateMcpServerForm(state, null, noServers))).toBe(true);
    // `args` keeps "  " (the extension accepts any non-empty string); `cwd` is dropped.
    expect(buildMcpServerConfig(state)).toEqual({ command: 'npx', args: ['  '] });
  });

  it('emits the required discriminant for a remote server', () => {
    expect(buildMcpServerConfig(remote())).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    });
    expect(buildMcpServerConfig(remote({ remoteType: 'sse' }))).toEqual({
      type: 'sse',
      url: 'https://example.com/mcp',
    });
  });

  it('includes headers and bearerTokenEnv when filled', () => {
    expect(
      buildMcpServerConfig(
        remote({ headers: [{ key: 'X-Trace', value: '1' }], bearerTokenEnv: ' MY_TOKEN ' }),
      ),
    ).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-Trace': '1' },
      bearerTokenEnv: 'MY_TOKEN',
    });
  });

  it('never produces a `bearerToken` key, whatever the form holds', () => {
    const config = buildMcpServerConfig(remote({ bearerTokenEnv: 'MY_TOKEN' }));
    expect(config).not.toHaveProperty('bearerToken');
    expect(Object.keys(config).sort()).toEqual(['bearerTokenEnv', 'type', 'url']);
  });

  it('drops stdio fields when the mode is remote, and vice versa', () => {
    expect(buildMcpServerConfig(remote({ command: 'npx', cwd: '/tmp' }))).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    });
    expect(buildMcpServerConfig(stdio({ url: 'https://x.test', bearerTokenEnv: 'T' }))).toEqual({
      command: 'npx',
    });
  });
});

describe('formStateFromConfig — round trip', () => {
  it('round-trips a stdio config through the form unchanged', () => {
    const config = { command: 'node', args: argRows('server.js'), env: { A: '1' }, cwd: '/srv' };
    expect(buildMcpServerConfig(formStateFromConfig('s', config))).toEqual(config);
  });

  it('round-trips a stdio config carrying significant whitespace', () => {
    // The seam mcp-backend found: both of these pass `isFormEditableMcpServerConfig`, so the panel
    // offers Edit for them, and an untouched Save must return them byte-for-byte.
    for (const config of [
      { command: 'node', args: argRows('--prefix= '), cwd: '/srv/ ' },
      { command: 'node', args: argRows('  ') },
    ]) {
      expect(buildMcpServerConfig(formStateFromConfig('s', config))).toEqual(config);
    }
  });

  it('round-trips a remote config through the form unchanged', () => {
    const config = {
      type: 'sse' as const,
      url: 'https://example.com/sse',
      headers: { 'X-A': 'b' },
      bearerTokenEnv: 'TOKEN',
    };
    expect(buildMcpServerConfig(formStateFromConfig('s', config))).toEqual(config);
  });

  it('selects the mode from the config shape and carries the name in', () => {
    expect(formStateFromConfig('a', { command: 'x' })).toMatchObject({ name: 'a', mode: 'stdio' });
    expect(formStateFromConfig('b', { type: 'http', url: 'https://x.test' })).toMatchObject({
      name: 'b',
      mode: 'remote',
      remoteType: 'http',
    });
  });

  it('copies args rather than aliasing the caller\u2019s array', () => {
    const config = { command: 'node', args: ['one'] };
    const state = formStateFromConfig('s', config);
    state.args.push(createArgRow('two'));
    expect(config.args).toEqual(['one']);
  });
});

describe('affordance gates (contract §7.1) — fail closed', () => {
  const damocles = { name: 's', status: 'connected', enabled: true } as const;

  it('allows edit and delete for a damocles server with an editable config', () => {
    const info: McpServerStatusInfo = {
      ...damocles,
      source: 'damocles',
      readonly: false,
      editableConfig: { command: 'npx' },
    };
    expect(canDeleteMcpServer(info)).toBe(true);
    expect(canEditMcpServer(info)).toBe(true);
  });

  it('allows delete but not edit when the stored config is not form-representable', () => {
    const info: McpServerStatusInfo = { ...damocles, source: 'damocles', readonly: false };
    expect(canDeleteMcpServer(info)).toBe(true);
    expect(canEditMcpServer(info)).toBe(false);
  });

  it('refuses both when `readonly` is absent — undefined must not read as editable', () => {
    const info: McpServerStatusInfo = {
      ...damocles,
      source: 'damocles',
      editableConfig: { command: 'npx' },
    };
    expect(canDeleteMcpServer(info)).toBe(false);
    expect(canEditMcpServer(info)).toBe(false);
  });

  it('refuses both for readonly claude and codex imports', () => {
    for (const source of ['claude', 'codex'] as const) {
      const info: McpServerStatusInfo = { ...damocles, source, readonly: true };
      expect(canDeleteMcpServer(info)).toBe(false);
      expect(canEditMcpServer(info)).toBe(false);
    }
  });

  it('refuses both for workspace servers even though they are readonly:false', () => {
    // READONLY_BY_SOURCE marks workspace `false`, so `readonly` alone would open the project's
    // .mcp.json to editing — which the brief forbids outright.
    const info: McpServerStatusInfo = {
      ...damocles,
      source: 'workspace',
      readonly: false,
      editableConfig: { command: 'npx' },
    };
    expect(canDeleteMcpServer(info)).toBe(false);
    expect(canEditMcpServer(info)).toBe(false);
  });

  it('refuses both when the source is absent', () => {
    const info: McpServerStatusInfo = { ...damocles, readonly: false };
    expect(canDeleteMcpServer(info)).toBe(false);
    expect(canEditMcpServer(info)).toBe(false);
  });
});
