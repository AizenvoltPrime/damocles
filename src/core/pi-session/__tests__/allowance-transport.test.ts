import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { BrokerAnswer, HeldAuthEntry } from '../../../shared/remote-user';
import { DEFAULT_MODELS } from '../../../shared/types/constants';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { runPinnedTurn } from '../../client-snapshots';
import { installPlatform } from '../../platform-host';
import { buildAccountInfo } from '../account-billing';
import { PiRuntime } from '../pi-runtime';
import { withSettingsPolicy } from '../settings-policy';
import { SUBSCRIPTION_SOURCE } from '../subscription';

const HOUR = 60 * 60 * 1000;
const ALLOWANCE: HeldAuthEntry = { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false, allowance: true };
const EXTRA: HeldAuthEntry = { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false };

/** A plugin shaped as pi-anthropic-auth is: it registers `anthropic` with pi's own transport wrapped by an onPayload of its own. */
const plugin = (marker: string): string => `
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
export default function (pi) {
  const builtin = anthropicMessagesApi().streamSimple;
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: (model, context, options) => builtin(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => ({ ...((await options?.onPayload?.(payload, payloadModel)) ?? payload), metadata: { user_id: "${marker}" } }),
    }),
  });
}
`;
const BROKEN_PLUGIN = 'export default function () { throw new Error("no transport"); }\n';

function writePlugin(dir: string, source: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', pi: { extensions: ['./src/index.ts'] } }));
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT');
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), source);
}

const SSE = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-4-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, data]) => `event: ${event as string}\ndata: ${JSON.stringify(data)}\n\n`).join('');

interface Seen {
  readonly token: string | undefined;
  readonly shapedBy: string | undefined;
}

/** Anthropic's Messages API on loopback: records each request's bearer token and shaping, and answers once `held` requests are in flight. */
async function anthropicStub(held: number) {
  const seen: Seen[] = [];
  const waiting: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const payload = JSON.parse(body) as { metadata?: { user_id?: string } };
      seen.push({ token: req.headers.authorization?.replace(/^Bearer /, ''), shapedBy: payload.metadata?.user_id });
      waiting.push(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(SSE);
      });
      if (seen.length >= held) for (const reply of waiting.splice(0)) reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('a daemon\'s core bills each Claude request as the client it runs for chose', () => {
  const dirs: string[] = [];
  const sessions: AgentSession[] = [];
  const closers: Array<() => Promise<void>> = [];
  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    await PiRuntime.disposeInstance();
    installPlatform(createFakePlatform());
    for (const close of closers.splice(0)) await close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A daemon's core whose package carries `bundled` as its subscription plugin, on a host whose own pi settings list the
   * subscription plugin with an intact clone (what a host that runs Damocles itself has), and whose Anthropic endpoint is the stub.
   */
  async function remoteCore(bundled: string, held = 1) {
    const stub = await anthropicStub(held);
    closers.push(stub.close);
    const appRoot = tempDir('damocles-allowance-app-');
    writePlugin(path.join(appRoot, 'dist', 'subscription-plugin'), bundled);
    const agentDir = tempDir('damocles-allowance-agent-');
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl: stub.url } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: [SUBSCRIPTION_SOURCE] }));
    writePlugin(path.join(agentDir, 'git', 'github.com', 'gotgenes', 'pi-anthropic-auth'), plugin('host-copy'));
    const host = createFakeRemoteHost(async (_provider, clientId): Promise<BrokerAnswer> => ({ type: 'oauth', access: `sk-ant-oat01-${clientId}`, expiresIn: HOUR, refresh: '' }));
    host.set('clientAuth', 'client-a', { providers: { anthropic: ALLOWANCE } });
    host.set('clientAuth', 'client-b', { providers: { anthropic: EXTRA } });
    installPlatform({ ...createFakePlatform({ appRoot }), remote: host.remote });
    const runtime = PiRuntime.get(agentDir);
    await runtime.init();
    // what init's own seed left, before anything that could reconcile the subscription plugin
    const hostSettings = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8');
    const workspace = tempDir('damocles-allowance-ws-');
    await runtime.folder(workspace);
    return { host, runtime, stub, agentDir, hostSettings, workspace };
  }

  /** A chat's pi session on the runtime's shared model runtime, so its agent loop sends through the provider core registered. */
  async function chat(runtime: PiRuntime, cwd: string): Promise<AgentSession> {
    // keeps almost nothing recent, so a manual compaction has a turn to summarize
    const settingsManager = withSettingsPolicy(SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }, { projectTrusted: true }));
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true } as never);
    await resourceLoader.reload();
    const modelRuntime = runtime.modelRuntime!;
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model: modelRuntime.getModel('anthropic', 'claude-haiku-4-5'),
      thinkingLevel: 'off',
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [],
    } as never);
    sessions.push(session);
    return session;
  }

  const structuredRequest = {
    systemPrompt: 'Name the session.',
    userMessage: 'hello',
    outputToolName: 'set_title',
    outputToolDescription: 'Sets the title',
    schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    purpose: 'session-title',
  } as const;

  it('runs two clients\' turns at once, each request through its own client\'s transport, and never loads the host\'s plugin', async () => {
    const { host, runtime, stub, agentDir, hostSettings, workspace } = await remoteCore(plugin('bundled'), 2);
    const [chatA, chatB] = [await chat(runtime, workspace), await chat(runtime, workspace)];

    host.setActing('client-a');
    const turnA = runPinnedTurn(host.remote, 'panel-a', () => chatA.prompt('from a'));
    host.setActing('client-b');
    const turnB = runPinnedTurn(host.remote, 'panel-b', () => chatB.prompt('from b'));
    await Promise.all([turnA, turnB]);

    expect(stub.seen).toHaveLength(2);
    expect(stub.seen).toEqual(expect.arrayContaining([
      { token: 'sk-ant-oat01-client-a', shapedBy: 'bundled' },
      { token: 'sk-ant-oat01-client-b', shapedBy: undefined },
    ]));
    expect(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).toBe(hostSettings);
    expect(fs.readdirSync(path.join(agentDir, 'git', 'github.com'))).toEqual(['gotgenes']);
  }, 60_000);

  it('a sub-call follows its turn\'s pin, and outside every run the acting client', async () => {
    const { host, runtime, stub } = await remoteCore(plugin('bundled'));

    host.setActing('client-b');
    await runtime.runStructuredCompletion(structuredRequest);
    host.setActing('client-a');
    await runPinnedTurn(host.remote, 'panel-a', () => {
      host.setActing('client-b');
      return runtime.runStructuredCompletion(structuredRequest);
    });

    expect(stub.seen).toEqual([
      { token: 'sk-ant-oat01-client-b', shapedBy: undefined },
      { token: 'sk-ant-oat01-client-a', shapedBy: 'bundled' },
    ]);
  }, 60_000);

  it('a compaction follows the pin of the turn that runs it, whoever acts meanwhile', async () => {
    const { host, runtime, stub, workspace } = await remoteCore(plugin('bundled'));
    const chatA = await chat(runtime, workspace);
    host.setActing('client-a');
    await runPinnedTurn(host.remote, 'panel-a', async () => {
      await chatA.prompt('first from a');
      await chatA.prompt('second from a');
      host.setActing('client-b');
      await chatA.compact();
    });

    expect(stub.seen.length).toBeGreaterThanOrEqual(3);
    expect(stub.seen.every((request) => request.token === 'sk-ant-oat01-client-a' && request.shapedBy === 'bundled')).toBe(true);
  }, 60_000);

  it('a bundled plugin that fails to load: allowance requests bill extra usage, the account state says so, and nothing throws', async () => {
    const { host, runtime, stub } = await remoteCore(BROKEN_PLUGIN);
    host.setActing('client-a');
    const claude = DEFAULT_MODELS.find((model) => model.value === 'claude-sonnet-5-5');
    const status = runtime.getClaudeAuthStatus();
    const account = buildAccountInfo({
      modelValue: 'claude-sonnet-5-5',
      modelInfo: claude,
      claudeAuthMode: status.mode,
      openaiAuthStatus: runtime.getOpenAIAuthStatus(),
      preferApiKey: false,
      flatFeeKeyProviders: runtime.flatFeeKeyProviders(),
      allowanceUnavailable: status.allowanceUnavailable === true,
    });

    expect(status).toEqual({ mode: 'extra', allowanceUnavailable: true });
    expect(account).toEqual({ model: 'claude-sonnet-5-5', dollarBilled: true, allowanceUnavailable: true });
    await runPinnedTurn(host.remote, 'panel-a', () => runtime.runStructuredCompletion(structuredRequest));
    expect(stub.seen).toEqual([{ token: 'sk-ant-oat01-client-a', shapedBy: undefined }]);
    host.setActing('client-b');
    expect(runtime.getClaudeAuthStatus()).toEqual({ mode: 'extra' });
  }, 60_000);
});
