import { bootMessages, conversation, MAIN, sessionState, settingsUpdate } from '../lib/script.ts';
import type { Scene } from '../lib/scene.ts';

const PLAN_PATH = 'C:/Users/dev/.damocles/plans/add-audit-log-0197a3c2.md';
const PLAN = `# Audit log for admin actions

Record who changed what in the admin API, queryable by admins.

## Slice 1: record role changes end to end
- \`audit_events\` table (actor, action, target, diff, at) with a migration
- \`audit.record()\` called from \`PATCH /admin/users/:id/role\`
- Test: a role change writes exactly one event

## Slice 2: list events
- \`GET /admin/audit?actor=&since=\` with cursor pagination
- Test: filters and page boundaries

## Slice 3: cover the remaining admin routes
- Suspend, delete and API-key rotation record events
- Test: each route writes its event inside the same transaction`;

export const plan: Scene = {
  id: 'plan',
  chapter: 'Plan mode',
  accent: 'violet',
  boot: bootMessages({ mode: 'plan' }),
  async run(stage) {
    const c = conversation(stage);
    await stage.caption('Plan mode: the agent researches read-only and writes a plan first.');
    await c.prompt('Add an audit log for admin actions.');

    c.startMessage();
    await c.think('Plan mode, so read-only research first. I need to see the admin routes and how migrations are laid out.', 2);
    const glob = { pattern: 'src/routes/admin/**/*.ts' };
    const ls = { command: 'ls migrations', timeout: 10 };
    await c.callTool('toolu_p_glob', 'Glob', glob);
    await c.callTool('toolu_p_ls', 'Bash', ls);
    await c.seal();
    await c.bill({ totalInputTokens: 3600, totalOutputTokens: 150, cacheReadTokens: 17000, cacheCreationTokens: 2200, costUsd: 0.041 });
    await c.runTool('toolu_p_glob', 'Glob', glob, 'src/routes/admin/users.ts\nsrc/routes/admin/keys.ts', { durationMs: 40 });
    await c.runTool('toolu_p_ls', 'Bash', ls, '0001_init.sql\n0002_sessions.sql\n0003_api_keys.sql', { durationMs: 90 });

    c.startMessage();
    await c.say('Writing the plan as vertical slices.');
    const write = { file_path: PLAN_PATH, content: PLAN };
    await c.callTool('toolu_p_write', 'Write', write);
    await c.seal();
    await c.runTool('toolu_p_write', 'Write', write, `File created successfully at: ${PLAN_PATH}`, { durationMs: 12 });

    c.startMessage();
    await c.callTool('toolu_p_exit', 'ExitPlanMode', {});
    await c.seal();
    await c.bill({ totalInputTokens: 900, totalOutputTokens: 620, cacheReadTokens: 20000, costUsd: 0.029 });
    await stage.send(
      { type: 'toolPending', toolUseId: 'toolu_p_exit', toolName: 'ExitPlanMode', input: {}, parentToolUseId: null },
      { type: 'requestPlanApproval', toolUseId: 'toolu_p_exit', planContent: PLAN, owner: MAIN },
      sessionState('requires_action', undefined, ['toolu_p_exit']),
    );
    await stage.caption('Nothing is written until you approve the plan.');
    await stage.pause(600);
    await stage.focus([
      stage.page.getByRole('heading', { name: 'Audit log for admin actions' }).last(),
      stage.page.getByRole('button', { name: 'Yes, auto-accept edits' }),
    ], { maxZoom: 1.4 });
    await stage.pause(2400);
    stage.unfocus();
    await stage.pause(1000);
    const approved = stage.waitForPost('approvePlan');
    await stage.click(stage.page.getByRole('button', { name: 'Yes, auto-accept edits' }));
    await approved;
    await stage.send(
      sessionState('running'),
      settingsUpdate('acceptEdits'),
      { type: 'toolCompleted', toolUseId: 'toolu_p_exit', toolName: 'ExitPlanMode', result: 'Plan approved. Proceeding with implementation.', durationMs: 5200 },
    );
    c.startMessage();
    await c.say('Plan approved. Starting slice 1: the `audit_events` migration.');
    await c.seal();
    await stage.focus(stage.page.locator('textarea').first(), { maxZoom: 1.5 });
    await stage.pause(2200);
  },
};
