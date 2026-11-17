import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as fs from 'node:fs';
import { access } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { callFactsOf } from '../permission-gate';
import type { ChatMachine } from '../proven-shell';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, access: vi.fn(actual.access) };
});

// pi's Read falls back to other spellings of a missing file (NFD, a curly apostrophe, a narrow space before AM/PM), and Windows
// follows a link at any segment but the last while it answers whether one exists, so each is placed before it is probed.
describe.runIf(process.platform === 'win32')('a Read\'s fallback names (win32)', () => {
  const machine: ChatMachine = { platform: 'win32', allowedNetworkHosts: () => Promise.resolve(new Set()) };
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

  it('places an NFD folder that is a junction to a share without probing a path through it', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-nfd-')));
    roots.push(root);
    const junction = path.join(root, 'cafe\u0301');
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), junction, 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) =>
      (String(file).toLowerCase() === junction.toLowerCase() ? '\\\\evil\\share' : readlink(file))) as typeof fs.promises.readlink);
    onTestFinished(() => { spy.mockRestore(); });
    vi.mocked(access).mockClear();

    const facts = await callFactsOf('Read', { file_path: 'caf\u00e9\\x.txt' }, machine, () => root);

    const throughJunction = vi.mocked(access).mock.calls.map(([file]) => String(file)).filter((file) => file.toLowerCase().startsWith(junction.toLowerCase()));
    expect(throughJunction).toEqual([]);
    expect(facts).toMatchObject({ reachesNetwork: true, networkHosts: ['evil'], networkPaths: ['caf\u00e9\\x.txt'] });
  });

  it('names the hosts of the fallback names after a requested name that reaches, which pi probes when the remote file is missing', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-nfd-')));
    roots.push(root);
    const nfc = path.join(root, 'caf\u00e9');
    const nfd = path.join(root, 'cafe\u0301');
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), nfc, 'junction');
    fs.symlinkSync(path.join(root, 'real'), nfd, 'junction');
    const targets = new Map([[nfc.toLowerCase(), '\\\\a\\s'], [nfd.toLowerCase(), '\\\\b\\s']]);
    const readlink = fs.promises.readlink.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) =>
      targets.get(String(file).toLowerCase()) ?? readlink(file)) as typeof fs.promises.readlink);
    onTestFinished(() => { spy.mockRestore(); });
    vi.mocked(access).mockClear();

    expect(await callFactsOf('Read', { file_path: 'caf\u00e9\\x.txt' }, machine, () => root)).toMatchObject({ reachesNetwork: true, networkHosts: ['a', 'b'] });
    expect(vi.mocked(access)).not.toHaveBeenCalled();
  });

  it('stops at the first fallback name that exists, as pi does, and places none after it', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-nfd-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'it\'s'));
    fs.writeFileSync(path.join(root, 'it\'s', 'cafe\u0301.txt'), 'x');
    const curly = path.join(root, 'it\u2019s');
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), curly, 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) =>
      (String(file).toLowerCase() === curly.toLowerCase() ? '\\\\evil\\share' : readlink(file))) as typeof fs.promises.readlink);
    onTestFinished(() => { spy.mockRestore(); });

    // the NFD name exists, so pi opens it and never tries the curly-apostrophe name through the junction
    expect(await callFactsOf('Read', { file_path: 'it\'s\\caf\u00e9.txt' }, machine, () => root)).toMatchObject({ reachesNetwork: false });
  });
});
