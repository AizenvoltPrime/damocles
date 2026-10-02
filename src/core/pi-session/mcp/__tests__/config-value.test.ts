import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from '../../../../shared/types/mcp';
import { CONFIG_COMMAND_TIMEOUT_MS, resolveMcpServerValues, runConfigCommand } from '../config-value';
import { migrateOwnedMcpFile } from '../../../chat-panel/settings-manager/managers/mcp-config-write';

// `~/.damocles/mcp.json` is resolved from homedir() at module load, so home points into a temp dir.
const { fakeRoot, fakeHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'damocles-cv-home-'));
  return { fakeRoot: root, fakeHome: nodePath.join(root, 'home') };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});
afterAll(() => rmSync(fakeRoot, { recursive: true, force: true }));

const VAR = 'DAMOCLES_CV_TOKEN';
const OTHER = 'DAMOCLES_CV_OTHER';
const MISSING = 'DAMOCLES_CV_NEVER_SET';

const stdio = (env: Record<string, string>): McpStdioServerConfig => ({ command: 'srv', env });
const http = (headers: Record<string, string>, clientSecret?: string): McpHttpServerConfig => ({
  type: 'http',
  url: 'https://mcp.example.com/mcp',
  headers,
  ...(clientSecret !== undefined ? { oauth: { clientSecret } } : {}),
});

const pi = { format: 'pi', trusted: true, folderScoped: false } as const;
const legacy = { format: 'legacy', trusted: true, folderScoped: false } as const;

/** Forward slashes, so a path survives being quoted inside a bash command on Windows. */
const shPath = (path: string): string => path.replace(/\\/g, '/');

async function resolved(config: McpServerConfig, opts: Parameters<typeof resolveMcpServerValues>[1]) {
  const result = await resolveMcpServerValues(config, opts);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.config;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'damocles-config-value-'));
  vi.stubEnv(VAR, 'tok-123');
  vi.stubEnv(OTHER, 'other');
  vi.stubEnv(MISSING, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('pi format', () => {
  it('interpolates $VAR and ${VAR} in env, headers and oauth.clientSecret', async () => {
    const env = (await resolved(stdio({ A: `$${VAR}`, B: `pre-\${${VAR}}-post`, C: `$${VAR}/$${OTHER}` }), pi)) as McpStdioServerConfig;
    expect(env.env).toEqual({ A: 'tok-123', B: 'pre-tok-123-post', C: 'tok-123/other' });

    const remote = (await resolved(http({ Authorization: `Bearer \${${VAR}}` }, `$${OTHER}`), pi)) as McpHttpServerConfig;
    expect(remote.headers).toEqual({ Authorization: 'Bearer tok-123' });
    expect(remote.oauth && remote.oauth.clientSecret).toBe('other');
  });

  it('reads $$ as a literal $ and $! as a literal !, never as a variable or a command', async () => {
    const out = (await resolved(stdio({ PRICE: `$$${VAR}`, BANG: '$!echo hi', MIXED: 'a$$b$!c' }), pi)) as McpStdioServerConfig;
    expect(out.env).toEqual({ PRICE: `$${VAR}`, BANG: '!echo hi', MIXED: 'a$b!c' });
  });

  it('leaves values without a reference untouched', async () => {
    const out = (await resolved(stdio({ PLAIN: 'just text', LONE: 'cost: 5$' }), pi)) as McpStdioServerConfig;
    expect(out.env).toEqual({ PLAIN: 'just text', LONE: 'cost: 5$' });
  });

  it('fails closed on a missing variable, naming the variable and field but never a value', async () => {
    const result = await resolveMcpServerValues(
      http({ Authorization: `Bearer \${${MISSING}}`, 'X-Other': `$${VAR}` }),
      pi,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorInfo).toEqual({ code: 'missingVariable', params: { variable: MISSING, field: 'headers.Authorization' } });
    expect(result.error).toContain(MISSING);
    expect(JSON.stringify(result)).not.toContain('tok-123');
  });

  it('treats an empty variable as missing, as pi does', async () => {
    vi.stubEnv(OTHER, '');
    const result = await resolveMcpServerValues(stdio({ A: `$${OTHER}` }), pi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorInfo).toEqual({ code: 'missingVariable', params: { variable: OTHER, field: 'env.A' } });
  });

  it('reads $env:NAME as the variable `env` followed by text, so an unmigrated value fails closed', async () => {
    vi.stubEnv('env', undefined);
    const result = await resolveMcpServerValues(stdio({ A: `$env:${VAR}` }), pi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorInfo).toMatchObject({ code: 'missingVariable', params: { variable: 'env' } });
  });

  it('applies header rules to bearerToken, which is sent as an Authorization header', async () => {
    const out = (await resolved({ ...http({}), bearerToken: `$${VAR}` }, pi)) as McpHttpServerConfig;
    expect(out.bearerToken).toBe('tok-123');
    const missing = await resolveMcpServerValues({ ...http({}), bearerToken: `$${MISSING}` }, pi);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errorInfo).toEqual({ code: 'missingVariable', params: { variable: MISSING, field: 'bearerToken' } });
  });

  it('names an oauth.clientSecret failure by its field', async () => {
    const secret = await resolveMcpServerValues(http({}, `$${MISSING}`), pi);
    expect(secret.ok).toBe(false);
    if (!secret.ok) expect(secret.errorInfo.params?.['field']).toBe('oauth.clientSecret');
  });

  it('runs a value starting with ! as a command and uses its trimmed stdout', async () => {
    const out = (await resolved(http({ Authorization: '!echo from-command' }), pi)) as McpHttpServerConfig;
    expect(out.headers).toEqual({ Authorization: 'from-command' });
  });

  it('re-runs the command on every resolve, so a rotated credential applies on the next connect', async () => {
    const counter = shPath(join(dir, 'count'));
    const command = `!echo x >> "${counter}"; wc -l < "${counter}"`;
    const first = (await resolved(stdio({ N: command }), pi)) as McpStdioServerConfig;
    const second = (await resolved(stdio({ N: command }), pi)) as McpStdioServerConfig;
    expect(first.env?.['N']).toBe('1');
    expect(second.env?.['N']).toBe('2');
  });

  it('reports a failing command as commandFailed with the field only, never the command or its output', async () => {
    const result = await resolveMcpServerValues(stdio({ SECRET: '!echo leaked-output; exit 3' }), pi);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorInfo).toEqual({ code: 'commandFailed', params: { field: 'env.SECRET' } });
    expect(JSON.stringify(result)).not.toContain('leaked-output');
    expect(JSON.stringify(result)).not.toContain('exit 3');
  });

  it('reports a command with empty output as failed', async () => {
    const result = await resolveMcpServerValues(stdio({ SECRET: '!true' }), pi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorInfo.code).toBe('commandFailed');
  });

  it('never runs a command from an untrusted folder file, and fails closed as commandUntrusted', async () => {
    const marker = join(dir, 'ran');
    const result = await resolveMcpServerValues(
      stdio({ FIRST: '!echo fine', SECRET: `!echo x > "${shPath(marker)}"` }),
      { format: 'pi', trusted: false, folderScoped: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorInfo).toEqual({ code: 'commandUntrusted', params: { field: 'env.FIRST' } });
    expect(existsSync(marker)).toBe(false);
  });

  it('runs a command from a trusted folder file', async () => {
    const out = (await resolved(stdio({ SECRET: '!echo folder-ok' }), { format: 'pi', trusted: true, folderScoped: true })) as McpStdioServerConfig;
    expect(out.env).toEqual({ SECRET: 'folder-ok' });
  });

  it('does not change the input config', async () => {
    const input = stdio({ A: `$${VAR}` });
    await resolved(input, pi);
    expect(input.env).toEqual({ A: `$${VAR}` });
  });
});

describe('legacy format (claude, claude-local, codex, .mcp.json)', () => {
  it('interpolates ${VAR} and $env:VAR', async () => {
    const out = (await resolved(stdio({ A: `\${${VAR}}`, B: `$env:${VAR}`, C: `x-\${${OTHER}}-y` }), legacy)) as McpStdioServerConfig;
    expect(out.env).toEqual({ A: 'tok-123', B: 'tok-123', C: 'x-other-y' });
  });

  it('keeps a leading ! literal and never runs it', async () => {
    const marker = join(dir, 'ran');
    const value = `!echo x > "${shPath(marker)}"`;
    const out = (await resolved(http({ Authorization: value }), legacy)) as McpHttpServerConfig;
    expect(out.headers).toEqual({ Authorization: value });
    expect(existsSync(marker)).toBe(false);
  });

  it('turns a missing variable into an empty string, as these formats always did', async () => {
    const out = (await resolved(stdio({ A: `x\${${MISSING}}y` }), legacy)) as McpStdioServerConfig;
    expect(out.env).toEqual({ A: 'xy' });
  });

  it('leaves oauth.clientSecret literal', async () => {
    const out = (await resolved(http({}, `\${${VAR}}`), legacy)) as McpHttpServerConfig;
    expect(out.oauth && out.oauth.clientSecret).toBe(`\${${VAR}}`);
  });

  it('leaves a bare $VAR untouched, because the legacy formats do not define it', async () => {
    const out = (await resolved(stdio({ A: `$${VAR}` }), legacy)) as McpStdioServerConfig;
    expect(out.env).toEqual({ A: `$${VAR}` });
  });
});

describe('values the transport would reject', () => {
  // Node's spawn and undici's Headers quote the offending value in their errors, so it is refused here by field name.
  const detail = (field: string) => `${field} resolves to a value containing a line break or NUL character`;

  it.each([
    ['pi', { format: 'pi', trusted: true, folderScoped: false }],
    ['legacy', { format: 'legacy', trusted: true, folderScoped: false }],
  ] as const)('refuses a header that resolves to a line break (%s format), naming only the field', async (_label, opts) => {
    vi.stubEnv('DAMOCLES_CV_MULTILINE', 'secret-top\r\nsecret-bottom');
    const result = await resolveMcpServerValues(http({ Authorization: '${DAMOCLES_CV_MULTILINE}' }), opts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorInfo).toEqual({ code: 'invalidConfig', params: { detail: detail('headers.Authorization') } });
    expect(JSON.stringify(result)).not.toContain('secret-');
  });

  it('refuses a command whose output spans lines when it feeds a header', async () => {
    const result = await resolveMcpServerValues(http({ Authorization: '!printf "secret-a\\nsecret-b"' }), pi);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorInfo).toEqual({ code: 'invalidConfig', params: { detail: detail('headers.Authorization') } });
    expect(JSON.stringify(result)).not.toContain('secret-');
  });

  it('refuses a bearerToken with a line break and an env value with a NUL', async () => {
    vi.stubEnv('DAMOCLES_CV_MULTILINE', 'x\ny');
    const bearer = await resolveMcpServerValues({ ...http({}), bearerToken: '$DAMOCLES_CV_MULTILINE' }, pi);
    expect(!bearer.ok && bearer.errorInfo.params?.['detail']).toBe(detail('bearerToken'));

    const nul = await resolveMcpServerValues(stdio({ K: 'a\u0000b' }), pi);
    expect(!nul.ok && nul.errorInfo.params?.['detail']).toBe(detail('env.K'));
  });

  it('allows a line break in an env value and in oauth.clientSecret, which are not headers', async () => {
    vi.stubEnv('DAMOCLES_CV_MULTILINE', 'x\ny');
    const env = (await resolved(stdio({ K: '$DAMOCLES_CV_MULTILINE' }), pi)) as McpStdioServerConfig;
    expect(env.env).toEqual({ K: 'x\ny' });
    const secret = (await resolved(http({}, '$DAMOCLES_CV_MULTILINE'), pi)) as McpHttpServerConfig;
    expect(secret.oauth && secret.oauth.clientSecret).toBe('x\ny');
  });
});

describe('runConfigCommand', () => {
  it('waits 10 seconds by default, like pi', () => {
    expect(CONFIG_COMMAND_TIMEOUT_MS).toBe(10_000);
  });

  it('resolves undefined when the command outlives its timeout, instead of hanging the connect', async () => {
    const started = Date.now();
    await expect(runConfigCommand('sleep 5; echo late', { timeoutMs: 200 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('resolves undefined on abort', async () => {
    const controller = new AbortController();
    const pending = runConfigCommand('sleep 5; echo late', { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  // Node refuses to spawn a batch file without a shell (EINVAL, thrown synchronously) since CVE-2024-27980.
  it.runIf(process.platform === 'win32')('falls back to the default shell when the configured shell is a batch file', async () => {
    const batchShell = join(dir, 'shell.cmd');
    writeFileSync(batchShell, '@echo off\r\n', 'utf-8');
    await expect(runConfigCommand('echo fallback-ok', { shellPath: batchShell })).resolves.toBe('fallback-ok');
  });

  it('resolves trimmed stdout, and undefined for a non-zero exit', async () => {
    await expect(runConfigCommand('echo "  padded  "', {})).resolves.toBe('padded');
    await expect(runConfigCommand('echo out; exit 1', {})).resolves.toBeUndefined();
  });
});

describe('migrateOwnedMcpFile: Damocles-owned files adopt the pi format', () => {
  const userFile = (): string => join(fakeHome, '.damocles', 'mcp.json');
  const localFile = (): string => join(dir, 'ws', '.damocles', 'mcp.local.json');

  function write(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  }
  const servers = (path: string): Record<string, Record<string, unknown>> =>
    (JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;

  afterEach(() => rmSync(fakeHome, { recursive: true, force: true }));

  it('rewrites $env:NAME to ${NAME} in env, headers, bearerToken and oauth.clientSecret, which then resolves', async () => {
    write(userFile(), {
      other: 'kept',
      mcpServers: {
        local: { command: 'srv', args: ['$env:ARG'], env: { API_KEY: `$env:${VAR}`, MIXED: `a-$env:${OTHER}-b` } },
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: `Bearer $env:${VAR}` },
          bearerToken: `$env:${VAR}`,
          oauth: { clientSecret: `$env:${OTHER}` },
        },
      },
    });

    await expect(migrateOwnedMcpFile(userFile())).resolves.toBe(true);

    expect((JSON.parse(readFileSync(userFile(), 'utf-8')) as Record<string, unknown>)['other']).toBe('kept');
    const migrated = servers(userFile());
    expect(migrated['local']).toEqual({
      command: 'srv',
      args: ['$env:ARG'],
      env: { API_KEY: `\${${VAR}}`, MIXED: `a-\${${OTHER}}-b` },
    });
    expect(migrated['remote']).toMatchObject({
      headers: { Authorization: `Bearer \${${VAR}}` },
      bearerToken: `\${${VAR}}`,
      oauth: { clientSecret: `\${${OTHER}}` },
    });
    const out = (await resolved(migrated['local'] as unknown as McpServerConfig, pi)) as McpStdioServerConfig;
    expect(out.env).toEqual({ API_KEY: 'tok-123', MIXED: 'a-other-b' });
  });

  it('renames oauth.redirectUri to oauth.callbackUrl, and drops it when callbackUrl is already set', async () => {
    write(localFile(), {
      mcpServers: {
        a: { type: 'http', url: 'https://a.example.com/mcp', oauth: { clientId: 'c', redirectUri: 'http://127.0.0.1:3118/callback' } },
        b: { type: 'http', url: 'https://b.example.com/mcp', oauth: { redirectUri: 'http://127.0.0.1:1/x', callbackUrl: 'http://127.0.0.1:2/y' } },
      },
    });

    await expect(migrateOwnedMcpFile(localFile())).resolves.toBe(true);

    const migrated = servers(localFile());
    expect(migrated['a']?.['oauth']).toEqual({ clientId: 'c', callbackUrl: 'http://127.0.0.1:3118/callback' });
    expect(migrated['b']?.['oauth']).toEqual({ callbackUrl: 'http://127.0.0.1:2/y' });
  });

  it('is idempotent: a second run reports no change and leaves the bytes identical', async () => {
    write(userFile(), { mcpServers: { s: { command: 'x', env: { K: `$env:${VAR}` } } } });
    await migrateOwnedMcpFile(userFile());
    const once = readFileSync(userFile(), 'utf-8');

    await expect(migrateOwnedMcpFile(userFile())).resolves.toBe(false);
    expect(readFileSync(userFile(), 'utf-8')).toBe(once);
  });

  // Every config load runs this, so it must not wait on a lock another writer holds or left behind.
  it('takes no lock when there is nothing to migrate', async () => {
    write(userFile(), { mcpServers: { s: { command: 'x', env: { K: `\${${VAR}}` } } } });
    mkdirSync(`${userFile()}.lock`);

    await expect(migrateOwnedMcpFile(userFile())).resolves.toBe(false);
  }, 3_000);

  it('leaves a missing or unparseable file untouched', async () => {
    await expect(migrateOwnedMcpFile(userFile())).resolves.toBe(false);
    expect(existsSync(userFile())).toBe(false);

    const broken = '{ "mcpServers": { "s": { "env": { "K": "$env:X" } }';
    mkdirSync(dirname(userFile()), { recursive: true });
    writeFileSync(userFile(), broken, 'utf-8');
    await expect(migrateOwnedMcpFile(userFile())).resolves.toBe(false);
    expect(readFileSync(userFile(), 'utf-8')).toBe(broken);
  });

  it('refuses a file Damocles does not own', async () => {
    const foreign = join(dir, 'ws', '.mcp.json');
    write(foreign, { mcpServers: { s: { command: 'x', env: { K: `$env:${VAR}` } } } });
    const before = readFileSync(foreign, 'utf-8');

    await expect(migrateOwnedMcpFile(foreign)).rejects.toThrow();
    await expect(migrateOwnedMcpFile(join(dir, 'ws', '.pi', 'mcp.json'))).rejects.toThrow();
    expect(readFileSync(foreign, 'utf-8')).toBe(before);
  });
});
