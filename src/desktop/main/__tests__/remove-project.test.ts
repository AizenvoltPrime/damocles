import { describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_PREVIEW_LINES } from '../../preload/overlay-channels';
import type { MessageQuestion } from '../message-dialog';
import { removeProject, removeProjectQuestion, type RemoveProjectDeps, type WaitingChat } from '../remove-project';
import type { KillListEntry } from '../terminal/terminal-service';

const t = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '');

const held = (corePanelId: string, text: string, extra: Partial<WaitingChat> = {}): WaitingChat => ({ corePanelId, title: '', prompt: [{ type: 'text', text }], ...extra });

interface World {
  busy: boolean;
  waiting: WaitingChat[];
  terminals: Map<string, KillListEntry>;
  setups: Map<string, string>;
  answer: number | undefined;
  asked: MessageQuestion[];
  killAsked: string[][];
  trail: string[];
  // runs while the question is open
  duringQuestion?: (() => void) | undefined;
}

function setup(world: Partial<World> = {}) {
  const w: World = { busy: false, waiting: [], terminals: new Map(), setups: new Map(), answer: 0, asked: [], killAsked: [], trail: [], ...world };
  const deps: RemoveProjectDeps = {
    project: () => ({ name: 'acme' }),
    busy: async () => w.busy,
    waitingChats: () => [...w.waiting],
    terminals: {
      idsIn: () => [...w.terminals.keys()],
      setupTerminal: (worktreeId) => w.setups.get(worktreeId),
      toConfirm: (ids) => ids.flatMap((id) => w.terminals.get(id) ?? []),
      confirmKill: vi.fn(async (ids: readonly string[]) => {
        w.killAsked.push([...ids]);
        w.duringQuestion?.();
        return w.answer === 0;
      }),
    },
    ask: vi.fn(async (question: MessageQuestion) => {
      w.asked.push(question);
      w.duringQuestion?.();
      return w.answer;
    }),
    discard: vi.fn(async (chats: readonly WaitingChat[]) => {
      w.trail.push(`discard:${chats.map((chat) => chat.corePanelId).join(',')}`);
    }),
    remove: vi.fn(async () => {
      w.trail.push('remove');
    }),
    t,
  };
  return { w, deps };
}

describe('removeProject', () => {
  it('removes a project with no waiting first message after only the terminal question it always asked', async () => {
    const { w, deps } = setup({ terminals: new Map([['term-1', { name: 'PowerShell', command: 'npm run dev' }]]) });
    expect(await removeProject('acme-key', deps)).toEqual({ ok: true });
    expect(deps.ask).not.toHaveBeenCalled();
    expect(w.killAsked).toEqual([['term-1']]);
    expect(w.trail).toEqual(['remove']);
  });

  it('asks nothing and removes a project with no waiting message and no terminal', async () => {
    const { w, deps } = setup();
    expect(await removeProject('acme-key', deps)).toEqual({ ok: true });
    expect(deps.ask).not.toHaveBeenCalled();
    expect(w.trail).toEqual(['remove']);
  });

  it('asks one question naming the project and its waiting chats, and Cancel changes nothing', async () => {
    const { w, deps } = setup({ waiting: [held('p1', 'Fix the login page'), held('p2', 'Ignored', { title: 'Release notes' })], answer: undefined });
    expect(await removeProject('acme-key', deps)).toEqual({ ok: true });
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]).toMatchObject({
      severity: 'danger',
      message: 'acme has 2 chats whose first messages are waiting for their worktrees. Do you want to remove the project?',
      preview: ['Fix the login page', 'Release notes'],
      actions: ['Remove Project'],
      cancelLabel: 'Cancel',
    });
    // Cancel is focused first
    expect(w.asked[0]!.defaultAction).toBeUndefined();
    expect(deps.terminals.confirmKill).not.toHaveBeenCalled();
    expect(w.trail).toEqual([]);
  });

  it('discards the waiting chats\' worktrees before the project is removed when Remove Project is chosen', async () => {
    const { w, deps } = setup({ waiting: [held('p1', 'Fix the login page', { worktreeId: 'wt-1' })] });
    expect(await removeProject('acme-key', deps)).toEqual({ ok: true });
    expect(w.asked[0]!.message).toBe('acme has a chat whose first message is waiting for its worktree. Do you want to remove the project?');
    expect(w.trail).toEqual(['discard:p1', 'remove']);
  });

  it('merges the terminal question into the one question, counting no Setup terminal of a waiting chat', async () => {
    const { w, deps } = setup({
      waiting: [held('p1', 'Fix the login page', { worktreeId: 'wt-1' })],
      terminals: new Map([['term-setup', { name: 'Setup', command: 'npm ci' }], ['term-2', { name: 'bash', command: 'npm run dev' }]]),
      setups: new Map([['wt-1', 'term-setup']]),
    });
    expect(await removeProject('acme-key', deps)).toEqual({ ok: true });
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]!.detail).toBe('Removing it discards the message and the worktree being prepared for it. It also terminates an active terminal session.');
    expect(deps.terminals.confirmKill).not.toHaveBeenCalled();
    expect(w.trail).toEqual(['discard:p1', 'remove']);
  });

  it('asks again, listing it, when another chat starts holding its first message while the terminal question is open', async () => {
    const { w, deps } = setup({ terminals: new Map([['term-1', { name: 'bash', command: 'npm run dev' }]]) });
    w.duringQuestion = () => {
      w.duringQuestion = undefined;
      w.waiting = [held('p1', 'Late prompt')];
    };
    expect(await removeProject('acme-key', deps)).toEqual({ ok: true });
    expect(w.killAsked).toHaveLength(1);
    expect(w.asked.map((question) => question.preview)).toEqual([['Late prompt']]);
    expect(w.trail).toEqual(['discard:p1', 'remove']);
  });

  it('refuses while a conversation runs, before and after the question', async () => {
    const before = setup({ busy: true, waiting: [held('p1', 'x')] });
    expect(await removeProject('acme-key', before.deps)).toMatchObject({ ok: false });
    expect(before.w.asked).toEqual([]);
    const after = setup({ waiting: [held('p1', 'x')] });
    after.w.duringQuestion = () => { after.w.busy = true; };
    expect(await removeProject('acme-key', after.deps)).toEqual({ ok: false, reason: 'A conversation is running in acme. Stop it or wait for it to finish, then remove the project.' });
    expect(after.w.trail).toEqual([]);
  });
});

describe('removeProjectQuestion', () => {
  it('shows an untitled chat as a short excerpt of its message with hidden characters escaped, and bounds the list', () => {
    const chats = Array.from({ length: MAX_MESSAGE_PREVIEW_LINES + 2 }, (_, index) => held(`p${index}`, `Chat ${index}`));
    chats[0] = held('p0', `  Fix\nthe \u202Elogin\u202C ${'word '.repeat(40)}`);
    chats[1] = { corePanelId: 'p1', title: '', prompt: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] };
    const question = removeProjectQuestion('ac\u202Eme', chats, 2, t);
    expect(question.message).toBe(`ac\\u{202E}me has ${chats.length} chats whose first messages are waiting for their worktrees. Do you want to remove the project?`);
    expect(question.detail).toBe('Removing it discards the messages and the worktrees being prepared for them. It also terminates 2 active terminal sessions.');
    const preview = question.preview!;
    expect(preview).toHaveLength(MAX_MESSAGE_PREVIEW_LINES);
    expect(preview[0]).toMatch(/^Fix the \\u\{202E\}login\\u\{202C\} word word .*…$/);
    expect([...preview[0]!.replace(/\\u\{[0-9A-F]+\}/g, 'x')].length).toBeLessThanOrEqual(40);
    expect(preview[1]).toBe('A message with images only');
    expect(preview.at(-1)).toBe('and 3 more');
  });
});
