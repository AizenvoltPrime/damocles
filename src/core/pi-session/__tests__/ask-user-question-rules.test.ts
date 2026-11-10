import { describe, it, expect } from 'vitest';
import { ASK_AS_OFTEN_AS_NEEDED } from '../ask-user-question-rules';
import { buildPlanModeGuidance } from '../plan-mode-guidance';
import { SYSTEM_PROMPT_PREAMBLE } from '../system-prompt';
import { createAskUserQuestionTool } from '../tools/ask-user-question-tool';
import type { PiCodingAgentModule } from '../pi-loader';
import { PermissionHandler } from '../../permission-handler';
import { buildLeadSystemPrompt } from '../../team/prompts';
import { designSection, nestedDesignSection } from '../../design/guidance';
import { designRuleSet } from '../../design/rule-set';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { ASK_USER_QUESTION_LIMITS } from '../../../shared/types/permissions';

const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

type ToolShape = { description: string; parameters: { properties: { questions: { maxItems: number } } } };

describe('ASK_AS_OFTEN_AS_NEEDED', () => {
  it('names the per-call limit the tool schema and validator enforce', () => {
    const tool = createAskUserQuestionTool(pi, new PermissionHandler(createFakePlatform())) as unknown as ToolShape;
    expect(ASK_AS_OFTEN_AS_NEEDED).toContain(`up to ${ASK_USER_QUESTION_LIMITS.MAX_QUESTIONS} questions`);
    expect(tool.parameters.properties.questions.maxItems).toBe(ASK_USER_QUESTION_LIMITS.MAX_QUESTIONS);
  });

  it('reaches every prompt that tells the model to ask the user', () => {
    const tool = createAskUserQuestionTool(pi, new PermissionHandler(createFakePlatform())) as unknown as ToolShape;
    const prompts = {
      toolDescription: tool.description,
      systemPrompt: SYSTEM_PROMPT_PREAMBLE,
      planMode: buildPlanModeGuidance(),
      teamLead: buildLeadSystemPrompt('Title', 'Brief', [{ name: 'Bot', role: 'specialist', specialization: 'work' }], undefined, undefined),
      designChat: designSection('/d', designRuleSet({ designPreview: true })),
      designSubagentThatAsks: nestedDesignSection('/d', [], [], { writes: false, asks: true }),
    };
    for (const [name, prompt] of Object.entries(prompts)) expect(prompt, name).toContain(ASK_AS_OFTEN_AS_NEEDED);
  });

  it('stays out of a design subagent that cannot ask', () => {
    expect(nestedDesignSection('/d', [], [], { writes: true, asks: false })).not.toContain(ASK_AS_OFTEN_AS_NEEDED);
  });
});
