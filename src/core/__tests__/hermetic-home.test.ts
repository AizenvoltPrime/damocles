import { describe, it, expect, inject } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { DAMOCLES_HOME_DIR } from '../paths';

describe('hermetic test home', () => {
  it('resolves DAMOCLES_HOME_DIR and os.tmpdir() inside the per-run test root', () => {
    const runRoot = path.resolve(inject('testHomeRoot')).toLowerCase();
    const home = path.resolve(os.homedir());
    expect(home.toLowerCase().startsWith(runRoot)).toBe(true);
    expect(path.resolve(os.tmpdir()).toLowerCase().startsWith(runRoot)).toBe(true);
    expect(path.basename(home)).toMatch(/^h-/);
    expect(path.basename(path.dirname(home))).toMatch(/^dth-/);
    expect(path.resolve(DAMOCLES_HOME_DIR)).toBe(path.join(home, '.damocles'));
  });
});
