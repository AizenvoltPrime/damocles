import { describe, it, expect, vi } from 'vitest';
import { PermissionHandler } from '../index';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { CanUseToolContext } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import {
  TOOL_ASK_USER_QUESTION,
  TOOL_BROWSER_REQUEST_INPUT,
  TOOL_EXIT_PLAN_MODE,
  TOOL_SKILL,
} from '../../../shared/tool-names';

/** Stand in for a file on disk, so `prepareDiff` produces a real original and proposed content pair. */
function stubFileOnDisk(platform: FakePlatform, content: string): void {
  vi.spyOn(platform.editor, 'readText').mockResolvedValue(content);
}

/** A handler wired to a message list, which is the only thing the webview side of a prompt is. */
function handlerWith(): { handler: PermissionHandler; messages: ExtensionToWebviewMessage[]; platform: FakePlatform } {
  const platform = createFakePlatform();
  const handler = new PermissionHandler(platform);
  handler.setCwd(process.cwd());
  const messages: ExtensionToWebviewMessage[] = [];
  handler.setPostMessage((msg) => messages.push(msg));
  handler.setPlanContentResolver(async () => 'the plan');
  return { handler, messages, platform };
}

function abortedCtx(toolUseID: string): CanUseToolContext {
  const controller = new AbortController();
  controller.abort();
  return { signal: controller.signal, toolUseID, parentToolUseId: null };
}

function liveCtx(toolUseID: string): CanUseToolContext {
  return { signal: new AbortController().signal, toolUseID, parentToolUseId: null };
}

/** Poll until a condition holds: a file approval reaches its map through several awaits, not one. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which?',
      header: 'Pick',
      multiSelect: false,
      options: [
        { label: 'a', description: 'first' },
        { label: 'b', description: 'second' },
      ],
    },
  ],
};

const FORM_INPUT = {
  title: 'Log in',
  fields: [{ id: 'user', label: 'User', selector: '#user', type: 'text' }],
};

describe('a prompt raised on an already-aborted signal settles instead of stranding', () => {
  /**
   * Adding an abort listener to a signal that already aborted never fires it, so the entry would
   * register and never settle: `pendingPrompts()` keeps it, the panel pins on `requires_action`,
   * and the `canUseTool` promise the agent is waiting on never resolves.
   */
  const kinds: [string, (h: PermissionHandler, ctx: CanUseToolContext) => Promise<unknown>][] = [
    ['shell approval', (h, ctx) => h.canUseTool('Bash', { command: 'echo hi' }, ctx)],
    ['question', (h, ctx) => h.canUseTool(TOOL_ASK_USER_QUESTION, QUESTION_INPUT, ctx)],
    ['form', (h, ctx) => h.canUseTool(TOOL_BROWSER_REQUEST_INPUT, FORM_INPUT, ctx)],
    ['plan approval', (h, ctx) => h.canUseTool(TOOL_EXIT_PLAN_MODE, {}, ctx)],
    ['skill approval', (h, ctx) => h.canUseTool(TOOL_SKILL, { skill: 'simplify' }, ctx)],
    [
      'elicitation',
      (h, ctx) =>
        h.requestElicitation(
          { elicitationId: 'e1', serverName: 'srv', message: 'sign in', mode: 'url', url: 'https://example.test' },
          ctx.signal,
        ),
    ],
  ];

  for (const [name, raise] of kinds) {
    it(`settles a ${name} and leaves no pending prompt behind`, async () => {
      const { handler } = handlerWith();
      handler.setPermissionMode('plan');

      await raise(handler, abortedCtx('t1'));

      expect(handler.pendingPrompts().length > 0).toBe(false);
    });
  }
});

describe('pendingElicitations counts as a pending prompt', () => {
  it('fires the pending-prompt listener and counts while an elicitation is open', async () => {
    const { handler, messages } = handlerWith();
    const changes: boolean[] = [];
    handler.setPendingPromptsListener(() => changes.push(handler.pendingPrompts().length > 0));

    const elicitation = handler.requestElicitation(
      { elicitationId: 'e1', serverName: 'srv', message: 'sign in', mode: 'form' },
      liveCtx('e1').signal,
    );

    expect(handler.pendingPrompts().length > 0).toBe(true);
    expect(messages.map((m) => m.type)).toEqual(['requestElicitation']);

    handler.resolveElicitation('e1', { action: 'accept', content: {} });
    await elicitation;

    expect(handler.pendingPrompts().length > 0).toBe(false);
    expect(changes).toEqual([true, false]);
  });
});

describe('a webview reload gets every live prompt posted again', () => {
  it('re-posts the exact message each prompt was raised with, in the order they were raised', async () => {
    const { handler, messages } = handlerWith();

    void handler.canUseTool('Bash', { command: 'rm -rf /tmp/x' }, liveCtx('t1'));
    void handler.canUseTool(TOOL_ASK_USER_QUESTION, QUESTION_INPUT, liveCtx('q1'));
    void handler.requestElicitation(
      { elicitationId: 'e1', serverName: 'srv', message: 'sign in', mode: 'form' },
      liveCtx('e1').signal,
    );
    handler.setPermissionMode('plan');
    // The plan prompt reads the plan file first, so it reaches its map one await later than the rest.
    void handler.canUseTool(TOOL_EXIT_PLAN_MODE, {}, liveCtx('p1'));
    await waitFor(() => messages.length === 4);

    const raised = [...messages];
    // Four kinds, so no kind can be silently missing from the re-post.
    expect(raised.map((m) => m.type).sort()).toEqual([
      'requestElicitation',
      'requestPermission',
      'requestPlanApproval',
      'requestQuestion',
    ]);
    messages.length = 0;

    handler.repostPendingPrompts();

    // Deep equality across the whole array is what pins both the payloads and their order.
    expect(messages).toEqual(raised);
  });

  it('re-posts a file approval with its diff payload intact, which nothing could rebuild later', async () => {
    const { handler, messages, platform } = handlerWith();
    stubFileOnDisk(platform, 'alpha\nbeta\n');

    void handler.canUseTool(
      'Edit',
      { file_path: '/tmp/a.txt', old_string: 'alpha', new_string: 'omega' },
      liveCtx('t1'),
    );
    await waitFor(() => handler.pendingPrompts().length > 0);

    const raised = messages.find((m) => m.type === 'requestPermission');
    expect(raised).toMatchObject({ patch: expect.stringContaining('@@ -1,2 +1,2 @@\n-alpha\n+omega\n beta') });
    expect(raised).not.toHaveProperty('originalContent');
    expect(raised).not.toHaveProperty('proposedContent');

    messages.length = 0;
    handler.repostPendingPrompts();

    expect(messages).toEqual([raised]);
  });

  it('posts nothing when no prompt is open', () => {
    const { handler, messages } = handlerWith();
    handler.repostPendingPrompts();
    expect(messages).toEqual([]);
  });
});

describe('resolveApproval settles the tool call even when the diff view will not close', () => {
  it('resolves when closing the diff tab rejects, instead of stranding the call for good', async () => {
    const { handler, platform } = handlerWith();
    stubFileOnDisk(platform, 'alpha\nbeta\n');

    const approval = handler.canUseTool(
      'Edit',
      { file_path: '/tmp/a.txt', old_string: 'alpha', new_string: 'omega' },
      liveCtx('t1'),
    );
    await waitFor(() => handler.pendingPrompts().length > 0);

    // A tab the user already closed makes the close path throw, and nothing awaits resolveApproval.
    vi.spyOn(platform.editor.diffs[0]!, 'close').mockRejectedValue(new Error('the diff tab is gone'));

    await handler.resolveApproval('t1', true);

    await expect(approval).resolves.toMatchObject({ behavior: 'allow' });
  });
});
