import { log } from '../logger';
import { haikuStructuredQuery } from './haiku-query';
import { buildDirectContext } from './recall-loop';
import type { TaskNode, NodeSummary, StructuredTurn } from './types';

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    taskDescription: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    keyDecisions: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    keyEntities: { type: 'array', items: { type: 'string' }, maxItems: 15 },
  },
  required: ['title', 'taskDescription', 'filesChanged', 'keyDecisions', 'keyEntities'],
  additionalProperties: false,
};

const SUMMARY_SYSTEM_PROMPT = `Summarize this task conversation into structured fields.
- title: concise name for the task (may improve on the original)
- taskDescription: 1-2 sentence description of what was being done
- filesChanged: list of file paths that were created or modified
- keyDecisions: 2-3 bullet points of important decisions or approaches taken
- keyEntities: technical terms, file names, concepts discussed`;

export async function generateNodeSummary(
  node: TaskNode,
  turns: StructuredTurn[],
  cwd: string,
  outcome: NodeSummary['outcome'],
  abortSignal?: AbortSignal,
): Promise<NodeSummary> {
  if (turns.length === 0) {
    return {
      title: node.title,
      taskDescription: 'No conversation turns recorded.',
      outcome,
      filesChanged: [],
      keyDecisions: [],
      keyEntities: node.keyEntities,
    };
  }

  const transcript = buildDirectContext(turns);
  const truncated = transcript.length > 100_000
    ? transcript.slice(0, 100_000) + '\n[...truncated...]'
    : transcript;

  const result = await haikuStructuredQuery<Omit<NodeSummary, 'outcome'>>({
    systemPrompt: `${SUMMARY_SYSTEM_PROMPT}\nThe task title was "${node.title}".`,
    userMessage: truncated,
    schema: SUMMARY_SCHEMA,
    cwd,
    abortSignal,
  });

  if (result) {
    result.keyEntities = result.keyEntities.filter(e => typeof e === 'string');
    result.filesChanged = result.filesChanged.filter(f => typeof f === 'string');
    result.keyDecisions = result.keyDecisions.filter(d => typeof d === 'string');
  }

  if (!result) {
    log('[SummaryGenerator] Haiku call failed, using fallback summary');
    const allFiles = new Set<string>();
    for (const turn of turns) {
      for (const f of turn.filesTouched) allFiles.add(f);
    }
    return {
      title: node.title,
      taskDescription: `Task with ${turns.length} conversation turns.`,
      outcome,
      filesChanged: [...allFiles],
      keyDecisions: [],
      keyEntities: node.keyEntities,
    };
  }

  return { ...result, outcome };
}
