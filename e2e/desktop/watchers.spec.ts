import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { chatTab, expect, nextTab, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { chatRequests, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { addProject, chatInput, hostMessages, postFromWebview, recordHostMessages, sendAndAwaitEcho } from './support/ui';

const MCP_SERVER = path.join(__dirname, 'support', 'mcp-stdio-server.cjs');

function requestFor(stub: OpenAIStub, prompt: string): string {
  const request = chatRequests(stub).find((r) => JSON.stringify(r.body).includes(`"text":"${prompt}"`));
  if (!request) throw new Error(`no chat request carried "${prompt}"`);
  return JSON.stringify(request.body);
}

/**
 * Sends a turn until the request the stub receives contains `marker`; each probe is a full turn, so polling never races a send.
 * `newConversation` starts each probe in a new session, for input pi reads only when it builds a session's system prompt.
 */
async function untilRequestContains(tab: Page, stub: OpenAIStub, label: string, marker: string, newConversation = false): Promise<void> {
  let probe = 0;
  const turnsDone = async (): Promise<number> => (await hostMessages(tab, 'done')).length;
  await expect.poll(async () => {
    const prompt = `${label} ${++probe}`;
    if (newConversation) {
      await postFromWebview(tab, { type: 'clearSession' });
      await expect(tab.getByText(/^Echo: /)).toHaveCount(0);
    }
    // A turn's end is its `done`: the reply echoes the hook's context once a hook runs, and the virtualized list drops
    // replies scrolled out of view from the DOM, so neither the reply's text nor a count of replies can mark it.
    const before = await turnsDone();
    await chatInput(tab).fill(prompt);
    await chatInput(tab).press('Enter');
    await expect.poll(turnsDone).toBe(before + 1);
    return requestFor(stub, prompt).includes(marker);
  }, { timeout: 60_000, intervals: [0] }).toBe(true);
}

// The request that carried a tool result back to the model; title generation and other sub-calls carry none.
function lastToolResultRequest(stub: OpenAIStub): string {
  const bodies = chatRequests(stub).map((r) => JSON.stringify(r.body)).filter((body) => body.includes('"role":"tool"'));
  const last = bodies.at(-1);
  if (last === undefined) throw new Error('no chat request carried a tool result');
  return last;
}

async function hostMessageNames(tab: Page, type: string, list: 'servers' | 'agents' | 'commands'): Promise<string[]> {
  const latest = (await hostMessages(tab, type)).at(-1) as Record<string, Array<{ name: string }>> | undefined;
  return (latest?.[list] ?? []).map((entry) => entry.name);
}

test('watchers: memory file, hooks, agent registry, slash command and MCP config edits under the home apply live', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const desktop = await launch();
    const tab = await chatTab(desktop.app);
    await expect(chatInput(tab)).toBeVisible();
    await recordHostMessages(tab);
    // The first turn starts the session, which subscribes to the agent registry.
    await sendAndAwaitEcho(tab, 'warm up');

    // Memory: the watcher reloads the loader, so the global instructions file reaches the next conversation's system prompt.
    const memoryMarker = 'GLOBAL-MEMORY-MARKER-41d0';
    fs.writeFileSync(path.join(home.damoclesDir, 'AGENTS.md'), `# Global rules\n\n${memoryMarker}\n`);
    await untilRequestContains(tab, stub, 'memory probe', memoryMarker, true);

    // Hooks: a before_agent_start hook's stdout is injected as run context.
    const hookMarker = 'HOOK-CONTEXT-MARKER-9b2e';
    const hooks = { hooks: { before_agent_start: [{ command: [process.execPath, '-e', `process.stdout.write('${hookMarker}')`] }] } };
    fs.writeFileSync(path.join(home.damoclesDir, 'hooks.json'), JSON.stringify(hooks, null, 2));
    await untilRequestContains(tab, stub, 'hook probe', hookMarker);

    // Agent registry: a user agent file joins the spawnable agents the panel lists.
    fs.mkdirSync(path.join(home.damoclesDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home.damoclesDir, 'agents', 'e2e-scout.md'), '---\nname: e2e-scout\ndescription: Finds things for the e2e suite\n---\nYou scout.\n');
    await expect.poll(() => hostMessageNames(tab, 'customAgents', 'agents')).toContain('e2e-scout');

    // Slash command: once the menu has listed its commands (as typing '/' asks), a new user command file is broadcast into it.
    await postFromWebview(tab, { type: 'requestCustomSlashCommands' });
    await expect.poll(async () => (await hostMessages(tab, 'customSlashCommands')).length).toBeGreaterThan(0);
    fs.mkdirSync(path.join(home.damoclesDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home.damoclesDir, 'commands', 'e2e-greet.md'), '---\ndescription: Greets for the e2e suite\n---\nSay hello.\n');
    await expect.poll(() => hostMessageNames(tab, 'customSlashCommands', 'commands')).toContain('e2e-greet');

    // MCP config: a server added to ~/.damocles/mcp.json appears in the panel's MCP list.
    fs.writeFileSync(path.join(home.damoclesDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'e2e-watch': { command: process.execPath, args: [MCP_SERVER] } } }, null, 2));
    await expect.poll(() => hostMessageNames(tab, 'mcpConfigUpdate', 'servers')).toContain('e2e-watch');
  } finally {
    await stub.close();
  }
});

test('watchers: a permission rule written to a trusted project applies to the next tool call', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const notes = path.join(home.project, 'notes.txt');
    fs.writeFileSync(notes, 'FILE-CONTENT-MARKER-5a7c\n');
    const denied = 'Permission denied by a rule in your Damocles settings';
    const desktop = await launch();
    const homeTab = await chatTab(desktop.app);
    await expect(chatInput(homeTab)).toBeVisible();
    const opened = nextTab(desktop.app, [homeTab]);
    await addProject(desktop.app, home.project, true);
    const alpha = await opened;
    await expect(chatInput(alpha)).toBeVisible();

    // Read is read-only, so with no rule it runs without a prompt and its result reaches the model.
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'read', arguments: { path: notes } }] });
    await sendAndAwaitEcho(alpha, 'read before the rule');
    const allowed = lastToolResultRequest(stub);
    expect(allowed).toContain('FILE-CONTENT-MARKER-5a7c');
    expect(allowed).not.toContain(denied);

    fs.mkdirSync(path.join(home.project, '.damocles'), { recursive: true });
    fs.writeFileSync(path.join(home.project, '.damocles', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read'] } }, null, 2));
    let probe = 0;
    await expect.poll(async () => {
      stub.replies.push({ chunks: [], toolCalls: [{ name: 'read', arguments: { path: notes } }] });
      await sendAndAwaitEcho(alpha, `read after the rule ${++probe}`);
      return lastToolResultRequest(stub).includes(denied);
    }, { timeout: 60_000, intervals: [0] }).toBe(true);
  } finally {
    await stub.close();
  }
});
