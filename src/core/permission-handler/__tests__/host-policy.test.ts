import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { agentSocketPath, asClient, bypassAllowed, runPinnedTurn } from '../../client-snapshots';
import { PermissionHandler } from '../index';
import type { ClientPolicy } from '../../../shared/remote-user';

// Two devices attached to one daemon's core, each with its own host store's policy for this host.
function twoDevices(laptop: ClientPolicy, desktop: ClientPolicy, settings: Record<string, unknown> = {}) {
  const host = createFakeRemoteHost();
  host.set('clientPolicy', 'laptop', laptop);
  host.set('clientPolicy', 'desktop', desktop);
  host.setActing('laptop');
  const platform = { ...createFakePlatform({ settings: { project: settings } }), remote: host.remote };
  return { host, platform };
}

const cwd = os.tmpdir();
const edit = { file_path: path.join(cwd, 'a.ts'), old_string: 'a', new_string: 'b' };

describe('the host\'s configured policy on a daemon\'s core, per issuing client', () => {
  it('starts a new chat in the default mode the acting client configured for the host, else the settings\' default', () => {
    const { host, platform } = twoDevices({ voice: true, allowBypass: false, defaultPermissionMode: 'plan' }, { voice: true, allowBypass: false }, { 'damocles.permissionMode': 'acceptEdits' });
    expect(new PermissionHandler(platform).getPermissionMode()).toBe('plan');
    host.setActing('desktop');
    expect(new PermissionHandler(platform).getPermissionMode()).toBe('acceptEdits');
  });

  it('refuses YOLO from the client whose policy refuses it, and takes it from the one that allows it', () => {
    const { host, platform } = twoDevices({ voice: true, allowBypass: false }, { voice: true, allowBypass: true });
    const handler = new PermissionHandler(platform);
    // a forged setPermissionMode to bypass from the laptop
    expect(handler.setDangerouslySkipPermissions(true)).toBe(false);
    expect(handler.getDangerouslySkipPermissions()).toBe(false);
    host.setActing('desktop');
    expect(handler.setDangerouslySkipPermissions(true)).toBe(true);
  });

  it('runs a YOLO panel\'s turn for a client whose policy refuses bypass in that client\'s default mode for the host', async () => {
    const { host, platform } = twoDevices({ voice: true, allowBypass: false, defaultPermissionMode: 'acceptEdits' }, { voice: true, allowBypass: true });
    host.setActing('desktop');
    const handler = new PermissionHandler(platform);
    handler.setCwd(cwd);
    handler.setPermissionMode('default');
    expect(handler.setDangerouslySkipPermissions(true)).toBe(true);
    // the desktop's own turn runs in YOLO
    expect(await runPinnedTurn(host.remote, 'p1', () => handler.decide('Bash', { command: 'make' }, null))).toBe('allow');
    host.setActing('laptop');
    const laptopTurn = runPinnedTurn(host.remote, 'p1', async () => {
      // the desktop acting mid-run never changes the laptop turn's pinned policy
      host.setActing('desktop');
      return [handler.decide('Edit', edit, null), handler.decide('Bash', { command: 'make' }, null)];
    });
    expect(await laptopTurn).toEqual(['allow', 'ask']);
  });

  it('a refused YOLO with no default mode configured runs in the panel\'s own mode', async () => {
    const { host, platform } = twoDevices({ voice: true, allowBypass: false }, { voice: true, allowBypass: true });
    host.setActing('desktop');
    const handler = new PermissionHandler(platform);
    handler.setCwd(cwd);
    handler.setPermissionMode('default');
    handler.setDangerouslySkipPermissions(true);
    host.setActing('laptop');
    expect(await runPinnedTurn(host.remote, 'p1', () => handler.decide('Edit', edit, null))).toBe('ask');
  });

  it('runs a refused YOLO turn in plan mode when that is the client\'s default for the host, for every plan mode check', async () => {
    const { host, platform } = twoDevices({ voice: true, allowBypass: false, defaultPermissionMode: 'plan' }, { voice: true, allowBypass: true });
    host.setActing('desktop');
    const handler = new PermissionHandler(platform);
    handler.setCwd(cwd);
    handler.setPermissionMode('default');
    handler.setDangerouslySkipPermissions(true);
    expect(await runPinnedTurn(host.remote, 'p1', () => handler.turnPermissionMode())).toBe('default');
    host.setActing('laptop');
    expect(await runPinnedTurn(host.remote, 'p1', () => handler.turnPermissionMode())).toBe('plan');
    // the chat itself keeps its mode and YOLO
    expect(handler.getPermissionMode()).toBe('default');
  });

  it('reads YOLO for each viewing device from that device\'s policy, whoever acts', () => {
    const { host, platform } = twoDevices({ voice: true, allowBypass: false }, { voice: true, allowBypass: true });
    host.setActing('desktop');
    expect(asClient(host.remote, 'laptop', () => bypassAllowed(platform))).toBe(false);
    expect(asClient(host.remote, 'desktop', () => bypassAllowed(platform))).toBe(true);
  });

  it('gives a spawned process the pinned client\'s own agent socket, only while that client forwards its agent', async () => {
    const { host, platform } = twoDevices({ voice: true, allowBypass: false, agentForwarding: true }, { voice: true, allowBypass: false, agentForwarding: true });
    // a daemon that runs no proxy (Windows) has none
    expect(agentSocketPath(platform)).toBeUndefined();
    host.setAgentFolder('/run/user/1000/damocles-x');
    expect(agentSocketPath(platform)).toBe('/run/user/1000/damocles-x/agent-of-laptop.sock');
    host.setActing('desktop');
    expect(agentSocketPath(platform)).toBe('/run/user/1000/damocles-x/agent-of-desktop.sock');
    // a turn the laptop started keeps the laptop's socket while the desktop acts, so the desktop's agent never signs for it
    host.setActing('laptop');
    expect(await runPinnedTurn(host.remote, 'p1', async () => {
      host.setActing('desktop');
      return agentSocketPath(platform);
    })).toBe('/run/user/1000/damocles-x/agent-of-laptop.sock');
    host.set('clientPolicy', 'desktop', { voice: true, allowBypass: false });
    expect(agentSocketPath(platform)).toBeUndefined();
    // this computer's own core has none
    expect(agentSocketPath({})).toBeUndefined();
  });
});
