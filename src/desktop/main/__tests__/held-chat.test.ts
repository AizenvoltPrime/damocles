// chats.showSession on a device: the daemon names a chat its core holds, and the device opens it by joining that panel, never
// by looking it up in its own chat lists, which may not hold it (a project it has not opened, a file its catalog has not
// listed yet).
import { describe, expect, it, vi } from 'vitest';
import { showHeldChat, type HeldChatDeps } from '../held-chat';

interface View {
  readonly id: string;
}

function deps(overrides: Partial<HeldChatDeps<View>> = {}) {
  const order: string[] = [];
  const created: View[] = [];
  const base: HeldChatDeps<View> = {
    loaded: () => undefined,
    create: () => {
      const view = { id: `view-${created.length + 1}` };
      created.push(view);
      order.push(`create ${view.id}`);
      return view;
    },
    join: vi.fn(async (view: View) => {
      order.push(`join ${view.id}`);
      return true;
    }),
    show: (view) => order.push(`show ${view.id}`),
    dispose: (view) => order.push(`dispose ${view.id}`),
  };
  return { deps: { ...base, ...overrides }, order, created };
}

describe('showHeldChat', () => {
  it('opens a chat no list of this device holds by joining the panel that holds it, and shows it only once it joined', async () => {
    const { deps: held, order } = deps();
    expect(await showHeldChat(held)).toBe(true);
    expect(order).toEqual(['create view-1', 'join view-1', 'show view-1']);
  });

  it('shows a view of this device that already holds the chat, opening no other', async () => {
    const existing = { id: 'view-0' };
    const { deps: held, order } = deps({ loaded: () => existing });
    expect(await showHeldChat(held)).toBe(true);
    expect(order).toEqual(['show view-0']);
  });

  it('answers false and leaves no view behind when no panel of the core holds the chat, or the join fails', async () => {
    const refused = deps({ join: async () => false });
    expect(await showHeldChat(refused.deps)).toBe(false);
    expect(refused.order).toEqual(['create view-1', 'dispose view-1']);
    const failing = deps({
      join: async () => {
        throw new Error('the connection closed');
      },
    });
    await expect(showHeldChat(failing.deps)).rejects.toThrow('the connection closed');
    expect(failing.order).toEqual(['create view-1', 'dispose view-1']);
  });
});
