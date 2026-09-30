import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { CheckpointService } from '../checkpoint-service';
import { folderRepoFor, withRepoLock, type StoredCheckpointRecord } from '../checkpoints';
import { createDamoclesExtensionFactory } from '../damocles-extension';
import { watchPromptEntry } from '../prompt-entry';
import { withQueuePolicy } from '../queue-policy';
import { bindPanel, panelSession } from './real-pi-fixtures';

/**
 * The first streamed text of a new conversation reaches the webview, and the run settles, while the
 * turn's baseline cannot finish: another holder keeps the folder lock for the whole prompt. A real pi
 * session and agent loop, the real Damocles extension handlers, the real checkpoint producer, and a
 * scripted provider in place of the model. A pi handler that awaited checkpoint git work would hold
 * the stream (message_start) or the prompt (agent_settled) until the lock is released, which never
 * happens before the assertions.
 */

const STUB_CREDENTIAL = ['sk', 'ant', 'oat01', 'stub'].join('-');
const GIB = 1024 * 1024 * 1024;
const SMALL_FILES = 2000;
// Far above any scheduling delay of an in-process stub stream; a blocked handler never settles at all.
const STREAM_BOUND_MS = 10_000;

const made: string[] = [];
const sessions: AgentSession[] = [];
const services: CheckpointService[] = [];
const locks: Array<() => void> = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** A folder like the one that froze the chat: one 1 GB file, a video and ~2000 small source files. */
function largeFolder(): string {
  const cwd = tempDir('dam-ckpt-large-');
  const fd = fs.openSync(path.join(cwd, 'raw.rgba'), 'w');
  fs.ftruncateSync(fd, GIB);
  fs.closeSync(fd);
  fs.writeFileSync(path.join(cwd, 'final.mp4'), Buffer.alloc(64 * 1024, 1));
  for (let dir = 0; dir < SMALL_FILES / 100; dir++) {
    const sub = path.join(cwd, 'src', `m${dir}`);
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), `export const v${dir}_${i} = ${dir * 100 + i};\n`);
  }
  // The folder repo lives under the hermetic home, outside the temp dir.
  made.push(folderRepoFor(cwd).repoDir);
  return cwd;
}

/** Hold the folder repo's lock until the returned release is called. */
async function holdFolderLock(cwd: string): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let acquired!: () => void;
  const isAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  void withRepoLock(folderRepoFor(cwd).repoDir, async () => { acquired(); await held; });
  await isAcquired;
  locks.push(release);
  return release;
}

/** 'settled' when `promise` settles within `ms`, else 'pending'. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); }),
  ]);
  clearTimeout(timer);
  return outcome;
}

afterEach(async () => {
  for (const release of locks.splice(0)) release();
  for (const service of services.splice(0)) await service.drain(60_000);
  for (const session of sessions.splice(0)) session.dispose();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('the first checkpoint of a large folder', () => {
  it('never holds the first streamed text or the settled prompt back behind the baseline', async () => {
    const cwd = largeFolder();
    const agentDir = tempDir('dam-ckpt-agent-');
    const sessionDir = tempDir('dam-ckpt-sessions-');

    const faux = createFauxCore({ api: 'anthropic-messages', provider: 'anthropic', models: [{ id: 'claude-opus-5-5' }] });
    faux.setResponses([() => fauxAssistantMessage('I am a stub model.')]);

    const holder: { service?: CheckpointService } = {};
    const damocles = createDamoclesExtensionFactory(
      { get: () => undefined, values: () => [] },
      { get: (id) => (holder.service?.sessionId === id ? holder.service : undefined) },
    );
    const extensionFactory = (pi: ExtensionAPI): void => {
      pi.registerProvider('anthropic', { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', streamSimple: faux.streamSimple } as never);
      damocles(pi);
    };
    const settingsManager = withQueuePolicy(SettingsManager.create(cwd, agentDir, { projectTrusted: true }));
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey('anthropic', STUB_CREDENTIAL);
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extensionFactory],
    } as never);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir, model: modelRuntime.getModel('anthropic', 'claude-opus-5-5'), thinkingLevel: 'off', modelRuntime,
      settingsManager, resourceLoader, sessionManager: SessionManager.create(cwd, sessionDir), tools: [],
    } as never);
    sessions.push(session);

    const records: StoredCheckpointRecord[] = [];
    holder.service = new CheckpointService({
      cwd,
      sessionId: session.sessionId,
      onCheckpointReady: () => undefined,
      persist: (record) => {
        records.push(record);
        session.sessionManager.appendCustomEntry('damocles-checkpoint', record);
        return true;
      },
      onBaselineTimeout: () => undefined,
      baselineWaitMs: () => 30_000,
      maxFileSizeBytes: () => 25 * 1024 * 1024,
    });
    services.push(holder.service);

    // The webview side: the panel's own stream adapter, timestamped at the first streamed text it posts.
    const emitted: ExtensionToWebviewMessage[] = [];
    let firstTextAt = 0;
    const push = emitted.push.bind(emitted);
    emitted.push = (...messages: ExtensionToWebviewMessage[]): number => {
      if (!firstTextAt && messages.some((m) => m.type === 'partial')) firstTextAt = performance.now();
      return push(...messages);
    };
    const panel = panelSession(emitted);
    bindPanel(panel, session);
    (panel as unknown as { adapter: { subscribe: (s: AgentSession) => () => void } }).adapter.subscribe(session);

    const releaseLock = await holdFolderLock(cwd);
    let committedAt = 0;
    const watch = watchPromptEntry(session, (entry) => {
      committedAt = performance.now();
      holder.service?.startTurn(session.sessionManager, entry.id, entry.text);
    });
    const prompted = session.prompt('what model are you', { preflightResult: watch.preflightResult });
    expect(await settlesWithin(prompted, STREAM_BOUND_MS)).toBe('settled');
    await prompted;
    watch.dispose();

    // The whole prompt streamed and settled while the baseline was still waiting for the folder lock.
    expect(committedAt).toBeGreaterThan(0);
    expect(firstTextAt).toBeGreaterThan(committedAt);
    expect(records).toEqual([]);
    console.log(`[AC1] first streamed text ${(firstTextAt - committedAt).toFixed(1)} ms after the prompt entry committed, with the folder lock held`);

    // Once the lock is free, the baseline and finalize complete in the background.
    releaseLock();
    await expect.poll(() => records.length, { timeout: 120_000, interval: 100 }).toBe(1);
    const record = records[0]!;
    if (record.kind !== 'checkpoint' || record.v !== 3) throw new Error('expected a v3 checkpoint entry');
    expect(record.skipped.byReason.size).toMatchObject({ count: 1, bytes: GIB });
    expect(record.skipped.byReason.category?.count).toBe(1);
  }, 180_000);
});
