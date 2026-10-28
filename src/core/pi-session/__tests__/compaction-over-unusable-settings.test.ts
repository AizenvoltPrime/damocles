import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionOptions } from '../../session-types';
import { PiSession } from '../pi-session';
import { PiRuntime } from '../pi-runtime';
import { initPiLoader } from '../pi-loader';
import { installFakePlatform } from '../../../__mocks__/fake-platform';

/**
 * A panel session over an agent `settings.json` pi cannot load keeps auto-compaction off (B3), which then holds
 * only in pi's memory, and keeps it off after pi re-reads the file once it is fixed.
 */
describe('auto-compaction over an unusable agent settings file', () => {
  const made: string[] = [];
  const sessions: PiSession[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  beforeAll(async () => {
    if (!(await initPiLoader())) throw new Error('pi failed to load');
  }, 60_000);

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.dispose();
    await PiRuntime.disposeInstance();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stays off at bind and after a loader reload of the file fixed meanwhile', async () => {
    const platform = installFakePlatform();
    const workspace = tempDir('damocles-settings-ws-');
    const agentDir = tempDir('damocles-settings-agent-');
    const settingsFile = path.join(agentDir, 'settings.json');
    const broken = '{ "compaction": ';
    fs.writeFileSync(settingsFile, broken);
    PiRuntime.get(agentDir);

    const session = new PiSession({
      cwd: workspace,
      settingsFolder: undefined,
      projectScope: true,
      platform,
      permissionHandler: { getPermissionMode: () => 'default', turnPermissionMode: () => 'default', setPermissionRequiredNotifier: () => {}, setPlanContentResolver: () => {}, setPendingPromptsListener: () => {}, setPromptOwnerResolver: () => {}, pendingPrompts: () => [] } as unknown as SessionOptions['permissionHandler'],
      onMessage: () => {},
      resolveThinking: () => ({ thinkingDisabled: false, effort: null }),
    });
    sessions.push(session);
    await session.initializeEarly();

    const [folder] = PiRuntime.get().folders();
    const settings = folder!.services.settingsManager;
    expect(settings.getCompactionEnabled()).toBe(false);
    await settings.flush();
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(broken);

    // Fixed with no compaction key, so the file alone would leave pi on its default of on.
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: [] }));
    await folder!.reloadBare();
    expect(settings.getCompactionEnabled()).toBe(false);
    await settings.flush();
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toMatchObject({ packages: [], compaction: { enabled: false } });
  }, 60_000);
});
