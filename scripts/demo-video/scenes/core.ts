import { bootMessages, conversation, SID } from '../lib/script.ts';
import { permissionOption, type Scene } from '../lib/scene.ts';
import { AUTH_PATH, AUTH_TS, EDIT_OLD, EDIT_NEW, EDIT2_OLD, EDIT2_NEW, TEST_FRAMES } from './fixtures.ts';

const SUMMARY = `Rate limiting is in place on \`POST /login\`:

- **\`loginLimiter\`**: 10 attempts per 15 minutes per IP, answering \`429 too_many_attempts\` with \`RateLimit\` headers.
- Applied only to the login route, so the rest of the API is unaffected.
- All **35 tests** pass, including a new check for the 429 after the tenth failed attempt.`;

const PROMPT = 'The /login route has no rate limiting. Add it and make sure the tests still pass.';

export const core: Scene = {
  id: 'core',
  chapter: 'Core loop',
  accent: 'blue',
  boot: bootMessages(),
  async run(stage) {
    const c = conversation(stage);
    await stage.caption('Ask in plain language. Claude or GPT works inside VS Code.');
    await stage.pause(600);
    const entryId = await c.prompt(PROMPT);

    c.startMessage();
    await c.think('The user wants rate limiting on POST /login. I should check whether a limiter already exists, then read the auth router to see how middleware is wired before editing.', 3);
    await c.say("I'll check for an existing limiter and read the auth routes.");
    const grep = { pattern: 'rateLimit', path: 'src', output_mode: 'files_with_matches' };
    const read = { file_path: AUTH_PATH };
    await c.callTool('toolu_grep1', 'Grep', grep);
    await c.callTool('toolu_read1', 'Read', read);
    await c.seal();
    await c.bill({ totalInputTokens: 4200, totalOutputTokens: 180, cacheReadTokens: 21000, cacheCreationTokens: 3100, costUsd: 0.061 });
    await stage.caption('Every tool call streams in live, with its result one click away.');
    await c.runTool('toolu_grep1', 'Grep', grep, 'No files found', { durationMs: 96 });
    await c.runTool('toolu_read1', 'Read', read, AUTH_TS, { durationMs: 12 });

    c.startMessage();
    await c.say("No limiter exists yet. I'll add one scoped to the login route.");
    const edit1 = { file_path: AUTH_PATH, old_string: EDIT_OLD, new_string: EDIT_NEW };
    await c.callTool('toolu_edit1', 'Edit', edit1);
    await c.seal();
    await c.bill({ totalInputTokens: 900, totalOutputTokens: 320, cacheReadTokens: 25000, costUsd: 0.038 });
    await stage.send(
      { type: 'requestPermission', toolUseId: 'toolu_edit1', toolName: 'Edit', toolInput: edit1, filePath: AUTH_PATH, originalContent: AUTH_TS, proposedContent: AUTH_TS.replace(EDIT_OLD, EDIT_NEW), editLineNumber: 4 },
      { type: 'sessionStateChanged', state: 'requires_action', sessionId: SID },
    );
    await stage.caption('Edits wait for your approval, shown as a highlighted diff.');
    stage.mark('gif-start');
    await stage.focus(stage.page.locator('[role="region"][aria-label="Permission request"]'), { maxZoom: 1.3 });
    await stage.pause(2600);
    const approved = stage.waitForPost('approveEdit');
    await stage.click(permissionOption(stage, 'Yes, accept all edits'));
    await approved;
    await stage.send({ type: 'sessionStateChanged', state: 'running', sessionId: SID });
    await c.runTool('toolu_edit1', 'Edit', edit1, `The file ${AUTH_PATH} has been updated.`, { durationMs: 18 });

    c.startMessage();
    const edit2 = { file_path: AUTH_PATH, old_string: EDIT2_OLD, new_string: EDIT2_NEW };
    await c.callTool('toolu_edit2', 'Edit', edit2);
    await c.seal();
    await c.runTool('toolu_edit2', 'Edit', edit2, `The file ${AUTH_PATH} has been updated.`, { durationMs: 15 });

    c.startMessage();
    await c.say('Now the test suite.');
    const bash = { command: 'npm test', timeout: 120 };
    await c.callTool('toolu_bash1', 'Bash', bash);
    await c.seal();
    await c.bill({ totalInputTokens: 600, totalOutputTokens: 60, cacheReadTokens: 27000, costUsd: 0.019 });
    await stage.send(
      { type: 'requestPermission', toolUseId: 'toolu_bash1', toolName: 'Bash', toolInput: bash, command: 'npm test', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }] },
      { type: 'sessionStateChanged', state: 'requires_action', sessionId: SID },
    );
    await stage.caption('Shell commands ask first, then stream their output as they run.');
    await stage.focus(stage.page.locator('[role="region"][aria-label="Permission request"]'), { maxZoom: 1.3 });
    await stage.pause(1500);
    const ran = stage.waitForPost('approveEdit');
    await stage.click(permissionOption(stage, 'Yes'));
    await ran;
    stage.unfocus();
    await stage.send({ type: 'sessionStateChanged', state: 'running', sessionId: SID });
    await c.runTool('toolu_bash1', 'Bash', bash, TEST_FRAMES.at(-1)!, { durationMs: 2140, progress: TEST_FRAMES, stepMs: 420 });
    stage.mark('gif-end');

    c.startMessage();
    await c.say(SUMMARY, 220);
    await c.seal();
    await c.bill({ totalInputTokens: 1400, totalOutputTokens: 240, cacheReadTokens: 28000, costUsd: 0.044 });
    await c.endTurn(SUMMARY);
    await stage.pause(1800);

    await stage.caption('Every prompt is a checkpoint: roll files back, fork the chat, or both.');
    stage.respond('requestRewindHistory', () => [{
      type: 'rewindHistory', canFork: true, prompts: [{
        kind: 'prompt', messageId: entryId, content: PROMPT, timestamp: Date.now() - 60_000, filesAffected: 1,
        files: [{ path: AUTH_PATH, displayName: 'auth.ts' }], linesChanged: { added: 9, removed: 1 },
      }],
    }]);
    await stage.click(stage.page.getByRole('button', { name: 'Rewind conversation to this message' }).first());
    await stage.focus(stage.page.getByRole('alertdialog').last(), { maxZoom: 1.35 });
    await stage.pause(1600);
    await stage.click(stage.page.getByText('Rewind code to here', { exact: true }));
    await stage.pause(900);
    const rewound = stage.waitForPost('rewindToMessage');
    await stage.click(stage.page.getByRole('button', { name: 'Roll back files' }));
    const req = await rewound;
    stage.unfocus();
    await stage.send({ type: 'rewindComplete', rewindToMessageId: req.userMessageId, option: req.option, promptContent: PROMPT });
    await stage.pause(2600);
  },
};
