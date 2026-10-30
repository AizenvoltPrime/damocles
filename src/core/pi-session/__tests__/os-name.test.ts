import { describe, expect, it } from 'vitest';
import { productOsName, type OsNameInputs } from '../os-name';

const on = (over: Partial<OsNameInputs>): string =>
  productOsName({ platform: 'linux', release: '6.8.0-45-generic', type: 'Linux', osRelease: undefined, ...over });

describe('the OS name the environment section states', () => {
  it('names Windows 11 from build 22000, Windows 10 before it, and an older Windows by its version', () => {
    expect(on({ platform: 'win32', release: '10.0.26100', type: 'Windows_NT' })).toBe('Windows 11');
    expect(on({ platform: 'win32', release: '10.0.22000', type: 'Windows_NT' })).toBe('Windows 11');
    expect(on({ platform: 'win32', release: '10.0.19045', type: 'Windows_NT' })).toBe('Windows 10');
    expect(on({ platform: 'win32', release: '6.3.9600', type: 'Windows_NT' })).toBe('Windows 6.3');
  });

  it('keeps the name through a Windows cumulative update, which changes only the build', () => {
    expect(on({ platform: 'win32', release: '10.0.26100' })).toBe(on({ platform: 'win32', release: '10.0.26200' }));
  });

  it('names macOS by the Darwin major, macOS 26 Tahoe being Darwin 25', () => {
    const named = [20, 21, 22, 23, 24, 25].map((darwin) => on({ platform: 'darwin', release: `${darwin}.1.0`, type: 'Darwin' }));
    expect(named).toEqual(['macOS 11', 'macOS 12', 'macOS 13', 'macOS 14', 'macOS 15', 'macOS 26']);
    // a point release changes the Darwin minor only
    expect(on({ platform: 'darwin', release: '24.6.0' })).toBe('macOS 15');
  });

  it("names a Linux distribution by os-release's NAME and VERSION_ID, whatever the kernel", () => {
    const ubuntu = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n';
    expect(on({ osRelease: ubuntu })).toBe('Ubuntu 24.04');
    expect(on({ osRelease: ubuntu, release: '6.11.0-19-generic' })).toBe('Ubuntu 24.04');
    expect(on({ osRelease: "NAME='Fedora Linux'\r\nVERSION_ID=41\r\n" })).toBe('Fedora Linux 41');
    expect(on({ osRelease: 'NAME="Arch Linux"\nID=arch\n' })).toBe('Arch Linux');
    expect(on({ osRelease: 'NAME="My \\"Distro\\""\nVERSION_ID="1"\n' })).toBe('My "Distro" 1');
  });

  it('names Linux plainly when no os-release file is readable or it names nothing', () => {
    expect(on({ osRelease: undefined })).toBe('Linux');
    expect(on({ osRelease: 'ID=custom\n' })).toBe('Linux');
  });

  it("keeps an os-release value one bounded line, without control or bidi characters", () => {
    expect(on({ osRelease: 'NAME="Ubu\u202entu\u0007"\nVERSION_ID="24.04\u2028x"\n' })).toBe('Ubuntu 24.04 x');
    const named = on({ osRelease: `NAME="${'N'.repeat(500)}"\nVERSION_ID="${'9'.repeat(500)}"\n` });
    expect(named).toBe(`${'N'.repeat(64)} ${'9'.repeat(64)}`);
  });

  it('names any other platform by its kernel type', () => {
    expect(on({ platform: 'freebsd', release: '14.1-RELEASE', type: 'FreeBSD' })).toBe('FreeBSD');
  });
});
