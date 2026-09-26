import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { DAMOCLES_HOME_DIR } from '../paths';

describe('hermetic test home', () => {
  it('resolves DAMOCLES_HOME_DIR inside a fresh per-file temp home', () => {
    const home = path.resolve(os.homedir());
    expect(home.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase())).toBe(true);
    expect(path.basename(home)).toMatch(/^home-/);
    expect(path.basename(path.dirname(home))).toMatch(/^damocles-test-homes-/);
    expect(path.resolve(DAMOCLES_HOME_DIR)).toBe(path.join(home, '.damocles'));
  });
});
