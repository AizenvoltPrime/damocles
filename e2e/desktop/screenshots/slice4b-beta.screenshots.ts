import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { seedStubModel } from '../support/hermetic';
import { startOpenAIStub } from '../support/openai-stub';
import { hostMessage, openProjectChat, settled, shoot, shootReferences } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { chatInput, hostMessages, recordHostMessages, sendAndAwaitEcho } from '../support/ui';

// Review captures of beta's slice 4b overlays and the composer model popover beside the design reference.

/** Runs `body` against the chat page's Pinia stores, for overlay states the stub model cannot reach. */
async function withStores(tab: Page, body: string, arg: unknown = null): Promise<void> {
  await tab.evaluate(([code, payload]) => {
    type PiniaHost = { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, unknown> } } } } };
    const stores = (document.querySelector('#app') as unknown as PiniaHost).__vue_app__.config.globalProperties.$pinia._s;
    new Function('store', 'arg', code)((id: string) => stores.get(id), payload);
  }, [body, arg] as const);
  await settled(tab);
}

/**
 * A mouse press on the transcript before a store-driven open, so the capture shows focus as after a mouse
 * open: Chromium draws :focus-visible on the overlay's focused close button only when the last input was a key.
 */
async function pointerFirst(tab: Page): Promise<void> {
  await tab.mouse.click(450, 260);
}

const MIN = 60_000;

/** The reference's sample team (Chat Panel.dc.html `teamSeed`) as a TeamState, so the two captures compare like for like. */
function sampleTeam(now: number) {
  const member = (agentId: string, name: string, role: 'lead' | 'specialist', specialization: string, status: string, over: Record<string, unknown> = {}) => ({
    agentId, name, role, specialization, model: 'Stub model', profileId: null, attempt: 0, status,
    activeMs: 0, runningSince: status === 'running' ? now - 2 * MIN : null, toolCount: 8, lastToolName: 'Bash',
    totalInputTokens: 4_000, totalOutputTokens: 9_000, cacheReadTokens: 48_000, cacheCreationTokens: 2_000, costUsd: 0.14,
    dollarBilled: true, effort: 'high', progressSummary: null, result: null, logFilePath: `C:/logs/${name.toLowerCase()}.jsonl`, ...over,
  });
  const messages: Array<[string, string | null, string]> = [
    ['Atlas', null, 'Kickoff: lock an account for 15 minutes after 10 failed logins. Mira implements, Theo reviews, Nova adds edge-case tests, Iris updates the docs.'],
    ['Atlas', 'Mira', 'Lockout lives in `src/auth/lockout.ts`, reuse the users table, no new service.'],
    ['Theo', 'Atlas', 'Ready to review once the diff lands. I will check that a locked account returns the same 401 as a bad password.'],
    ['Iris', 'Atlas', 'Docs updated in `docs/security.md`. Done on my side.'],
    ['Mira', null, 'Wrote `lockout.ts` and migration `0019_lockout.sql`. Running the new tests now.'],
  ];
  const scratchpad: Array<[string, string, number, string]> = [
    ['plan', 'Atlas', 2, '- Count failures per account in `users.failed_attempts`\n- Lock for 15 minutes after 10 failures via `locked_until`\n- Reset the count on a successful login'],
    ['decisions', 'Atlas', 1, '- A locked account returns the same 401 body as a wrong password\n- No email alerts in this change'],
    ['test-plan', 'Nova', 1, '- Two failed logins at the same instant count as two\n- Unlock exactly at 15:00, not 14:59'],
  ];
  return {
    teamId: 'tm1', toolUseId: 'tc-team', title: 'Per-account lockout after repeated failures', status: 'running', phase: 'working',
    agents: [
      member('ag1', 'Atlas', 'lead', 'Splits the work, keeps the scratchpad current and writes the final summary.', 'running', { lastToolName: 'team_send_message' }),
      member('ag2', 'Mira', 'specialist', 'Writes the lockout module, the migration and the tests.', 'running', { effort: 'medium', toolCount: 22, progressSummary: 'Running the lockout tests' }),
      member('ag3', 'Theo', 'specialist', 'Reviews the diff for races, timing leaks and lockout used as denial of service.', 'awaiting-review', { toolCount: 11, lastToolName: 'Grep' }),
      member('ag4', 'Nova', 'specialist', 'Adds edge-case tests: parallel failures, the unlock boundary and a correct password while locked.', 'standby', { effort: 'medium', toolCount: 6, lastToolName: 'Read' }),
      member('ag5', 'Iris', 'specialist', 'Updates the security and API docs to describe the lockout.', 'completed', { effort: 'low', activeMs: 64_000, toolCount: 11, lastToolName: 'Edit' }),
    ],
    messages: messages.map(([from, to, content], i) => ({
      messageId: `m${i}`, senderAgentId: '', senderName: from, recipientAgentId: null, recipientName: to, content, timestamp: now - (5 - i) * 25_000,
    })),
    scratchpad: scratchpad.map(([section, agentName, version, content], i) => ({ section, agentName, agentId: '', version, content, timestamp: now - (3 - i) * 30_000 })),
    result: null, startTime: now - 3 * MIN, endTime: null, totalToolCount: 58,
    runs: [{ toolUseId: 'tc-team', status: 'running', startTime: now - 134_000, endTime: null, toolCount: 58, usage: { totalInputTokens: 20_000, totalOutputTokens: 45_000, cacheReadTokens: 240_000, cacheCreationTokens: 10_000, costUsd: 0.45 } }],
  };
}

const MIRA_HISTORY = [
  { id: 'h0', role: 'user', content: [{ type: 'text', text: 'Implement the lockout in src/auth/lockout.ts with a migration adding users.failed_attempts and users.locked_until. Add tests in test/lockout.spec.ts.' }] },
  { id: 'h1', role: 'user', content: [{ type: 'text', text: '[Message from Atlas]: Lockout lives in src/auth/lockout.ts, reuse the users table, no new service.' }] },
  { id: 'h2', role: 'assistant', content: [
    { type: 'thinking', thinking: 'Two new columns on users, then a small module the login route can call. Check the schema first.' },
    { type: 'text', text: 'Lockout module and migration are in. Running the new tests.' },
    { type: 'tool_use', id: 'z5', name: 'Bash', input: { command: 'npm test -- lockout' } },
  ] },
];

function sampleSubagent(now: number) {
  const grep = { id: 'g9', name: 'Grep', input: { pattern: 'router.post', path: 'src/routes' }, status: 'completed', result: 'src/routes/auth.ts:5', durationMs: 84 };
  return {
    id: 'tc-sub', agentType: 'code-reviewer', description: 'Check the other auth routes for brute-force gaps',
    prompt: 'Review src/routes/auth.ts and the session middleware for routes that accept credentials without a limiter.',
    status: 'running', startTime: now - 47_000, isBackground: true, sdkAgentId: 'agent-7', model: 'Stub model', effort: 'high',
    messagesSealed: false, toolCalls: [], progressSummary: 'Reading src/middleware/session.ts',
    usage: { totalInputTokens: 1_000, totalOutputTokens: 3_000, cacheReadTokens: 26_000, cacheCreationTokens: 1_000, costUsd: 0.06 },
    dollarBilled: true,
    messages: [{
      id: 's-m1', role: 'assistant', content: '', timestamp: now - 40_000,
      contentBlocks: [{ type: 'text', text: 'Looking for every route that accepts a password or a token.' }, { type: 'tool_use', id: grep.id, name: grep.name, input: grep.input }],
      toolCalls: [grep],
    }],
  };
}

const SAMPLE_SERVERS = [
  { name: 'github', status: 'connected', enabled: true, source: 'damocles', readonly: false, editableConfig: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    description: 'Issues, pull requests and code search on GitHub.', serverInfo: { name: 'github-mcp', version: '2.1.0' },
    tools: [
      { name: 'search_code', exposure: 'deferred', exposureSource: 'config', configExposure: 'deferred', annotations: { readOnly: true, openWorld: true }, description: 'Search code across repositories' },
      { name: 'create_pull_request', exposure: 'direct', exposureSource: 'user', configExposure: 'deferred', annotations: { destructive: true }, description: 'Open a pull request' },
      { name: 'merge_pull_request', exposure: 'off', exposureSource: 'user', configExposure: 'deferred', annotations: { destructive: true }, description: 'Merge a pull request' },
    ] },
  { name: 'sentry', status: 'needs-auth', enabled: true, source: 'claude', supportsOAuth: true, tools: [] },
  { name: 'linear', status: 'disabled', enabled: false, source: 'workspace', tools: [] },
  { name: 'postgres', status: 'failed', enabled: true, source: 'codex', error: 'spawn psql-mcp ENOENT', stderrTail: 'psql-mcp: command not found', tools: [] },
];

const SAMPLE_TOOLS = {
  groups: [
    { group: 'memory', enabled: true, available: true },
    { group: 'browser', enabled: false, available: true },
    { group: 'core', enabled: true, available: true },
  ],
  tools: [
    { name: 'SaveMemory', label: 'SaveMemory', description: 'Save a fact, preference or episode', group: 'memory', toggleable: true, enabled: true },
    { name: 'SearchMemories', label: 'SearchMemories', description: 'Semantically search memories', group: 'memory', toggleable: true, enabled: true },
    { name: 'BrowserNavigate', label: 'BrowserNavigate', description: 'Open a URL in the agent’s tab', group: 'browser', toggleable: true, enabled: false },
    { name: 'read', label: 'Read', description: 'Read a file', group: 'core', toggleable: false, enabled: true },
    { name: 'bash', label: 'Bash', description: 'Run a shell command', group: 'core', toggleable: false, enabled: true },
    { name: 'YouTubeTranscript', label: 'YouTubeTranscript', description: 'Fetch a video transcript', group: 'core', toggleable: true, enabled: false },
  ],
};

test('model popover and agent overlays beside the reference', async ({ home, launch }, testInfo) => {
  test.setTimeout(600_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    await setContentSize(app, 1280, 860);
    await sendAndAwaitEcho(tab, 'Rate-limit the /login route');

    await shootReferences(app, testInfo, [
      { name: 'model-popover', setup: "logic.setState({ menu: 'model' });" },
      { name: 'team-agents', setup: "logic.openOv('team', { ovRef: 'tm1', teamTab: 'agents' });" },
      { name: 'team-timeline', setup: "logic.openOv('team', { ovRef: 'tm1', teamTab: 'timeline' });" },
      { name: 'team-scratchpad', setup: "logic.openOv('team', { ovRef: 'tm1', teamTab: 'scratchpad' });" },
      { name: 'team-agent', setup: "logic.openOv('teamAgent', { ovRef: 'ag2', ovTeam: 'tm1' });" },
      { name: 'subagent', setup: "logic.openOv('subagent', { ovRef: 's2' });" },
      { name: 'mcp', setup: "logic.openOv('mcp');" },
      { name: 'mcp-form', setup: "logic.openOv('mcp'); logic.openMcpForm(null);" },
      { name: 'tools', setup: "logic.openOv('tools');" },
      { name: 'bg-tasks', setup: "logic.openOv('bgTasks');" },
      { name: 'tool', setup: "logic.openOv('tool', { ovRef: 'g1' });" },
    ]);

    await shoot(app, tab, testInfo, 'model-popover', async () => {
      if (await tab.getByTestId('composer-model-menu').count() === 0) await tab.getByTestId('composer-model').click();
      await expect(tab.getByTestId('composer-model-menu')).toBeVisible();
    });
    await tab.keyboard.press('Escape');

    const now = Date.now();
    await pointerFirst(tab);
    await withStores(tab, "const s = store('team'); s.handleTeamStarted(arg); s.openOverlay('tm1');", sampleTeam(now));
    await expect(tab.getByRole('tablist')).toBeVisible();
    for (const view of ['agents', 'timeline', 'scratchpad'] as const) {
      await tab.getByTestId(`team-tab-${view}`).click();
      await shoot(app, tab, testInfo, `team-${view}`);
    }

    await tab.getByTestId('team-tab-agents').click();
    await withStores(tab, "store('team').handleAgentDataLoaded('ag2', arg);", MIRA_HISTORY);
    await tab.getByRole('button', { name: 'Open agent Mira' }).click();
    await expect(tab.getByTestId('agent-prompt')).toBeVisible();
    await shoot(app, tab, testInfo, 'team-agent');
    await tab.keyboard.press('Escape');
    await tab.keyboard.press('Escape');

    await pointerFirst(tab);
    await withStores(tab, "const s = store('subagent'); s.subagents = { ...s.subagents, [arg.id]: arg }; s.expandSubagent(arg.id);", sampleSubagent(now));
    await expect(tab.getByTestId('agent-steer-bar')).toBeVisible();
    await shoot(app, tab, testInfo, 'subagent');

    await tab.getByRole('dialog').last().locator('h2').click();
    await withStores(tab, "store('ui').expandTool('g9', 'subagent');");
    await expect(tab.getByRole('dialog')).toHaveCount(2);
    await shoot(app, tab, testInfo, 'tool');
    await tab.keyboard.press('Escape');
    await tab.keyboard.press('Escape');

    await pointerFirst(tab);
    await withStores(tab, "const s = store('backgroundTasks'); s.handleTaskStarted(arg); s.handleTaskStarted({ taskId: 't2', toolUseId: 'none', description: 'npm run build -- --watch', status: 'completed' }); s.openOverlay();", { taskId: 't1', toolUseId: 'tc-sub', description: 'Check the other auth routes', status: 'running' });
    await expect(tab.getByTestId('bg-subagent-row')).toBeVisible();
    await shoot(app, tab, testInfo, 'bg-tasks');
    await tab.keyboard.press('Escape');

    await pointerFirst(tab);
    // The panel re-reads the MCP config when it mounts, so the sample servers go in after the host's reply.
    await recordHostMessages(tab);
    const statuses = (await hostMessages(tab, 'mcpServerStatus')).length;
    await withStores(tab, "store('ui').openMcpPanel();");
    await expect.poll(async () => (await hostMessages(tab, 'mcpServerStatus')).length).toBeGreaterThan(statuses);
    await withStores(tab, "store('settings').setMcpServers(arg);", SAMPLE_SERVERS);
    await expect(tab.getByTestId('mcp-server-row').first()).toBeVisible();
    await tab.getByRole('button', { name: /3 tools/ }).first().click();
    await shoot(app, tab, testInfo, 'mcp');
    await tab.getByTestId('mcp-add-server').click();
    await expect(tab.getByTestId('mcp-server-form')).toBeVisible();
    await shoot(app, tab, testInfo, 'mcp-form');
    await tab.keyboard.press('Escape');
    await tab.keyboard.press('Escape');

    await pointerFirst(tab);
    await withStores(tab, "store('ui').openToolsPanel();");
    await withStores(tab, "store('settings').setToolsSnapshot(arg);", SAMPLE_TOOLS);
    await expect(tab.getByTestId('tools-group').first()).toBeVisible();
    await shoot(app, tab, testInfo, 'tools');
  } finally {
    await stub.close();
  }
});

/** Scrolls the reference transcript so the element whose own text is `text` sits mid-viewport. */
const referenceScrollTo = (text: string): string =>
  `const el = [...document.querySelectorAll('span,div')].find((node) => node.childElementCount === 0 && node.textContent?.trim() === ${JSON.stringify(text)});
   if (!el) throw new Error('no reference element for ' + ${JSON.stringify(text)});
   el.scrollIntoView({ block: 'center' });`;

/** One assistant turn holding a completed Read, an Edit awaiting approval, a running Bash, a background subagent and a team. */
function cardTurn(now: number) {
  const read = { id: 'c-read', name: 'Read', input: { file_path: 'src/routes/auth.ts' }, status: 'completed', result: '1\timport { Router } from "express";', durationMs: 12 };
  const edit = {
    id: 'c-edit', name: 'Edit', status: 'awaiting_approval',
    input: { file_path: 'src/routes/auth.ts', old_string: "router.post('/login', async (req, res) => {", new_string: "const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 });\n\nrouter.post('/login', loginLimiter, async (req, res) => {" },
  };
  const bash = { id: 'c-bash', name: 'Bash', input: { command: 'npm test -- test/auth.spec.ts' }, status: 'running', liveOutput: ' RUN  v3.2.4\n ✓ test/auth.spec.ts > login > rejects a wrong password\n ✓ test/auth.spec.ts > login > issues a session\n' };
  const agent = { id: 'tc-sub', name: 'Agent', input: { description: 'Check the other auth routes for brute-force gaps', subagent_type: 'code-reviewer', run_in_background: true }, status: 'running' };
  const team = { id: 'tc-team', name: 'create_team', input: { title: 'Per-account lockout after repeated failures' }, status: 'running' };
  const calls = [read, bash, agent, team, edit];
  return {
    role: 'assistant', content: '', timestamp: now,
    contentBlocks: calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
    toolCalls: calls,
  };
}

const CARD_TASKS = [
  { id: '1', subject: 'Add a limiter to /login', status: 'in_progress', activeForm: 'Adding the limiter' },
  { id: '2', subject: 'Run the auth tests', status: 'pending' },
  { id: '3', subject: 'Summarize the change', status: 'pending' },
];

test('message cards beside the reference', async ({ home, launch }, testInfo) => {
  test.setTimeout(600_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    await setContentSize(app, 1280, 860);
    await sendAndAwaitEcho(tab, 'Rate-limit the /login route');

    await shootReferences(app, testInfo, [
      { name: 'card-tool', setup: referenceScrollTo('rateLimit|express-rate-limit') },
      { name: 'card-edit', setup: referenceScrollTo('+7 −0') },
      { name: 'card-agent', setup: referenceScrollTo('Check the other auth routes for brute-force gaps') },
      { name: 'card-team', setup: referenceScrollTo('Per-account lockout after repeated failures') },
      { name: 'card-tasks', setup: referenceScrollTo('Add a limiter to /login') },
    ]);

    const now = Date.now();
    await withStores(tab, "store('team').handleTeamStarted(arg);", sampleTeam(now));
    await withStores(tab, "const s = store('subagent'); s.subagents = { ...s.subagents, [arg.id]: arg };", sampleSubagent(now));
    await withStores(tab, "store('streaming').addMessage(arg);", cardTurn(now));
    await withStores(tab, "store('task').tasks = arg;", CARD_TASKS);
    await expect(tab.getByTestId('team-card')).toBeVisible();

    const scrollTo = (testId: string) => async (): Promise<void> => {
      await tab.getByTestId(testId).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await settled(tab);
    };
    await shoot(app, tab, testInfo, 'card-tool', scrollTo('tool-card'));
    await shoot(app, tab, testInfo, 'card-edit', async () => {
      await tab.getByTestId('tool-card').last().evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await settled(tab);
    });
    await shoot(app, tab, testInfo, 'card-agent', scrollTo('subagent-card'));
    await shoot(app, tab, testInfo, 'card-team', scrollTo('team-card'));
    await shoot(app, tab, testInfo, 'card-tasks', scrollTo('task-list-card'));

    await withStores(tab, "store('ui').expandTool('c-bash', 'session');");
    await expect(tab.getByTestId('tool-overlay-copy-command')).toBeVisible();
    await shoot(app, tab, testInfo, 'tool-shell');
  } finally {
    await stub.close();
  }
});

/** Tool calls for the specialised cards, each in the state the reference's cards show most. */
function specialCards(now: number) {
  const calls = [
    { id: 'k-skill', name: 'Skill', input: { skill: 'commit' }, status: 'completed', metadata: { skillDescription: 'Write a conventional commit for the staged change.' } },
    { id: 'k-plan', name: 'EnterPlanMode', input: {}, status: 'completed' },
    { id: 'k-question', name: 'AskUserQuestion', status: 'completed', input: { questions: [{ header: 'Limit', question: 'How many attempts per window?', options: [{ label: '5' }, { label: '10' }], multiSelect: false }] }, result: JSON.stringify({ answers: { 'How many attempts per window?': '5' } }) },
    { id: 'k-form', name: 'BrowserRequestInput', status: 'completed', input: { title: 'Sign in', fields: [{ label: 'Email', type: 'email', selector: '#email' }, { label: 'Password', type: 'password', selector: '#pw' }], submitSelector: '#go' }, result: JSON.stringify({ filled: 2, submitted: true, fields: [{ label: 'Email', type: 'email', ok: true }, { label: 'Password', type: 'password', ok: true, masked: true }] }) },
    { id: 'k-steer', name: 'SteerSubagent', status: 'completed', input: { agent_id: 'agent-7f3a91c2', message: 'Also check /refresh, but do not change it.' }, metadata: { steerStatus: 'steered', agentType: 'code-reviewer', description: 'Check the other auth routes' }, durationMs: 300 },
    { id: 'k-structured', name: 'StructuredOutput', status: 'completed', input: { summary: 'Added a per-IP limiter to /login.', files: ['src/routes/auth.ts', 'test/auth.spec.ts'] } },
  ];
  return {
    role: 'assistant', content: '', timestamp: now,
    contentBlocks: calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
    toolCalls: calls,
  };
}

function compassSample() {
  const node = (id: number, kind: string, name: string, file: string, community: number) => ({ id, kind, name, qualified_name: `${file}::${name}`, file_path: `C:/repo/${file}`, line_start: 4 + id, line_end: 20 + id, language: 'typescript', community_id: community });
  const nodes = [node(1, 'File', 'auth.ts', 'src/routes/auth.ts', 1), node(2, 'Function', 'login', 'src/routes/auth.ts', 1), node(3, 'Function', 'issueSession', 'src/auth/session.ts', 2), node(4, 'Class', 'RateLimiter', 'src/auth/limiter.ts', 2), node(5, 'Test', 'login rejects', 'test/auth.spec.ts', 1)];
  const edge = (id: number, kind: string, a: number, b: number) => ({ id, kind, source_qualified: nodes[a - 1]!.qualified_name, target_qualified: nodes[b - 1]!.qualified_name, file_path: nodes[a - 1]!.file_path });
  return {
    graph: { nodes, edges: [edge(1, 'CONTAINS', 1, 2), edge(2, 'CALLS', 2, 3), edge(3, 'CALLS', 2, 4), edge(4, 'TESTED_BY', 2, 5)], communities: [{ id: 1, name: 'routes', size: 3 }, { id: 2, name: 'auth', size: 2 }] },
    search: nodes.slice(1).map((n) => ({ node: n, score: 1 })),
    validation: {
      timestamp: Date.now(), durationMs: 42, totalIssues: 2,
      issues: [
        { category: 'Unresolved imports', severity: 'warning', count: 3, description: 'Imports Compass could not resolve to a file.', entities: ['src/a.ts → ./missing', 'src/b.ts → lodash/fp'], truncated: false },
        { category: 'Orphan nodes', severity: 'info', count: 1, description: 'Nodes with no edges.', entities: ['src/util/noop.ts'], truncated: false },
      ],
      summary: { nodeCount: 1284, edgeCount: 3120, fileCount: 211, communityCount: 14, edgeToNodeRatio: 2.43, workspaceFileCount: 230, coveragePercent: 92 },
    },
  };
}

test('restyled cards and overlays without a reference counterpart', async ({ home, launch }, testInfo) => {
  test.setTimeout(600_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    await setContentSize(app, 1280, 860);
    await sendAndAwaitEcho(tab, 'Rate-limit the /login route');

    await shootReferences(app, testInfo, [{ name: 'card-specials', setup: referenceScrollTo('rateLimit|express-rate-limit') }]);

    const now = Date.now();
    await hostMessage(app, tab, { type: 'exploreStarted', toolUseId: 'k-explore', model: 'Stub model', prompt: 'Find the auth tests', description: 'Find the auth tests and how they run', startTime: now - 18_000 });
    await withStores(tab, "store('streaming').addMessage(arg);", {
      role: 'assistant', content: '', timestamp: now,
      contentBlocks: [{ type: 'tool_use', id: 'k-explore', name: 'Agent', input: { description: 'Find the auth tests and how they run', subagent_type: 'Explore' } }],
      toolCalls: [{ id: 'k-explore', name: 'Agent', input: { description: 'Find the auth tests and how they run', subagent_type: 'Explore' }, status: 'running' }],
    });
    await withStores(tab, "store('streaming').addMessage(arg);", specialCards(now));
    await expect(tab.getByTestId('skill-tool-card')).toBeVisible();
    const scrollTo = (testId: string) => async (): Promise<void> => {
      await tab.getByTestId(testId).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await settled(tab);
    };
    await shoot(app, tab, testInfo, 'card-specials', scrollTo('explore-card'));
    await shoot(app, tab, testInfo, 'card-specials-2', scrollTo('form-tool-card'));

    await tab.mouse.click(450, 260);
    const patch = "--- src/routes/auth.ts\n+++ src/routes/auth.ts\n@@ -1,3 +1,5 @@\n-router.post('/login', async (req, res) => {\n+const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 });\n+\n+router.post('/login', loginLimiter, async (req, res) => {\n   const user = await verify(req.body);\n });\n";
    await withStores(tab, "store('diff').expandDiff(arg);", { filePath: `${home.project}/src/routes/auth.ts`, tool: 'Edit', source: { kind: 'patch', patch } });
    await expect(tab.getByTestId('diff-overlay')).toBeVisible();
    await shoot(app, tab, testInfo, 'diff');
    await tab.keyboard.press('Escape');

    const compass = compassSample();
    await tab.mouse.click(450, 260);
    await withStores(tab, "const s = store('compass'); s.searchQuery = 'login'; s.searchResults = arg; s.setActivePanel('search');", compass.search);
    await expect(tab.getByTestId('compass-search')).toBeVisible();
    await shoot(app, tab, testInfo, 'compass-search');
    await tab.keyboard.press('Escape');

    await tab.mouse.click(450, 260);
    await withStores(tab, "const s = store('compass'); s.setValidationResult(arg); s.setActivePanel('validate');", compass.validation);
    await tab.getByRole('button', { name: /Unresolved imports/ }).click();
    await shoot(app, tab, testInfo, 'compass-validation');
    await tab.keyboard.press('Escape');

    await tab.mouse.click(450, 260);
    await withStores(tab, "const s = store('compass'); s.setActivePanel('graph');");
    await withStores(tab, "store('compass').setGraphData(arg);", compass.graph);
    await expect(tab.locator('path.node-shape')).toHaveCount(compass.graph.nodes.length);
    await settled(tab);
    // A mouse press inside the overlay, as a user's would be, so the capture shows mouse focus.
    await tab.getByRole('dialog').last().locator('h2').click();
    await shoot(app, tab, testInfo, 'compass-graph');
    await tab.getByTestId('compass-edge-filter').click();
    await shoot(app, tab, testInfo, 'compass-edge-filter');
    await tab.keyboard.press('Escape');
    await pointerFirst(tab);
    await withStores(tab, "store('compass').setHelpOpen(true);");
    await shoot(app, tab, testInfo, 'compass-help');
    await withStores(tab, "store('compass').setHelpOpen(false); store('compass').setActivePanel(null);");

    // A 2x2 PNG: the lightbox frames whatever image a steer carried.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnwEIGP6DMQMDAwBPAQf/lxmF8QAAAABJRU5ErkJggg==';
    const steered = { ...sampleSubagent(now), id: 'tc-img', messages: [{ id: 'img-1', role: 'user', content: 'Match this layout.', timestamp: now, contentBlocks: [{ type: 'text', text: 'Match this layout.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] };
    await tab.mouse.click(450, 260);
    await withStores(tab, "const s = store('subagent'); s.subagents = { ...s.subagents, [arg.id]: arg }; s.expandSubagent(arg.id);", steered);
    await tab.getByTitle(/Click to preview/).first().click();
    await expect(tab.getByRole('dialog', { name: /Image/ })).toBeVisible();
    await shoot(app, tab, testInfo, 'lightbox');
    await tab.keyboard.press('Escape');
    await tab.keyboard.press('Escape');

    // The destination picker opens from "Always allow" on a shell permission card.
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'npm test -- test/auth.spec.ts' } }] });
    await chatInput(tab).fill('Run the auth tests');
    await chatInput(tab).press('Enter');
    const card = tab.getByTestId('permission-card');
    await expect(card).toBeVisible();
    await card.getByRole('option', { name: /^Always allow/ }).click();
    await expect(tab.getByRole('alertdialog')).toBeVisible();
    await shoot(app, tab, testInfo, 'permission-destination');
  } finally {
    await stub.close();
  }
});
