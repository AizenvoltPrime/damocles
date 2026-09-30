import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showMessageBox = vi.fn();
vi.mock('electron', () => ({ dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) } }));

import { DONT_TRUST_BUTTON, TRUST_BUTTON, TRUST_FILE, TrustStore } from '../trust-store';

let userData: string;
let project: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-trust-'));
  project = path.join(userData, 'workspace', 'project');
  fs.mkdirSync(path.join(project, 'packages', 'child'), { recursive: true });
  showMessageBox.mockReset();
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const store = (): TrustStore => new TrustStore(userData, () => undefined, (message) => message, () => undefined);

describe('TrustStore', () => {
  it('trusts a folder only by exact match: not its parent, not its children', async () => {
    const trust = store();
    await trust.grant(project);
    expect(trust.isTrusted(project)).toBe(true);
    expect(trust.isTrusted(`${project}${path.sep}`)).toBe(true);
    expect(trust.isTrusted(path.join(project, 'packages', 'child'))).toBe(false);
    expect(trust.isTrusted(path.dirname(project))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('matches case-insensitively on Windows, as folderKey does', async () => {
    const trust = store();
    await trust.grant(project);
    expect(trust.isTrusted(project.toUpperCase())).toBe(true);
  });

  it('persists grants across instances under userData with a schema version', async () => {
    await store().grant(project);
    const saved = JSON.parse(fs.readFileSync(path.join(userData, TRUST_FILE), 'utf8'));
    expect(saved).toEqual({ version: 1, folders: [project] });
    expect(store().isTrusted(project)).toBe(true);
  });

  it('trusts nothing from an unreadable or foreign allowlist', () => {
    fs.writeFileSync(path.join(userData, TRUST_FILE), '{ nope');
    expect(store().isTrusted(project)).toBe(false);
    fs.writeFileSync(path.join(userData, TRUST_FILE), JSON.stringify({ version: 99, folders: [project] }));
    expect(store().isTrusted(project)).toBe(false);
    fs.writeFileSync(path.join(userData, TRUST_FILE), JSON.stringify({ version: 1, folders: ['relative/path', 7] }));
    expect(store().isTrusted('relative/path')).toBe(false);
  });

  it('grants through the dialog, fires onDidGrant with that folder, and asks once for concurrent requests', async () => {
    showMessageBox.mockResolvedValue({ response: TRUST_BUTTON, checkboxChecked: false });
    const trust = store();
    const granted: Array<readonly string[]> = [];
    trust.onDidGrant((folders) => granted.push(folders));
    const [first, second] = await Promise.all([trust.requestTrust(project), trust.requestTrust(project)]);
    expect([first, second]).toEqual([true, true]);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(granted).toEqual([[project]]);
    expect(await trust.requestTrust(project)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('leaves the folder untrusted when declined and persists nothing', async () => {
    showMessageBox.mockResolvedValue({ response: DONT_TRUST_BUTTON, checkboxChecked: false });
    const trust = store();
    const listener = vi.fn();
    trust.onDidGrant(listener);
    expect(await trust.requestTrust(project)).toBe(false);
    expect(trust.isTrusted(project)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(userData, TRUST_FILE))).toBe(false);
  });
  // A folder trusted in memory but not on disk would never fire the grant and would be untrusted after a restart.
  it('leaves the folder untrusted and fires nothing when the allowlist write fails, so a retry grants it', async () => {
    const trust = store();
    const listener = vi.fn();
    trust.onDidGrant(listener);
    fs.mkdirSync(path.join(userData, TRUST_FILE));
    await expect(trust.grant(project)).rejects.toThrow();
    expect(trust.isTrusted(project)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    fs.rmdirSync(path.join(userData, TRUST_FILE));
    await trust.grant(project);
    expect(trust.isTrusted(project)).toBe(true);
    expect(listener).toHaveBeenCalledWith([project]);
    expect(store().isTrusted(project)).toBe(true);
  });
});
