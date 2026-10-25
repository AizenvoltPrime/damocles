import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { FormatService, loggedError, type FormatAction, type FormatTarget } from '../formatting/format-service';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFormatter } from '../../workspace/format/formatter';
import type { HostOutcome } from '../../workspace/format/formatter-hosts';
import { testWorkspaces } from './test-workspaces';
import type { Workspaces } from '../workspace/workspaces';
import { HostStore } from '../remote/host-store';
import { createProjectTrust, createRemoteTrust } from '../remote/remote-trust';
import { TRUST_FILE, TrustStore } from '../trust-store';
import { rootKey } from '../../preload/folder-root';
import { projectKeyOf, targetFolderKeyOf } from '../../../shared/project-location';

const dirs: string[] = [];

function put(file: string, content = ''): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function installPrettier(dir: string, version: string): string {
  put(path.join(dir, 'node_modules', 'prettier', 'package.json'), JSON.stringify({ name: 'prettier', version, main: 'index.cjs' }));
  return put(path.join(dir, 'node_modules', 'prettier', 'index.cjs'), 'module.exports = {};');
}

interface Setup {
  readonly service: FormatService;
  readonly root: string;
  readonly hostCalls: Array<{ target: { key: string; root: string }; request: { prettier: string; config: string | null; file: string; text: string } }>;
  readonly notices: Array<{ severity: string; message: string; action?: FormatAction }>;
  readonly logLines: string[];
  readonly trustRequests: string[];
  readonly shown: { count: number };
  trusted: () => boolean;
  projectPresent: () => boolean;
  // further listed projects, such as one nested in the root
  others: Array<{ key: string; fsPath: string; name: string; trusted: boolean }>;
  formatOnSave: boolean;
  outcome: HostOutcome;
  target: (name: string, languageId?: string) => string;
}

let setup: Setup;

function create(): Setup {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fms')));
  dirs.push(base);
  const root = path.join(base, 'alpha');
  fs.mkdirSync(root, { recursive: true });
  const project = { key: folderKey(root), fsPath: root, name: 'alpha' };
  const targets = new Map<string, FormatTarget>();
  const state: Setup = {
    root,
    hostCalls: [],
    notices: [],
    logLines: [],
    trustRequests: [],
    shown: { count: 0 },
    trusted: () => true,
    projectPresent: () => true,
    others: [],
    formatOnSave: true,
    outcome: { kind: 'formatted', text: 'formatted\n' },
    target: (name, languageId = 'typescript') => {
      const file = put(path.join(root, ...name.split('/')), 'text');
      const id = `doc-${targets.size}`;
      targets.set(id, { path: file, projectKey: project.key, relativePath: name, name: path.basename(name), languageId });
      return id;
    },
    service: undefined as unknown as FormatService,
  };
  const { fileWatchers: watchers } = createFakePlatform();
  // the real resolution, with the host the test answers for
  const formatter = createFormatter({ starters: { startFormatterHost: () => { throw new Error('no formatter host in this test'); } }, watchers, log: () => undefined });
  (state as { service: FormatService }).service = new FormatService({
    target: (documentId) => targets.get(documentId),
    // Fresh objects per read, as main's project list gives.
    projects: () => [...(state.projectPresent() ? [{ ...project }] : []), ...state.others.map((other) => ({ ...other }))],
    isTrusted: ({ fsPath }) => (fsPath === root ? state.trusted() : state.others.some((other) => other.fsPath === fsPath && other.trusted)),
    requestTrust: ({ fsPath }) => state.trustRequests.push(fsPath),
    formatOnSave: () => state.formatOnSave,
    workspaces: testWorkspaces({ watchers, format: { ...formatter, format: async (target, request) => {
      state.hostCalls.push({ target, request });
      return state.outcome;
    } } }),
    notify: (severity, message, action) => state.notices.push({ severity, message, ...(action ? { action } : {}) }),
    formatLog: { appendLine: (line) => state.logLines.push(line), show: () => state.shown.count++ },
    log: () => undefined,
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
  });
  return state;
}

beforeEach(() => {
  setup = create();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('formatter selection (D29)', () => {
  it('runs the project\'s Prettier 3 inside the root through the root\'s host, with the real paths', async () => {
    const entry = installPrettier(setup.root, '3.3.3');
    const id = setup.target('src/a.ts');
    expect(await setup.service.format(id, 'text', 'save')).toEqual({ kind: 'formatted', text: 'formatted\n' });
    expect(setup.hostCalls).toEqual([{ target: { key: folderKey(setup.root), root: setup.root }, request: { prettier: entry, config: null, file: path.join(setup.root, 'src', 'a.ts'), text: 'text' } }]);
    expect(setup.notices).toEqual([]);
  });

  it('runs Prettier 2 the same way, and answers unchanged for its own text or an ignored file', async () => {
    installPrettier(setup.root, '2.8.8');
    const id = setup.target('a.ts');
    setup.outcome = { kind: 'formatted', text: 'text' };
    expect(await setup.service.format(id, 'text', 'save')).toEqual({ kind: 'unchanged' });
    setup.outcome = { kind: 'ignored' };
    expect(await setup.service.format(id, 'text', 'save')).toEqual({ kind: 'unchanged' });
    expect(setup.hostCalls).toHaveLength(2);
  });

  it('does not run any other major version, and the notice names it', async () => {
    installPrettier(setup.root, '1.19.1');
    expect(await setup.service.format(setup.target('a.ts'), 'text', 'save')).toEqual({ kind: 'skipped' });
    expect(setup.hostCalls).toEqual([]);
    expect(setup.notices).toEqual([{ severity: 'warning', message: 'Prettier 1.19.1 was not run on a.ts. Format on save runs Prettier 2 and 3.' }]);
  });

  it('does not run a Prettier found only in a parent folder, and the notice names its path', async () => {
    const parent = path.dirname(setup.root);
    installPrettier(parent, '3.3.3');
    expect(await setup.service.format(setup.target('a.ts'), 'text', 'save')).toEqual({ kind: 'skipped' });
    expect(setup.hostCalls).toEqual([]);
    expect(setup.notices[0]!.message).toContain(path.join(parent, 'node_modules', 'prettier'));
    expect(setup.logLines[0]).toMatch(/\[alpha\] a\.ts: not formatted: the nearest Prettier is outside the project/);
  });

  it('formats nothing when Prettier is configured but not installed, and says so', async () => {
    put(path.join(setup.root, '.prettierrc'), '{}');
    expect(await setup.service.format(setup.target('data.json', 'json'), '{}', 'save')).toEqual({ kind: 'skipped' });
    expect(setup.notices[0]!.message).toBe('Prettier is configured in this project but not installed, so data.json was not formatted. Install the project\'s dependencies to format it.');
  });

  it('otherwise hands TS, JS and JSON to Monaco\'s built-in formatter and leaves other files alone', async () => {
    expect(await setup.service.format(setup.target('a.ts'), 'x', 'save')).toEqual({ kind: 'builtin' });
    expect(await setup.service.format(setup.target('b.js', 'javascript'), 'x', 'save')).toEqual({ kind: 'builtin' });
    expect(await setup.service.format(setup.target('c.json', 'json'), 'x', 'save')).toEqual({ kind: 'builtin' });
    expect(await setup.service.format(setup.target('d.md', 'markdown'), 'x', 'save')).toEqual({ kind: 'skipped' });
    expect(setup.hostCalls).toEqual([]);
    expect(setup.notices).toEqual([]);
  });

  it('formats on save only while the setting is on; Format Document runs either way', async () => {
    const id = setup.target('a.ts');
    setup.formatOnSave = false;
    expect(await setup.service.format(id, 'x', 'save')).toEqual({ kind: 'skipped' });
    expect(await setup.service.format(id, 'x', 'command')).toEqual({ kind: 'builtin' });
  });

  it('formats nothing for a document main does not hold as an editable project file', async () => {
    expect(await setup.service.format('doc-unknown', 'x', 'command')).toEqual({ kind: 'skipped' });
  });
});

describe('config confinement', () => {
  it('runs Prettier with a config inside the root, or with none anywhere, and names that exact file to the host', async () => {
    installPrettier(setup.root, '3.3.3');
    const id = setup.target('src/a.ts');
    expect(await setup.service.format(id, 'x', 'save')).toMatchObject({ kind: 'formatted' });
    const config = put(path.join(setup.root, '.prettierrc'), '{"semi":false}');
    expect(await setup.service.format(id, 'x', 'save')).toMatchObject({ kind: 'formatted' });
    expect(setup.hostCalls.map((call) => call.request.config)).toEqual([null, config]);
  });

  it('names the config Prettier 2 would load, past a source only Prettier 3 reads', async () => {
    installPrettier(setup.root, '2.8.8');
    const config = put(path.join(setup.root, '.prettierrc.json'), '{}');
    put(path.join(setup.root, 'src', '.prettierrc.mjs'), 'export default {};');
    expect(await setup.service.format(setup.target('src/a.ts'), 'x', 'save')).toMatchObject({ kind: 'formatted' });
    expect(setup.hostCalls.map((call) => call.request.config)).toEqual([config]);
  });

  it('does not run Prettier when its nearest config lies only in a parent folder, and the notice names it', async () => {
    installPrettier(setup.root, '3.3.3');
    const parentConfig = put(path.join(path.dirname(setup.root), 'prettier.config.js'), 'module.exports = {};');
    const id = setup.target('src/a.ts');
    expect(await setup.service.format(id, 'x', 'save')).toEqual({ kind: 'skipped' });
    expect(setup.hostCalls).toEqual([]);
    expect(setup.notices.map((notice) => notice.message)).toEqual([
      `Prettier was not run on a.ts. Its nearest config is outside the project, at ${parentConfig}. Add a Prettier config to this project, or add the folder that holds that config as a project.`,
    ]);
    expect(setup.logLines[0]).toContain(`the nearest Prettier config is outside the project, at ${parentConfig}`);
    // A package.json prettier key in the parent is a config source too; a config in the root, nearer, wins over both.
    fs.rmSync(parentConfig);
    put(path.join(path.dirname(setup.root), 'package.json'), JSON.stringify({ prettier: 'shared-config' }));
    expect(await setup.service.format(id, 'x', 'command')).toEqual({ kind: 'skipped' });
    put(path.join(setup.root, 'package.json'), JSON.stringify({ name: 'alpha', prettier: { semi: false } }));
    expect(await setup.service.format(id, 'x', 'command')).toMatchObject({ kind: 'formatted' });
  });
});

describe('trust gate', () => {
  it('does not format a file of an untrusted project nested in the trusted one, and names the nested project', async () => {
    installPrettier(path.join(setup.root, 'vendor', 'lib'), '3.3.3');
    const id = setup.target('vendor/lib/a.ts');
    setup.others.push({ key: 'nested', fsPath: path.join(setup.root, 'vendor', 'lib'), name: 'lib', trusted: false });
    expect(await setup.service.format(id, 'x', 'command')).toEqual({ kind: 'skipped' });
    expect(setup.hostCalls).toEqual([]);
    expect(setup.notices.map((notice) => notice.message)).toEqual(['Format Document is off in untrusted folders. Trust lib to format its files.']);
    setup.others[0]!.trusted = true;
    expect(await setup.service.format(id, 'x', 'command')).toMatchObject({ kind: 'formatted' });
  });

  it('takes no other host\'s untrusted project for one nested in this project, though its path names this project\'s folder', async () => {
    installPrettier(path.join(setup.root, 'vendor', 'lib'), '3.3.3');
    const id = setup.target('vendor/lib/a.ts');
    const nested = path.join(setup.root, 'vendor', 'lib');
    setup.others.push({ key: projectKeyOf({ kind: 'loopback' }, folderKey(nested)), fsPath: nested, name: 'lib', trusted: false });
    expect(await setup.service.format(id, 'x', 'command')).toMatchObject({ kind: 'formatted' });
    expect(setup.notices).toEqual([]);
  });

  it('formats a trusted project opened inside an untrusted folder that is listed too', async () => {
    installPrettier(setup.root, '3.3.3');
    setup.others.push({ key: 'outer', fsPath: path.dirname(setup.root), name: 'outer', trusted: false });
    expect(await setup.service.format(setup.target('a.ts'), 'x', 'save')).toMatchObject({ kind: 'formatted' });
  });

  it('starts no host in an untrusted project and shows the notice with Trust once per project per run for saves', async () => {
    installPrettier(setup.root, '3.3.3');
    setup.trusted = () => false;
    const id = setup.target('a.ts');
    expect(await setup.service.format(id, 'x', 'save')).toEqual({ kind: 'skipped' });
    expect(await setup.service.format(id, 'x', 'save')).toEqual({ kind: 'skipped' });
    expect(setup.hostCalls).toEqual([]);
    expect(setup.notices).toHaveLength(1);
    expect(setup.notices[0]).toMatchObject({ severity: 'info', message: 'Format on save is off in untrusted folders. Trust alpha to format its files.', action: { label: 'Trust' } });
    setup.notices[0]!.action!.run();
    expect(setup.trustRequests).toEqual([setup.root]);
    // Format Document is the user's explicit request: it says so every time.
    await setup.service.format(id, 'x', 'command');
    await setup.service.format(id, 'x', 'command');
    expect(setup.notices.map((notice) => notice.message).slice(1)).toEqual([
      'Format Document is off in untrusted folders. Trust alpha to format its files.',
      'Format Document is off in untrusted folders. Trust alpha to format its files.',
    ]);
  });

  it('does not use the built-in formatter in an untrusted project either', async () => {
    setup.trusted = () => false;
    expect(await setup.service.format(setup.target('a.ts'), 'x', 'command')).toEqual({ kind: 'skipped' });
  });

  it('reads trust again before Prettier runs: a project untrusted while the resolution ran starts no host', async () => {
    installPrettier(setup.root, '3.3.3');
    let checks = 0;
    setup.trusted = () => checks++ === 0;
    expect(await setup.service.format(setup.target('a.ts'), 'x', 'save')).toEqual({ kind: 'skipped' });
    expect(checks).toBe(2);
    expect(setup.hostCalls).toEqual([]);
  });

  it('starts no host for a removed project, before or during the resolution', async () => {
    installPrettier(setup.root, '3.3.3');
    const id = setup.target('a.ts');
    setup.projectPresent = () => false;
    expect(await setup.service.format(id, 'x', 'save')).toEqual({ kind: 'skipped' });
    let lookups = 0;
    setup.projectPresent = () => lookups++ === 0;
    expect(await setup.service.format(id, 'x', 'save')).toEqual({ kind: 'skipped' });
    expect(setup.hostCalls).toEqual([]);
  });

  it('refuses a file that no longer resolves inside the project', async () => {
    installPrettier(setup.root, '3.3.3');
    const id = setup.target('src/a.ts');
    const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fmo')));
    dirs.push(elsewhere);
    put(path.join(elsewhere, 'a.ts'));
    // A junction swapped in for the file's folder after it opened.
    fs.rmSync(path.join(setup.root, 'src'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(setup.root, 'src'), 'junction');
    expect(await setup.service.format(id, 'x', 'save')).toEqual({ kind: 'skipped' });
    expect(setup.hostCalls).toEqual([]);
  });
});

describe('failures', () => {
  it('on a refused module outside the root answers failed and names it, once per run for saves', async () => {
    installPrettier(setup.root, '3.3.3');
    const plugin = path.join(path.dirname(setup.root), 'node_modules', 'prettier-plugin-x', 'index.js');
    setup.outcome = { kind: 'refused', path: plugin };
    const id = setup.target('src/a.ts');
    expect(await setup.service.format(id, 'x', 'save')).toEqual({ kind: 'failed' });
    expect(await setup.service.format(id, 'x', 'save')).toEqual({ kind: 'failed' });
    expect(setup.notices).toEqual([{
      severity: 'warning',
      message: `Prettier could not format a.ts: it needs ${plugin}, which is outside the project, so it was not loaded. Install it in this project, or add the folder that holds it as a project.`,
    }]);
    expect(setup.logLines[0]).toMatch(/\[alpha\] src\/a\.ts: not formatted: Prettier 3\.3\.3 needs .*prettier-plugin-x.*, which is outside the project$/);
  });

  it('on a Prettier still loading after the budget answers failed and says it was still starting', async () => {
    installPrettier(setup.root, '3.3.3');
    setup.outcome = { kind: 'timeout', starting: true };
    expect(await setup.service.format(setup.target('a.ts'), 'x', 'save')).toEqual({ kind: 'failed' });
    expect(setup.notices.map((notice) => notice.message)).toEqual(['Prettier took longer than 3 seconds to start for a.ts. The file was saved unformatted.']);
    expect(setup.logLines[0]).toMatch(/a\.ts: Prettier 3\.3\.3 took longer than 3000 ms to load; it keeps loading for the next format$/);
  });

  it('on a timeout answers failed, logs it without file text and offers Show Output', async () => {
    installPrettier(setup.root, '3.3.3');
    setup.outcome = { kind: 'timeout', starting: false };
    expect(await setup.service.format(setup.target('src/a.ts'), 'secret text', 'save')).toEqual({ kind: 'failed' });
    expect(setup.notices).toEqual([{ severity: 'warning', message: 'Prettier took longer than 3 seconds on a.ts and was stopped. The file was saved unformatted.', action: expect.objectContaining({ label: 'Show Output' }) }]);
    expect(setup.logLines).toHaveLength(1);
    expect(setup.logLines[0]).toMatch(/\[alpha\] src\/a\.ts: Prettier 3\.3\.3 took longer than 3000 ms and was stopped$/);
    setup.notices[0]!.action!.run();
    expect(setup.shown.count).toBe(1);
  });

  it('on an error logs only its first line and says so for every failure', async () => {
    installPrettier(setup.root, '3.3.3');
    setup.outcome = { kind: 'error', message: 'SyntaxError: \';\' expected. (1:7)\n> 1 | const password = "hunter2"\n    |       ^' };
    expect(await setup.service.format(setup.target('a.ts'), 'x', 'command')).toEqual({ kind: 'failed' });
    expect(await setup.service.format(setup.target('a.ts'), 'x', 'command')).toEqual({ kind: 'failed' });
    expect(setup.notices.map((notice) => notice.message)).toEqual(['Prettier could not format a.ts.', 'Prettier could not format a.ts.']);
    expect(setup.logLines.join('\n')).not.toContain('hunter2');
    expect(setup.logLines[0]).toContain('SyntaxError: \';\' expected. (1:7)');
  });

  it('reports the shell\'s built-in formatter failing or timing out the same way', () => {
    const id = setup.target('a.ts');
    setup.service.builtinFailed(id, 'save', true, '');
    setup.service.builtinFailed(id, 'command', false, 'worker died\nstack');
    expect(setup.notices.map((notice) => notice.message)).toEqual([
      'The built-in formatter took longer than 3 seconds on a.ts and was stopped. The file was saved unformatted.',
      'The built-in formatter could not format a.ts.',
    ]);
    expect(setup.logLines[1]).toMatch(/the built-in formatter failed: worker died$/);
  });

  it('keeps control characters out of the log', () => {
    expect(loggedError('a\u001b[31mb\u0007c\r\nnext')).toBe('a [31mb c');
  });
});


describe('a remote chat worktree root', () => {
  async function remoteSetup(): Promise<{ service: FormatService; documentId: string; projectKey: string; userData: string; store: HostStore; notices: Array<{ message: string; action?: FormatAction }>; answers: Array<number | undefined>; granted: Array<Promise<boolean>>; hostKeys: string[] }> {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fmr')));
    dirs.push(base);
    const userData = path.join(base, 'userData');
    fs.mkdirSync(userData);
    const app = path.join(base, 'app');
    const working = path.join(base, 'worktrees', 'ab12cd34', 'app');
    fs.mkdirSync(app, { recursive: true });
    installPrettier(working, '3.3.3');
    const file = put(path.join(working, 'a.ts'), 'text');
    const projectKey = projectKeyOf({ kind: 'loopback' }, folderKey(app));
    const project = { key: projectKey, fsPath: app, name: 'app' };
    const worktreeRoot = { key: rootKey({ projectKey, worktreeId: 'ab12cd34' }), fsPath: working, name: 'app' };
    const store = await HostStore.open(userData, () => undefined);
    const answers: Array<number | undefined> = [];
    const ask = async (): Promise<number | undefined> => answers.shift();
    const t = (message: string, ...args: Array<string | number>): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]));
    const local = new TrustStore(userData, ask, t, () => undefined);
    const trust = createProjectTrust({
      local,
      remote: createRemoteTrust({ store, ask, t, log: () => undefined }),
      remoteTarget: (key) => (key === projectKey ? { key, authorityKey: 'loopback', folderKey: folderKey(app), fsPath: app, host: 'Local daemon' } : undefined),
    });
    const notices: Array<{ message: string; action?: FormatAction }> = [];
    const granted: Array<Promise<boolean>> = [];
    const hostKeys: string[] = [];
    const { fileWatchers: watchers } = createFakePlatform();
    const formatter = createFormatter({ starters: { startFormatterHost: () => { throw new Error('no formatter host in this test'); } }, watchers, log: () => undefined });
    const workspaces: Workspaces = testWorkspaces({
      watchers,
      format: { ...formatter, format: async (target) => {
        hostKeys.push(target.key);
        return { kind: 'formatted', text: 'formatted\n' };
      } },
      remote: () => workspaces.local,
    });
    const service = new FormatService({
      target: (id) => (id === 'doc' ? { path: file, projectKey: worktreeRoot.key, relativePath: 'a.ts', name: 'a.ts', languageId: 'typescript' } : undefined),
      projects: () => [project, worktreeRoot],
      isTrusted: (candidate) => trust.isTrusted(candidate),
      requestTrust: (candidate) => granted.push(trust.request(candidate)),
      formatOnSave: () => true,
      workspaces,
      notify: (_severity, message, action) => notices.push({ message, ...(action ? { action } : {}) }),
      formatLog: { appendLine: () => undefined, show: () => undefined },
      log: () => undefined,
      t,
    });
    return { service, documentId: 'doc', projectKey, userData, store, notices, answers, granted, hostKeys };
  }

  it('formats while the host store trusts its project, whatever the local allowlist says', async () => {
    const remote = await remoteSetup();
    await remote.store.grantTrust('loopback', targetFolderKeyOf(remote.projectKey)!);
    expect(await remote.service.format(remote.documentId, 'text', 'command')).toEqual({ kind: 'formatted', text: 'formatted\n' });
    expect(remote.hostKeys).toEqual([rootKey({ projectKey: remote.projectKey, worktreeId: 'ab12cd34' })]);
    expect(remote.notices).toEqual([]);
  });

  it('grants its project into remote-hosts.json only, never trusted-folders.json', async () => {
    const remote = await remoteSetup();
    expect(await remote.service.format(remote.documentId, 'text', 'command')).toEqual({ kind: 'skipped' });
    remote.answers.push(0);
    remote.notices[0]!.action!.run();
    expect(await remote.granted[0]).toBe(true);
    expect((await HostStore.open(remote.userData, () => undefined)).isTrusted('loopback', targetFolderKeyOf(remote.projectKey)!)).toBe(true);
    expect(fs.existsSync(path.join(remote.userData, TRUST_FILE))).toBe(false);
    expect(await remote.service.format(remote.documentId, 'text', 'command')).toEqual({ kind: 'formatted', text: 'formatted\n' });
  });
});
