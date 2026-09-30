import * as fs from 'node:fs';
import * as path from 'node:path';
import { mainLog } from './support/app';
import { chatTab, expect, nextTab, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { chatInput, clickMenu, hostMessages, postFromWebview, recordHostMessages, sendAndAwaitEcho } from './support/ui';

const GIT_MISSING = 'Git was not found on PATH, so checkpoints and rewind are turned off.';
const MCP_SERVER = path.join(__dirname, 'support', 'mcp-stdio-server.cjs');

/** The current PATH minus every directory that holds a git executable. */
function pathWithoutGit(): string {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat', 'git'] : ['git'];
  return (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((dir) => dir && !names.some((n) => fs.existsSync(path.join(dir, n))))
    .join(path.delimiter);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A fake git and an npx-style MCP command, in a directory only a login profile puts on PATH. */
function writeProfileTools(h: HermeticHome): string {
  const tools = path.join(h.home, 'e2e-tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, 'git'), '#!/bin/sh\necho "git version 9.9.9-e2e"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'e2e-mcp'), `#!/bin/sh\nexec "${process.execPath}" "${MCP_SERVER}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(h.home, '.profile'), `export PATH="${tools}:$PATH"\n`);
  return tools;
}

test.describe('child process environment', () => {
  test('a login shell profile that adds a directory to PATH makes git and an npx-style stdio MCP command resolve', async ({ home, launch }) => {
    test.skip(process.platform === 'win32', 'Windows GUI apps inherit the registry environment; desktop runs no login shell there.');
    const tools = writeProfileTools(home);
    fs.writeFileSync(path.join(home.damoclesDir, 'mcp.json'), JSON.stringify({ mcpServers: { e2e: { command: 'e2e-mcp', args: [] } } }, null, 2));

    const desktop = await launch({ env: { PATH: pathWithoutGit(), SHELL: '/bin/sh' } });
    const tab = await chatTab(desktop.app);
    await expect(chatInput(tab)).toBeVisible();
    expect(pathWithoutGit().split(path.delimiter)).not.toContain(tools);
    await expect.poll(() => mainLog(home)).toContain('[git] git version 9.9.9-e2e');

    await recordHostMessages(tab);
    await expect.poll(async () => {
      await postFromWebview(tab, { type: 'requestMcpStatus' });
      const latest = (await hostMessages(tab, 'mcpServerStatus')).at(-1);
      return (latest?.['servers'] as { name: string; status: string }[] | undefined)?.find((s) => s.name === 'e2e')?.status;
    }, { timeout: 60_000 }).toBe('connected');
  });

  test('with git absent from PATH the capability warning appears once and checkpoints report disabled', async ({ home, launch }) => {
    const stub = await startOpenAIStub();
    try {
      seedStubModel(home, stub.baseUrl);
      // A missing shell keeps the launch PATH on macOS and Linux, where the login shell would add git back.
      const env: Record<string, string> = { PATH: pathWithoutGit() };
      if (process.platform !== 'win32') env['SHELL'] = path.join(home.root, 'no-such-shell');
      const desktop = await launch({ env });
      const tab = await chatTab(desktop.app);
      await expect(chatInput(tab)).toBeVisible();
      await expect.poll(() => desktop.output()).toContain(`[notification:warning] ${GIT_MISSING}`);

      await sendAndAwaitEcho(tab, 'a turn with no git');
      await expect.poll(() => desktop.output()).toContain(`[CheckpointService] git unavailable, checkpoints disabled for this session: ${GIT_MISSING}`);

      const opened = nextTab(desktop.app, [tab]);
      await clickMenu(desktop.app, 'damocles.openChat');
      const second = await opened;
      await expect(chatInput(second)).toBeVisible();
      await sendAndAwaitEcho(second, 'another tab with no git');
      await expect.poll(() => count(desktop.output(), '[CheckpointService] git unavailable')).toBe(2);

      expect(count(desktop.output(), `[notification:warning] ${GIT_MISSING}`)).toBe(1);
      expect(desktop.output()).not.toContain('[CheckpointService] turnStart failed');
    } finally {
      await stub.close();
    }
  });
});
