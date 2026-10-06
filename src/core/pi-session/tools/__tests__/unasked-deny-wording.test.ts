import { describe, it, expect } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import { PermissionHandler } from '../../../permission-handler';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../../../shared/types/constants';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';
import { createAskUserQuestionTool } from '../ask-user-question-tool';
import { createBrowserRequestInputTool } from '../browser-request-input-tool';
import { createPlanModeTools } from '../plan-mode-tools';

type Executable = { execute: (id: string, params: unknown, signal: AbortSignal, onUpdate?: undefined, ctx?: unknown) => Promise<unknown> };

const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
const question = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] };
const form = { fields: [{ id: 'a', label: 'A', type: 'text', selector: '#a' }] };

/** A real handler. `answer` plays the user: it receives each prompt the webview would show. */
function handlerAnswering(answer: ((msg: ExtensionToWebviewMessage, handler: PermissionHandler) => void) | null): PermissionHandler {
  const handler = new PermissionHandler(createFakePlatform());
  if (answer) handler.setPostMessage((msg) => answer(msg, handler));
  handler.setPermissionMode('plan');
  handler.setPlanContentResolver(async () => '# Plan\n- step');
  return handler;
}

function tools(handler: PermissionHandler): Record<'ask' | 'form' | 'exitPlan', Executable> {
  const scope = { getCurrentPage: () => ({}), reveal: () => undefined } as never;
  return {
    ask: createAskUserQuestionTool(pi, handler) as unknown as Executable,
    form: createBrowserRequestInputTool(pi, scope, handler) as unknown as Executable,
    exitPlan: withBranch(createPlanModeTools(pi, handler)[1] as unknown as Executable),
  };
}

/** The tool context pi passes, with an empty branch for the plan version. */
function withBranch(tool: Executable): Executable {
  return { execute: (id, params, signal) => tool.execute(id, params, signal, undefined, { sessionManager: { getBranch: () => [] } }) };
}

const params = { ask: question, form, exitPlan: {} } as const;

/** The model-facing text of a deny: a thrown error's message, or an error result's text (ExitPlanMode keeps its details). */
async function rejection(promise: Promise<unknown>): Promise<string> {
  let result: { isError?: boolean; content?: Array<{ text?: string }> };
  try {
    result = (await promise) as typeof result;
  } catch (err) {
    return (err as Error).message;
  }
  if (result.isError) return result.content?.map((part) => part.text ?? '').join('') ?? '';
  throw new Error('expected the tool to deny');
}

describe('AskUserQuestion, BrowserRequestInput and ExitPlanMode word an unasked deny as policy', () => {
  for (const name of ['ask', 'form', 'exitPlan'] as const) {
    it(`${name}: no webview to ask in`, async () => {
      const message = await rejection(tools(handlerAnswering(null))[name].execute('t1', params[name], new AbortController().signal));
      expect(message).toContain(POLICY_BLOCK_MARKER);
      expect(message).not.toContain(FEEDBACK_MARKER);
    });

    it(`${name}: no tool use id`, async () => {
      const message = await rejection(tools(handlerAnswering(() => undefined))[name].execute('', params[name], new AbortController().signal));
      expect(message).toContain(POLICY_BLOCK_MARKER);
      expect(message).not.toContain(FEEDBACK_MARKER);
    });
  }

  it('ask and form: an abort before the user answered', async () => {
    for (const name of ['ask', 'form'] as const) {
      const controller = new AbortController();
      controller.abort();
      const message = await rejection(tools(handlerAnswering(() => undefined))[name].execute('t1', params[name], controller.signal));
      expect(message).toContain(POLICY_BLOCK_MARKER);
      expect(message).not.toContain(FEEDBACK_MARKER);
    }
  });

  it('exitPlan: an abort before the user answered', async () => {
    const handler = handlerAnswering(() => undefined);
    const controller = new AbortController();
    controller.abort();
    const message = await rejection(tools(handler).exitPlan.execute('t1', {}, controller.signal));
    expect(message).toContain(POLICY_BLOCK_MARKER);
    expect(message).not.toContain(FEEDBACK_MARKER);
  });

  it('ask: input the handler rejects before asking anyone', async () => {
    const message = await rejection(tools(handlerAnswering(() => undefined)).ask.execute('t1', { questions: [] }, new AbortController().signal));
    expect(message).toContain('input invalid');
    expect(message).toContain(POLICY_BLOCK_MARKER);
    expect(message).not.toContain(FEEDBACK_MARKER);
  });

  it('exitPlan: no plan file to show', async () => {
    const handler = handlerAnswering(() => undefined);
    handler.setPlanContentResolver(async () => null);
    const message = await rejection(tools(handler).exitPlan.execute('t1', {}, new AbortController().signal));
    expect(message).toContain('No plan file found');
    expect(message).toContain(POLICY_BLOCK_MARKER);
    expect(message).not.toContain(FEEDBACK_MARKER);
  });

  it('a real user cancel or revise still uses the user wording', async () => {
    const handler = handlerAnswering((msg, h) => {
      if (msg.type === 'requestQuestion') h.resolveQuestion(msg.toolUseId, null);
      if (msg.type === 'requestForm') h.resolveForm(msg.toolUseId, null);
      if (msg.type === 'requestPlanApproval') h.resolvePlanApproval(msg.toolUseId, false);
    });
    const all = tools(handler);
    for (const name of ['ask', 'form', 'exitPlan'] as const) {
      const message = await rejection(all[name].execute('t1', params[name], new AbortController().signal));
      expect(message).toContain(FEEDBACK_MARKER);
      expect(message).not.toContain(POLICY_BLOCK_MARKER);
    }
  });
});
