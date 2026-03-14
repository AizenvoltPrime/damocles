import { describe, it, expect, vi } from 'vitest';
import type { RecallConfig, StructuredTurn } from '../types';
import { DIRECT_CONTEXT_THRESHOLD } from '../types';
import { createCardGameHistory, createWebAppHistory, createLargeHistory } from './fixtures/histories';
import { createReplMockSdkQuery, scoreRetrieval } from './fixtures/mock-sdk';
import type { MockReplResponse } from './fixtures/mock-sdk';

function makeDefaultConfig(): RecallConfig {
  return {
    enabled: true,
    subcallModel: 'claude-haiku-4-5-20251001',
    maxIterations: 15,
    maxInjectedChars: 200_000,
  };
}

function defaultOptions(overrides: Partial<{
  config: RecallConfig;
  cwd: string;
  model: string;
  intentContext: { intent: string; keyEntities: string[] };
}> = {}) {
  return {
    config: makeDefaultConfig(),
    cwd: '/test',
    model: 'test-model',
    intentContext: { intent: 'general' as string, keyEntities: [] as string[] },
    ...overrides,
  };
}

function padHistory(history: StructuredTurn[]): StructuredTurn[] {
  const totalChars = history.reduce((sum, t) => sum + t.userMessage.length + t.assistantResponse.length, 0);
  if (totalChars > DIRECT_CONTEXT_THRESHOLD + 2000) return history;

  const deficit = DIRECT_CONTEXT_THRESHOLD + 2000 - totalChars;
  const padPerTurn = Math.ceil(deficit / history.length);

  return history.map(t => ({
    ...t,
    assistantResponse: t.assistantResponse + '\n\n' +
      'I also reviewed the surrounding code for consistency and made minor adjustments to ensure compatibility. '.repeat(Math.ceil(padPerTurn / 105)),
  }));
}

async function setupWithMock(responses: MockReplResponse[]) {
  vi.resetModules();
  vi.doMock('../../logger', () => ({ log: vi.fn() }));

  const mock = createReplMockSdkQuery(responses);
  vi.doMock('../../shared/sdk-loader', () => ({
    loadSdkQuery: () => mock,
  }));

  const module = await import('../recall-loop');
  return module.runRecallLoop;
}

// ─────────────────────────────────────────────────────────────────────────────
// Golden-set retrieval tests
//
// These run the FULL runRecallLoop with a mock SDK that returns realistic
// REPL code. The REPL sandbox executes real JavaScript against real history
// data, so these validate the entire retrieval pipeline from prompt to context.
//
// Requirements for the REPL loop to execute (not short-circuit):
//   1. History total chars > DIRECT_CONTEXT_THRESHOLD (12K)
//   2. Prompt must NOT be vague (>60 chars, or contain file paths/extensions)
// ─────────────────────────────────────────────────────────────────────────────

describe('golden-set retrieval: keyword search', () => {
  it('finds turns mentioning InputManager in assistant responses', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `I'll search for mentions of InputManager.\n\`\`\`repl\nconst matches = context.filter(t =>\n  t.assistantResponse.toLowerCase().includes('inputmanager') ||\n  t.userMessage.toLowerCase().includes('inputmanager')\n);\nconst output = matches.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'what did you say about the InputManager autoload singleton in the project structure earlier?',
      7,
      defaultOptions({ intentContext: { intent: 'recall', keyEntities: ['InputManager'] } }),
    );

    expect(result.context).not.toBeNull();
    expect(result.context).toContain('InputManager');
    const score = scoreRetrieval(result.context!, [0, 1], history);
    expect(score.recall).toBeGreaterThanOrEqual(0.5);
    expect(result.trajectory.shortCircuited).toBe(false);
    expect(result.trajectory.iterations).toHaveLength(1);
  });

  it('finds turns mentioning hover flickering bug', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `Searching for the flickering bug.\n\`\`\`repl\nconst matches = context.filter(t =>\n  t.userMessage.toLowerCase().includes('flicker') ||\n  t.assistantResponse.toLowerCase().includes('flicker')\n);\nconst output = matches.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'can you show me the bug with hover flickering that was caused by the z-index race condition?',
      7,
      defaultOptions({ intentContext: { intent: 'debug', keyEntities: ['flickering', 'hover'] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [3], history);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(result.context).toContain('z-index race condition');
  });

  it('finds turns about mana system across multiple turns', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `Let me find all mana-related turns.\n\`\`\`repl\nconst matches = context.filter(t =>\n  t.userMessage.toLowerCase().includes('mana') ||\n  t.assistantResponse.toLowerCase().includes('mana')\n);\nconst output = matches.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'what about the mana system and the bug where mana was not resetting at the start of each turn?',
      7,
      defaultOptions({ intentContext: { intent: 'recall', keyEntities: ['mana'] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [5, 6], history);
    expect(score.recall).toBe(1);
    expect(result.context).toContain('ManaSystem');
  });

  it('searches user messages for CORS error', async () => {
    const history = padHistory(createWebAppHistory());
    const runRecallLoop = await setupWithMock([{
      text: `Searching for CORS-related turns.\n\`\`\`repl\nconst matches = context.filter(t =>\n  t.userMessage.toLowerCase().includes('cors') ||\n  t.assistantResponse.toLowerCase().includes('cors')\n);\nconst output = matches.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'how did you fix the CORS issue with the localhost:3001 API requests that was blocking the frontend?',
      6,
      defaultOptions({ intentContext: { intent: 'recall', keyEntities: ['CORS'] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [3], history);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
  });
});

describe('golden-set retrieval: file-based search', () => {
  it('finds turns that touched HandDisplay.gd', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `Searching for HandDisplay file changes.\n\`\`\`repl\nconst matches = context.filter(t =>\n  t.filesTouched.some(f => f.includes('HandDisplay'))\n);\nconst output = matches.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'show me all the changes and modifications you made to the HandDisplay.gd file throughout our session',
      7,
      defaultOptions({ intentContext: { intent: 'feature', keyEntities: ['HandDisplay.gd'] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [2, 3], history);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
  });

  it('finds turns that touched Prisma schema', async () => {
    const history = padHistory(createWebAppHistory());
    const runRecallLoop = await setupWithMock([{
      text: `Searching for Prisma-related files.\n\`\`\`repl\nconst matches = context.filter(t =>\n  t.filesTouched.some(f => f.includes('prisma'))\n);\nconst output = matches.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'what did we set up in the Prisma schema and database configuration for the PostgreSQL backend?',
      6,
      defaultOptions({ intentContext: { intent: 'recall', keyEntities: ['Prisma', 'schema'] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [2], history);
    expect(score.recall).toBe(1);
  });

  it('finds turns by tool call name (Write operations)', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `Finding all file creation operations.\n\`\`\`repl\nconst writes = context.filter(t =>\n  t.toolCalls.some(tc => tc.name === 'Write' && tc.input.file_path?.includes('.gd'))\n);\nconst output = writes.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nFiles: \${t.filesTouched.join(', ')}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'which GDScript files did you create during the Godot card game project setup and feature implementation?',
      7,
      defaultOptions({ intentContext: { intent: 'feature', keyEntities: ['GDScript', '.gd'] } }),
    );

    expect(result.context).not.toBeNull();
    expect(result.context).toContain('.gd');
  });
});

describe('golden-set retrieval: multi-iteration', () => {
  it('handles two iterations: explore then finalize', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([
      {
        text: `Let me first explore the history.\n\`\`\`repl\nconsole.log(\`Total turns: \${context.length}\`);\nconst topics = context.map(t => t.userMessage.slice(0, 50));\nconsole.log(topics.join('\\n'));\n\`\`\``,
      },
      {
        text: `Found what I need. The turn system is in turns 5-6.\n\`\`\`repl\nconst relevant = context.filter(t => t.promptIndex >= 5);\nconst output = relevant.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
      },
    ]);

    const result = await runRecallLoop(
      history,
      'tell me about the turn system implementation including the state machine phases and mana integration',
      7,
      defaultOptions({ intentContext: { intent: 'explain', keyEntities: ['turn system'] } }),
    );

    expect(result.context).not.toBeNull();
    expect(result.trajectory.iterations).toHaveLength(2);
    const score = scoreRetrieval(result.context!, [5, 6], history);
    expect(score.recall).toBe(1);
  });

  it('handles code error in first iteration then recovers', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([
      {
        text: `\`\`\`repl\nconst result = undefinedVariable.map(x => x);\n\`\`\``,
      },
      {
        text: `Let me fix that.\n\`\`\`repl\nconst matches = context.filter(t => t.userMessage.includes('drag'));\nconst output = matches.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
      },
    ]);

    const result = await runRecallLoop(
      history,
      'show me the drag and drop implementation for the Card scene including the Area2D input handling',
      7,
      defaultOptions({ intentContext: { intent: 'explain', keyEntities: ['drag and drop'] } }),
    );

    expect(result.context).not.toBeNull();
    expect(result.trajectory.iterations).toHaveLength(2);
    expect(result.trajectory.iterations[0]!.replOutput).toContain('Error');
    const score = scoreRetrieval(result.context!, [1], history);
    expect(score.recall).toBe(1);
  });
});

describe('golden-set retrieval: FINAL variants', () => {
  it('handles FINAL_VAR resolution', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `\`\`\`repl\nconst deckTurns = context.filter(t => t.userMessage.toLowerCase().includes('deck'));\nconst output = deckTurns.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL_VAR("output");\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'what about the deck data structure and the JSON card definitions loader implementation?',
      7,
      defaultOptions({ intentContext: { intent: 'recall', keyEntities: ['deck'] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [4], history);
    expect(score.recall).toBe(1);
  });

  it('handles inline FINAL in model text (no code block)', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `The user is asking about the card scene. Let me return the relevant turn directly.\n\nFINAL("[Prompt 1] User: Now add a Card scene with drag and drop functionality\\nAssistant: I've created a Card scene with drag and drop.")`,
    }]);

    const result = await runRecallLoop(
      history,
      'tell me about the Card scene implementation, including the drag and drop and collision detection setup',
      7,
      defaultOptions({ intentContext: { intent: 'explain', keyEntities: ['Card'] } }),
    );

    expect(result.context).not.toBeNull();
    expect(result.context).toContain('[Prompt 1]');
    expect(result.context).toContain('drag and drop');
  });

  it('handles FINAL with template literal containing variable references', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `\`\`\`repl\nconst match = context.find(t => t.promptIndex === 4);\nconst result = \`[Prompt \${match.promptIndex}] User: \${match.userMessage}\\nAssistant: \${match.assistantResponse}\`;\nFINAL(result);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'show me the DeckLoader implementation details including the JSON schema validation and CardData resource',
      7,
      defaultOptions({ intentContext: { intent: 'explain', keyEntities: ['DeckLoader'] } }),
    );

    expect(result.context).not.toBeNull();
    expect(result.context).toContain('[Prompt 4]');
    expect(result.context).toContain('DeckLoader');
  });
});

describe('golden-set retrieval: combined search strategies', () => {
  it('combines keyword and file-based search', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `I need to combine keyword and file search.\n\`\`\`repl\nconst byKeyword = context.filter(t =>\n  t.assistantResponse.toLowerCase().includes('turn') ||\n  t.userMessage.toLowerCase().includes('turn')\n);\nconst byFile = context.filter(t =>\n  t.filesTouched.some(f => f.includes('TurnManager'))\n);\nconst combined = [...new Set([...byKeyword, ...byFile])];\nconst output = combined.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'show me everything about the turn system implementation and all changes to the TurnManager.gd file',
      7,
      defaultOptions({ intentContext: { intent: 'explain', keyEntities: ['turn system', 'TurnManager'] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [5, 6], history);
    expect(score.recall).toBe(1);
  });

  it('uses llm_query for summarization within REPL', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `\`\`\`repl\nconst allBugs = context.filter(t =>\n  t.userMessage.toLowerCase().includes('bug') ||\n  t.assistantResponse.toLowerCase().includes('fixed')\n);\nconst summaries = await llm_query_batched(\n  allBugs.map(t => \`Summarize this bug fix: \${t.assistantResponse.slice(0, 500)}\`)\n);\nconst output = allBugs.map((t, i) =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nSummary: \${summaries[i]}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'summarize all the bugs we fixed during this session, including the hover flickering and the mana reset issue',
      7,
      defaultOptions({ intentContext: { intent: 'recall', keyEntities: ['bugs', 'fixed'] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [3, 6], history);
    expect(score.recall).toBe(1);
    expect(result.trajectory.iterations[0]!.subcalls.length).toBeGreaterThan(0);
  });

  it('handles recent-turns search for temporal queries', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `The user wants recent context.\n\`\`\`repl\nconst recent = context.slice(-2);\nconst output = recent.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'what did we just work on in the last couple of turns, including the mana system and TurnManager changes?',
      7,
      defaultOptions({ intentContext: { intent: 'general', keyEntities: [] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [5, 6], history);
    expect(score.recall).toBe(1);
  });
});

describe('golden-set retrieval: large history', () => {
  it('searches 50-turn history and finds specific topic', async () => {
    const history = padHistory(createLargeHistory(50));
    const runRecallLoop = await setupWithMock([{
      text: `\`\`\`repl\nconst matches = context.filter(t =>\n  t.userMessage.toLowerCase().includes('authentication') ||\n  t.filesTouched.some(f => f.includes('authentication'))\n);\nconsole.log(\`Found \${matches.length} matches in \${context.length} turns\`);\nconst output = matches.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'show me all the authentication module implementations including JWT setup, refresh tokens, and session expiry fixes',
      50,
      defaultOptions({ intentContext: { intent: 'recall', keyEntities: ['authentication', 'JWT'] } }),
    );

    expect(result.context).not.toBeNull();
    expect(result.context).toContain('authentication');
    const authTurnIndices = history
      .filter(t => t.userMessage.toLowerCase().includes('authentication'))
      .map(t => t.promptIndex);
    expect(authTurnIndices.length).toBeGreaterThan(0);
    const score = scoreRetrieval(result.context!, authTurnIndices, history);
    expect(score.recall).toBeGreaterThanOrEqual(0.5);
  });

  it('pipeline completes within trajectory metadata bounds', async () => {
    const history = padHistory(createLargeHistory(30));
    const runRecallLoop = await setupWithMock([{
      text: `\`\`\`repl\nconst recent = context.slice(-3);\nconst output = recent.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'show me the most recent work items from the last few turns including implementation details and decisions',
      30,
      defaultOptions(),
    );

    expect(result.trajectory.turnCount).toBe(30);
    expect(result.trajectory.historyChars).toBeGreaterThan(0);
    expect(result.trajectory.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.trajectory.iterations).toHaveLength(1);
    expect(result.trajectory.forcedAnswer).toBe(false);
    expect(result.trajectory.timedOut).toBe(false);
  });
});

describe('golden-set retrieval: edge cases', () => {
  it('handles empty search results gracefully', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([
      {
        text: `\`\`\`repl\nconst matches = context.filter(t =>\n  t.userMessage.toLowerCase().includes('kubernetes')\n);\nconsole.log(\`Found \${matches.length} matches\`);\n\`\`\``,
      },
      {
        text: `No matches found. Returning recent context as fallback.\n\`\`\`repl\nconst recent = context.slice(-2);\nconst output = recent.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
      },
    ]);

    const result = await runRecallLoop(
      history,
      'show the Kubernetes deployment configuration and the container orchestration setup we discussed earlier',
      7,
      defaultOptions({ intentContext: { intent: 'feature', keyEntities: ['Kubernetes'] } }),
    );

    expect(result.context).not.toBeNull();
    expect(result.trajectory.iterations).toHaveLength(2);
  });

  it('handles REPL variable persistence across iterations', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([
      {
        text: `\`\`\`repl\nconst bugTurns = context.filter(t => t.userMessage.toLowerCase().includes('bug'));\nconsole.log(\`Found \${bugTurns.length} bug-related turns\`);\n\`\`\``,
      },
      {
        text: `Good, I found bug turns. Now let me format them.\n\`\`\`repl\nconst output = bugTurns.map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('\\n\\n');\nFINAL(output);\n\`\`\``,
      },
    ]);

    const result = await runRecallLoop(
      history,
      'list all the bugs we encountered and fixed during this card game development session in Godot',
      7,
      defaultOptions({ intentContext: { intent: 'debug', keyEntities: ['bugs'] } }),
    );

    expect(result.context).not.toBeNull();
    const score = scoreRetrieval(result.context!, [3, 6], history);
    expect(score.recall).toBe(1);
  });

  it('handles abort signal during loop', async () => {
    const history = padHistory(createCardGameHistory());
    const controller = new AbortController();

    const runRecallLoop = await setupWithMock([{
      text: `\`\`\`repl\nconsole.log('this should execute');\n\`\`\``,
    }]);

    controller.abort();

    const result = await runRecallLoop(
      history,
      'test abort signal handling during the recall loop execution to verify clean shutdown behavior',
      7,
      { ...defaultOptions(), abortSignal: controller.signal },
    );

    expect(result.trajectory.iterations).toHaveLength(0);
  });

  it('produces valid trajectory for each retrieval', async () => {
    const history = padHistory(createCardGameHistory());
    const runRecallLoop = await setupWithMock([{
      text: `\`\`\`repl\nconst output = context.slice(-1).map(t =>\n  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`\n).join('');\nFINAL(output);\n\`\`\``,
    }]);

    const result = await runRecallLoop(
      history,
      'show me the most recent turn in the conversation history to verify the trajectory metadata is correct',
      7,
      defaultOptions(),
    );

    expect(result.trajectory.promptIndex).toBe(7);
    expect(result.trajectory.userPrompt).toContain('show me the most recent turn');
    expect(result.trajectory.turnCount).toBe(history.length);
    expect(result.trajectory.iterations).toHaveLength(1);
    expect(result.trajectory.iterations[0]!.codeBlock).not.toBeNull();
    expect(result.trajectory.iterations[0]!.replOutput).not.toBeNull();
    expect(result.trajectory.iterations[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('golden-set retrieval: scoring validation', () => {
  it('perfect precision and recall for exact match', () => {
    const history = createCardGameHistory();
    const context = '[Prompt 3] User: bug\nAssistant: fixed\n\n[Prompt 6] User: mana\nAssistant: reset';
    const score = scoreRetrieval(context, [3, 6], history);

    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.f1).toBe(1);
    expect(score.retrievedIndices).toEqual([3, 6]);
  });

  it('partial recall when some expected turns are missing', () => {
    const history = createCardGameHistory();
    const context = '[Prompt 5] User: turn system\nAssistant: implemented';
    const score = scoreRetrieval(context, [5, 6], history);

    expect(score.precision).toBe(1);
    expect(score.recall).toBe(0.5);
    expect(score.f1).toBeCloseTo(2 / 3, 5);
  });

  it('low precision when irrelevant turns are included', () => {
    const history = createCardGameHistory();
    const context = '[Prompt 0] User: project\n\n[Prompt 1] User: card\n\n[Prompt 2] User: hand\n\n[Prompt 3] User: bug';
    const score = scoreRetrieval(context, [3], history);

    expect(score.precision).toBe(0.25);
    expect(score.recall).toBe(1);
  });

  it('handles empty retrieved context', () => {
    const history = createCardGameHistory();
    const score = scoreRetrieval('No relevant context found.', [3, 6], history);

    expect(score.precision).toBe(0);
    expect(score.recall).toBe(0);
    expect(score.f1).toBe(0);
    expect(score.retrievedIndices).toEqual([]);
  });
});
