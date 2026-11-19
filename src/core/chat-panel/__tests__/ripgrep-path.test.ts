import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { unpackedExecutable } from '../ripgrep';

const rgRelative = path.join('node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');

describe('unpackedExecutable', () => {
  it('moves a binary inside the packaged app.asar to the app.asar.unpacked copy', () => {
    const asar = path.resolve('/opt/Damocles/resources/app.asar');
    const paths = { resourceRoot: asar, unpackedRoot: `${asar}.unpacked` };
    expect(unpackedExecutable(path.join(asar, rgRelative), paths)).toBe(path.join(`${asar}.unpacked`, rgRelative));
  });

  it('leaves the path alone when both roots are the same directory (VS Code, unpackaged desktop)', () => {
    const root = path.resolve('/ext/damocles');
    const file = path.join(root, rgRelative);
    expect(unpackedExecutable(file, { resourceRoot: root, unpackedRoot: root })).toBe(file);
  });

  it('leaves a path outside resourceRoot alone', () => {
    const asar = path.resolve('/opt/Damocles/resources/app.asar');
    const outside = path.resolve('/usr/bin/rg');
    expect(unpackedExecutable(outside, { resourceRoot: asar, unpackedRoot: `${asar}.unpacked` })).toBe(outside);
  });
});
