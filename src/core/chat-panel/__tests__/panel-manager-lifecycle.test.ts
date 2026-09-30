import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger', () => ({ log: vi.fn() }));
vi.mock('../ide-context-manager', () => ({
  IdeContextManager: class {
    dispose(): void {}
  },
}));

import { createHarness, folderEntry, makeFakeHost, type FakeSession, type Harness } from './panel-manager-harness';

const A = path.join(path.resolve(os.tmpdir(), 'pml-root'), 'alpha');
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let h: Harness;
afterEach(() => h.dispose());

describe('PanelManager panel lifecycle', () => {
  it('tears down a panel whose host closed while its session was being created', async () => {
    h = createHarness([folderEntry(A)]);
    let release!: () => void;
    h.holdCreation.gate = new Promise<void>((resolve) => { release = resolve; });
    const host = makeFakeHost();
    const opening = h.manager.initializeHost(host);
    await tick();

    host.closeFromUser();
    h.holdCreation.gate = null;
    release();
    const panelId = await opening;

    expect(h.manager.getPanels().has(panelId)).toBe(false);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() awaits the session disposal of a panel closed before it', async () => {
    h = createHarness([folderEntry(A)]);
    const host = makeFakeHost();
    const panelId = await h.manager.initializeHost(host);
    const session = h.instance(panelId).session as unknown as FakeSession;
    let finish!: () => void;
    session.dispose.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));

    host.closeFromUser();
    let disposed = false;
    const disposing = h.manager.dispose().then(() => { disposed = true; });
    await tick();
    expect(disposed).toBe(false);

    finish();
    await disposing;
    expect(disposed).toBe(true);
  });

  it('dispose() still resolves when a session disposal of a closed panel failed', async () => {
    h = createHarness([folderEntry(A)]);
    const host = makeFakeHost();
    const panelId = await h.manager.initializeHost(host);
    (h.instance(panelId).session as unknown as FakeSession).dispose.mockRejectedValue(new Error('teardown failed'));

    host.closeFromUser();

    await expect(h.manager.dispose()).resolves.toBeUndefined();
  });
});
