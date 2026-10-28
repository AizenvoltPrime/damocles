import type { TestInfo } from '@playwright/test';
import { attachDiagnostics, launchDesktop, type DesktopApp } from '../../desktop/support/app';
import { createHermeticHome, type HermeticHome } from '../../desktop/support/hermetic';
import type { ReleaseMirror } from './release-mirror';
import { remoteEnv } from './remote';
import { attachChatPages } from './remote-runs';
import { sshClientHome, type SshClientHome, type SshdFixture } from './sshd';

/**
 * Another computer attached to the same target account: an app instance with its own home, userData (so its own client id),
 * ~/.ssh key and known_hosts. e2e/desktop/support/second-process.ts hosts a headless core on the first instance's HOME and
 * has no SSH client, so a device is a second Electron launch.
 */
export interface SecondDevice {
  readonly home: HermeticHome;
  readonly ssh: SshClientHome;
  launch(env?: Record<string, string>): Promise<DesktopApp>;
  /** Closes every launch, attaches their logs when the test failed (`failed`) or a close did, then removes the home. */
  dispose(testInfo: TestInfo, failed: boolean): Promise<void>;
}

export async function secondDevice(fixture: SshdFixture, alias: string, mirror: Pick<ReleaseMirror, 'url'>): Promise<SecondDevice> {
  const home = createHermeticHome();
  const ssh = await sshClientHome(home);
  await fixture.authorize(ssh.publicKey);
  ssh.addHost(alias, fixture);
  await ssh.trust(fixture);
  const launched: DesktopApp[] = [];
  return {
    home,
    ssh,
    launch: async (env = {}) => {
      const desktop = await launchDesktop(home, { env: { ...remoteEnv(ssh, mirror), ...env } });
      launched.push(desktop);
      return desktop;
    },
    dispose: async (testInfo, failed) => {
      let closeError: { error: unknown } | undefined;
      // a launch the test closed already has no open page
      if (failed) for (const [index, desktop] of launched.entries()) await attachChatPages(testInfo, `device-2-launch-${index}`, desktop.app);
      for (const desktop of launched) {
        await desktop.close().catch((error: unknown) => {
          closeError ??= { error };
        });
      }
      // once every launch closed, as the fixture does: the launches share userData's logs
      if (closeError || failed) {
        for (const [index, desktop] of launched.entries()) await attachDiagnostics(testInfo, `device-2-launch-${index}`, desktop, home);
      }
      await home.dispose();
      if (closeError) throw closeError.error;
    },
  };
}
