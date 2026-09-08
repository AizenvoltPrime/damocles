import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { PiRuntime } from '../pi-runtime';

/**
 * A subagent session must resolve relative paths against the WORKSPACE, never against the extension
 * host's `process.cwd()`. The temp workspace here differs from `process.cwd()`, so nothing can pass by
 * coincidence.
 *
 * Two independent facts are pinned, and they are not the same fact:
 *
 *  1. `sessionManager.getCwd()` is the workspace. This is Damocles': `PiRuntime.createSubagentSession`
 *     passes the cwd to `SessionManager.inMemory(...)`, and dropping the argument makes pi default it
 *     to `process.cwd()`. Reverting that call site fails this.
 *
 *  2. The session's own resolved cwd is the workspace, observed through pi's native `read` on a
 *     relative name. This is pi's, not Damocles': `createAgentSessionFromServices` forwards
 *     `cwd: options.services.cwd` unconditionally and exposes no `cwd` option, so this holds because of
 *     how pi resolves it. It is pinned here so a future change to that forwarding is caught rather than
 *     assumed, and it is what pi's `read`/`bash`/`edit`/`find`/`grep`/`ls` actually read.
 */
describe('in-memory session cwd', () => {
  const made: string[] = [];
  const sessions: AgentSession[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  beforeAll(() => {
    vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    } as unknown as vscode.LogOutputChannel);
  });

  afterEach(async () => {
    sessions.length = 0;
    await PiRuntime.disposeInstance();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Read a workspace-relative name through pi's native `read`, which resolves against the session cwd. */
  const readRelative = async (session: AgentSession, name: string): Promise<string> => {
    const tool = session.getToolDefinition('read');
    if (!tool) throw new Error('pi native `read` is not registered on this session');
    // No `ctx`: pi's tools read `ctx?.cwd || cwd`, so omitting it makes `read` resolve against the
    // constructor cwd, which is the session's own resolved cwd and the value under test.
    const result = await tool.execute('cwd-probe', { path: name }, undefined, undefined, undefined as never);
    return (result.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  };

  it('a subagent session resolves against the workspace', async () => {
    const workspace = tempDir('damocles-cwd-ws-');
    const agentDir = tempDir('damocles-cwd-agent-');
    fs.writeFileSync(path.join(workspace, 'marker.txt'), 'workspace marker');
    expect(workspace).not.toBe(process.cwd());

    const runtime = PiRuntime.get(workspace, agentDir);

    const subagent = await runtime.createSubagentSession({
      cwd: workspace,
      systemPrompt: 'probe',
      tools: ['read'],
      customTools: [],
      extensionFactory: () => {},
    });
    sessions.push(subagent);
    expect(subagent.sessionManager.getCwd()).toBe(workspace);
    await expect(readRelative(subagent, 'marker.txt')).resolves.toContain('workspace marker');
  }, 60_000);
});
