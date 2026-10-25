import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { memoryJudgeStatus } from '../memory-judge-status';
import { PiRuntime } from '../../../../pi-session/pi-runtime';
import { PI_AGENT_DIR } from '../../../../pi-session/agent-dir';

/** A runtime whose model runtime is set but which no chat has started. */
function loadedRuntime(): void {
  const runtime = PiRuntime.get();
  (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = {
    hasConfiguredAuth: () => false,
    getProviderAuthStatus: () => ({ configured: false }),
  };
}

function writeAuthFile(entries: Record<string, unknown>): void {
  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(PI_AGENT_DIR, 'auth.json'), JSON.stringify(entries));
}
const CHATGPT_GRANT = { openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 9_999_999_999_999 } };

describe('memory-judge status', () => {
  beforeEach(() => {
    for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) vi.stubEnv(name, '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    fs.rmSync(path.join(PI_AGENT_DIR, 'auth.json'), { force: true });
    await PiRuntime.disposeInstance();
  });

  it('reads the judge from the stored keys before pi starts', async () => {
    const platform = createFakePlatform({ secrets: { 'damocles.explore.apiKey.openrouter': 'or-key' } });
    expect(await memoryJudgeStatus(platform)).toEqual({
      type: 'memoryJudgeStatus',
      memoryJudge: { kind: 'classifier', via: 'openrouter' },
      classifierCredentials: { typesafe: 'no-key', openrouter: 'ok', openai: 'no-key' },
    });

    await platform.secrets.store('damocles.typesafe.apiKey', 'ts-key');
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'typesafe' } });

    await platform.secrets.delete('damocles.typesafe.apiKey');
    await platform.secrets.delete('damocles.explore.apiKey.openrouter');
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'unknown' } });
  });

  it('counts a stored OpenRouter sign-in before pi starts', async () => {
    const platform = createFakePlatform();
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'unknown' }, classifierCredentials: { openrouter: 'no-key' } });

    writeAuthFile({ openrouter: { type: 'oauth', access: 'a', refresh: 'r', expires: 9_999_999_999_999 } });
    expect(await memoryJudgeStatus(platform)).toEqual({
      type: 'memoryJudgeStatus',
      memoryJudge: { kind: 'classifier', via: 'openrouter' },
      classifierCredentials: { typesafe: 'no-key', openrouter: 'ok', openai: 'no-key' },
    });
  });

  it('counts the environment keys pi reads before pi starts', async () => {
    const platform = createFakePlatform();
    vi.stubEnv('OPENAI_API_KEY', 'sk-env');
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'openai' } });
    vi.stubEnv('OPENROUTER_API_KEY', 'or-env');
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'openrouter' } });
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-env');
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'typesafe' } });
  });

  it('names GPT-6 Luna before pi starts only while the OpenAI request credential is the API key', async () => {
    const platform = createFakePlatform({ secrets: { 'damocles.openai.apiKey': 'sk-key' } });
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'openai' }, classifierCredentials: { openai: 'ok' } });

    writeAuthFile(CHATGPT_GRANT);
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'unknown' }, classifierCredentials: { openai: 'chatgpt-active' } });

    await platform.state.workspace.update('damocles.openai.preferApiKey', true);
    expect(await memoryJudgeStatus(platform)).toMatchObject({ classifierCredentials: { openai: 'chatgpt-active' } });
    await platform.state.global.update('damocles.openai.preferApiKey', true);
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'openai' } });
  });

  it('reports a chosen classifier that cannot run as no judge before pi starts, never another classifier', async () => {
    const platform = createFakePlatform({
      secrets: { 'damocles.explore.apiKey.openrouter': 'or-key' },
      settings: { user: { 'damocles.memory.judge': 'jev-typesafe' } },
    });
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'none', forced: { choice: 'jev-typesafe', reason: 'no-key' } } });

    await platform.settings.update('damocles.memory.judge', 'jev-openrouter', 'user');
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'classifier', via: 'openrouter' } });

    await platform.settings.update('damocles.memory.judge', 'claude-sonnet-5-5', 'user');
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'unknown' } });
  });

  it('reports a stored judge outside the catalog as unrecognized before pi starts', async () => {
    const platform = createFakePlatform({ settings: { user: { 'damocles.memory.judge': 'claude-opus-1' } } });
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'none', forced: { choice: 'claude-opus-1', reason: 'unrecognized' } } });
  });

  it('keeps the judge model unknown while pi is loaded but no chat has started it', async () => {
    const platform = createFakePlatform();
    loadedRuntime();
    expect(await memoryJudgeStatus(platform)).toMatchObject({ memoryJudge: { kind: 'unknown' } });
  });
});
