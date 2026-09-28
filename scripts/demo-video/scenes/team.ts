import { bootMessages, conversation, SID } from '../lib/script.ts';
import { steer, team as startTeam, type MemberSpec } from '../lib/agents.ts';
import { agentCard, overlayClose, stopButton, type Scene } from '../lib/scene.ts';

const TEAM_ID = '5b8d7c2e-9f10-4a3b-8c21-0e6f4d9a7b13';
const CREATE = 'toolu_create_team';
const RESUME = 'toolu_resume_team';
const TITLE = 'Redis session store';
const MEMBERS: MemberSpec[] = [
  { agentId: 'c1d2e3f4-0a1b-4c2d-9e3f-5a6b7c8d9e0f', name: 'Lead', role: 'lead', model: 'claude-opus-5-5' },
  { agentId: 'd2e3f4a5-1b2c-4d3e-8f4a-6b7c8d9e0f1a', name: 'Implementor', role: 'specialist', model: 'claude-sonnet-5' },
  { agentId: 'e3f4a5b6-2c3d-4e4f-9a5b-7c8d9e0f1a2b', name: 'Reviewer', role: 'specialist', model: 'gpt-6-sol' },
];
const INPUT = {
  title: TITLE,
  brief: 'Replace the in-memory session map with a Redis-backed store. Keep the sessions API unchanged; tests must stay green.',
  agents: [{ name: 'Lead', role: 'lead' }, { name: 'Implementor', role: 'specialist' }, { name: 'Reviewer', role: 'specialist' }],
};
const RESULT = 'Sessions now live in Redis behind the same API. The reviewer signed off after TTL refresh on reconnect was added; 38 tests pass.';

export const team: Scene = {
  id: 'team',
  chapter: 'Teams',
  accent: 'yellow',
  boot: bootMessages({ mode: 'acceptEdits', yolo: true }),
  async run(stage) {
    const c = conversation(stage);
    await stage.caption('Teams: a lead coordinates specialists over a shared message bus.');
    await c.prompt('Move sessions to Redis as a team: one agent implements, another reviews.');

    c.startMessage();
    await c.say("This splits cleanly into build and review, so I'll run it as a team.");
    await c.callTool(CREATE, 'create_team', INPUT);
    await c.seal();
    await c.bill({ totalInputTokens: 3100, totalOutputTokens: 190, cacheReadTokens: 18000, cacheCreationTokens: 2400, costUsd: 0.044 });
    await stage.send({ type: 'toolPending', toolUseId: CREATE, toolName: 'create_team', input: INPUT, parentToolUseId: null });

    const t = startTeam(stage, { teamId: TEAM_ID, toolUseId: CREATE, title: TITLE, members: MEMBERS });
    const run1Start = Date.now();
    await stage.send({ type: 'teamStarted', team: t.state([t.run(CREATE, 'running', run1Start)], 'running', () => 'pending') });
    await t.phase('spawning');
    await t.status('Lead', 'running');
    await t.phase('working');
    await stage.focus(agentCard(stage, TITLE), { maxZoom: 1.4 });
    await t.work('Lead', 'Implementor builds the Redis store; Reviewer checks it against the brief.', { name: 'team_spawn_specialist', input: { name: 'Implementor', task: 'Implement RedisSessionStore behind the existing sessions API.' }, result: 'Spawned Implementor.' });
    await t.scratchpad('Lead', 'plan', '1. RedisSessionStore with the same interface\n2. Wire it in src/sessions/index.ts\n3. Review, then run the tests');
    await t.status('Implementor', 'running');
    await t.work('Implementor', 'Writing the store against the existing interface.', { name: 'Write', input: { file_path: 'c:/dev/acme-api/src/sessions/redis-store.ts', content: 'export class RedisSessionStore implements SessionStore { /* ... */ }' }, result: 'File created successfully', ms: 700 });
    await t.status('Reviewer', 'running');
    await t.work('Reviewer', 'Reading the new store.', { name: 'Read', input: { file_path: 'c:/dev/acme-api/src/sessions/redis-store.ts' }, result: 'export class RedisSessionStore ...', ms: 500 });
    await t.message('Implementor', 'Lead', 'Store written and wired in. Running the session tests next.');
    stage.unfocus();

    await stage.caption('Open a team to follow every agent, message and scratchpad note.');
    stage.mark('gif-start');
    await stage.click(agentCard(stage, TITLE));
    await stage.pause(900);
    await t.work('Implementor', '', { name: 'Bash', input: { command: 'npm test -- sessions' }, result: 'Tests  9 passed (9)', ms: 600 });
    await stage.pause(900);
    stage.mark('gif-end');
    await stage.click(overlayClose(stage));
    await stage.pause(300);

    await stage.caption('Steer a team member directly, too.');
    const reviewer = t.member('Reviewer');
    const steered = await steer(stage, MEMBERS.map((m) => ({
      kind: 'team-member' as const, id: m.agentId, teamId: TEAM_ID, teamTitle: TITLE, memberName: m.name, role: m.role, status: 'running' as const,
    })), `${TITLE} · Reviewer`, 'Also check what happens to TTLs when Redis restarts.');
    await stage.send(
      { type: 'teamAgentUserMessage', teamId: TEAM_ID, agentId: reviewer.agentId, content: `[STEERING INSTRUCTION: ABSOLUTE PRIORITY]\n${steered.message}`, timestamp: Date.now() },
      { type: 'subagentSteered', agentId: reviewer.agentId, toolUseId: null, description: `${TITLE} · Reviewer`, message: steered.message, requestId: steered.requestId, status: 'steered', team: { teamId: TEAM_ID, teamTitle: TITLE, memberName: 'Reviewer', role: 'specialist' } },
    );
    await t.work('Reviewer', 'Checking TTL handling across a Redis restart, as asked.', { name: 'Grep', input: { pattern: 'expire|ttl', path: 'src/sessions' }, result: 'src/sessions/redis-store.ts:31: await this.redis.set(key, value, { EX: ttl })', ms: 500 });

    await stage.caption('Stop a team mid-run and resume it later.');
    await stage.pause(700);
    const cancelled = stage.waitForPost('cancelSession');
    await stage.click(stopButton(stage));
    await cancelled;
    await stage.send(
      { type: 'sessionStateChanged', state: 'idle', sessionId: SID },
      { type: 'toolAbandoned', toolUseId: CREATE, toolName: 'create_team', parentToolUseId: null },
      { type: 'teamPhaseUpdate', teamId: TEAM_ID, phase: 'synthesizing' },
      { type: 'sessionCancelled' },
      { type: 'processing', isProcessing: false },
    );
    await stage.pause(300);
    for (const m of MEMBERS) await t.status(m.name, 'cancelled');
    await t.phase('complete');
    const run1 = t.run(CREATE, 'cancelled', run1Start);
    await stage.send({ type: 'teamCompleted', teamId: TEAM_ID, status: 'cancelled', result: '## Partial Team Results (team did not complete normally)', run: run1 });
    await stage.pause(1500);

    await c.prompt('continue');
    c.startMessage();
    await c.say('Resuming the team where it stopped.');
    await c.callTool(RESUME, 'resume_team', { team_id: TEAM_ID });
    await c.seal();
    await stage.send({ type: 'toolPending', toolUseId: RESUME, toolName: 'resume_team', input: { team_id: TEAM_ID }, parentToolUseId: null });
    const run2Start = Date.now();
    await t.phase('working');
    await stage.send({ type: 'teamStarted', team: t.state([run1, t.run(RESUME, 'running', run2Start)], 'running', () => 'running') });
    await t.work('Reviewer', 'Keys lose their TTL after a restart. Asking for a refresh on reconnect.');
    await t.message('Reviewer', 'Implementor', 'Refresh the TTL on reconnect; otherwise sessions outlive their expiry.');
    await t.work('Implementor', 'Adding the TTL refresh.', { name: 'Edit', input: { file_path: 'c:/dev/acme-api/src/sessions/redis-store.ts', old_string: 'this.redis.on(\'ready\', noop);', new_string: 'this.redis.on(\'ready\', () => this.refreshTtls());' }, result: 'The file has been updated.', ms: 500 });
    await t.message('Reviewer', 'Lead', 'Approved.');
    await t.status('Implementor', 'completed');
    await t.status('Reviewer', 'completed');
    await t.phase('synthesizing');
    await t.work('Lead', 'All work reviewed and approved.');
    await t.status('Lead', 'completed');
    await t.phase('complete');
    await stage.send(
      { type: 'teamCompleted', teamId: TEAM_ID, status: 'completed', result: RESULT, run: t.run(RESUME, 'completed', run2Start) },
      { type: 'toolCompleted', toolUseId: RESUME, toolName: 'resume_team', result: RESULT, durationMs: Date.now() - run2Start },
    );

    c.startMessage();
    await c.say(RESULT, 200);
    await c.seal();
    await c.bill({ totalInputTokens: 2100, totalOutputTokens: 150, cacheReadTokens: 22000, costUsd: 0.036 });
    await c.endTurn(RESULT);
    await stage.pause(2400);
  },
};
