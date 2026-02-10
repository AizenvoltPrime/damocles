import {
  getEntriesForPrompt,
  updateEntryDescription,
  markLowRelevance as markEntryLowRelevance,
  insertSummary,
} from './context-database';
import type { DatabaseInstance } from '../memory/types';

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type ZodZ = typeof import('zod').z;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function createContextMcpServer(
  db: DatabaseInstance,
  sessionId: string,
  promptIndex: number,
  createSdkMcpServer: SdkCreateServer,
  tool: SdkTool,
  z: ZodZ,
): ReturnType<SdkCreateServer> {
  return createSdkMcpServer({
    name: 'damocles-context',
    version: '1.0.0',
    tools: [
      tool(
        'list_prompt_entries',
        'List all auto-created context entries for the current prompt. Call this first to see what needs annotation.',
        {},
        async () => {
          const entries = getEntriesForPrompt(db, sessionId, promptIndex);
          if (entries.length === 0) return textResult('No entries for this prompt.');

          const summary = entries.map(e => ({
            id: e.id,
            file_path: e.file_path,
            entry_type: e.entry_type,
            tool_calls: (JSON.parse(e.tool_calls as string) as Array<Record<string, unknown>>).map(tc => ({
              tool_name: tc['tool_name'],
              input_summary: tc['input_summary'],
            })),
          }));
          return textResult(JSON.stringify(summary));
        },
        { annotations: { readOnlyHint: true } }
      ),

      tool(
        'update_entry_description',
        'Add a description, search tags, and related file paths to a context entry.',
        {
          entry_id: z.number().describe('The entry ID to update'),
          description: z.string().describe('1-2 sentence summary of what this tool activity accomplished'),
          tags: z.string().describe('Comma-separated keywords for search (file names, concepts, actions)'),
          related_files: z.array(z.string()).describe('Array of other file paths related to this entry'),
        },
        async (input) => {
          updateEntryDescription(db, input.entry_id, input.description, input.tags, input.related_files);
          return textResult(`Updated entry ${input.entry_id}`);
        }
      ),

      tool(
        'mark_low_relevance',
        'Mark a trivial or irrelevant entry so it is excluded from future context retrieval.',
        {
          entry_id: z.number().describe('The entry ID to mark as low relevance'),
        },
        async (input) => {
          markEntryLowRelevance(db, input.entry_id);
          return textResult(`Marked entry ${input.entry_id} as low relevance`);
        }
      ),

      tool(
        'write_prompt_summary',
        'Write an overall summary for this prompt. Call this last, after annotating all entries.',
        {
          summary: z.string().describe('1-3 sentence overall summary of what happened in this prompt'),
          tags: z.string().describe('Comma-separated keywords covering the prompt as a whole'),
        },
        async (input) => {
          insertSummary(db, sessionId, promptIndex, input.summary, input.tags);
          return textResult('Prompt summary saved.');
        }
      ),
    ],
  });
}
