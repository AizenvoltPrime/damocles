import { describe, it, expect, vi } from 'vitest';
import { createWorkspaceHandlers } from '../workspace-handlers';

vi.mock('vscode', () => ({
  window: {},
  workspace: {},
  Uri: { file: (p: string) => ({ fsPath: p }) },
  l10n: { t: (s: string) => s },
}));
vi.mock('../../../../logger', () => ({ log: vi.fn() }));

const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

async function dispatchSteer(msg: Record<string, unknown>) {
  const steerTarget = vi.fn(async () => undefined);
  const deps = { postMessage: () => undefined } as unknown as Parameters<typeof createWorkspaceHandlers>[0];
  const ctx = { session: { steerTarget } } as never;
  await createWorkspaceHandlers(deps).steerAgent!({ type: 'steerAgent', ...msg } as never, ctx);
  return steerTarget;
}

describe('steerAgent', () => {
  it('passes the pasted images and the request id through to steerTarget', async () => {
    const steerTarget = await dispatchSteer({ agentId: 'agent-1', message: 'look at this', images: [PNG], requestId: 'req-1' });

    expect(steerTarget).toHaveBeenCalledWith('agent-1', 'look at this', [PNG], 'req-1');
  });

  it('passes no images when the steer has none', async () => {
    const steerTarget = await dispatchSteer({ agentId: 'agent-1', message: 'focus on tests', requestId: 'req-2' });

    expect(steerTarget).toHaveBeenCalledWith('agent-1', 'focus on tests', undefined, 'req-2');
  });
});
