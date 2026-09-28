import { bootMessages, conversation, SID } from '../lib/script.ts';
import { steer, subagent, type SubagentSpec } from '../lib/agents.ts';
import { agentCard, overlayClose, stopButton, type Scene } from '../lib/scene.ts';

const MAP: SubagentSpec = {
  toolUseId: 'toolu_agent_map', agentId: '3f9c2a71-5b8e-4d2', agentType: 'Explore', model: 'claude-sonnet-5',
  description: 'Map session cookie reads', prompt: 'Find every place the API reads the sid cookie and note how each one validates it.',
};
const MW: SubagentSpec = {
  toolUseId: 'toolu_agent_mw', agentId: '8e21b0c4-1a2f-4c9', agentType: 'Explore', model: 'claude-sonnet-5',
  description: 'Audit session middleware', prompt: 'Review the session middleware for missing expiry or signature checks.',
};

const ANSWER = `Both agents are done. The cookie is read in **3 places**:

1. \`src/middleware/session.ts\` verifies the signature and expiry.
2. \`src/routes/auth.ts\` only reads it to clear it on logout, which is fine.
3. \`src/ws/upgrade.ts\` **skips the signature check**. It needs \`sessions.verify()\` before trusting the id.`;

export const subagents: Scene = {
  id: 'subagents',
  chapter: 'Subagents',
  accent: 'green',
  boot: bootMessages({ mode: 'acceptEdits', yolo: true }),
  async run(stage) {
    const c = conversation(stage);
    await stage.caption('Subagents fan work out in parallel, each with its own live view.');
    await c.prompt('Audit how we validate the session cookie across the API.');

    c.startMessage();
    await c.think('Two independent questions: where the cookie is read, and whether the middleware checks it properly. Parallel Explore agents fit.', 2);
    await c.say("I'll split this across two Explore agents.");
    const mapInput = { description: MAP.description, prompt: MAP.prompt, subagent_type: 'Explore' };
    const mwInput = { description: MW.description, prompt: MW.prompt, subagent_type: 'Explore' };
    await c.callTool(MAP.toolUseId, 'Agent', mapInput);
    await c.callTool(MW.toolUseId, 'Agent', mwInput);
    await c.seal();
    await c.bill({ totalInputTokens: 3800, totalOutputTokens: 210, cacheReadTokens: 19000, cacheCreationTokens: 2600, costUsd: 0.052 });
    await stage.send(
      { type: 'toolPending', toolUseId: MAP.toolUseId, toolName: 'Agent', input: mapInput, parentToolUseId: null },
      { type: 'toolPending', toolUseId: MW.toolUseId, toolName: 'Agent', input: mwInput, parentToolUseId: null },
    );
    const map = subagent(stage, MAP);
    const mw = subagent(stage, MW);
    await map.start();
    await mw.start();
    stage.mark('gif-start');
    await stage.focus([agentCard(stage, MAP.description), agentCard(stage, MW.description)], { maxZoom: 1.4 });
    await Promise.all([
      (async () => {
        await map.step('Searching for reads of the sid cookie.', { id: 'toolu_m1', name: 'Grep', input: { pattern: "cookies\\.sid|cookie\\('sid'", path: 'src' }, result: 'src/middleware/session.ts\nsrc/routes/auth.ts\nsrc/ws/upgrade.ts', ms: 500 });
        await map.step('', { id: 'toolu_m2', name: 'Read', input: { file_path: 'c:/dev/acme-api/src/ws/upgrade.ts' }, result: '// websocket upgrade handler', ms: 400 });
      })(),
      (async () => {
        await stage.pause(400);
        await mw.step('Reading the session middleware.', { id: 'toolu_w1', name: 'Read', input: { file_path: 'c:/dev/acme-api/src/middleware/session.ts' }, result: '// session middleware', ms: 600 });
        await mw.step('', { id: 'toolu_w2', name: 'Glob', input: { pattern: 'test/**/*session*' }, result: 'test/sessions.test.ts\ntest/fixtures/session-store.ts', ms: 400 });
      })(),
    ]);

    await stage.caption('Redirect any running agent mid-task with /steer.');
    const steered = await steer(stage, [
      { kind: 'subagent', id: MAP.agentId, agentType: 'Explore', description: MAP.description, status: 'running', isBackground: false },
      { kind: 'subagent', id: MW.agentId, agentType: 'Explore', description: MW.description, status: 'running', isBackground: false },
    ], MW.description, 'Skip the tests folder and focus on src/middleware.');
    await stage.send({ type: 'subagentSteered', agentId: MW.agentId, toolUseId: MW.toolUseId, agentType: 'Explore', description: MW.description, message: steered.message, requestId: steered.requestId, status: 'steered' });
    await stage.pause(700);
    stage.mark('gif-end');
    await stage.click(agentCard(stage, MW.description));
    await mw.step('Focusing on src/middleware as instructed.', { id: 'toolu_w3', name: 'Grep', input: { pattern: 'verify|expires', path: 'src/middleware' }, result: 'src/middleware/session.ts:18: sessions.verify(sid)\nsrc/middleware/session.ts:24: if (s.expiresAt < now)', ms: 500 });
    await stage.pause(1600);
    await stage.click(overlayClose(stage));
    await stage.pause(400);

    await stage.caption('Stop the run at any time. Stopped agents keep their progress.');
    await stage.pause(900);
    const cancelled = stage.waitForPost('cancelSession');
    await stage.click(stopButton(stage));
    await cancelled;
    await stage.send(
      { type: 'sessionStateChanged', state: 'idle', sessionId: SID },
      { type: 'toolAbandoned', toolUseId: MAP.toolUseId, toolName: 'Agent', parentToolUseId: null },
      { type: 'toolAbandoned', toolUseId: MW.toolUseId, toolName: 'Agent', parentToolUseId: null },
      { type: 'sessionCancelled' },
      { type: 'processing', isProcessing: false },
    );
    await stage.pause(300);
    await stage.send(
      ...map.finishMessages('stopped', 'Found three cookie reads; still checking src/ws/upgrade.ts.'),
      ...mw.finishMessages('stopped', 'The middleware verifies signature and expiry.'),
    );
    await stage.pause(1400);

    await stage.caption('Say "continue" and each agent resumes with its full context.');
    await c.prompt('continue');
    c.startMessage();
    await c.say('Resuming both agents where they stopped.');
    const mapAgain = subagent(stage, { ...MAP, toolUseId: 'toolu_resume_map', resumedFrom: MAP.agentId });
    const mwAgain = subagent(stage, { ...MW, toolUseId: 'toolu_resume_mw', resumedFrom: MW.agentId });
    await c.callTool(mapAgain.spec.toolUseId, 'Agent', { resume: MAP.agentId });
    await c.callTool(mwAgain.spec.toolUseId, 'Agent', { resume: MW.agentId });
    await c.seal();
    await stage.send(
      { type: 'toolPending', toolUseId: mapAgain.spec.toolUseId, toolName: 'Agent', input: { resume: MAP.agentId }, parentToolUseId: null },
      { type: 'toolPending', toolUseId: mwAgain.spec.toolUseId, toolName: 'Agent', input: { resume: MW.agentId }, parentToolUseId: null },
    );
    await mapAgain.start();
    await mwAgain.start();
    await Promise.all([
      (async () => {
        await mapAgain.step('Picking up at src/ws/upgrade.ts.', { id: 'toolu_m3', name: 'Grep', input: { pattern: 'verify', path: 'src/ws/upgrade.ts' }, result: 'No matches', ms: 400 });
        await mapAgain.answer('upgrade.ts trusts the sid without sessions.verify().');
      })(),
      mwAgain.answer('Middleware is correct: signature and expiry are both checked.'),
    ]);
    await stage.send(
      ...mapAgain.finishMessages('completed', 'upgrade.ts trusts the sid without sessions.verify().'),
      ...mwAgain.finishMessages('completed', 'Middleware is correct: signature and expiry are both checked.'),
    );

    c.startMessage();
    await c.say(ANSWER, 240);
    await c.seal();
    await c.bill({ totalInputTokens: 2400, totalOutputTokens: 260, cacheReadTokens: 24000, costUsd: 0.047 });
    await c.endTurn(ANSWER);
    await stage.pause(2400);
  },
};
