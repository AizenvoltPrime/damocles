import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetHostData, type ForgetHostDataSteps } from '../forget-host-data';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-forget-host-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// A host's session mirror and browser profile on disk, and every other step recorded.
function steps(overrides: Partial<ForgetHostDataSteps> = {}) {
  const mirrorFolder = path.join(root, 'remote', 'h1');
  const profileFolder = path.join(root, 'browser-profiles', 'ssh+h1');
  for (const folder of [mirrorFolder, profileFolder]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'data'), 'x');
  }
  const ran: string[] = [];
  const record = (name: string) => vi.fn(async () => void ran.push(name));
  const all: ForgetHostDataSteps = {
    dropEngine: record('engine'),
    exitControlMaster: record('master'),
    mirrorIdle: record('mirror'),
    mirrorFolder,
    forgetPorts: vi.fn(() => void ran.push('ports')),
    engineHalted: () => false,
    releaseBrowser: record('browser'),
    profileFolder,
    forgetChats: vi.fn(() => void ran.push('chats')),
    forgetRemoteState: record('state'),
    log: () => undefined,
    ...overrides,
  };
  return { all, ran, mirrorFolder, profileFolder };
}

describe('forgetHostData', () => {
  it('removes the profile folder without asking a halted engine, which holds no browser context and refuses every request', async () => {
    const releaseBrowser = vi.fn(() => Promise.reject(new Error('The Damocles engine is not running')));
    const { all, ran, mirrorFolder, profileFolder } = steps({ engineHalted: () => true, releaseBrowser });
    await forgetHostData(all);
    expect(releaseBrowser).not.toHaveBeenCalled();
    expect(fs.existsSync(mirrorFolder)).toBe(false);
    expect(fs.existsSync(profileFolder)).toBe(false);
    expect(ran).toEqual(['engine', 'master', 'mirror', 'ports', 'chats', 'state']);
  });

  it('releases the browser context of a running engine before its profile goes', async () => {
    let profileAtRelease: boolean | undefined;
    const { all, profileFolder } = steps({ releaseBrowser: async () => void (profileAtRelease = fs.existsSync(profileFolder)) });
    await forgetHostData(all);
    expect(profileAtRelease).toBe(true);
    expect(fs.existsSync(profileFolder)).toBe(false);
  });

  it('runs every step after a failed one and throws the first failure, logging each', async () => {
    const log = vi.fn();
    const { all, ran, mirrorFolder, profileFolder } = steps({
      exitControlMaster: () => Promise.reject(new Error('master gone')),
      forgetPorts: () => {
        throw new Error('ports');
      },
      log,
    });
    await expect(forgetHostData(all)).rejects.toThrow('master gone');
    expect(ran).toEqual(['engine', 'mirror', 'browser', 'chats', 'state']);
    expect(fs.existsSync(mirrorFolder)).toBe(false);
    expect(fs.existsSync(profileFolder)).toBe(false);
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([expect.stringContaining('master gone'), expect.stringContaining('ports')]);
  });

  it('keeps the profile a context it could not release still holds, and the mirror folder a sync may still write', async () => {
    const { all, ran, mirrorFolder, profileFolder } = steps({
      mirrorIdle: () => Promise.reject(new Error('sync')),
      releaseBrowser: () => Promise.reject(new Error('core crashed')),
    });
    await expect(forgetHostData(all)).rejects.toThrow('sync');
    expect(fs.existsSync(mirrorFolder)).toBe(true);
    expect(fs.existsSync(profileFolder)).toBe(true);
    expect(ran).toEqual(['engine', 'master', 'ports', 'chats', 'state']);
  });
});
