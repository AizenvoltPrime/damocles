import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hookLabel, MAX_HOOK_LABEL_LENGTH, onRunningHooksChange, runningHooks, trackRunningHook } from '../running-hooks';
import { dispatchObserveOnly, type DispatchDeps } from '../dispatch';
import { registerConfiguredHooks } from '../index';
import type { ConfiguredHook } from '../types';
import type { HooksConfigService } from '../config';

// Assembled from parts so the file holds no literal matching a secret scanner's token pattern.
const SECRET = ['ghp', 'Zx81TokenValue'].join('_');

describe('hookLabel', () => {
  it("names an interpreter's script by its file name", () => {
    expect(hookLabel('bash ./scripts/notify.sh')).toBe('notify.sh');
    expect(hookLabel('sh -e scripts/notify.sh')).toBe('notify.sh');
    expect(hookLabel('python3 -u hooks/notify.py')).toBe('notify.py');
    expect(hookLabel('uv run --with requests scripts/notify.py')).toBe('notify.py');
    expect(hookLabel('pwsh -NoProfile -ExecutionPolicy Bypass -File ./hooks/notify.ps1')).toBe('notify.ps1');
    expect(hookLabel('cmd /c hooks\\notify.bat')).toBe('notify.bat');
    expect(hookLabel([process.execPath, '/home/me/hooks/notify.mjs'])).toBe('notify.mjs');
  });

  it('names any other program by its file name', () => {
    expect(hookLabel('./hooks/notify')).toBe('notify');
    expect(hookLabel('notify-send "Turn done"')).toBe('notify-send');
    expect(hookLabel(['/usr/local/bin/say-done', 'now'])).toBe('say-done');
    expect(hookLabel('${workspaceFolder}/.damocles/notify.sh')).toBe('notify.sh');
  });

  it('names an interpreter alone when it runs inline code, a module or no script file', () => {
    expect(hookLabel('bash -c "./notify.sh"')).toBe('bash');
    expect(hookLabel('bash -lc ./notify.sh')).toBe('bash');
    expect(hookLabel("node -e \"require('./notify.js')\"")).toBe('node');
    expect(hookLabel('python -m notify')).toBe('python');
    expect(hookLabel('pwsh -Command ./notify.ps1')).toBe('pwsh');
    expect(hookLabel('bash -s ./scripts/notify')).toBe('bash');
    expect(hookLabel('python - ./scripts/notify')).toBe('python');
  });

  it("names the script bash, sh and python run by their own option rules, without an extension when it is written as a path", () => {
    expect(hookLabel('bash ./scripts/notify')).toBe('notify');
    expect(hookLabel('bash .damocles/hooks/notify')).toBe('notify');
    expect(hookLabel('bash -o pipefail ./hooks/notify')).toBe('notify');
    expect(hookLabel('bash -eo pipefail ./hooks/notify')).toBe('notify');
    expect(hookLabel('bash -O extglob +o histexpand ./hooks/notify')).toBe('notify');
    expect(hookLabel('bash --rcfile ./hooks/rc --noprofile ./hooks/notify')).toBe('notify');
    expect(hookLabel('bash -- ./hooks/notify')).toBe('notify');
    expect(hookLabel(['sh', '-e', 'C:\\hooks\\notify'])).toBe('notify');
    expect(hookLabel('python3 -W ignore -X dev ./hooks/notify')).toBe('notify');
    expect(hookLabel('python -uWignore ./hooks/notify')).toBe('notify');
    // The first operand is the script, so a later script-like argument is never taken for it.
    expect(hookLabel('bash ./hooks/notify other.sh')).toBe('notify');
  });

  it.each<[string | string[], string]>([
    ['cd .damocles && ./hooks/notify.sh', 'notify.sh'],
    ['cd "my hooks" && bash ./notify', 'notify'],
    ['cd /d C:\\repo && cd hooks && notify.bat', 'notify.bat'],
    ['pushd C:\\repo && TOKEN=1 hooks\\notify.bat', 'notify.bat'],
    ['env python3 hook.py', 'hook.py'],
    ['env -i -u HOME PATH=/usr/bin TOKEN=x python3 -u hooks/notify.py', 'notify.py'],
    ['env -C ./hooks --unset=HOME -- node hook.js', 'hook.js'],
    [['/usr/bin/env', 'GH=1', 'bash', './hooks/notify'], 'notify'],
    ['zsh ./notify.zsh', 'notify.zsh'],
    ['zsh -f ./hooks/notify', 'notify'],
    ['dash ./hooks/notify', 'notify'],
    ['ksh -o errexit ./hooks/notify', 'notify'],
    ['py -3 hook.py', 'hook.py'],
    ['py -3.12-64 -u hooks/notify.py', 'notify.py'],
    ['py -V:Anaconda/3.11 hook.py', 'hook.py'],
    ['pythonw hook.pyw', 'hook.pyw'],
    ['pythonw3.12.exe hooks\\notify.py', 'notify.py'],
    ['node -r ./setup.js hook.js', 'hook.js'],
    ['node --require ./setup.js --import ./register.mjs hooks/notify.mjs', 'notify.mjs'],
    ['node --loader ts-node/esm.js hook.ts', 'hook.ts'],
    ['npx tsx hook.ts', 'hook.ts'],
    ['npx -y tsx@4 hooks/notify.ts', 'notify.ts'],
    ['npx -p tsx --yes -- tsx hook.ts', 'hook.ts'],
    ['bunx tsx hook.ts', 'hook.ts'],
    ['pnpm dlx tsx hook.ts', 'hook.ts'],
    ['yarn dlx --package=tsx tsx hook.ts', 'hook.ts'],
    ['npx @acme/notify-cli@2 --quiet', 'notify-cli'],
  ])('names the script behind a cd, env, py launcher, node preload or package runner: %s', (command, label) => {
    expect(hookLabel(command)).toBe(label);
  });

  it('names the leading program when what it runs is not a plain script or package', () => {
    expect(hookLabel('cd hooks || ./notify.sh')).toBe('cd');
    expect(hookLabel('env -S "python3 -u" hook.py')).toBe('env');
    expect(hookLabel('env TOKEN=1')).toBe('env');
    expect(hookLabel('npx -c "tsx hook.ts"')).toBe('npx');
    expect(hookLabel('npx github:acme/notify')).toBe('npx');
    expect(hookLabel('npx --registry https://registry.example tsx hook.ts')).toBe('npx');
    expect(hookLabel('pnpm install')).toBe('pnpm');
    expect(hookLabel('tsx -e "notify()"')).toBe('tsx');
  });

  it('shows only the interpreter for an operand that is a bare word or not a path', () => {
    expect(hookLabel('bash notify')).toBe('bash');
    expect(hookLabel('bash -o pipefail notify')).toBe('bash');
    expect(hookLabel('python ./hooks/no`tify')).toBe('python');
  });

  it('reads Windows paths and quoted paths', () => {
    expect(hookLabel('C:\\Tools\\hook.exe')).toBe('hook.exe');
    expect(hookLabel('"C:\\Program Files\\Git\\bin\\bash.exe" "C:\\my hooks\\notify.sh"')).toBe('notify.sh');
    expect(hookLabel("'/opt/my hooks/notify.sh' --quiet")).toBe('notify.sh');
    expect(hookLabel(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-File', 'D:\\repo\\.damocles\\notify.ps1'])).toBe('notify.ps1');
    expect(hookLabel('powershell.exe -File "C:\\Users\\me\\my hooks\\notify.ps1"')).toBe('notify.ps1');
  });

  it('never shows an argument, so a token on the command line never appears', () => {
    const commands: Array<string | string[]> = [
      `./notify.sh ${SECRET}`,
      `./notify.sh --token=${SECRET}`,
      `TOKEN=${SECRET} ./notify.sh`,
      `GH_TOKEN="${SECRET} x" API=1 bash ./notify.sh`,
      `bash -c "curl -H 'Authorization: Bearer ${SECRET}' https://hooks.example/x"`,
      `bash ${SECRET}`,
      `bash -o ${SECRET} ./hooks/notify`,
      `python -W ${SECRET} ./hooks/notify`,
      `bash --rcfile ${SECRET} ./hooks/notify`,
      `node --token ${SECRET} hook.js`,
      `node ${SECRET}.js.map hook.js`,
      `python notify.py ${SECRET}.py`,
      `bash https://hooks.example/${SECRET}.sh`,
      `cmd /c "notify.bat ${SECRET}"`,
      `curl -d ${SECRET} https://hooks.example/notify`,
      `./notify.sh ${SECRET}|tee log`,
      `cd ${SECRET} && ./notify.sh`,
      `env -u ${SECRET} TOKEN=${SECRET} ./notify.sh`,
      `env -S "${SECRET}" hook.py`,
      `node -r ./${SECRET}.js hook.js`,
      `npx -p ${SECRET} tsx hook.ts ${SECRET}.ts`,
      `npx --token ${SECRET} tsx hook.ts`,
      `npx https://hooks.example/${SECRET}.sh`,
      `pnpm dlx github:acme/${SECRET}`,
      `py -V:${SECRET} hook.py`,
      ['node', `--key=${SECRET}`, 'hook.js'],
      ['/bin/notify', SECRET],
      [`/hooks/${SECRET}/notify.sh`],
    ];
    for (const command of commands) expect(hookLabel(command), String(command)).not.toContain(SECRET.slice(4));
  });

  it('strips control and format characters', () => {
    expect(hookLabel(['/x/no\u0007ti\u001bfy.sh'])).toBe('notify.sh');
    expect(hookLabel(['/x/\u202Enotify.sh\u2066'])).toBe('notify.sh');
    expect(hookLabel('bash ./scripts/no\u0000tify.sh')).toBe('notify.sh');
  });

  it(`cuts a label longer than ${MAX_HOOK_LABEL_LENGTH} characters and ends it in an ellipsis`, () => {
    const label = hookLabel(`bash ./${'n'.repeat(80)}.sh`);
    expect([...label]).toHaveLength(MAX_HOOK_LABEL_LENGTH);
    expect(label.endsWith('…')).toBe(true);
    expect(hookLabel(`bash ./${'n'.repeat(MAX_HOOK_LABEL_LENGTH - 3)}.sh`)).toBe(`${'n'.repeat(MAX_HOOK_LABEL_LENGTH - 3)}.sh`);
  });
});

describe('the running-hook registry', () => {
  const hook = (command: string, scope: ConfiguredHook['scope'] = 'project'): ConfiguredHook => ({ command, scope });

  it('holds each hook under its session until its release, and tells listeners of each change', () => {
    const changes: string[] = [];
    const unwatch = onRunningHooksChange((sessionId) => changes.push(sessionId));
    const first = trackRunningHook('s-a', hook('bash ./notify.sh', 'user'));
    const second = trackRunningHook('s-a', hook('bash ./notify.sh'));
    const other = trackRunningHook('s-b', hook('./other.sh'));

    expect(runningHooks('s-a')).toEqual([{ label: 'notify.sh', scope: 'user' }, { label: 'notify.sh', scope: 'project' }]);
    expect(runningHooks('s-b')).toEqual([{ label: 'other.sh', scope: 'project' }]);

    first();
    first();
    expect(runningHooks('s-a')).toEqual([{ label: 'notify.sh', scope: 'project' }]);
    second();
    other();
    expect(runningHooks('s-a')).toEqual([]);
    expect(runningHooks('s-b')).toEqual([]);
    expect(changes).toEqual(['s-a', 's-a', 's-b', 's-a', 's-a', 's-b']);
    unwatch();
  });
});

describe('a Stop hook dispatch', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A Stop hook `node <dir>/scripts/notify.js` that runs until the returned release. */
  function heldHook(scope: ConfiguredHook['scope']): { entry: ConfiguredHook; release: () => void } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-running-hook-')));
    made.push(dir);
    const releaseFile = path.join(dir, 'release');
    const script = path.join(dir, 'scripts', 'notify.js');
    fs.mkdirSync(path.dirname(script));
    fs.writeFileSync(script, `const timer = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(releaseFile)})) clearInterval(timer); }, 50);\n`);
    return { entry: { command: [process.execPath, script, `--token=${SECRET}`], scope }, release: () => fs.writeFileSync(releaseFile, '') };
  }

  const configOf = (entries: Record<string, ConfiguredHook[]>): HooksConfigService => ({
    getEntries: (key: string) => entries[key] ?? [],
    hasEntries: (key: string) => (entries[key] ?? []).length > 0,
  }) as unknown as HooksConfigService;

  it('tracks each hook as running for the session it names until that hook ends', async () => {
    const held = heldHook('project');
    const deps: DispatchDeps = { config: configOf({ agent_end: [held.entry] }), workspaceRoot: process.cwd(), userHome: os.homedir() };
    const done = dispatchObserveOnly(deps, 'agent_end', process.cwd(), {}, undefined, 'stop-session');

    expect(runningHooks('stop-session')).toEqual([{ label: 'notify.js', scope: 'project' }]);
    held.release();
    await done;
    expect(runningHooks('stop-session')).toEqual([]);
  }, 20_000);

  it('tracks nothing without a session id', async () => {
    const held = heldHook('user');
    const deps: DispatchDeps = { config: configOf({ session_start: [held.entry] }), workspaceRoot: process.cwd(), userHome: os.homedir() };
    const changed = vi.fn();
    const unwatch = onRunningHooksChange(changed);
    held.release();
    await dispatchObserveOnly(deps, 'session_start', process.cwd(), {});
    unwatch();
    expect(changed).not.toHaveBeenCalled();
  }, 20_000);

  it("is tracked under the session pi's agent_settled names, by the configured Stop hooks", async () => {
    const held = heldHook('user');
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = { on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(event, handler); return () => {}; } };
    registerConfiguredHooks(pi as never, {
      dispatch: { config: configOf({ agent_end: [held.entry] }), workspaceRoot: process.cwd(), userHome: os.homedir() },
      registry: { get: () => ({ postMessage: () => {} }) },
    });
    const ctx = {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => 'main-session', getSessionFile: () => '/t.jsonl', buildSessionProjection: () => ({ messages: [] }) },
    };

    const settled = handlers.get('agent_settled')!({ type: 'agent_settled' }, ctx);
    expect(runningHooks('main-session')).toEqual([{ label: 'notify.js', scope: 'user' }]);
    held.release();
    await settled;
    expect(runningHooks('main-session')).toEqual([]);
  }, 20_000);
});
