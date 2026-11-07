import { describe, it, expect } from 'vitest';
import { validateToolArguments, type Tool, type ToolCall } from '@earendil-works/pi-ai';
import type { PiCodingAgentModule } from '../../pi-loader';
import { PermissionHandler } from '../../../permission-handler';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { POLICY_BLOCK_MARKER } from '../../../../shared/types/constants';
import { QUESTION_PREVIEW_FORM } from '../../../../shared/question-preview';
import { createAskUserQuestionTool } from '../ask-user-question-tool';

type AskTool = Tool & {
  prepareArguments: (args: unknown) => unknown;
  execute: (id: string, params: unknown, signal: AbortSignal) => Promise<{ content: Array<{ text: string }> }>;
};

const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

const ask = (preview: unknown) => ({
  questions: [{
    question: 'Which layout?',
    header: 'Layout',
    multiSelect: false,
    options: [{ label: 'Grid', description: 'rows', preview }, { label: 'List', description: 'one column' }],
  }],
});

function askTool(answer?: (toolUseId: string, handler: PermissionHandler) => void): AskTool {
  const handler = new PermissionHandler(createFakePlatform());
  handler.setPostMessage((msg) => {
    if (msg.type === 'requestQuestion') answer?.(msg.toolUseId, handler);
  });
  return createAskUserQuestionTool(pi, handler) as unknown as AskTool;
}

/** pi's order for a model call: the tool's prepareArguments, then schema validation, then execute (agent-loop.js prepareToolCall). */
function preparedByPi(tool: AskTool, args: unknown): unknown {
  const prepared = tool.prepareArguments(args);
  return validateToolArguments(tool, { type: 'toolCall', id: 't1', name: tool.name, arguments: prepared as ToolCall['arguments'] });
}

describe('AskUserQuestion option previews', () => {
  it('refuses a bare string preview with a policy reason that names the typed form, ahead of pi schema validation', () => {
    const tool = askTool();

    expect(() => preparedByPi(tool, ask('<p>Two columns</p>'))).toThrow(POLICY_BLOCK_MARKER);
    expect(() => preparedByPi(tool, ask('<p>Two columns</p>'))).toThrow(QUESTION_PREVIEW_FORM);
  });

  it('refuses a design preview with a policy reason', async () => {
    const tool = askTool();

    expect(() => preparedByPi(tool, ask({ kind: 'design', path: 'designs/grid.html' }))).toThrow(/design previews are not available/);
    await expect(tool.execute('t1', ask({ kind: 'design', path: 'designs/grid.html' }), new AbortController().signal)).rejects.toThrow(POLICY_BLOCK_MARKER);
  });

  it('returns the selected option\'s typed preview to the model in annotations', async () => {
    const preview = { kind: 'markdown', content: '```ts\nconst grid = true;\n```' } as const;
    const tool = askTool((toolUseId, handler) => {
      handler.resolveQuestion(toolUseId, { 'Which layout?': 'Grid' }, { 'Which layout?': { preview } });
    });

    const args = preparedByPi(tool, ask(preview));
    const result = await tool.execute('t1', args, new AbortController().signal);

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      answers: { 'Which layout?': 'Grid' },
      annotations: { 'Which layout?': { preview } },
    });
  });
});

describe('AskUserQuestion design-kind previews (PD-18)', () => {
  const tool = (designPreviews: boolean): AskTool => createAskUserQuestionTool(pi, new PermissionHandler(createFakePlatform()), undefined, designPreviews) as unknown as AskTool;

  it('names the design kind only in a design chat, in a description fixed when the tool is built', () => {
    expect(tool(false).description).not.toContain('"kind": "design"');
    expect(tool(true).description).toContain('{ "kind": "design", "path": "variants/<option>/<screen>.html" }');
    expect(tool(true).description).toBe(tool(true).description);
  });

  it('tells the model previews work on multi-select questions, and in a design chat that one question uses one preview kind', () => {
    expect(tool(false).description).toContain('Previews work on single-select and multiSelect questions.');
    expect(tool(false).description).not.toMatch(/single-select questions \(not multiSelect\)/);
    expect(tool(false).description).not.toContain('one preview kind');
    expect(tool(true).description).toContain('One question uses one preview kind');
  });

  it('lets a design chat\'s call through to the question manager, and refuses one elsewhere before it asks', () => {
    const args = ask({ kind: 'design', path: 'variants/a/S1.html' });
    expect(preparedByPi(tool(true), args)).toEqual(args);
    expect(() => tool(false).prepareArguments(args)).toThrow(/design previews are not available in this chat/);
    expect(() => tool(true).prepareArguments(ask({ kind: 'design', path: '../../.ssh/id_rsa' }))).toThrow(/must be an \.html file of this design/);
  });
});
