import { describe, expect, it } from 'vitest';
import { daemonChildEnv } from '../child-env';

const ENV = { PATH: '/usr/bin', HOME: '/home/u', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', electron_lower: 'x', UNSET: undefined };

describe('daemonChildEnv', () => {
  it('gives a forked Node child ELECTRON_RUN_AS_NODE only when the daemon runs under Electron', () => {
    expect(daemonChildEnv('node', ENV, true)).toEqual({ PATH: '/usr/bin', HOME: '/home/u', ELECTRON_RUN_AS_NODE: '1' });
    expect(daemonChildEnv('node', ENV, false)).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
  });

  it('gives a user-facing process no ELECTRON_* variable', () => {
    for (const electron of [true, false]) expect(daemonChildEnv('user', ENV, electron)).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
  });
});
