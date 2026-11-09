import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_PREVIEW_SCREEN_FEATURE, designScreenAuthority, isDesignScreenPath } from '../design/design-screen-path';

describe('isDesignScreenPath', () => {
  it("names a screen of a designs folder in the host's path rules, below a home reached through a link too", () => {
    expect(isDesignScreenPath(path.posix, '/home/a/.damocles/designs/d-1234/screens/S2-home.html')).toBe(true);
    // Fedora Atomic's /home is a link to /var/home, so the file's real path names the other spelling
    expect(isDesignScreenPath(path.posix, '/var/home/a/.damocles/designs/d-1234/screens/S2.HTML')).toBe(true);
    expect(isDesignScreenPath(path.win32, 'c:\\users\\A\\.Damocles\\Designs\\d-1234\\screens\\S2.html')).toBe(true);
  });

  it('refuses every other file of a design, a folder of another name, a case POSIX tells apart and a Windows-unsafe name', () => {
    expect(isDesignScreenPath(path.posix, '/home/a/.damocles/designs/d-1234/design.md')).toBe(false);
    expect(isDesignScreenPath(path.posix, '/home/a/.damocles/designs/d-1234/screens/x/S2.html')).toBe(false);
    expect(isDesignScreenPath(path.posix, '/home/a/.damocles/designs/.state/screens/S2.html')).toBe(false);
    expect(isDesignScreenPath(path.posix, '/home/a/.damocles/plans/d-1234/screens/S2.html')).toBe(false);
    expect(isDesignScreenPath(path.posix, '/home/a/.Damocles/designs/d-1234/screens/S2.html')).toBe(false);
    expect(isDesignScreenPath(path.posix, '/home/a/.damocles/designs/d-1234/Screens/S2.html')).toBe(false);
    expect(isDesignScreenPath(path.posix, '/home/a/.damocles/designs/d-1234/screens/aux.html')).toBe(false);
    expect(isDesignScreenPath(path.posix, '.damocles/designs/d-1234/screens/S2.html')).toBe(false);
  });
});

describe('designScreenAuthority', () => {
  const screen = '/home/a/.damocles/designs/d-1234/screens/S1.html';
  const hosts = (features: Record<string, readonly string[]>) => ({
    features: (authority: string) => features[authority],
    osOf: (authority: string): NodeJS.Platform | undefined => (authority === 'local' ? 'win32' : authority in features ? 'linux' : undefined),
  });

  it("offers a remote screen only while its host's server serves design.previewScreen", () => {
    const current = hosts({ 'ssh:box': ['design.read', DESIGN_PREVIEW_SCREEN_FEATURE] });
    expect(designScreenAuthority({ path: screen, host: 'ssh:box' }, current)).toBe('ssh:box');
    expect(designScreenAuthority({ path: screen, host: 'ssh:box' }, hosts({ 'ssh:box': ['design.read'] }))).toBeUndefined();
    // not connected: no features, so no offer until it reconnects and publishes again
    expect(designScreenAuthority({ path: screen, host: 'ssh:box' }, hosts({}))).toBeUndefined();
  });

  it("reads this computer's screens in its own path rules, needing no feature", () => {
    expect(designScreenAuthority({ path: 'C:\\Users\\a\\.damocles\\designs\\d-1234\\screens\\S1.html' }, hosts({}))).toBe('local');
    expect(designScreenAuthority({ path: 'C:\\Users\\a\\.damocles\\screens\\S1.html' }, hosts({}))).toBeUndefined();
  });
});
