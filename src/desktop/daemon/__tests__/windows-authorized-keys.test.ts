import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunOutput, SpawnSpec } from '../../../core/process-launcher';
import { ADMINISTRATORS_SID, csvSids, icaclsRuns, installAuthorizedKey, SYSTEM_SID, windowsKeysFile } from '../authorized-keys';

const KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)} damocles@laptop`;
const USER_SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
// a Microsoft Entra ID account's SID
const ENTRA_SID = 'S-1-12-1-3627502487-1290264359-2862409915-1855531393';
// whoami's CSV with the localized group names it prints on a German system
const ADMIN_GROUPS = `"Jeder","Bekannte Gruppe","S-1-1-0","Obligatorische Gruppe"\r\n"VORDEFINIERT\\Administratoren","Alias","${ADMINISTRATORS_SID}","Obligatorische Gruppe, Gruppe aktiviert"\r\n`;
const USER_GROUPS = `"Jeder","Bekannte Gruppe","S-1-1-0","Obligatorische Gruppe"\r\n"VORDEFINIERT\\Benutzer","Alias","S-1-5-32-545","Obligatorische Gruppe"\r\n`;
const userLine = (sid: string): string => `"host\\dev","${sid}"\r\n`;

const output = (stdout: string, code = 0): RunOutput => ({ exit: { code, signal: null }, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });

describe('the Windows authorized keys file and its ACL', () => {
  it('reads SIDs from whoami\'s CSV whatever the group names\' language', () => {
    expect(csvSids(ADMIN_GROUPS)).toEqual(['S-1-1-0', ADMINISTRATORS_SID]);
    expect(csvSids(userLine(USER_SID))).toEqual([USER_SID]);
  });

  it('chooses administrators_authorized_keys under a local absolute ProgramData for an administrator, the profile\'s file for anyone else', () => {
    expect(windowsKeysFile(true, { ProgramData: 'D:\\ProgramData' }, 'C:\\Users\\dev')).toBe('D:\\ProgramData\\ssh\\administrators_authorized_keys');
    for (const ProgramData of ['relative', '\\ProgramData', '\\\\host\\share\\ProgramData']) {
      expect(windowsKeysFile(true, { ProgramData }, 'C:\\Users\\dev'), ProgramData).toBe('C:\\ProgramData\\ssh\\administrators_authorized_keys');
    }
    expect(windowsKeysFile(false, { ProgramData: 'D:\\ProgramData' }, 'C:\\Users\\dev')).toBe('C:\\Users\\dev\\.ssh\\authorized_keys');
  });

  it('resets the ACL, makes Administrators own administrators_authorized_keys, then grants full control by SID only', () => {
    const file = 'C:\\ProgramData\\ssh\\administrators_authorized_keys';
    expect(icaclsRuns(file, { admin: true })).toEqual([
      [file, '/reset'],
      [file, '/setowner', '*S-1-5-32-544'],
      [file, '/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '/grant:r', '*S-1-5-18:F'],
    ]);
    expect(icaclsRuns('C:\\Users\\dev\\.ssh\\authorized_keys', { admin: false, userSid: USER_SID })).toEqual([
      ['C:\\Users\\dev\\.ssh\\authorized_keys', '/reset'],
      ['C:\\Users\\dev\\.ssh\\authorized_keys', '/inheritance:r', '/grant:r', `*${USER_SID}:F`, '/grant:r', `*${SYSTEM_SID}:F`],
    ]);
  });
});

describe.runIf(process.platform === 'win32')('installAuthorizedKey on Windows', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });

  interface Answers {
    readonly groups?: RunOutput | Error;
    readonly user?: RunOutput | Error;
    readonly icaclsCode?: number;
  }

  async function windowsTarget(answers: Answers) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-keys-'));
    roots.push(root);
    const run = vi.fn(async (spec: SpawnSpec, _options: { readonly timeoutMs: number }): Promise<RunOutput> => {
      if (spec.file.toLowerCase().endsWith('whoami.exe')) {
        const answer = spec.args.includes('/groups') ? (answers.groups ?? output(ADMIN_GROUPS)) : (answers.user ?? output(userLine(USER_SID)));
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return output('', answers.icaclsCode ?? 0);
    });
    const env = { SystemRoot: 'C:\\Windows', ProgramData: path.join(root, 'ProgramData') };
    const log = vi.fn();
    const deps = { platform: 'win32' as const, homedir: path.join(root, 'home'), env, uid: undefined, run, restorecon: async () => undefined, log };
    const whoamiArgs = () => run.mock.calls.map(([spec]) => spec).filter((spec) => spec.file.toLowerCase().endsWith('whoami.exe')).map((spec) => spec.args[0]);
    const icacls = () => run.mock.calls.map(([spec]) => spec).filter((spec) => spec.file.toLowerCase().endsWith('icacls.exe'));
    return { root, run, log, deps, whoamiArgs, icacls };
  }

  it('writes administrators_authorized_keys for an administrator and restricts it through icacls at its absolute path, asking no user SID', async () => {
    const { root, deps, whoamiArgs, icacls } = await windowsTarget({ user: output('"host\\dev","no sid"\r\n') });
    const file = path.join(root, 'ProgramData', 'ssh', 'administrators_authorized_keys');
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'installed', path: file });
    expect(await fs.readFile(file, 'utf8')).toBe(`${KEY}\r\n`);
    expect(whoamiArgs()).toEqual(['/groups']);
    expect(icacls().map((spec) => spec.file)).toEqual(Array(3).fill('C:\\Windows\\System32\\icacls.exe'));
    expect(icacls().map((spec) => spec.args)).toEqual(icaclsRuns(file, { admin: true }));
  });

  it('writes the profile\'s authorized_keys for any other user, with an ACL of that user and SYSTEM, an Entra ID account included', async () => {
    for (const sid of [USER_SID, ENTRA_SID]) {
      const { root, deps, icacls } = await windowsTarget({ groups: output(USER_GROUPS), user: output(userLine(sid)) });
      const file = path.join(root, 'home', '.ssh', 'authorized_keys');
      expect(await installAuthorizedKey(KEY, deps), sid).toEqual({ result: 'installed', path: file });
      expect(icacls().map((spec) => spec.args)).toEqual(icaclsRuns(file, { admin: false, userSid: sid }));
    }
  });

  it('resets the ACL of a file that already holds the key', async () => {
    const { root, deps, icacls } = await windowsTarget({});
    const file = path.join(root, 'ProgramData', 'ssh', 'administrators_authorized_keys');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${KEY}\r\n`);
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'present', path: file });
    expect(icacls().map((spec) => spec.args)).toEqual(icaclsRuns(file, { admin: true }));
  });

  it('reports aclFailed when icacls fails or cannot start', async () => {
    const { root, deps } = await windowsTarget({ icaclsCode: 5 });
    const file = path.join(root, 'ProgramData', 'ssh', 'administrators_authorized_keys');
    expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'failed', code: 'aclFailed', path: file });
    const unstarted = await windowsTarget({});
    unstarted.run.mockImplementation(async (spec) => {
      if (spec.file.toLowerCase().endsWith('icacls.exe')) throw new Error('spawn EPERM');
      return output(ADMIN_GROUPS);
    });
    expect(await installAuthorizedKey(KEY, unstarted.deps)).toEqual({ result: 'failed', code: 'aclFailed', path: path.join(unstarted.root, 'ProgramData', 'ssh', 'administrators_authorized_keys') });
    expect(unstarted.log).toHaveBeenCalledWith(expect.stringContaining('did not start: spawn EPERM'));
  });

  it('reports accountFailed and writes nothing when whoami fails, cannot start or names no user SID', async () => {
    const cases: Answers[] = [
      { groups: output('', 1) },
      { groups: new Error('spawn ENOENT') },
      { groups: output(USER_GROUPS), user: output('', 1) },
      { groups: output(USER_GROUPS), user: output('"host\\dev","no sid"\r\n') },
    ];
    for (const answers of cases) {
      const { root, deps, icacls, log } = await windowsTarget(answers);
      expect(await installAuthorizedKey(KEY, deps)).toEqual({ result: 'failed', code: 'accountFailed', path: '' });
      expect(icacls()).toEqual([]);
      await expect(fs.readdir(root)).resolves.toEqual([]);
      expect(log).toHaveBeenCalled();
    }
  });
});
