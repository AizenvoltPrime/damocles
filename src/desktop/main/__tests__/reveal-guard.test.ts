import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../local-services/confine';
import { LocalizedError } from '../../../shared/localized-text';
import { revealAllowed, walkingBelow, withRenderedMessage, type RevealGuardDeps } from '../reveal-guard';
import { RETRY_AFTER_MS, RootSpellings } from '../workspace/root-spellings';
import type { OutsideResolution } from '../../workspace/file-system';

const SHARE_PROJECT: Project = { key: '\\\\server\\share\\proj', fsPath: '\\\\server\\share\\proj', name: 'proj' };
const MAPPED: Project = { key: 'z:\\mapped', fsPath: 'Z:\\mapped', name: 'mapped' };

// the outside rule's answers by drive path; any other drive path is a local folder
let outside: Map<string, OutsideResolution>;
// the paths below a root whose walk meets a link to a share, as `<root> <relativePath>`
let shareLinks: Set<string>;
// what was walked: `outside <path>` and `below <root> <relativePath>`
let walked: string[];

async function guard(overrides: Partial<RevealGuardDeps> = {}): Promise<RevealGuardDeps> {
  const spellings = new RootSpellings({ os: 'win32', realpath: async (folder) => (folder === MAPPED.fsPath ? '\\\\nas\\data\\mapped' : folder), log: () => undefined });
  await spellings.retain([SHARE_PROJECT, MAPPED]);
  return {
    os: 'win32',
    roots: [SHARE_PROJECT, MAPPED],
    spellings,
    wslDistros: [],
    resolveOutside: async (target) => {
      walked.push(`outside ${target}`);
      return outside.get(target) ?? { kind: 'folder', path: target };
    },
    walksBelow: async (root, relativePath) => {
      walked.push(`below ${root} ${relativePath}`);
      return ![...shareLinks].some((link) => `${root} ${relativePath}`.startsWith(link));
    },
    ...overrides,
  };
}

beforeEach(() => {
  outside = new Map();
  shareLinks = new Set();
  walked = [];
});

// outsideSegments follows this computer's path rules, so the win32 verdicts need a win32 computer
describe.runIf(process.platform === 'win32')('revealAllowed on win32', () => {
  it('allows a drive path whose walk from its drive leads to no share or device', async () => {
    const deps = await guard();
    for (const allowed of ['C:\\Users\\me\\a.txt', 'D:/work/x', 'C:\\']) expect(await revealAllowed(allowed, deps), allowed).toBe(true);
    expect(walked).toEqual(['outside C:\\Users\\me\\a.txt', 'outside D:/work/x', 'outside C:\\']);
  });

  it('allows a share path a local project holds or is, in any spelling of its folder, and refuses any other share path', async () => {
    const deps = await guard();
    for (const allowed of ['\\\\server\\share\\proj\\a.ts', '\\\\server\\share\\proj', '\\\\SERVER\\Share\\proj\\src', '\\\\nas\\data\\mapped\\a.ts', '\\\\nas\\data\\mapped']) {
      expect(await revealAllowed(allowed, deps), allowed).toBe(true);
    }
    for (const refused of ['\\\\server\\share\\other\\a.ts', '\\\\server\\share', '\\\\evil\\share\\proj\\a.ts', '//server/share/other']) {
      expect(await revealAllowed(refused, deps), refused).toBe('share');
    }
  });

  it('refuses a share path with a part Windows reads as another, before any root holds it', async () => {
    const deps = await guard();
    // Windows reads '.. ' as '..', so Explorer would show \\server\share\x
    for (const refused of ['\\\\server\\share\\proj\\.. \\x', '\\\\server\\share\\proj\\..\\other', '\\\\server\\share\\proj\\a.\\b', '\\\\server\\share\\proj\\a.ts:stream', '\\\\server\\share\\proj\\\\a']) {
      expect(await revealAllowed(refused, deps), refused).toBe('name');
    }
    expect(await revealAllowed('\\\\server\\share\\proj\\con', deps)).toBe(true);
    expect(walked).toEqual(['below \\\\server\\share\\proj con']);
  });

  it('allows a share project\'s own folder without waiting on another root\'s realpath', async () => {
    let asked = 0;
    const spellings = new RootSpellings({ os: 'win32', realpath: async (folder) => {
      asked++;
      if (folder === MAPPED.fsPath) throw new Error('offline');
      return folder;
    }, log: () => undefined });
    await spellings.retain([SHARE_PROJECT, MAPPED]);
    const deps = await guard({ spellings });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      expect(await revealAllowed('\\\\server\\share\\proj', deps)).toBe(true);
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('walks the entry itself of a drive path no project holds: refuses one a link or mapped drive leads onto a share no project holds', async () => {
    const deps = await guard();
    outside.set('C:\\x\\linked\\a.txt', { kind: 'outside', reason: 'share' });
    outside.set('C:\\x\\to-share', { kind: 'outside', reason: 'share' });
    outside.set('Y:\\other\\a.txt', { kind: 'share', path: '\\\\evil\\share\\a.txt', entry: 'file' });
    outside.set('Y:\\proj\\a.ts', { kind: 'share', path: '\\\\server\\share\\proj\\a.ts', entry: 'file' });
    outside.set('C:\\gone\\a.txt', { kind: 'missing' });
    expect(await revealAllowed('C:\\x\\linked\\a.txt', deps)).toBe('share');
    // a link that is the revealed entry itself, which Explorer reads for its icon or preview
    expect(await revealAllowed('C:\\x\\to-share', deps)).toBe('share');
    expect(await revealAllowed('Y:\\other\\a.txt', deps)).toBe('share');
    expect(await revealAllowed('Y:\\proj\\a.ts', deps)).toBe(true);
    expect(await revealAllowed('C:\\gone\\a.txt', deps)).toBe(true);
  });

  it('walks a project\'s path below its folder: refuses a link in it to a share, the link itself included', async () => {
    const deps = await guard();
    // a link in a project that a cloned repository made, leading to a share
    shareLinks.add('Z:\\mapped models');
    expect(await revealAllowed('Z:\\mapped\\models', deps)).toBe('share');
    expect(await revealAllowed('Z:\\mapped\\models\\a.bin', deps)).toBe('share');
    expect(await revealAllowed('Z:\\mapped\\src\\a.ts', deps)).toBe(true);
    expect(walked).toEqual(['below Z:\\mapped models', 'below Z:\\mapped models/a.bin', 'below Z:\\mapped src/a.ts']);
  });

  it('allows a project whose own folder is a link to a share, walking only below it, and the folder itself with no walk', async () => {
    const linkedRoot: Project = { key: 'c:\\proj', fsPath: 'C:\\proj', name: 'proj' };
    const deps = await guard({ roots: [linkedRoot] });
    // walked from its drive, the project's own folder would be refused as a link to a share
    outside.set('C:\\proj', { kind: 'outside', reason: 'share' });
    outside.set('C:\\proj\\src\\a.ts', { kind: 'outside', reason: 'share' });
    expect(await revealAllowed('C:\\proj\\src\\a.ts', deps)).toBe(true);
    expect(await revealAllowed('C:\\proj', deps)).toBe(true);
    expect(walked).toEqual(['below C:\\proj src/a.ts']);
  });

  it('passes a drive mapped to a saved WSL distro as that distro\'s path', async () => {
    const deps = await guard({ wslDistros: ['Ubuntu'] });
    outside.set('W:\\home\\me', { kind: 'share', path: '\\\\wsl.localhost\\Ubuntu\\home\\me', entry: 'folder' });
    outside.set('V:\\home\\me', { kind: 'share', path: '\\\\wsl.localhost\\Debian\\home\\me', entry: 'folder' });
    expect(await revealAllowed('W:\\home\\me', deps)).toBe(true);
    expect(await revealAllowed('V:\\home\\me', deps)).toBe('share');
  });

  it('rejects when a walk fails, so no path it could not check reaches Explorer', async () => {
    const denied = new Error('EACCES: permission denied');
    await expect(revealAllowed('C:\\locked\\a.txt', await guard({ resolveOutside: () => Promise.reject(denied) }))).rejects.toBe(denied);
    await expect(revealAllowed('Z:\\mapped\\locked', await guard({ walksBelow: () => Promise.reject(denied) }))).rejects.toBe(denied);
  });

  it('refuses a device path, even of a drive a project is on', async () => {
    const deps = await guard({ roots: [SHARE_PROJECT, MAPPED, { key: 'c:\\work', fsPath: 'C:\\work', name: 'work' }] });
    for (const refused of ['\\\\?\\C:\\x', '\\\\.\\C:\\x', '\\\\?\\C:\\work\\a.ts', '\\\\?\\UNC\\server\\share\\proj\\a.ts', '\\\\.\\pipe\\x']) {
      expect(await revealAllowed(refused, deps), refused).toBe('share');
    }
  });

  it('allows a reserved device name only inside a project, walked, and refuses a part Windows rewrites anywhere', async () => {
    const deps = await guard({ roots: [{ key: 'c:\\work', fsPath: 'C:\\work', name: 'work' }] });
    expect(await revealAllowed('C:\\work\\con', deps)).toBe(true);
    expect(walked).toEqual(['below C:\\work con']);
    expect(await revealAllowed('C:\\other\\con', deps)).toBe('name');
    const rewritten = ['C:\\work\\link.\\x', 'C:\\work\\link \\x', 'C:\\work\\a.txt:stream', 'C:\\work\\..\\x', 'C:\\work\\.\\x', 'C:x.txt', '\\x.txt', 'C:\\work\\a\0b'];
    // names Windows refuses, which a walk reads as missing and so would pass unchecked
    const invalid = ['C:\\work\\a*b', 'C:\\work\\a?b', 'C:\\work\\a<b', 'C:\\work\\a|b', 'C:\\work\\a"b', 'C:\\work\\a\u0001b', 'C:\\work\\\\?\\UNC\\evil\\s'];
    for (const refused of [...rewritten, ...invalid]) expect(await revealAllowed(refused, deps), refused).toBe('name');
    expect(await revealAllowed('C:\\work\\src\\', deps)).toBe(true);
  });

  it('walks a sibling that differs from a project folder only in case from its drive, as a case-sensitive folder holds both', async () => {
    const deps = await guard({ roots: [{ key: 'c:\\p\\a', fsPath: 'C:\\p\\a', name: 'a' }] });
    outside.set('C:\\p\\A', { kind: 'outside', reason: 'share' });
    expect(await revealAllowed('C:\\p\\A', deps)).toBe('share');
    expect(await revealAllowed('C:\\p\\A\\x', deps)).toBe(true);
    expect(await revealAllowed('c:\\p\\a\\x', deps)).toBe(true);
    expect(walked).toEqual(['outside C:\\p\\A', 'outside C:\\p\\A\\x', 'below C:\\p\\a x']);
  });

  it('refuses a drive path the outside rule refuses for its spelling as a name, not a share', async () => {
    const deps = await guard();
    outside.set('C:\\x\\y', { kind: 'outside', reason: 'name' });
    expect(await revealAllowed('C:\\x\\y', deps)).toBe('name');
  });

  it('walks a share path below the spelling of the project holding it: refuses a link there to another share', async () => {
    const deps = await guard();
    shareLinks.add('\\\\server\\share\\proj models');
    expect(await revealAllowed('\\\\server\\share\\proj\\models\\a.bin', deps)).toBe('share');
    expect(await revealAllowed('\\\\nas\\data\\mapped\\a.ts', deps)).toBe(true);
    expect(await revealAllowed('\\\\server\\share\\proj', deps)).toBe(true);
    expect(walked).toEqual(['below \\\\server\\share\\proj models/a.bin', 'below \\\\nas\\data\\mapped a.ts']);
  });

  it('walks a path below the deepest root holding it by its open path, which a deeper root\'s realpath never shadows', async () => {
    // C:\proj is a link to a share the user opened; S:\ is a subst drive whose realpath, C:\proj\inner, lies below it
    const linked: Project = { key: 'c:\\proj', fsPath: 'C:\\proj', name: 'proj' };
    const subst: Project = { key: 's:\\', fsPath: 'S:\\', name: 'inner' };
    const spellings = new RootSpellings({ os: 'win32', realpath: async (folder) => (folder === subst.fsPath ? 'C:\\proj\\inner' : folder), log: () => undefined });
    await spellings.retain([linked, subst]);
    const deps = await guard({ roots: [linked, subst], spellings });
    outside.set('C:\\proj\\inner\\a.ts', { kind: 'outside', reason: 'share' });
    expect(await revealAllowed('C:\\proj\\inner\\a.ts', deps)).toBe(true);
    expect(walked).toEqual(['below C:\\proj inner/a.ts']);
  });

  it('allows a \\\\wsl.localhost or \\\\wsl$ path of a saved WSL host\'s distro, and refuses one of any other distro', async () => {
    const saved = await guard({ wslDistros: ['Ubuntu'] });
    for (const allowed of ['\\\\wsl.localhost\\Ubuntu\\srv\\a', '\\\\wsl$\\Ubuntu\\srv\\a', '\\\\wsl.localhost\\ubuntu\\srv', '\\\\wsl.localhost\\Ubuntu']) {
      expect(await revealAllowed(allowed, saved), allowed).toBe(true);
    }
    for (const refused of ['\\\\wsl.localhost\\Debian\\srv\\a', '\\\\wsl.localhostx\\Ubuntu\\srv']) {
      expect(await revealAllowed(refused, saved), refused).toBe('share');
    }
    expect(await revealAllowed('\\\\wsl.localhost\\Ubuntu\\srv\\..\\..\\x', saved)).toBe('name');
    expect(await revealAllowed('\\\\wsl.localhost\\Ubuntu\\srv\\a', await guard())).toBe('share');
  });

  it('allows the share path of a mapped project whose realpath failed earlier, once it resolves again', async () => {
    let online = false;
    const spellings = new RootSpellings({ os: 'win32', realpath: async (folder) => {
      if (!online) throw new Error(`${folder}: the network name cannot be found`);
      return folder === MAPPED.fsPath ? '\\\\nas\\data\\mapped' : folder;
    }, log: () => undefined });
    await spellings.retain([MAPPED]);
    const deps = await guard({ roots: [MAPPED], spellings });
    expect(await revealAllowed('\\\\nas\\data\\mapped\\a.ts', deps)).toBe('share');
    online = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      expect(await revealAllowed('\\\\nas\\data\\mapped\\a.ts', deps)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a saved WSL distro\'s path without taking a failed root\'s realpath again', async () => {
    let asked = 0;
    const spellings = new RootSpellings({ os: 'win32', realpath: async () => {
      asked++;
      throw new Error('offline');
    }, log: () => undefined });
    await spellings.retain([MAPPED]);
    const deps = await guard({ roots: [MAPPED], spellings, wslDistros: ['Ubuntu'] });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      expect(await revealAllowed('\\\\wsl.localhost\\Ubuntu\\srv\\a', deps)).toBe(true);
      expect(asked).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts only this computer\'s roots', async () => {
    const remote: Project = { key: 'ssh+h1|\\\\server\\share\\other', fsPath: '\\\\server\\share\\other', name: 'other' };
    expect(await revealAllowed('\\\\server\\share\\other\\a.ts', await guard({ roots: [remote] }))).toBe('share');
  });
});

describe('the Reveal check\'s helpers', () => {
  it('walks below a root with nothing left to follow past a missing part, and rejects any other walk failure', async () => {
    const coded = (code: string): Error => Object.assign(new Error(code), { code });
    const failures = new Map([['C:\\gone', coded('ENOENT')], ['C:\\file', coded('ENOTDIR')], ['C:\\locked', coded('EACCES')]]);
    const walkedFrom: string[][] = [];
    const walksBelow = walkingBelow(async (base, segments) => {
      walkedFrom.push([base, ...segments]);
      const failure = failures.get(base);
      if (failure) throw failure;
      return base !== 'C:\\share';
    });
    expect(await walksBelow('C:\\proj', '')).toBe(true);
    expect(await walksBelow('C:\\proj', 'src/a.ts')).toBe(true);
    expect(await walksBelow('C:\\share', 'x')).toBe(false);
    expect(await walksBelow('C:\\gone', 'x')).toBe(true);
    expect(await walksBelow('C:\\file', 'x/y')).toBe(true);
    await expect(walksBelow('C:\\locked', 'x')).rejects.toBe(failures.get('C:\\locked'));
    expect(walkedFrom.slice(0, 2)).toEqual([['C:\\proj'], ['C:\\proj', 'src', 'a.ts']]);
  });

  it('words a LocalizedError\'s message by render, and leaves any other rejection alone', () => {
    const text = { message: 'The drive {0} did not answer within a second.', args: ['Z:\\'] };
    const localized = new LocalizedError(text);
    expect(withRenderedMessage(localized, (rendered) => `el: ${rendered.message} ${String(rendered.args?.[0])}`)).toBe(localized);
    expect(localized.message).toBe('el: The drive {0} did not answer within a second. Z:\\');
    expect(localized.text).toBe(text);
    const plain = new Error('EACCES: permission denied');
    expect(withRenderedMessage(plain, () => 'never')).toBe(plain);
    expect(plain.message).toBe('EACCES: permission denied');
  });
});

describe('revealAllowed off win32', () => {
  it('allows every path, since POSIX has no UNC or device path', async () => {
    const deps = await guard({ os: 'linux' });
    for (const target of ['/home/me/a.txt', '//server/share/x', '\\\\server\\share\\x', '\\\\?\\C:\\x']) expect(await revealAllowed(target, deps), target).toBe(true);
  });
});
