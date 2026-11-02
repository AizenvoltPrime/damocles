import { describe, expect, it, vi } from 'vitest';
import type { CliPath } from '../cli-path';
import { cliPathActions } from '../cli-path-actions';
import type { NoticeSeverity } from '../../preload/notifications';

function setup(platform: 'win32' | 'darwin', cliPath: Partial<CliPath>) {
  const notices: Array<[NoticeSeverity, string]> = [];
  const actions = cliPathActions({
    cliPath: cliPath as CliPath,
    platform,
    t: (message, ...args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message),
    notice: (severity, message) => notices.push([severity, message]),
    log: () => undefined,
  });
  return { actions, notices };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('cliPathActions', () => {
  it('adds and removes on Windows as the user\'s own choice, telling what PATH holds now', async () => {
    const add = vi.fn(async () => 'added' as const);
    const remove = vi.fn(async () => 'notPresent' as const);
    const { actions, notices } = setup('win32', { add, remove });
    actions.install();
    actions.uninstall();
    await settle();
    expect(add).toHaveBeenCalledWith('user');
    expect(remove).toHaveBeenCalledWith('user');
    expect(notices).toEqual([
      ['info', 'The \'damocles\' command is on your PATH. Open a new terminal and run damocles . in any folder, or in WSL.'],
      ['info', 'The \'damocles\' command was not on your PATH.'],
    ]);
  });

  it('installs and uninstalls the macOS link, warns about a link that is not Damocles\' and says nothing for a cancelled prompt', async () => {
    const install = vi.fn(async () => 'cancelled' as const);
    const uninstall = vi.fn(async () => 'notOurs' as const);
    const { actions, notices } = setup('darwin', { install, uninstall });
    actions.install();
    actions.uninstall();
    await settle();
    expect(notices).toEqual([['warning', '/usr/local/bin/damocles belongs to another program, so Damocles left it in place.']]);
  });

  it('shows a failure with its reason', async () => {
    const { actions, notices } = setup('win32', { add: async () => { throw new Error('RegSetValueExW failed: 5'); } });
    actions.install();
    await settle();
    expect(notices).toEqual([['error', 'Damocles could not change the \'damocles\' command: RegSetValueExW failed: 5']]);
  });
});
