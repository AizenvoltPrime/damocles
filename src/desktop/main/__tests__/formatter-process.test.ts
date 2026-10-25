import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

const ROOT = { key: 'c:\\work\\alpha', root: 'C:\\work\\alpha' };
const REQUEST = { prettier: 'C:\\work\\alpha\\node_modules\\prettier\\index.cjs', config: 'C:\\work\\alpha\\.prettierrc', file: 'C:\\work\\alpha\\a.ts', text: 'a' };

describe('spawnFormatterHost', () => {
  it('forks the host script with the root as cwd, no ELECTRON_ variable and no stdio', async () => {
    const { utilityProcess } = await import('electron');
    const child = { on: vi.fn(), postMessage: vi.fn(), kill: vi.fn() };
    vi.mocked(utilityProcess.fork).mockReturnValue(child as never);
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    const { spawnFormatterHost } = await import('../formatting/formatter-process');
    const host = spawnFormatterHost('/app/dist/formatter-host.js', ROOT.root);
    const [script, args, options] = vi.mocked(utilityProcess.fork).mock.calls[0]!;
    expect(script).toBe('/app/dist/formatter-host.js');
    expect(args).toEqual([]);
    expect(options).toMatchObject({ cwd: ROOT.root, stdio: 'ignore', serviceName: 'Damocles Formatter' });
    expect(Object.keys(options!.env!).some((key) => /^ELECTRON_/i.test(key))).toBe(false);
    host.postMessage({ id: 1, ...REQUEST });
    expect(child.postMessage).toHaveBeenCalledWith({ id: 1, ...REQUEST });
    host.kill();
    expect(child.kill).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
