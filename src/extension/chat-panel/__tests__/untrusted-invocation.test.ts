import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger', () => ({ log: vi.fn() }));

import type { CustomSlashCommandInfo, SkillInfo } from '../../../shared/types/commands';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import {
  createChatHandlers,
} from '../message-router/handlers/chat-handlers';
import type {
  HandlerContext,
  HandlerDependencies,
  MessageHandler,
} from '../message-router/types';

function skill(name: string, untrusted: boolean): SkillInfo {
  return {
    name,
    description: 'd',
    filePath: `/ws/.damocles/skills/${name}/SKILL.md`,
    source: 'project',
    ...(untrusted ? { untrusted: true } : {}),
  };
}

function command(name: string, untrusted: boolean): CustomSlashCommandInfo {
  return {
    name,
    description: 'd',
    filePath: `/ws/.damocles/commands/${name}.md`,
    source: 'user',
    ...(untrusted ? { untrusted: true } : {}),
  };
}

interface Harness {
  send: MessageHandler;
  queue: MessageHandler;
  posted: ExtensionToWebviewMessage[];
  sessionSend: ReturnType<typeof vi.fn>;
  queueInput: ReturnType<typeof vi.fn>;
  preApproveSkill: ReturnType<typeof vi.fn>;
  ctx: HandlerContext;
}

function makeHarness(opts: {
  skills?: SkillInfo[];
  commands?: CustomSlashCommandInfo[];
}): Harness {
  const skills = opts.skills ?? [];
  const commands = opts.commands ?? [];
  const posted: ExtensionToWebviewMessage[] = [];
  const sessionSend = vi.fn(async () => undefined);
  const queueInput = vi.fn(() => 'queued');
  const preApproveSkill = vi.fn();

  const deps = {
    workspacePath: '/ws',
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => {
      posted.push(message);
    },
    storageManager: { broadcastPromptHistoryEntry: vi.fn() },
    settingsManager: { sendCurrentSettings: vi.fn(async () => undefined) },
    workspaceManager: {
      findSkill: async (name: string) => skills.find((s) => s.name === name),
      findCommand: async (name: string) => commands.find((c) => c.name === name),
    },
    memoryService: { isEnabled: false, ensureInitialized: vi.fn(async () => undefined) },
    markUserTypedDuringTurn: vi.fn(),
  } as unknown as HandlerDependencies;

  const ctx = {
    host: {},
    session: {
      currentPromptIndex: 0,
      sendMessage: sessionSend,
      queueInput,
      compact: vi.fn(async () => undefined),
    },
    permissionHandler: { preApproveSkill, revokeSkillPreApproval: vi.fn() },
    ideContextManager: { buildContentBlocks: vi.fn() },
    panelId: 'panel-1',
  } as unknown as HandlerContext;

  const handlers = createChatHandlers(deps);
  const send = handlers['sendMessage'];
  const queue = handlers['queueMessage'];
  if (!send) throw new Error('chat handlers expose no sendMessage handler');
  if (!queue) throw new Error('chat handlers expose no queueMessage handler');
  return { send, queue, posted, sessionSend, queueInput, preApproveSkill, ctx };
}

function notifications(posted: ExtensionToWebviewMessage[]): string[] {
  return posted
    .filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'notification' }> =>
      m.type === 'notification',
    )
    .map((m) => m.message);
}

async function invoke(h: Harness, text: string): Promise<void> {
  await h.send({ type: 'sendMessage', content: text } as never, h.ctx);
}

async function enqueue(h: Harness, text: string): Promise<void> {
  await h.queue({ type: 'queueMessage', content: text } as never, h.ctx);
}

describe('slash-command invocation in an untrusted workspace', () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses an untrusted skill: no turn, no pre-approval, a trust-naming notification', async () => {
    h = makeHarness({ skills: [skill('foo', true)] });
    await invoke(h, '/foo');

    expect(h.sessionSend).not.toHaveBeenCalled();
    expect(h.preApproveSkill).not.toHaveBeenCalled();
    const messages = notifications(h.posted);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/trust/i);
  });

  it('refuses an untrusted skill invoked with arguments', async () => {
    h = makeHarness({ skills: [skill('foo', true)] });
    await invoke(h, '/foo some args');

    expect(h.sessionSend).not.toHaveBeenCalled();
    expect(h.preApproveSkill).not.toHaveBeenCalled();
    expect(notifications(h.posted)[0]).toMatch(/trust/i);
  });

  it('refuses an untrusted custom command: no turn, a trust-naming notification', async () => {
    h = makeHarness({ commands: [command('bar', true)] });
    await invoke(h, '/bar');

    expect(h.sessionSend).not.toHaveBeenCalled();
    const messages = notifications(h.posted);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/trust/i);
  });

  it('clears the optimistic spinner when it refuses', async () => {
    h = makeHarness({ skills: [skill('foo', true)] });
    await invoke(h, '/foo');

    expect(h.posted).toContainEqual({ type: 'processing', isProcessing: false });
  });

  // A dotted name reaches the intercept, so the refusal covers every name the scanner can list.
  it('refuses an untrusted dotted command', async () => {
    h = makeHarness({ commands: [command('foo.bar', true)] });
    await invoke(h, '/foo.bar');

    expect(h.sessionSend).not.toHaveBeenCalled();
    expect(notifications(h.posted)[0]).toMatch(/trust/i);
  });

  it('refuses an untrusted namespaced command', async () => {
    h = makeHarness({ commands: [command('ns:deploy', true)] });
    await invoke(h, '/ns:deploy');

    expect(h.sessionSend).not.toHaveBeenCalled();
    expect(notifications(h.posted)[0]).toMatch(/trust/i);
  });

  it('refuses an untrusted dotted skill and does not pre-approve it', async () => {
    h = makeHarness({ skills: [skill('foo.bar', true)] });
    await invoke(h, '/foo.bar');

    expect(h.sessionSend).not.toHaveBeenCalled();
    expect(h.preApproveSkill).not.toHaveBeenCalled();
    expect(notifications(h.posted)[0]).toMatch(/trust/i);
  });
});

// The refusal has to hold on both paths into the session, not just the one the UI uses most.
describe('slash-command invocation via queueMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses an untrusted skill without queueing anything', async () => {
    const h = makeHarness({ skills: [skill('foo', true)] });
    await enqueue(h, '/foo');

    expect(h.queueInput).not.toHaveBeenCalled();
    expect(h.preApproveSkill).not.toHaveBeenCalled();
    const messages = notifications(h.posted);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/trust/i);
  });

  it('refuses an untrusted custom command without queueing anything', async () => {
    const h = makeHarness({ commands: [command('bar', true)] });
    await enqueue(h, '/bar');

    expect(h.queueInput).not.toHaveBeenCalled();
    expect(notifications(h.posted)[0]).toMatch(/trust/i);
  });

  // The queue path never arms an optimistic spinner (App.vue handleQueueMessage), so disarming one
  // here would clear a spinner an in-flight turn owns.
  it('posts no processing update when it refuses', async () => {
    const h = makeHarness({ skills: [skill('foo', true)] });
    await enqueue(h, '/foo');

    expect(h.posted.filter((m) => m.type === 'processing')).toEqual([]);
  });

  it('queues a trusted skill as the rewritten execute-skill content', async () => {
    const h = makeHarness({ skills: [skill('foo', false)] });
    await enqueue(h, '/foo');

    expect(h.preApproveSkill).toHaveBeenCalledWith('foo');
    expect(h.queueInput).toHaveBeenCalledTimes(1);
    expect(h.queueInput.mock.calls[0]?.[0]).toBe('Execute skill foo');
  });
});

// Two kinds can claim one name. Only a name that nothing runnable claims may be refused.
describe('slash-command name claimed by both a skill and a command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the unflagged command when the skill of the same name is untrusted', async () => {
    const h = makeHarness({ skills: [skill('commit', true)], commands: [command('commit', false)] });
    await invoke(h, '/commit');

    expect(notifications(h.posted)).toEqual([]);
    expect(h.preApproveSkill).not.toHaveBeenCalled();
    expect(h.sessionSend).toHaveBeenCalledTimes(1);
    expect(h.sessionSend.mock.calls[0]?.[0]).toBe('/commit');
  });

  it('runs the unflagged command on the queue path too', async () => {
    const h = makeHarness({ skills: [skill('commit', true)], commands: [command('commit', false)] });
    await enqueue(h, '/commit');

    expect(notifications(h.posted)).toEqual([]);
    expect(h.queueInput).toHaveBeenCalledTimes(1);
    expect(h.queueInput.mock.calls[0]?.[0]).toBe('/commit');
  });

  it('keeps the command arguments intact when the command wins', async () => {
    const h = makeHarness({ skills: [skill('commit', true)], commands: [command('commit', false)] });
    await invoke(h, '/commit --amend');

    expect(notifications(h.posted)).toEqual([]);
    expect(h.sessionSend.mock.calls[0]?.[0]).toBe('/commit --amend');
  });

  it('runs the unflagged skill when the command of the same name is untrusted', async () => {
    const h = makeHarness({ skills: [skill('commit', false)], commands: [command('commit', true)] });
    await invoke(h, '/commit');

    expect(notifications(h.posted)).toEqual([]);
    expect(h.preApproveSkill).toHaveBeenCalledWith('commit');
    expect(h.sessionSend.mock.calls[0]?.[0]).toBe('Execute skill commit');
  });

  it('prefers the skill when neither is flagged', async () => {
    const h = makeHarness({ skills: [skill('commit', false)], commands: [command('commit', false)] });
    await invoke(h, '/commit');

    expect(h.preApproveSkill).toHaveBeenCalledWith('commit');
    expect(h.sessionSend.mock.calls[0]?.[0]).toBe('Execute skill commit');
  });

  it('refuses when both are untrusted, sending no turn', async () => {
    const h = makeHarness({ skills: [skill('commit', true)], commands: [command('commit', true)] });
    await invoke(h, '/commit');

    expect(h.sessionSend).not.toHaveBeenCalled();
    expect(h.preApproveSkill).not.toHaveBeenCalled();
    expect(notifications(h.posted)).toHaveLength(1);
    expect(notifications(h.posted)[0]).toMatch(/trust/i);
  });

  it('refuses when both are untrusted on the queue path, queueing nothing', async () => {
    const h = makeHarness({ skills: [skill('commit', true)], commands: [command('commit', true)] });
    await enqueue(h, '/commit');

    expect(h.queueInput).not.toHaveBeenCalled();
    expect(notifications(h.posted)).toHaveLength(1);
  });
});

describe('slash-command invocation in a trusted workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pre-approves a trusted skill and rewrites the content', async () => {
    const h = makeHarness({ skills: [skill('foo', false)] });
    await invoke(h, '/foo');

    expect(h.preApproveSkill).toHaveBeenCalledWith('foo');
    expect(h.sessionSend).toHaveBeenCalledTimes(1);
    expect(h.sessionSend.mock.calls[0]?.[0]).toBe('Execute skill foo');
    expect(notifications(h.posted)).toEqual([]);
  });

  it('appends skill arguments to the rewritten content', async () => {
    const h = makeHarness({ skills: [skill('foo', false)] });
    await invoke(h, '/foo some args');

    expect(h.preApproveSkill).toHaveBeenCalledWith('foo');
    expect(h.sessionSend.mock.calls[0]?.[0]).toBe('Execute skill foo\nAdditional info: some args');
  });

  it('passes a trusted custom command through untransformed', async () => {
    const h = makeHarness({ commands: [command('bar', false)] });
    await invoke(h, '/bar');

    expect(h.preApproveSkill).not.toHaveBeenCalled();
    expect(h.sessionSend).toHaveBeenCalledTimes(1);
    expect(h.sessionSend.mock.calls[0]?.[0]).toBe('/bar');
    expect(notifications(h.posted)).toEqual([]);
  });

  // A guard that refuses anything it cannot resolve would break plain prose starting with a slash and
  // every pi-native prompt template Damocles never enumerates.
  it('leaves a genuinely unknown /name as passthrough with no refusal', async () => {
    const h = makeHarness({});
    await invoke(h, '/definitelynotaskill');

    expect(h.preApproveSkill).not.toHaveBeenCalled();
    expect(h.sessionSend).toHaveBeenCalledTimes(1);
    expect(h.sessionSend.mock.calls[0]?.[0]).toBe('/definitelynotaskill');
    expect(notifications(h.posted)).toEqual([]);
  });

  it('leaves an unknown dotted /name as passthrough with no refusal', async () => {
    const h = makeHarness({});
    await invoke(h, '/nothing.here');

    expect(h.sessionSend.mock.calls[0]?.[0]).toBe('/nothing.here');
    expect(notifications(h.posted)).toEqual([]);
  });
});

// Text that the invocation alphabet must not treat as a slash command at all. Each of these names is
// planted as an untrusted asset, so an over-wide alphabet shows up as a refusal instead of a turn.
describe('text outside the invocation alphabet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['/..', '/.hidden', '/foo..bar', '/foo.', '/a:b:c'])(
    'sends %j as an ordinary turn rather than intercepting it',
    async (text) => {
      const name = text.slice(1);
      const h = makeHarness({ skills: [skill(name, true)], commands: [command(name, true)] });
      await invoke(h, text);

      expect(notifications(h.posted)).toEqual([]);
      expect(h.sessionSend).toHaveBeenCalledTimes(1);
      expect(h.sessionSend.mock.calls[0]?.[0]).toBe(text);
    },
  );
});
