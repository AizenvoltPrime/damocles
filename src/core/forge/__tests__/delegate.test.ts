import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpawnSpec } from '../../process-launcher/protocol';
import { asConfigParams, managedEntries } from '../../scm/askpass/credential-config';
import { createDelegator, DELEGATING_VARIABLE, delegateInput, parseFill, type DelegateDeps } from '../delegate';

const HELPER = 'C:/Program Files/Damocles/resources/app.asar.unpacked/dist/git-credential/git-credential-relay.cmd';
const FIELDS = { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' };

describe('delegation to the user\'s own helpers', () => {
  let tmp: string;
  let runs: Array<{ readonly spec: SpawnSpec; readonly input: string; readonly cwdExisted: boolean }>;
  let stdout: string;
  let code: number | null;
  let askpassDisposed: number;
  let askpassRegistered: number;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-delegate-'));
    runs = [];
    stdout = 'protocol=https\nhost=gitlab.com\nusername=ada\npassword=from-gcm\n';
    code = 0;
    askpassDisposed = 0;
    askpassRegistered = 0;
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // as childEnv gives it: the inherited GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT pairs already dropped
  const inherited: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    DAMOCLES_ASKPASS_HANDLE: '/run/a.sock',
    DAMOCLES_CREDENTIAL_NONCE: 'f'.repeat(64),
    DAMOCLES_ASKPASS_NODE: '/node',
    DAMOCLES_ASKPASS_MAIN: '/main.js',
  };

  const delegator = (trusted: boolean, overrides: Partial<DelegateDeps> = {}) => createDelegator({
    git: () => '/usr/bin/git',
    trustedProjectAt: () => (trusted ? '/repo' : undefined),
    askpass: async () => {
      askpassRegistered++;
      return { env: { GIT_ASKPASS: '/askpass.sh', DAMOCLES_ASKPASS_HANDLE: '/run/core.sock', DAMOCLES_ASKPASS_NONCE: 'a'.repeat(64) }, dispose: () => { askpassDisposed++; } };
    },
    log: () => undefined,
    tmpdir: () => tmp,
    env: () => ({ ...inherited }),
    ...overrides,
    run: async (spec, input) => {
      runs.push({ spec, input, cwdExisted: fs.existsSync(spec.cwd!) });
      return { exit: { code, signal: null }, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
    },
  } satisfies DelegateDeps);

  it('runs git credential fill in a trusted project\'s folder, and gives back what the user\'s helpers printed', async () => {
    const filled = await delegator(true).run({ op: 'get', cwd: '/repo/sub', fields: FIELDS, interactive: false, agentShell: false }, new AbortController().signal);
    expect(filled).toEqual({ username: 'ada', password: 'from-gcm' });
    const [{ spec, input }] = runs as [typeof runs[number]];
    expect(spec).toMatchObject({ file: '/usr/bin/git', args: ['credential', 'fill'], cwd: '/repo/sub', shell: false });
    expect(input).toBe('protocol=https\nhost=gitlab.com\npath=g/p.git\n\n');
    expect(spec.env!['GIT_CEILING_DIRECTORIES']).toBe(path.dirname('/repo'));
  });

  it('runs outside a trusted project from a fresh empty folder whose parent git never searches past, removed afterwards', async () => {
    await delegator(false).run({ op: 'get', cwd: '/elsewhere', fields: FIELDS, interactive: false, agentShell: false }, new AbortController().signal);
    const [{ spec, cwdExisted }] = runs as [typeof runs[number]];
    expect(path.dirname(spec.cwd!)).toBe(tmp);
    expect(cwdExisted).toBe(true);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(spec.env!['GIT_CEILING_DIRECTORIES']).toBe(tmp);
  });

  it('drops Damocles\' capabilities, and marks the run so its helper answers nothing', async () => {
    await delegator(true).run({ op: 'get', cwd: '/repo', fields: FIELDS, interactive: false, agentShell: false }, new AbortController().signal);
    const env = runs[0]!.spec.env!;
    for (const key of ['DAMOCLES_ASKPASS_HANDLE', 'DAMOCLES_CREDENTIAL_NONCE', 'DAMOCLES_ASKPASS_NODE', 'DAMOCLES_ASKPASS_MAIN', 'GIT_ASKPASS']) expect(env[key], key).toBeUndefined();
    expect(env[DELEGATING_VARIABLE]).toBe('1');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['GCM_INTERACTIVE']).toBe('never');
  });

  it('gives an interactive origin the askpass bridge for the manager\'s own prompts, and no GCM_INTERACTIVE', async () => {
    await delegator(true).run({ op: 'get', cwd: '/repo', fields: FIELDS, interactive: true, agentShell: false }, new AbortController().signal);
    const env = runs[0]!.spec.env!;
    expect(env['GIT_ASKPASS']).toBe('/askpass.sh');
    expect(env['DAMOCLES_ASKPASS_NONCE']).toBe('a'.repeat(64));
    expect(env['DAMOCLES_CREDENTIAL_NONCE']).toBeUndefined();
    expect(env['GCM_INTERACTIVE']).toBeUndefined();
    expect(askpassDisposed).toBe(1);
  });

  it('refuses an interactive delegation where no askpass bridge exists, as on a target, before starting git', async () => {
    const target = createDelegator({ git: () => '/usr/bin/git', trustedProjectAt: () => '/repo', log: () => undefined, tmpdir: () => tmp, env: () => ({}), run: async (spec, input) => {
      runs.push({ spec, input, cwdExisted: true });
      return { exit: { code: 0, signal: null }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    } });
    await expect(target.run({ op: 'get', cwd: '/repo', fields: FIELDS, interactive: true, agentShell: false }, new AbortController().signal)).rejects.toThrow('no askpass bridge');
    await target.run({ op: 'get', cwd: '/repo', fields: FIELDS, interactive: false, agentShell: false }, new AbortController().signal);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.spec.env!['GIT_ASKPASS']).toBeUndefined();
    expect(runs[0]!.spec.env!['GCM_INTERACTIVE']).toBe('never');
  });

  it('routes store to git credential approve and erase to reject, with the password, and returns nothing', async () => {
    const run = delegator(true);
    await expect(run.run({ op: 'store', cwd: '/repo', fields: { ...FIELDS, username: 'ada' }, password: 'from-gcm', interactive: false, agentShell: false }, new AbortController().signal)).resolves.toBeUndefined();
    await expect(run.run({ op: 'erase', cwd: '/repo', fields: { ...FIELDS, username: 'ada' }, password: 'from-gcm', interactive: false, agentShell: false }, new AbortController().signal)).resolves.toBeUndefined();
    expect(runs.map((entry) => entry.spec.args)).toEqual([['credential', 'approve'], ['credential', 'reject']]);
    expect(runs[0]!.input).toBe('protocol=https\nhost=gitlab.com\npath=g/p.git\nusername=ada\npassword=from-gcm\n\n');
  });

  it('answers nothing when the user\'s helpers gave nothing or printed no usable credential', async () => {
    code = 128;
    await expect(delegator(true).run({ op: 'get', cwd: '/repo', fields: FIELDS, interactive: false, agentShell: false }, new AbortController().signal)).resolves.toBeUndefined();
    code = 0;
    stdout = 'username=ada\n';
    await expect(delegator(true).run({ op: 'get', cwd: '/repo', fields: FIELDS, interactive: false, agentShell: false }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('drops an inherited GIT_CONFIG_PARAMETERS, the takeover\'s entries with it', async () => {
    const saved = process.env['GIT_CONFIG_PARAMETERS'];
    process.env['GIT_CONFIG_PARAMETERS'] = `'core.pager=less' ${asConfigParams(managedEntries([{ webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'] }], HELPER), undefined)!}`;
    try {
      const ownEnv = createDelegator({ git: () => '/usr/bin/git', trustedProjectAt: () => '/repo', log: () => undefined, tmpdir: () => tmp, run: async (spec, input) => {
        runs.push({ spec, input, cwdExisted: true });
        return { exit: { code: 0, signal: null }, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
      } });
      await ownEnv.run({ op: 'get', cwd: '/repo', fields: FIELDS, interactive: false, agentShell: false }, new AbortController().signal);
    } finally {
      if (saved === undefined) delete process.env['GIT_CONFIG_PARAMETERS'];
      else process.env['GIT_CONFIG_PARAMETERS'] = saved;
    }
    expect(Object.keys(runs[0]!.spec.env!).filter((key) => key.toUpperCase() === 'GIT_CONFIG_PARAMETERS')).toEqual([]);
  });

  it('answers an agent shell from a fresh empty folder even inside a trusted project, so its repository\'s helpers never run', async () => {
    await delegator(true).run({ op: 'get', cwd: '/repo/sub', fields: FIELDS, interactive: false, agentShell: true }, new AbortController().signal);
    const [{ spec, cwdExisted }] = runs as [typeof runs[number]];
    expect(path.dirname(spec.cwd!)).toBe(tmp);
    expect(cwdExisted).toBe(true);
    expect(spec.env!['GIT_CEILING_DIRECTORIES']).toBe(tmp);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('leaves no empty folder behind when the askpass registration fails', async () => {
    const failing = delegator(false, { askpass: () => Promise.reject(new Error('no registration')) });
    await expect(failing.run({ op: 'get', cwd: '/elsewhere', fields: FIELDS, interactive: true, agentShell: false }, new AbortController().signal)).rejects.toThrow('no registration');
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith('damocles-git-credential-'))).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('registers no askpass prompt for an interactive store or erase, which never prompts', async () => {
    const run = delegator(true);
    await run.run({ op: 'store', cwd: '/repo', fields: { ...FIELDS, username: 'ada' }, password: 'from-gcm', interactive: true, agentShell: false }, new AbortController().signal);
    await run.run({ op: 'erase', cwd: '/repo', fields: { ...FIELDS, username: 'ada' }, password: 'from-gcm', interactive: true, agentShell: false }, new AbortController().signal);
    expect(askpassRegistered).toBe(0);
    for (const { spec } of runs) {
      expect(spec.env!['GIT_ASKPASS']).toBeUndefined();
      expect(spec.env!['GCM_INTERACTIVE']).toBe('never');
    }
  });

  it('refuses a field with a line break and reads only a bounded fill', () => {
    expect(() => delegateInput({ op: 'get', cwd: '/', fields: { protocol: 'https', host: 'a\nb' }, interactive: false, agentShell: false })).toThrow(RangeError);
    expect(parseFill('password=x\n')).toEqual({ username: '', password: 'x' });
    expect(parseFill(`password=${'x'.repeat(70_000)}\n`)).toBeUndefined();
  });
});
